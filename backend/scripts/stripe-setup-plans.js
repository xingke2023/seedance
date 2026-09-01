#!/usr/bin/env node
'use strict'

/**
 * 在 Stripe 里建好三档订阅商品与价格，然后把 Price ID 打印成 .env 片段。
 * 只需要跑一次；已经建过的（按 metadata.plan_key 查）会直接复用，不会重复建。
 *
 *   node scripts/stripe-setup-plans.js            # 演练，只打印将要创建什么
 *   node scripts/stripe-setup-plans.js --apply    # 真的写进 Stripe
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const { stripe, PLANS, PACKS, CURRENCY } = require('../src/lib/stripe')

const apply = process.argv.includes('--apply')

/** 同一档在不同货币下是不同的 price —— 换币种要按货币找，不能只按 plan_key */
async function findExistingPrice(planKey) {
  const prices = await stripe().prices.search({
    query: `metadata['plan_key']:'${planKey}' AND active:'true'`,
    limit: 20,
  })
  return prices.data.find(p => p.currency === CURRENCY) || null
}

/** 商品可以跨货币复用，只换价格 */
async function findExistingProduct(planKey) {
  const products = await stripe().products.search({
    query: `metadata['plan_key']:'${planKey}' AND active:'true'`,
    limit: 1,
  })
  return products.data[0] || null
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY || ''
  if (!key) {
    console.error('缺少 STRIPE_SECRET_KEY')
    process.exit(1)
  }
  const live = key.startsWith('sk_live_')
  console.log(`模式：${live ? '⚠️  生产 (sk_live)' : '测试 (sk_test)'}  货币：${CURRENCY.toUpperCase()}`)
  if (live && !apply) console.log('（生产密钥下更要先看清楚演练结果）')
  console.log('')

  const out = []

  // recurring 为 null 就是买断价，Stripe 用同一个 prices 接口
  async function ensure(item, { recurring, label }) {
    const money = (item.amount / 100).toFixed(2)
    // 演练不碰网络：只有 --apply 才去 Stripe 查/建
    const existing = apply ? await findExistingPrice(item.key) : null
    if (existing) {
      console.log(`✓ ${item.name}  已存在  ${existing.id}`)
      out.push(`${item.priceEnv}=${existing.id}`)
      return
    }
    if (!apply) {
      console.log(`· ${item.name}  将创建：${CURRENCY.toUpperCase()} ${money}${label}，${item.credits} 次`)
      out.push(`${item.priceEnv}=<--apply 后生成>`)
      return
    }

    const product = await findExistingProduct(item.key) || await stripe().products.create({
      name: `MACRODATA ${item.name}`,
      description: (item.features || [`${item.credits} 次生成额度`]).join('、'),
      metadata: { plan_key: item.key, credits: String(item.credits) },
    })
    const price = await stripe().prices.create({
      product: product.id,
      currency: CURRENCY,
      unit_amount: item.amount,
      ...(recurring ? { recurring } : {}),
      metadata: { plan_key: item.key, credits: String(item.credits) },
    })
    console.log(`✓ ${item.name}  已创建  ${price.id}`)
    out.push(`${item.priceEnv}=${price.id}`)
  }

  console.log('【按月订阅】')
  for (const plan of PLANS) await ensure(plan, { recurring: { interval: 'month' }, label: '/月' })

  console.log('\n【一次性次数包】')
  for (const pack of PACKS) await ensure(pack, { recurring: null, label: ' 买断' })

  console.log('\n把下面几行写进 backend/.env：\n')
  console.log(out.join('\n'))
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
