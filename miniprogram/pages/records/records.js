const api = require('../../utils/api');
const missedUtil = require('../../utils/missed');

const STATUS = {
  ontime: { text: '按时', cls: 'st-ok' },
  early: { text: '提前', cls: 'st-early' },
  late: { text: '延迟', cls: 'st-late' },
  missed: { text: '漏服', cls: 'st-miss' }
};

Page({
  data: {
    groups: [],
    total: 0,
    loaded: false,
    hasMissed: false
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  /**
   * 记录有两个来源：
   *   1. 设备上报的服药事件（服务端归档，真实的「吃了」）
   *   2. 前端按计划推算的漏服（设备不会上报「没吃」）
   * 两者拼在一起展示，漏服条目带 synthetic 标记，界面底部会说明来源。
   */
  load() {
    return api
      .getStatus()
      .then((res) => {
        const records = res.records || [];
        const plan = res.plan || null;
        const times = (plan && plan.times) || [];
        const list = records.slice().sort((a, b) => Number(b.seq) - Number(a.seq));

        const map = {};
        const order = [];
        list.forEach((r) => {
          const date = r.date || '未知日期';
          if (!map[date]) {
            map[date] = [];
            order.push(date);
          }
          const st = STATUS[r.status] || { text: r.status || '未知', cls: '' };
          map[date].push({
            seq: String(r.seq),
            drug_name: r.drug_name || '--',
            dose: r.dose || '',
            plan_time: r.plan_time || '--:--',
            actual_time: r.actual_time || '--:--',
            statusText: st.text,
            statusClass: st.cls,
            synthetic: false
          });
        });

        // 今天已过期但没有记录的时段，补成「漏服」条目
        const missed = missedUtil.findMissed(times, records, new Date());
        if (missed.length) {
          const today = missedUtil.localDateStr(new Date());
          if (!map[today]) {
            map[today] = [];
            order.unshift(today);
          }
          missed.forEach((t) => {
            map[today].push({
              seq: 'missed-' + t,
              drug_name: (plan && plan.drug_name) || '--',
              dose: (plan && plan.dose) || '',
              plan_time: t,
              actual_time: '未记录',
              statusText: STATUS.missed.text,
              statusClass: STATUS.missed.cls,
              synthetic: true
            });
          });
        }

        this.setData({
          loaded: true,
          total: list.length + missed.length,
          hasMissed: missed.length > 0,
          groups: order.map((d) => ({ date: d, items: map[d] }))
        });
      })
      .catch(() => {
        this.setData({ loaded: true });
      });
  }
});
