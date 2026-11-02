/**
 * 华为云 IoTDA 应用侧 API 封装
 *
 * 标准版/企业版实例必须使用「衍生 AK/SK 签名算法」V11-HMAC-SHA256，
 * 通用版 SDK-HMAC-SHA256 会被拒绝（401 Authentication failed）。
 * 本文件按官方 SDK 的 DerivedAKSKSigner / HKDF 实现复刻，零第三方依赖。
 */
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('./config');

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sha256Hex = (str) => crypto.createHash('sha256').update(str, 'utf8').digest('hex');
const hmacHex = (key, str) => crypto.createHmac('sha256', key).update(str, 'utf8').digest('hex');

/** SDK 里的 hmacSHA256：结果先转 hex，再当二进制喂给下一轮 */
function hmacBinary(keyBuf, dataBuf) {
  return Buffer.from(crypto.createHmac('sha256', keyBuf).update(dataBuf).digest('hex'), 'hex');
}

/** HKDF-SHA256 派生密钥：salt = AK，IKM = SK，最终以 hex 字符串作为 HMAC key */
function deriveKey(ak, sk, info) {
  const tmpKey = hmacBinary(Buffer.from(ak, 'utf8'), Buffer.from(sk, 'utf8'));
  const okm = hmacBinary(tmpKey, Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([0x01])]));
  return okm.toString('hex').toLowerCase();
}

function canonicalQueryString(search) {
  if (!search) return '';
  const pairs = [];
  new URLSearchParams(search).forEach((v, k) => pairs.push([k, v]));
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

function buildHeaders(method, urlStr, bodyStr) {
  const u = new URL(urlStr);
  const xSdkDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  const contentType = 'application/json;charset=UTF-8';

  const allHeaders = { 'content-type': contentType, host: u.host, 'x-sdk-date': xSdkDate };
  const names = Object.keys(allHeaders).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((n) => `${n}:${allHeaders[n]}\n`).join('');

  // 规范化 URI：每段编码，末尾必须补斜杠
  let canonicalUri = u.pathname.split('/').map((s) => encodeURIComponent(s)).join('/');
  if (!canonicalUri.endsWith('/')) canonicalUri += '/';

  const payloadHash = bodyStr ? sha256Hex(bodyStr) : EMPTY_SHA256;
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString(u.search),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const info = `${xSdkDate.slice(0, 8)}/${config.REGION}/${config.DERIVED_SERVICE}`;
  const stringToSign = ['V11-HMAC-SHA256', xSdkDate, info, sha256Hex(canonicalRequest)].join('\n');
  const derKey = deriveKey(config.AK, config.SK, info);
  const signature = hmacHex(Buffer.from(derKey, 'utf8'), stringToSign);

  return {
    'Content-Type': contentType,
    Host: u.host,
    'X-Sdk-Date': xSdkDate,
    Authorization: `V11-HMAC-SHA256 Credential=${config.AK}/${info}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}

function request(method, apiPath, body, timeoutMs) {
  if (!config.AK || config.AK.indexOf('这里填') === 0) {
    return Promise.reject(new Error('还没填 AK，请打开 server/config.js 填写'));
  }

  const TIMEOUT = timeoutMs || 15000;
  const urlStr = config.ENDPOINT.replace(/\/+$/, '') + apiPath;
  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = buildHeaders(method, urlStr, bodyStr);
  if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

  const u = new URL(urlStr);
  const lib = u.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: method.toUpperCase(),
        headers,
        timeout: TIMEOUT
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch (e) {
            json = null;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            const err = new Error(`华为云返回 HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.body = data;
            err.huawei = json;
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => {
      const e = new Error(`请求华为云超时（${Math.round(TIMEOUT / 1000)}秒）`);
      e.isTimeout = true;
      req.destroy(e);
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** 查询设备在线状态：ONLINE / OFFLINE / ABNORMAL / INACTIVE */
async function getDevice() {
  return request('GET', `/v5/iot/${config.PROJECT_ID}/devices/${config.DEVICE_ID}`);
}

/** 列出设备（核对 device_id 用） */
async function listDevices(limit) {
  return request('GET', `/v5/iot/${config.PROJECT_ID}/devices?limit=${limit || 20}`);
}

/**
 * 查询设备属性 —— 读设备影子里的「最新上报值」
 * 注意：v5 的 /properties 接口要求设备在线，离线会报 403；
 *       影子接口离线也能读，正是我们需要的。
 */
async function getProperties() {
  const res = await request(
    'GET',
    `/v5/iot/${config.PROJECT_ID}/devices/${config.DEVICE_ID}/shadow`
  );
  const list = (res && res.shadow) || [];
  const svc = list.find((s) => s.service_id === config.SERVICE_ID) || list[0] || {};
  const reported = (svc.reported && svc.reported.properties) || {};
  let props = reported;
  if (typeof props === 'string') {
    try {
      props = JSON.parse(props);
    } catch (e) {
      props = {};
    }
  }
  return { properties: props, eventTime: (svc.reported && svc.reported.event_time) || null };
}

/** 下发命令 */
async function sendCommand(commandName, paras) {
  const payload = {
    service_id: config.SERVICE_ID,
    command_name: commandName,
    paras: config.PARAS_AS_STRING ? JSON.stringify(paras) : paras
  };
  return request(
    'POST',
    `/v5/iot/${config.PROJECT_ID}/devices/${config.DEVICE_ID}/commands`,
    payload,
    // 命令是同步接口：平台把报文投给设备后，还要等设备回执才返回。
    // 设备不回执（MQTT.fx 就不会）时平台会一直挂着，所以这里主动设个
    // 较短的超时，超时就当「已投递、未回执」处理，避免小程序干等。
    6000
  );
}

module.exports = { getDevice, listDevices, getProperties, sendCommand, request };
