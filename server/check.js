/**
 * 连通性自检脚本
 * 用法：node check.js
 *
 * 依次验证：配置是否填了 → AK/SK 签名能不能过 → 能不能查到设备 → 能不能读属性
 * 任何一步失败都会打印出华为云的原始错误，方便定位。
 */
const config = require('./config');
const huawei = require('./huawei');

const ok = (m) => console.log('  [OK]   ' + m);
const bad = (m) => console.log('  [FAIL] ' + m);

function checkConfig() {
  const problems = [];
  if (!config.AK || config.AK.indexOf('这里填') === 0) problems.push('AK 没填');
  if (!config.SK || config.SK.indexOf('这里填') === 0) problems.push('SK 没填');
  if (!config.PROJECT_ID || config.PROJECT_ID.indexOf('这里填') === 0) problems.push('PROJECT_ID 没填');
  if (!config.ENDPOINT) problems.push('PREFIX 没填（实例前缀）');
  return problems;
}

function explain(err) {
  const status = err.statusCode;
  const body = String(err.body || '');
  if (err.code === 'ENOTFOUND' || /getaddrinfo/.test(err.message || '')) {
    return (
      '域名解析失败，说明 ENDPOINT 拼错了。当前尝试的是：\n           ' +
      config.ENDPOINT +
      '\n          → 去控制台「总览」页复制「应用侧接入地址」，和它逐字对比（注意是 iotda-app 不是 iotda-device）'
    );
  }
  if (err.code === 'ETIMEDOUT' || /超时/.test(err.message || '')) {
    return '连接超时。检查网络/代理，或换手机热点试试。';
  }
  if (status === 401) {
    return '鉴权失败。检查：① AK/SK 有没有复制错或多空格 ② 电脑系统时间是否准确（签名带时间戳）';
  }
  if (status === 403) {
    return '无权限。检查：① PROJECT_ID 是否属于这个账号 ② 该账号是否已开通 IoTDA 服务';
  }
  if (status === 404) {
    return '资源不存在。检查：① DEVICE_ID 是否完整（含 _pillbox_01） ② ENDPOINT 里的实例地址是否和产品所在区域一致';
  }
  if (status === 400) {
    return '请求参数有问题。检查 SERVICE_ID 是否和物模型里的服务 ID 完全一致（区分大小写）。原始返回：' + body;
  }
  if (body) return '华为云原始返回：' + body;
  return err.message;
}

(async () => {
  console.log('');
  console.log('  智能药盒 · 云端连通性自检');
  console.log('  ─────────────────────────────────────');

  const problems = checkConfig();
  if (problems.length) {
    problems.forEach(bad);
    console.log('');
    console.log('  请先打开 server/config.js 把上面几项填好。');
    console.log('');
    process.exit(1);
  }
  ok('配置已填写');
  console.log(`         接入地址 ${config.ENDPOINT}`);
  console.log(`         设备ID   ${config.DEVICE_ID}`);
  console.log(`         服务ID   ${config.SERVICE_ID}`);

  try {
    const dev = await huawei.getDevice();
    ok(`设备查询成功，状态：${dev.status}`);
    if (dev.status !== 'ONLINE') {
      console.log('         设备当前不在线。MQTT.fx 或 ESP32 连上之后才会变成 ONLINE。');
    }
  } catch (err) {
    bad('设备查询失败');
    console.log('         ' + explain(err));
    console.log('');
    process.exit(1);
  }

  try {
    const { properties, eventTime } = await huawei.getProperties();
    const keys = Object.keys(properties);
    ok(`属性读取成功，共 ${keys.length} 个字段`);
    if (keys.length === 0) {
      console.log('         属性是空的 —— 说明设备还没上报过数据，先用 MQTT.fx 发一条。');
    } else {
      console.log('         最新上报时间：' + (eventTime || '未知'));
      keys.forEach((k) => console.log(`         ${k.padEnd(20)} = ${JSON.stringify(properties[k])}`));
    }
  } catch (err) {
    bad('属性读取失败');
    console.log('         ' + explain(err));
    console.log('');
    process.exit(1);
  }

  console.log('');
  console.log('  全部通过。可以执行 node server.js 启动中转服务了。');
  console.log('');
})();
