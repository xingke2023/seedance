'use strict'

const Stripe = require('stripe')

let client = null

/** 惰性构造 —— 没配密钥时不该在启动阶段炸掉整个后端 */
function stripe() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    const err = new Error('未配置 STRIPE_SECRET_KEY')
    err.statusCode = 503
    throw err
  }
  if (!client) client = new Stripe(key)
  return client
}

function stripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY)
}

const CURRENCY = (process.env.STRIPE_CURRENCY || 'cny').toLowerCase()

/**
 * 订阅套餐。amount 是最小货币单位（人民币的「分」），credits 是每个账期到账的次数。
 * price_id 走 env —— 调档位只改 env / 重跑 scripts/stripe-setup-plans.js，不动代码。
 */
const PLANS = [
  { key: 'basic', name: '基础版', amount: 19900, credits: 100, priceEnv: 'STRIPE_PRICE_BASIC',
    features: ['每月 100 次生成额度', '全部分镜与配音功能'] },
  { key: 'pro',   name: '专业版', amount: 49900, credits: 300, priceEnv: 'STRIPE_PRICE_PRO',
    features: ['每月 300 次生成额度', '全部分镜与配音功能', '优先任务队列'] },
  { key: 'ultra', name: '旗舰版', amount: 99900, credits: 800, priceEnv: 'STRIPE_PRICE_ULTRA',
    features: ['每月 800 次生成额度', '全部分镜与配音功能', '优先任务队列', '专属技术支持'] },
]

/**
 * 一次性次数包。支付宝和微信在 Stripe 里是一次性支付方式，用不了 `mode: 'subscription'`
 * （实测报 "The payment method `alipay` cannot be used in `subscription` mode."），
 * 所以要让这两种支付方式可用，只能另开一条买断的路。
 * 定价比同额度订阅高一档 —— 否则没人会选自动续费。
 */
const PACKS = [
  { key: 'pack100', name: '100 次', amount: 24900, credits: 100, priceEnv: 'STRIPE_PRICE_PACK100' },
  { key: 'pack300', name: '300 次', amount: 59900, credits: 300, priceEnv: 'STRIPE_PRICE_PACK300' },
  { key: 'pack800', name: '800 次', amount: 119900, credits: 800, priceEnv: 'STRIPE_PRICE_PACK800' },
]

/** 一次性订单支持的支付方式。微信还要额外给 client 参数，见 routes/billing.js */
const ONE_TIME_METHODS = ['card', 'alipay', 'wechat_pay']

function planPriceId(plan) {
  return process.env[plan.priceEnv] || ''
}

function listPlans() {
  return PLANS.map(p => ({
    key: p.key,
    name: p.name,
    amount: p.amount,
    currency: CURRENCY,
    credits: p.credits,
    features: p.features,
    price_id: planPriceId(p),
    configured: Boolean(planPriceId(p)),
  }))
}

function planByKey(key) {
  return PLANS.find(p => p.key === key) || null
}

function listPacks() {
  return PACKS.map(p => ({
    key: p.key,
    name: p.name,
    amount: p.amount,
    currency: CURRENCY,
    credits: p.credits,
    price_id: planPriceId(p),
    configured: Boolean(planPriceId(p)),
  }))
}

function packByKey(key) {
  return PACKS.find(p => p.key === key) || null
}

function packByPriceId(priceId) {
  if (!priceId) return null
  return PACKS.find(p => planPriceId(p) === priceId) || null
}

/** 续费时靠它把 Stripe 的 price 反查回次数 */
function planByPriceId(priceId) {
  if (!priceId) return null
  return PLANS.find(p => planPriceId(p) === priceId) || null
}

module.exports = {
  stripe, stripeConfigured, CURRENCY,
  listPlans, planByKey, planByPriceId, PLANS,
  listPacks, packByKey, packByPriceId, PACKS, ONE_TIME_METHODS,
}
