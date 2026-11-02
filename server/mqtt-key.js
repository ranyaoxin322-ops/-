/**
 * MQTT.fx 连接参数生成器
 * 用法：node mqtt-key.js
 *
 * 华为云设备接入的三元组里，Password 是按「当前 UTC 整点小时」动态算的，
 * 所以每小时都要重算一次。这个脚本直接把三条参数打印出来，复制粘贴即可。
 */
const crypto = require('crypto');
const config = require('./config');

const DEVICE_ID = config.DEVICE_ID;
const DEVICE_SECRET = config.DEVICE_SECRET;

// Huawei 的时间戳格式：yyyyMMddHH，必须是 UTC，不是北京时间
const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 10);

// 【关键】华为云的算法是 HMAC-SHA256(key = 时间戳, data = 设备密钥)，
// 注意 key 和 data 的顺序：时间戳当密钥，设备密钥当消息体。
// 写反了（密钥当 key、时间戳当消息）会一直返回 "Bad username or password"。
const password = crypto.createHmac('sha256', ts).update(DEVICE_SECRET, 'utf8').digest('hex');

// 算出这组密码在本地时间的几点失效
const expire = new Date();
expire.setUTCMinutes(0, 0, 0);
expire.setUTCHours(expire.getUTCHours() + 1);

console.log('');
console.log('  MQTT.fx 连接参数（复制下面三行）');
console.log('  ' + '-'.repeat(52));
console.log('  Broker Address : ' + config.MQTT_HOST);
console.log('  Broker Port    : ' + config.MQTT_PORT);
console.log('  Client ID      : ' + DEVICE_ID + '_0_1_' + ts);
console.log('  User Name      : ' + DEVICE_ID);
console.log('  Password       : ' + password);
console.log('  ' + '-'.repeat(52));
console.log('  UTC 时间戳 : ' + ts);
console.log('  本地时间   : ' + new Date().toLocaleString('zh-CN', { hour12: false }));
console.log('  本组密码在 ' + expire.toLocaleString('zh-CN', { hour12: false }) + ' 失效，过点重跑一次本脚本');
console.log('');
