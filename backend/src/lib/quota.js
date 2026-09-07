'use strict'

// 生成次数额度的总开关。**目前默认不限制** —— `/video/generate` 不再因为
// `used >= quota` 拦下请求，页面上的「剩余次数」显示成「不限制」。
//
// `used` 仍然照常累加（`UPDATE users SET used = used + 1`），充值入账也照常写 `quota`，
// 所以这只是把「拦」这一步关掉，不是把计数停掉 —— 哪天要重新收紧，
// backend/.env 里 `QUOTA_ENFORCED=true` 一开就立刻按历史用量生效，不用补数据。
const QUOTA_ENFORCED = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.QUOTA_ENFORCED || '').trim().toLowerCase()
)

module.exports = { QUOTA_ENFORCED }
