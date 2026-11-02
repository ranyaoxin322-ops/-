/**
 * 虚拟药盒设备（无第三方依赖）
 *
 * 作用：在你还没有真板子的时候，用它顶替 ESP32 / MQTT.fx，
 *       自动连华为云、自动订阅命令、自动回执，还能上报假数据。
 *
 * 用法：
 *   node device-sim.js                     只连上并自动回执命令
 *   node device-sim.js --report            连上后再上报一次属性（让小程序有数据显示）
 *   node device-sim.js --dose              演示一次服药：开盖 → 盖上取药 → 上报事件
 *   node device-sim.js --dose --plan=19:00 指定这次对应的计划时间
 *   node device-sim.js --dose --seq=4 --taken=2   指定事件序号和今日已完成次数
 *   node device-sim.js --seed              造一组自洽的演示数据（3 条记录，答辩用）
 *
 * 说明：
 *   同一个设备只能有一个连接，所以启动它之后 MQTT.fx 会掉线，这是正常的。
 */
const net = require('net');
const crypto = require('crypto');
const config = require('./config');

const DEVICE_ID = config.DEVICE_ID;
const SECRET = config.DEVICE_SECRET;
const SERVICE_ID = config.SERVICE_ID;

// ---------- MQTT 3.1.1 报文拼装（手写，不依赖 mqtt 库） ----------

function encLen(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

function encStr(s) {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

function packet(firstByte, body) {
  return Buffer.concat([Buffer.from([firstByte]), encLen(body.length), body]);
}

// ---------- 连接参数（与 mqtt-key.js 同一套算法） ----------
const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 10);
// ClientId 第四段 = 签名类型：1 表示「校验时间戳」（华为云生成工具里的默认选项）
const clientId = `${DEVICE_ID}_0_1_${ts}`;
// 华为云要求 HMAC-SHA256(key = 时间戳, data = 设备密钥)，顺序不能反
const password = crypto.createHmac('sha256', ts).update(SECRET, 'utf8').digest('hex');

function connectPacket() {
  const vh = Buffer.concat([
    encStr('MQTT'),
    Buffer.from([4, 0xc2]), // 协议级别 4，CleanSession + Username + Password
    Buffer.from([0, 60]) // keepalive 60 秒
  ]);
  const payload = Buffer.concat([encStr(clientId), encStr(DEVICE_ID), encStr(password)]);
  return packet(0x10, Buffer.concat([vh, payload]));
}

function subscribePacket(topic) {
  const body = Buffer.concat([
    Buffer.from([0, 1]), // packet id = 1
    encStr(topic),
    Buffer.from([0]) // QoS 0
  ]);
  return packet(0x82, body);
}

function publishPacket(topic, obj) {
  const body = Buffer.concat([encStr(topic), Buffer.from(JSON.stringify(obj), 'utf8')]);
  return packet(0x30, body);
}

// ---------- 业务 ----------
const SUB_TOPIC = `$oc/devices/${DEVICE_ID}/sys/commands/#`;
const REPORT_TOPIC = `$oc/devices/${DEVICE_ID}/sys/properties/report`;

function responseTopic(requestId) {
  return `$oc/devices/${DEVICE_ID}/sys/commands/response/request_id=${requestId}`;
}

/** 收到一条命令：打印出来，然后按协议回执 */
function handleCommand(sock, topic, payloadText) {
  const idx = topic.indexOf('request_id=');
  const requestId = idx >= 0 ? topic.slice(idx + 'request_id='.length) : '';

  let msg = {};
  try {
    msg = JSON.parse(payloadText);
  } catch (e) {
    /* 华为云有时下发字符串化的 paras，解析失败也要回执，否则平台一直挂着 */
  }

  const name = msg.command_name || 'unknown';
  console.log('');
  console.log(`  [命令] ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}  ${name}`);
  console.log(`         参数 ${JSON.stringify(msg.paras || {})}`);
  console.log(`         request_id ${requestId || '(缺失)'}`);

  if (!requestId) {
    console.log('         没有 request_id，无法回执');
    return;
  }

  sock.write(
    publishPacket(responseTopic(requestId), {
      result_code: 0,
      response_name: `${name}_response`,
      paras: { result: 0 }
    })
  );
  console.log(`         → 已回执 result_code=0`);
}

function reportProps(sock, props) {
  sock.write(publishPacket(REPORT_TOPIC, { services: [{ service_id: SERVICE_ID, properties: props }] }));
  console.log(`  [上报] ${JSON.stringify(props)}`);
}

/**
 * 按「计划时间 vs 实际时间」判定服药状态，规则与对接文档一致：
 *   超出 120 分钟 → missed（这段就是漏服）
 *   迟到 10 分钟以上 → late
 *   早于 10 分钟以上 → early
 *   其余算 ontime
 * 原来这里只有 early/ontime 两分支、且用字符串比大小，
 * 结果「计划 12:26、实际 17:50」也会报 ontime，记录页看着像 bug。
 */
function judgeStatus(planTime, actualTime) {
  const toMin = (s) => {
    const p = String(s || '').split(':');
    return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0);
  };
  let d = toMin(actualTime) - toMin(planTime);
  if (d < -720) d += 1440; // 跨零点：23:50 计划、00:10 实际，算迟到而非提前
  if (d > 120) return 'missed';
  if (d > 10) return 'late';
  if (d < -10) return 'early';
  return 'ontime';
}

