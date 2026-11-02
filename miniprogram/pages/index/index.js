const api = require('../../utils/api');

const STATE_TEXT = {
  idle: '待机中',
  reminding: '正在提醒',
  opened: '盒盖已打开'
};

/** "HH:MM" -> 当天的分钟数 */
function toMinutes(hhmm) {
  const s = String(hhmm || '');
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

/**
 * 算下一次提醒。
 * 计划存在小程序这边，设备影子里的 next_time 只是上一次上报时设备自己的判断，
 * 可能已经过期很久（设备离线就不会更新）。所以这里优先用计划自己算。
 */
function computeNext(times) {
  if (!times || !times.length) return { text: '--:--', hint: '' };
  const sorted = times
    .filter((t) => toMinutes(t) >= 0)
    .sort((a, b) => toMinutes(a) - toMinutes(b));
  if (!sorted.length) return { text: '--:--', hint: '' };

  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const nextToday = sorted.find((t) => toMinutes(t) > cur);
  if (nextToday) return { text: nextToday, hint: '' };

  // 刚过点的那一次给 30 分钟宽限，避免 20:01 就显示「明天 20:00」让人以为绕回去了
  const lastPassed = sorted.filter((t) => toMinutes(t) <= cur).pop();
  if (lastPassed && cur - toMinutes(lastPassed) <= 30) {
    return { text: lastPassed, hint: '已到时间' };
  }

  // 今天的都过了，下一个是明天第一个
  return { text: sorted[0], hint: '明天' };
}

/** 华为云 event_time "20261101T093014Z" -> 本地 "17:30" */
function formatEventTime(t) {
  if (!t || t.length < 15) return '';
  const iso =
    t.slice(0, 4) + '-' + t.slice(4, 6) + '-' + t.slice(6, 8) +
    'T' + t.slice(9, 11) + ':' + t.slice(11, 13) + ':' + t.slice(13, 15) + 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

Page({
  data: {
    loading: false,
    error: '',
    today: '',
    plan: null,
    props: {},
    online: false,
    stateText: '--',
    takenText: '0 / 0',
    progress: 0,
    planText: '尚未设置服药时间',
    planTimes: [],
    nextRemind: '--:--',
    nextRemindHint: '',
    dataTimeText: ''
  },

  onLoad() {
    const d = new Date();
    const week = ['日', '一', '二', '三', '四', '五', '六'];
    this.setData({
      today: `${d.getMonth() + 1}月${d.getDate()}日 星期${week[d.getDay()]}`
    });
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ error: '' });
    return api
      .getStatus()
      .then((res) => {
        const props = res.properties || {};
        const plan = res.plan || null;
        const times = (plan && plan.times) || [];
        // 分母优先用「计划次数」：计划存在小程序这边，永远是最新的；
        // 设备影子里的 total_today 只在设备上报时才更新，离线就会冻住。
        // 两者都不存在时才显示 0 / 0。
        const deviceTotal = Number(props.total_today || 0);
        const taken = Number(props.taken_today || 0);
        const total = times.length > 0 ? times.length : deviceTotal;
        const unsynced = times.length > 0 && deviceTotal > 0 && deviceTotal !== times.length;
        const next = times.length
          ? computeNext(times)
          : { text: props.next_time || '--:--', hint: '' };
        this.setData({
          plan,
          props,
          online: !!res.online,
          stateText: STATE_TEXT[props.state] || '待机中',
          takenText: `${taken} / ${total}`,
          progress: total ? Math.min(100, Math.round((taken / total) * 100)) : 0,
          planTimes: times,
          nextRemind: next.text,
          nextRemindHint: next.hint,
          dataTimeText: formatEventTime(res.eventTime),
          planText: times.length
            ? `每日 ${times.length} 次 · ${times.join(' / ')}` +
              (unsynced ? `（设备仍报 ${deviceTotal} 次，未同步）` : '')
            : '尚未设置服药时间'
        });
      })
      .catch((err) => {
        this.setData({
          error: (err && err.message) || '加载失败',
          online: false
        });
      });
  },

  refresh() {
    wx.showLoading({ title: '刷新中', mask: true });
    this.load().then(() => {
      wx.hideLoading();
      wx.showToast({ title: '已刷新', icon: 'none' });
    });
  },

  goPlan() {
    wx.switchTab({ url: '/pages/plan/plan' });
  }
});
