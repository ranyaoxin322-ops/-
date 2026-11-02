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
 * 靠 event_seq 去重：同一条事件只入库一次。
 */
function archiveEvent(props) {
  const seq = Number(props.event_seq || 0);
  if (!seq) return;

  const records = readJson(RECORD_FILE, []);
  if (records.some((r) => Number(r.seq) === seq)) return;

  records.push({
    seq,
    drug_name: props.event_drug_name || '',
    dose: props.event_dose || '',
    plan_time: props.event_plan_time || '',
    actual_time: props.event_actual_time || '',
    status: props.event_status || 'ontime',
    date: todayStr(),
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
  const times = (body.times || []).filter(Boolean);

  if (!drug_name) throw new Error('药品名称不能为空');
  if (!dose) throw new Error('每次用量不能为空');
  if (!times.length) throw new Error('至少需要一个服药时间');

  const plan = { drug_name, dose, times, updated_at: Date.now() };

  // 命令接口是同步的：平台把报文投给设备后，要等设备回执。
  // MQTT.fx 这种手动客户端不会回执，平台等满超时就返回超时——
  // 但命令其实已经投递出去了。这种情况不该判成失败，否则
  // 小程序会弹「下发失败」，可 MQTT.fx 那边明明收到了，很容易误判。
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
        '命令已发出，但没等到设备回执（MQTT.fx 不会自动回执）。' +
        '去 MQTT.fx 的订阅窗口看有没有收到 set_plan，收到就说明下发成功。';
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
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
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
        ? '药盒不在线。请先用 MQTT.fx 或 ESP32 连上华为云，再下发命令。'
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