/** 读 `--key=值` 形式的命令行参数 */
function argOf(k, def) {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.split('=')[1] : def;
}

/**
 * 秤盘原始码值。物模型 weight_g 现在装的是未标定的 ADC 原始码值，
 * 所以虚拟设备也要报同一量级（几十万），否则演示画面和真机对不上。
 * --base= 改基准码值，--drop= 改一次服药的码值下降量（真机以 A 实测的 D 为准）。
 */
const RAW_BASE = Number(argOf('base', '523841'));

/** 一次服药的码值下降量（演示值，真机由 A 实测） */
const RAW_DROP = Number(argOf('drop', '300'));

/**
 * --seed 演示：按当天计划造 3 条自洽记录
 *
 * 每条间隔 12 秒上报，因为服务端是 10 秒轮询影子归档的，一条条发才能逐条入档
 * （一次全发完的话，轮询只能看到最后一个状态，前面两条会丢）。
 * 计划 08:26 / 12:26 / 17:26，实际时间都落在 ±10 分钟内 → 全部 ontime，
 * 首页 3/3、记录页 3 条按时、零漏服。
 */
function runSeed(sock) {
  const items = [
    { seq: 1, plan: '08:26', actual: '08:24' },
    { seq: 2, plan: '12:26', actual: '12:31' },
    { seq: 3, plan: '17:26', actual: '17:28' }
  ];
  const GAP = 12000;

  items.forEach((it, i) => {
    setTimeout(() => {
      const status = judgeStatus(it.plan, it.actual);
      reportProps(sock, {
        state: 'idle',
        lid_open: false,
        weight_g: RAW_BASE - RAW_DROP * (i + 1),
        taken_today: it.seq,
        total_today: items.length,
        event_seq: it.seq,
        event_drug_name: '二甲双胍',
        event_dose: '2片',
        event_plan_time: it.plan,
        event_actual_time: it.actual,
        event_status: status
      });
      console.log(
        `  [seed ${it.seq}/${items.length}] ${it.plan} → ${it.actual}  ${status}` +
          `  码值 ${RAW_BASE - RAW_DROP * (i + 1)}  进度 ${it.seq}/${items.length}`
      );
    }, 1500 + i * GAP);
  });

  setTimeout(() => {
    console.log('  [seed] 完成：3 条记录已上报，去小程序下拉刷新看首页和记录页');
  }, 1500 + items.length * GAP);
}

/** --dose 演示：开盖 → 盖上并取走药 → 上报一条服药事件 */
function runDoseDemo(sock) {
  const planTime = argOf('plan', '17:26');
  const seq = Number(argOf('seq', '3'));
  const taken = Number(argOf('taken', '1'));
  const forceStatus = argOf('status', '');
  // 2 片药的码值当量，真机由 A 实测（见对接文档第 3 节），这里取个演示值
  const drop = RAW_DROP;
  const pad = (n) => String(n).padStart(2, '0');
  const nowHM = () => {
    const d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  };

  setTimeout(() => {
    console.log('');
    console.log('  [演示 1/2] 打开盒盖');
    reportProps(sock, { lid_open: true, state: 'opened' });
  }, 3000);

  setTimeout(() => {
    console.log(`  [演示 2/2] 盖上盒盖，取走药（码值 ${RAW_BASE} → ${RAW_BASE - drop}，降 ${drop}）`);
    const actual = nowHM();
    const status = forceStatus || judgeStatus(planTime, actual);
    reportProps(sock, {
      lid_open: false,
      state: 'idle',
      weight_g: RAW_BASE - drop,
      taken_today: taken,
      total_today: 3,
      event_seq: seq,
      event_drug_name: '二甲双胍',
      event_dose: '2片',
      event_plan_time: planTime,
      event_actual_time: actual,
      event_status: status
    });
    console.log(`  [演示] 计划 ${planTime} → 实际 ${actual}，判定 ${status}`);
    console.log('  [演示] 完成，去小程序首页下拉刷新 → 记录页看新条目');
  }, 6500);
}

