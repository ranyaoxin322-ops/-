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

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 设备上报服药事件后，把最新一次事件归档成本地记录。
 * 去重键是「日期 + event_seq」：设备如果把 event_seq 每天从 1 开始，
 * 只用 seq 去重会导致第二天的第一条记录被当成重复而丢掉。
 */
function archiveEvent(props) {
  const seq = Number(props.event_seq || 0);
  if (!seq) return;

  const date = todayStr();
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

async function handleStatus() {
  const propsRes = await huawei.getProperties();
  const props = propsRes.properties || {};

  archiveEvent(props);

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
    properties: props,
    eventTime: propsRes.eventTime,
    plan: readJson(PLAN_FILE, null),
    records: readJson(RECORD_FILE, [])
  };
}

async function handleSavePlan(body) {
  const drug_name = String(body.drug_name || '').trim();
  const dose = String(body.dose || '').trim();
  // 去重 + 排序：重复时间点会让首页分母虚高，也会让设备端多次提醒同一次
  const times = Array.from(new Set((body.times || []).map((t) => String(t || '').trim())))
    .filter(Boolean)
    .sort();

  if (!drug_name) throw new Error('药品名称不能为空');
  if (!dose) throw new Error('每次用量不能为空');
  if (!times.length) throw new Error('至少需要一个服药时间');
  const badTime = times.find((t) => !/^\d{1,2}:\d{2}$/.test(t));
  if (badTime) throw new Error(`时间格式必须是 HH:MM，收到：${badTime}`);
  if (times.length > 12) throw new Error('服药时间点过多（上限 12 个）');

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
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      raw += c;
      if (raw.length > 1e6) {
        // 不能只 destroy：不 reject 的话这个请求会永远挂着，客户端一直等到超时
        tooLarge = true;
        req.destroy();
        reject(new Error('请求体过大（上限 1MB）'));
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  if (req.method === 'OPTIONS') return send(res, 204, {});

  try {
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
        archiveEvent(propsRes.properties || {});
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
    send(res, 500, {
      ok: false,
      message: friendly,
      statusCode: err.statusCode || null,
      detail: err.huawei || err.body || null
    });
  }
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
