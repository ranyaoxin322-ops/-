const api = require('../../utils/api');
const missedUtil = require('../../utils/missed');

// 注意：华为云物模型里 state 的枚举值是 idle / reminder / opened（不是 reminding）。
// 两种写法都映射，避免设备端按旧文档上报后页面显示成「待机中」。
const STATE_TEXT = {
  idle: '待机中',
  reminder: '正在提醒',
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

/** 华为云 event_time "20261102T090851Z" -> Date（UTC 解析，取绝对值） */
function parseEventTime(t) {
  if (!t || t.length < 15) return null;
  const iso =
    t.slice(0, 4) + '-' + t.slice(4, 6) + '-' + t.slice(6, 8) +
    'T' + t.slice(9, 11) + ':' + t.slice(11, 13) + ':' + t.slice(13, 15) + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** 华为云 event_time "20261101T093014Z" -> 本地 "17:30" */
function formatEventTime(t) {
  const d = parseEventTime(t);
  if (!d) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 两个时间是否是本地同一天 */
function isSameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
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
    dataTimeText: '',
    missedTimes: [],
    missedText: ''
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
        const total = times.length > 0 ? times.length : deviceTotal;
        const unsynced = times.length > 0 && deviceTotal > 0 && deviceTotal !== times.length;

        // 分子只在「设备最后一次上报是今天」时才采信。
        // 设备夜里离线、跨天后 taken_today 还停着昨天的值（比如 3/3），
        // 第二天一打开就会显示「已完成」，这是最坑人的一种假象。
        const eventDate = parseEventTime(res.eventTime);
        const reportedToday = !!(eventDate && isSameLocalDay(eventDate, new Date()));
        const takenRaw = Math.max(0, Number(props.taken_today || 0));
        const taken = reportedToday ? takenRaw : 0;
        // 设备报的次数据超过计划（计划被改小、或设备没清零）时，进度条不溢出但数字要照实说
        const takenShown = total > 0 ? Math.min(taken, total) : taken;
        const overTaken = total > 0 && taken > total;
        const staleHint = !reportedToday && takenRaw > 0 ? '设备今日未上报，进度按 0 计' : '';
        const notes = [staleHint, overTaken ? `设备实报 ${taken} 次，超出计划` : ''].filter(Boolean);

        const next = times.length
          ? computeNext(times)
          : { text: props.next_time || '--:--', hint: '' };

        // 漏服：设备不会上报「没吃」，只能按「计划已过期 + 当天无记录」推算。
        // 设备离线时这个推算不可靠（可能其实吃了但没上报），所以要标注出来。
        const missed = times.length ? missedUtil.findMissed(times, res.records, new Date()) : [];
        const missedText = missed.length
          ? `逾期未服 ${missed.length} 次：${missed.join(' / ')}` +
            (res.online ? '（按计划推算）' : '（设备离线，仅供参考）')
          : '';

        this.setData({
          plan,
          props,
          online: !!res.online,
          stateText: STATE_TEXT[props.state] || '待机中',
          takenText: `${takenShown} / ${total}`,
          progress: total ? Math.min(100, Math.round((takenShown / total) * 100)) : 0,
          planTimes: times,
          nextRemind: next.text,
          nextRemindHint: next.hint,
          dataTimeText: formatEventTime(res.eventTime),
          missedTimes: missed,
          missedText,
          planText: times.length
            ? `每日 ${times.length} 次 · ${times.join(' / ')}` +
              (unsynced ? `（设备仍报 ${deviceTotal} 次，未同步）` : '') +
              (notes.length ? `（${notes.join('；')}）` : '')
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
