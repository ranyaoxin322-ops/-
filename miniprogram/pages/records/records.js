const api = require('../../utils/api');

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
    loaded: false
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    return api
      .getRecords()
      .then((res) => {
        const list = (res.records || []).slice().sort((a, b) => Number(b.seq) - Number(a.seq));

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
            seq: r.seq,
            drug_name: r.drug_name || '--',
            dose: r.dose || '',
            plan_time: r.plan_time || '--:--',
            actual_time: r.actual_time || '--:--',
            statusText: st.text,
            statusClass: st.cls
          });
        });

        this.setData({
          loaded: true,
          total: list.length,
          groups: order.map((d) => ({ date: d, items: map[d] }))
        });
      })
      .catch(() => {
        this.setData({ loaded: true });
      });
  }
});
