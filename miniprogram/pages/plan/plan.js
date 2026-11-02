const api = require('../../utils/api');

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
    if (!this.data.loaded) this.loadPlan();
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
          times: p && p.times && p.times.length ? p.times : ['08:00']
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
    times.sort();
    this.setData({ times, dirty: true });
  },

  addTime() {
    const last = this.data.times[this.data.times.length - 1] || '08:00';
    const times = this.data.times.concat(last);
    this.setData({ times, dirty: true });
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
