/**
 * 「漏服」判定
 *
 * 设备只在真的吃药时上报事件（开盖 + 重量下降），没吃的时候它什么都不会发，
 * 所以「漏服」没办法从设备侧拿到，只能由前端按计划时间 + 已有记录推算：
 *
 *   计划里某个时间点已经过去超过 GRACE_MIN 分钟，且当天没有 plan_time 与之对应的
 *   服药记录 → 判定为漏服。
 *
 * 这是推算而非事实，所以界面上要写清楚「按计划推算」，别当成设备上报的数据。
 */

/** 超过计划时间多久算漏服（分钟） */
const GRACE_MIN = 30;

/** "HH:MM" -> 当天的分钟数，非法返回 -1 */
function toMinutes(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return -1;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return -1;
  return h * 60 + mi;
}

/** 补零 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Date -> "2026-11-02"（本地时区） */
function localDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 找出今天「已过期但没记录」的时间点
 *
 * @param {string[]} times    计划时间点，如 ['08:00','12:30']
 * @param {Array}    records  服务端记录，元素含 date / plan_time / status
 * @param {Date}     [now]    当前时间，测试时可传
 * @returns {string[]}        漏服时间点，升序
 */
function findMissed(times, records, now) {
  const d = now || new Date();
  const today = localDateStr(d);
  const cur = d.getHours() * 60 + d.getMinutes();

  // 今天已经有记录的时段，不管状态是什么（含设备自己报的 missed）都不再重复推算，
  // 否则同一次漏服会在记录页出现两条。
  const known = {};
  (records || []).forEach((r) => {
    if (!r || r.date !== today) return;
    const t = String(r.plan_time || '');
    if (t) known[t] = true;
  });

  return (times || [])
    .filter((t) => toMinutes(t) >= 0)
    .filter((t) => cur >= toMinutes(t) + GRACE_MIN)
    .filter((t) => !known[t])
    .sort((a, b) => toMinutes(a) - toMinutes(b));
}

module.exports = { GRACE_MIN, toMinutes, localDateStr, findMissed };
