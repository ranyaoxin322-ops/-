/**
 * 本机中转服务
 * 小程序 → 这个服务 → 华为云 IoTDA → ESP32 药盒
 *
 * 启动：node server.js
 * 自检：node check.js
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const huawei = require('./huawei');

const DATA_DIR = path.join(__dirname, 'data');
const PLAN_FILE = path.join(DATA_DIR, 'plans.json');
const RECORD_FILE = path.join(DATA_DIR, 'records.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/** 调用方参数有误：回 400，不当成服务端故障 */
function badRequest(msg, status = 400) {
  const e = new Error(msg);
  e.httpStatus = status;
  return e;
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 华为云 event_time "20261102T090851Z" -> 本地日期 "2026-11-02"
 * 归档日期必须取「事件发生时间」，不能取「服务器当前时间」：
 * 设备 23:59 吃药、服务器 00:01 才轮询到，按当前时间会把记录算到第二天。
 */
function dateFromEventTime(t) {
  if (!t || String(t).length < 15) return todayStr();
  const s = String(t);
  const d = new Date(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T` +
      `${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`
  );
  if (isNaN(d.getTime())) return todayStr();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 设备上报服药事件后，把最新一次事件归档成本地记录。
 * 去重键是「日期 + event_seq」：设备如果把 event_seq 每天从 1 开始，
 * 只用 seq 去重会导致第二天的第一条记录被当成重复而丢掉。
 *
 * @param {object} props     设备影子里的属性
 * @param {string} [eventTime] 华为云 event_time，用来确定归档到哪一天
 */
function archiveEvent(props, eventTime) {
  const seq = Number(props.event_seq || 0);
  if (!seq) return;

  const date = dateFromEventTime(eventTime);
  const records = readJson(RECORD_FILE, []);
  if (records.some((r) => Number(r.seq) === seq && r.date === date)) return;

  records.push({
    seq,
    drug_name: props.event_drug_name || '',
    dose: props.event_dose || '',
    plan_time: props.event_plan_time || '',
    actual_time: props.event_actual_time || '',
    status: props.event_status || 'ontime',
    date,
    archived_at: Date.now()
  });

  writeJson(RECORD_FILE, records);
  console.log(`[归档] 新增服药记录 seq=${seq} ${props.event_plan_time}→${props.event_actual_time}`);
}

/**
 * 称重原始码值 → 克（可选，默认关闭）
 *
 * 现状（2026-11-02）：A 只输出 24 位 ADC 原始码值，固件不做标定，也拿不到可用的
 * 换算系数。所以整套系统按**原始码值**运行：物模型 weight_g 单位已清空、范围放宽到
 * ±1000000，小程序显示「秤盘读数（原始值）」，服药判定比的是码值差而不是克数。
 *
 * 这段只是留个口子：万一以后能标定，把系数填进 config.js 就切回克，页面不用改
 * （formatWeight 会自动按带小数的克数显示）。
 *   克 = (原始码值 - 零点) * K
 * K <= 0（默认）时完全跳过，weight_g 原样透传。
 */
function convertWeight(props) {
  const k = Number((config.RAW_WEIGHT_K || 0));
  if (!(k > 0)) return props;
  const raw = Number(props.weight_g);
  if (!isFinite(raw)) return props;
  const zero = Number(config.RAW_WEIGHT_ZERO || 0);
  const grams = Math.max(0, Math.round((raw - zero) * k * 100) / 100);
  return Object.assign({}, props, {
    weight_g: grams,
    weight_raw: raw
  });
}

async function handleStatus() {
  const propsRes = await huawei.getProperties();
  const props = propsRes.properties || {};

  archiveEvent(props, propsRes.eventTime);

  let online = false;
  try {
    const dev = await huawei.getDevice();
    online = dev && dev.status === 'ONLINE';
  } catch (e) {
    // 查不到设备状态不影响主流程
  }

  return {
    ok: true,
    online,
    properties: convertWeight(props),
    eventTime: propsRes.eventTime,
    plan: readJson(PLAN_FILE, null),
    records: readJson(RECORD_FILE, [])
  };
}

/**
 * 校验 HH:MM 是否真实存在
 * 只写 /^\d{1,2}:\d{2}$/ 会放过 25:99、99:99 这种格式对但时间不存在的东西，
 * 它们会被原样下发给设备，固件解析不了只能瞎猜。
 */
function isValidHM(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

/** 8:26 → 08:26。不补零的话字符串排序会把 "8:26" 排到 "12:26" 后面 */
function normalizeHM(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  return m ? `${String(Number(m[1])).padStart(2, '0')}:${m[2]}` : String(t || '').trim();
}

async function handleSavePlan(body) {
  const drug_name = String(body.drug_name || '').trim();
  const dose = String(body.dose || '').trim();
  // 去重 + 规范化 + 排序：重复时间点会让首页分母虚高，也会让设备端多次提醒同一次
  const times = Array.from(new Set((body.times || []).map((t) => normalizeHM(t))))
    .filter(Boolean)
    .sort();

  if (!drug_name) throw badRequest('药品名称不能为空');
  if (!dose) throw badRequest('每次用量不能为空');
  if (!times.length) throw badRequest('至少需要一个服药时间');
  const badTime = times.find((t) => !isValidHM(t));
  if (badTime) throw badRequest(`时间必须是 00:00~23:59 的 HH:MM，收到：${badTime}`);
  // 上限必须 ≤ 云端 taken_today / total_today 的取值上限（int，0~10）。
  // 计划 12 次时设备上报 taken_today=11 会被平台按超范围拒收，
  // 整条属性报文连 weight_g 一起丢掉，比少两个时间点严重得多。
  if (times.length > 10) throw badRequest('服药时间点过多（最多 10 个）');

  const plan = { drug_name, dose, times, updated_at: Date.now() };

  // 命令接口是同步的：平台把报文投给设备后，要等设备回执。
  // 正常固件（或 device-sim.js）会在 1 秒内回执，接口直接成功。
  // 只有设备侧没实现回执时才会走超时分支——那时命令其实已经投递出去了，
  // 不该判成失败，否则小程序会弹「下发失败」而设备明明收到了。
  let command = null;
  let warning = '';
  try {
    command = await huawei.sendCommand('set_plan', {
      drug_name,
      dose,
      times: times.join(',')
    });
  } catch (err) {
    if (err.isTimeout) {
      warning =
        '命令已发出，但设备没有回执（平台只等 20 秒）。' +
        '检查设备固件是否收到命令后立刻回执 result_code=0。';
    } else {
      throw err;
    }
  }

  writeJson(PLAN_FILE, plan);
  return { ok: true, plan, command, warning };
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body)
  };
  // 4xx 时请求体可能还没收完（比如超限只读了一半），
  // 复用连接会让客户端把剩下的数据继续写在一条已经回复过的连接上，干脆关掉。
  if (code >= 400) headers.Connection = 'close';
  res.writeHead(code, headers);
  res.end(body);
}

const MAX_BODY = 1e6;

function readBody(req) {
  return new Promise((resolve, reject) => {
    // 头里已经声明超限就直接拒，连 body 都不用收
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY) {
      req.pause();
      return reject(badRequest('请求体过大（上限 1MB）', 413));
    }
    let raw = '';
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      raw += c;
      if (raw.length > MAX_BODY) {
        tooLarge = true;
        // 这里只能 pause 不能 destroy：destroy 会把 socket 直接砍掉，
        // 上层拿到的 413 根本没机会写回去，客户端只看到「连接被重置」。
        req.pause();
        reject(badRequest('请求体过大（上限 1MB）', 413));
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(badRequest('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});

  try {
    // new URL 遇到畸形 request-target 会抛异常。放在 try 外面的话，
    // async handler 抛出的错误没人接，Node 15+ 会直接把进程干掉。
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (e) {
      return send(res, 400, { ok: false, message: '请求地址不合法' });
    }
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/ping') {
      return send(res, 200, { ok: true, service: 'smart-pillbox relay', time: Date.now() });
    }

    if (route === 'GET /api/status') {
      return send(res, 200, await handleStatus());
    }

    if (route === 'GET /api/plan') {
      return send(res, 200, { ok: true, plan: readJson(PLAN_FILE, null) });
    }

    if (route === 'POST /api/plan') {
      const body = await readBody(req);
      return send(res, 200, await handleSavePlan(body));
    }

    if (route === 'GET /api/records') {
      // 顺手拉一次设备影子并归档。
      // 否则「先开记录页、后回首页刷新」的顺序会看不到新记录，很像 bug。
      try {
        const propsRes = await huawei.getProperties();
        // 必须带上 eventTime：归档日期是按「事件发生时刻」换算的，
        // 不传就会退化成服务器当前时间，23:59 吃药、00:01 打开记录页会记到第二天
        archiveEvent(propsRes.properties || {}, propsRes.eventTime);
      } catch (e) {
        // 读影子失败不影响展示已有记录
      }
      const records = readJson(RECORD_FILE, []);
      records.sort((a, b) => Number(a.seq) - Number(b.seq));
      return send(res, 200, { ok: true, records });
    }

    if (route === 'POST /api/records/clear') {
      writeJson(RECORD_FILE, []);
      return send(res, 200, { ok: true });
    }

    send(res, 404, { ok: false, message: `接口不存在：${route}` });
  } catch (err) {
    console.error('[错误]', err.message, err.huawei ? JSON.stringify(err.huawei) : '');
    const code = err.huawei && err.huawei.error_code;
    const friendly =
      code === 'IOTDA.014016'
        ? '药盒不在线。先启动设备（真板子或 node device-sim.js），再下发命令。'
        : code === 'IOTDA.014000'
        ? '设备不存在。检查 config.js 里的 DEVICE_ID 是否和控制台一致。'
        : err.message || '服务内部错误';
    // 参数错误回 400、平台侧问题回 502、其余才算 500。
    // 全回 500 会让前端分不清「我填错了」和「云上出事了」。
    const status = err.httpStatus || (err.huawei ? 502 : 500);
    send(res, status, {
      ok: false,
      message: friendly,
      statusCode: err.statusCode || null,
      detail: err.huawei || err.body || null
    });
  }
});

/**
 * 客户端带 Expect: 100-continue 时，Node 默认先回 100 让对端把 body 发过来。
 * 头里 Content-Length 已经超限的话没必要收，直接 413 更省事，
 * 也避免「客户端发到一半被拒」这种谁都不舒服的场面。
 */
server.on('checkContinue', (req, res) => {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY) {
    const body = JSON.stringify({ ok: false, message: '请求体过大（上限 1MB）' });
    res.writeHead(413, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'close'
    });
    return res.end(body);
  }
  res.writeContinue();
  server.emit('request', req, res);
});

/**
 * 进程级兜底
 *
 * 轮询和每个请求虽然都包了 try/catch，但总有意料之外的异步回调
 * （比如流事件、定时器里抛错）会冒到顶层。Node 15+ 默认直接退出进程，
 * 演示现场挂一次就得重新起服务，代价太大，所以选择记录后继续跑。
 */
process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', (err && err.stack) || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[未处理 Promise]', (reason && reason.stack) || reason);
});

server.listen(config.PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips = [];
  Object.values(nets).forEach((list) =>
    (list || []).forEach((n) => {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    })
  );

  console.log('');
  console.log('  智能药盒中转服务已启动');
  console.log('  ─────────────────────────────────────');
  console.log(`  本机访问：http://localhost:${config.PORT}/api/ping`);
  ips.forEach((ip) => {
    console.log(`  局域网  ：http://${ip}:${config.PORT}/api/ping   ← 手机用这个 IP`);
  });
  console.log('  ─────────────────────────────────────');
  console.log('  把这个局域网 IP 填进 miniprogram/utils/api.js 的 BASE_URL');
  console.log('');
});

/**
 * 定时轮询设备影子并归档
 *
 * 为什么需要：影子只保留「最后一次上报」，而归档原本只在有人请求接口时才触发。
 * 设备连续上报两条事件、中间没人打开小程序，第一条就被覆盖掉了。
 * 服务端自己每 10 秒读一次影子，两次服药不可能只隔 10 秒，等于把窗口补上。
 *
 * 设环境变量 POLL_MS=0 可关闭（比如答辩时想完全手动控制）。
 */
const POLL_MS = Number(process.env.POLL_MS === undefined ? 10000 : process.env.POLL_MS);
if (POLL_MS > 0) {
  let polling = false;
  const pollOnce = async () => {
    if (polling) return; // 上一轮还没回来就跳过，避免请求堆积
    polling = true;
    try {
      const res = await huawei.getProperties();
      if (res && res.properties) archiveEvent(res.properties, res.eventTime);
    } catch (e) {
      // 网络抖动、设备离线、凭证过期都可能失败，下一轮继续，不影响接口服务
    } finally {
      polling = false;
    }
  };
  setInterval(pollOnce, POLL_MS);
  console.log(`  [归档] 影子轮询已开启：每 ${POLL_MS / 1000} 秒检查一次设备事件`);
}
