/**
 * 中转服务配置模板
 *
 * 用法：把本文件复制成 config.js，再填入你自己的值
 *      Windows:  copy config.example.js config.js
 *      macOS/Linux: cp config.example.js config.js
 *
 * 填完保存，在本目录执行：node check.js
 */

// ① 华为云 AK / SK
// 控制台右上角账号名 → 我的凭证 → 访问密钥 → 新增访问密钥 → 下载 csv
// csv 里 "Access Key Id" 是 AK，"Secret Access Key" 是 SK
const AK = '这里填你的 AK';
const SK = '这里填你的 SK';

// ② 项目 ID
// 我的凭证 → 项目列表 → 找区域 cn-north-4 那一行 → 复制"项目ID"
const PROJECT_ID = '这里填你的项目 ID';

// ③ 实例前缀
// 设备接入地址形如 382f09a250.st1.iotda-device.cn-north-4.myhuaweicloud.com
// 只填最前面那段：382f09a250
const PREFIX = '这里填实例前缀';

// ④ 区域
const REGION = 'cn-north-4';

// ================= 以下通常不用改 =================

// 应用侧接入地址：由前缀自动拼出来
// 注意是 iotda-app，不是 iotda-device —— 后者是给 ESP32 / MQTT.fx 用的
const ENDPOINT = PREFIX.indexOf('这里填') === 0
  ? ''
  : `https://${PREFIX.trim()}.st1.iotda-app.${REGION}.myhuaweicloud.com`;

module.exports = {
  AK: AK.trim(),
  SK: SK.trim(),
  PROJECT_ID: PROJECT_ID.trim(),
  ENDPOINT,
  REGION,

  // 衍生签名用的服务名（标准版实例必须用 V11-HMAC-SHA256）
  DERIVED_SERVICE: 'iotda',

  // 设备 ID：控制台设备详情页里的那一串，含 _pillbox_01 结尾
  DEVICE_ID: '这里填设备 ID',
  // 物模型里的服务 ID，必须与设备上报报文中的 service_id 完全一致
  SERVICE_ID: 'PillBox',

  // 中转服务监听端口
  PORT: 3000,

  // ---- 以下给 MQTT.fx / ESP32 用（运行 node mqtt-key.js 会读这几项）----
  MQTT_HOST: `${PREFIX.trim()}.st1.iotda-device.${REGION}.myhuaweicloud.com`,
  MQTT_PORT: 1883,
  // 注册设备时自己填的那个密钥
  DEVICE_SECRET: '这里填设备密钥',

  // 华为云部分版本要求命令参数 paras 传 JSON 字符串。
  // 如果下发命令报 400 或参数类型错误，把它改成 false 再试。
  PARAS_AS_STRING: true,

  // ---- 称重换算（默认关闭，现网就是关闭状态）----
  // 2026-11-02 起，物模型 weight_g 装的是称重模块的**原始 ADC 码值**：
  // 单位已清空、范围 ±1000000，固件不做标定，也拿不到可用的换算系数，
  // 所以整套系统按原始码值运行，这里保持 0 即可。
  //
  // 留这个口子是为了将来能标定时不用改代码：
  //   克 = (原始码值 - RAW_WEIGHT_ZERO) * RAW_WEIGHT_K
  // RAW_WEIGHT_K 填 0 = 不换算，weight_g 原样透传（当前状态）。
  //
  // 标定方法（做得到才填）：放一个已知重量 W 克的东西，读 raw，K = W / (raw - 零点)。
  // 只要求出「两片药掉多少码值」这类相对量、不需要绝对克数的话，
  // 根本不用填这里——服药判定在固件里按码值差做，见对接文档第 3 节。
  RAW_WEIGHT_K: 0,
  RAW_WEIGHT_ZERO: 0,

  // 内部用：判断是否还是占位符
  _PLACEHOLDER: '这里填'
};
