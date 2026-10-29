// pages/agreement/agreement.js
const agreement = require('../../utils/agreement.js')

Page({
  data: {
    title: '',
    updated: '',
    blocks: []
  },

  onLoad(options) {
    const doc = agreement.get(options.type)
    wx.setNavigationBarTitle({ title: doc.title })
    this.setData({ title: doc.title, updated: doc.updated, blocks: doc.blocks })
  }
})
