const api = require('../../utils/api');

/** 去重 + 升序。重复时间点会让首页分母虚高（显示 4 次其实只能吃 3 次） */
function normalizeTimes(list) {
  const seen = {};
  const out = [];
  (list || []).forEach((t) => {
    const s = String(t || '').trim();
    if (!s || seen[s]) return;
    seen[s] = true;
    out.push(s);
  });
  return out.sort();
}

/** 常用的几个时间都被占了，就在最后一个时间上往后推 1 小时，最多绕一圈 */
function nextHourOf(last, used) {
  const pad = (n) => String(n).padStart(2, '0');
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(last || '08:00'));
  let h = m ? Number(m[1]) : 8;
  const mi = m ? Number(m[2]) : 0;
  let pick = '';
  for (let i = 0; i < 24; i++) {
    h = (h + 1) % 24;
    pick = pad(h) + ':' + pad(mi);
    if (used.indexOf(pick) < 0) break;
  }
  return pick;
}

Page({
  data: {
    drug_name: '',
    dose: '',
    times: ['08:00'],
    saving: false,
    loaded: false,
    dirty: false
  },

  onShow() {
    // 没改过就重新拉一次：在别的地方（或重启后端后）改了计划，切回来能看到最新值。
    // 改过但没保存时不动，否则会把用户正在编辑的内容冲掉。
    if (!this.data.loaded || !this.data.dirty) this.loadPlan();
  },

  loadPlan() {
    api
      .getPlan()
      .then((res) => {
        const p = res.plan;
        this.setData({
          loaded: true,
          drug_name: (p && p.drug_name) || '',
          dose: (p && p.dose) || '',
          times: p && p.times && p.times.length ? normalizeTimes(p.times) : ['08:00']
        });
      })
      .catch(() => {
        this.setData({ loaded: true });
      });
  },

  onDrugInput(e) {
    this.setData({ drug_name: e.detail.value, dirty: true });
  },

  onDoseInput(e) {
    this.setData({ dose: e.detail.value, dirty: true });
  },

  onTimeChange(e) {
    const index = e.currentTarget.dataset.index;
    const times = this.data.times.slice();
    times[index] = e.detail.value;
    this.setData({ times: normalizeTimes(times), dirty: true });
  },

  addTime() {
    const used = this.data.times.slice();
    // 优先补一个常用时段，避免「添加」出来的时间和已有的重复（重复会被去重掉，看起来像没反应）
    const pick = ['08:00', '12:00', '18:00', '20:00', '22:00'].find((t) => used.indexOf(t) < 0) ||
      nextHourOf(used[used.length - 1], used);
    this.setData({ times: normalizeTimes(used.concat(pick)), dirty: true });
  },

  removeTime(e) {
    const index = e.currentTarget.dataset.index;
    const times = this.data.times.slice();
    times.splice(index, 1);
    this.setData({ times: times.length ? times : ['08:00'], dirty: true });
  },

  save() {
    const drug_name = String(this.data.drug_name || '').trim();
    const dose = String(this.data.dose || '').trim();
    const times = this.data.times.filter(Boolean);

    if (!drug_name) {
      wx.showToast({ title: '请填写药品名称', icon: 'none' });
      return;
    }
    if (!dose) {
      wx.showToast({ title: '请填写每次用量', icon: 'none' });
      return;
    }
    if (!times.length) {
      wx.showToast({ title: '至少设置一个服药时间', icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    api
      .savePlan({ drug_name, dose, times })
      .then((res) => {
        this.setData({ saving: false, dirty: false });
        if (res && res.warning) {
          wx.showModal({
            title: '已下发，等设备回执',
            content: res.warning,
            showCancel: false
          });
        } else {
          wx.showToast({ title: '已下发到药盒', icon: 'success' });
        }
      })
      .catch((err) => {
        this.setData({ saving: false });
        wx.showModal({
          title: '下发失败',
          content: (err && err.message) || '未知错误',
          showCancel: false
        });
      });
  }
});
