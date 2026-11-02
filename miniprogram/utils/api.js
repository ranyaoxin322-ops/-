/**
 * 后端地址配置
 *
 * ⚠️ 这里的 IP 必须改成你电脑的局域网 IP：
 *    1. 先运行 server/server.js，启动时会直接把可用 IP 打印出来
 *    2. 或者命令行执行 ipconfig，找「IPv4 地址」，形如 192.168.1.23
 *    3. 端口要和 server/config.js 里的 PORT 一致（默认 3000）
 *
 * 注意：不要填 localhost 或 127.0.0.1 —— 那是手机自己，手机访问不到你的电脑。
 */
const BASE_URL = 'http://10.194.168.173:3000';

function request(path, method, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method: method || 'GET',
      data: data || undefined,
      timeout: 12000,
      header: { 'content-type': 'application/json' },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (res.data && res.data.ok === false) {
            reject({ message: res.data.message || '服务返回失败', detail: res.data });
          } else {
            resolve(res.data);
          }
        } else {
          const msg = (res.data && res.data.message) || 'HTTP ' + res.statusCode;
          reject({ message: msg, detail: res.data });
        }
      },
      fail(err) {
        reject({
          message:
            '连不上中转服务。请确认：① 电脑上 node server.js 正在运行 ' +
            '② BASE_URL 里的 IP 是电脑的局域网 IP ③ 手机和电脑连同一个 WiFi',
          detail: err
        });
      }
    });
  });
}

module.exports = {
  BASE_URL,
  ping: () => request('/api/ping'),
  getStatus: () => request('/api/status'),
  getPlan: () => request('/api/plan'),
  savePlan: (plan) => request('/api/plan', 'POST', plan),
  getRecords: () => request('/api/records')
};