// ---------- 主流程 ----------
const wantReport = process.argv.includes('--report');
const wantDose = process.argv.includes('--dose');
const wantSeed = process.argv.includes('--seed');
let sock;
let keepTimer;

function start() {
  console.log('');
  console.log('  虚拟药盒 · device simulator');
  console.log('  ' + '─'.repeat(46));
  console.log(`  设备   ${DEVICE_ID}`);
  console.log(`  ClientId ${clientId}`);
  console.log(`  地址   ${config.MQTT_HOST}:${config.MQTT_PORT}`);
  console.log('  ' + '─'.repeat(46));

  sock = net.connect(config.MQTT_PORT, config.MQTT_HOST);

  let buf = Buffer.alloc(0);

  sock.on('connect', () => {
    console.log('  TCP 已连接，发送 CONNECT...');
    sock.write(connectPacket());
  });

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    for (;;) {
      if (buf.length < 2) return;

      // 解析剩余长度（变长编码）
      let mult = 1;
      let len = 0;
      let i = 1;
      let byte;
      do {
        if (i >= buf.length) return;
        byte = buf[i++];
        len += (byte & 0x7f) * mult;
        mult *= 128;
      } while (byte & 0x80);

      const total = i + len;
      if (buf.length < total) return;

      const header = buf[0];
      const body = buf.slice(i, total);
      buf = buf.slice(total);

      const type = header >> 4;

      if (type === 2) {
        // CONNACK
        const rc = body.length >= 2 ? body[1] : 255;
        if (rc === 0) {
          console.log('  ✓ 已上线（CONNACK 成功）');
          sock.write(subscribePacket(SUB_TOPIC));
          console.log(`  ✓ 已订阅 ${SUB_TOPIC}`);
          if (wantReport) {
            // 初始上报也认 --taken，否则小程序首页和记录页会对不上
            // （记录里有几次、首页却显示 0 次，看起来像漏记）
            const takenArg = process.argv.find((a) => a.startsWith('--taken='));
            reportProps(sock, {
              state: 'idle',
              next_time: '19:00',
              weight_g: RAW_BASE,
              lid_open: false,
              taken_today: takenArg ? Number(takenArg.split('=')[1]) : 0,
              total_today: 3
            });
          }
          keepTimer = setInterval(() => sock.write(Buffer.from([0xc0, 0x00])), 30000);
          if (wantSeed) runSeed(sock);
          else if (wantDose) runDoseDemo(sock);
        } else {
          console.log(`  × 连接被拒，返回码 ${rc}`);
          console.log('    1=协议版本不对 4=用户名密码错 5=未授权（密码多半过期）');
          process.exit(1);
        }
      } else if (type === 3) {
        // PUBLISH
        const qos = (header >> 1) & 0x03;
        const tlen = body.readUInt16BE(0);
        const topic = body.slice(2, 2 + tlen).toString('utf8');
        let off = 2 + tlen;
        let pid = 0;
        if (qos > 0) {
          pid = body.readUInt16BE(off);
          off += 2;
        }
        const payloadText = body.slice(off).toString('utf8');

        if (qos === 1) {
          // 回 PUBACK，否则平台会重发
          const ack = Buffer.alloc(2);
          ack.writeUInt16BE(pid);
          sock.write(packet(0x40, ack));
        }

        if (topic.indexOf('/commands/') >= 0) handleCommand(sock, topic, payloadText);
        else console.log(`  [其它] ${topic} ${payloadText.slice(0, 120)}`);
      } else if (type === 9) {
        console.log('  ✓ SUBACK 订阅确认');
      }
    }
  });

  sock.on('error', (e) => {
    console.log('  × 连接错误：' + e.message);
    console.log('    密码每小时过期，重跑本脚本即可');
    process.exit(1);
  });

  sock.on('close', () => {
    console.log('  连接已断开');
    if (keepTimer) clearInterval(keepTimer);
  });
}

process.on('SIGINT', () => {
  console.log('\n  退出');
  if (keepTimer) clearInterval(keepTimer);
  if (sock) sock.destroy();
  process.exit(0);
});

start();
