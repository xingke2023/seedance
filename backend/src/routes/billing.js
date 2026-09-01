'use strict'

const { query } = require('../db')
const {
  stripe, stripeConfigured, CURRENCY,
  listPlans, planByKey, planByPriceId,
  listPacks, packByKey, ONE_TIME_METHODS,
} = require('../lib/stripe')

function appBase() {
  return (process.env.APP_BASE_URL || process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '')
}

/**
 * Stripe 在 2025 年把发票上的订阅/价格挪了位置（invoice.subscription →
 * invoice.parent.subscription_details.subscription，line.price → line.pricing.price_details.price）。
 * 装的 SDK 固定在一个 API 版本上，但账号后台可以单独设版本，两种形状都可能收到，所以都认。
 */
function invoiceSubscriptionId(invoice) {
  const direct = invoice.subscription
  if (typeof direct === 'string') return direct
  if (direct && direct.id) return direct.id
  const nested = invoice.parent?.subscription_details?.subscription
  if (typeof nested === 'string') return nested
  if (nested && nested.id) return nested.id
  for (const line of invoice.lines?.data || []) {
    const s = line.subscription || line.parent?.subscription_item_details?.subscription
    if (typeof s === 'string') return s
    if (s && s.id) return s.id
  }
  return null
}

function invoicePriceId(invoice) {
  for (const line of invoice.lines?.data || []) {
    const id = line.price?.id || line.pricing?.price_details?.price
    if (id) return id
  }
  return null
}

function subscriptionPriceId(sub) {
  const item = sub.items?.data?.[0]
  return item?.price?.id || item?.plan?.id || null
}

/** 账期结束时间：新版从 subscription 移到了 subscription item 上 */
function subscriptionPeriodEnd(sub) {
  const ts = sub.current_period_end || sub.items?.data?.[0]?.current_period_end
  return ts ? new Date(ts * 1000) : null
}

function customerId(obj) {
  const c = obj.customer
  return typeof c === 'string' ? c : (c?.id || null)
}

async function userIdForCustomer(stripeCustomerId) {
  if (!stripeCustomerId) return null
  const { rows } = await query(
    'SELECT user_id FROM billing_customers WHERE stripe_customer_id = $1',
    [stripeCustomerId]
  )
  return rows[0]?.user_id || null
}

/** 拿到（或首次建立）该用户的 Stripe customer */
async function ensureCustomer(user) {
  const { rows } = await query(
    'SELECT stripe_customer_id FROM billing_customers WHERE user_id = $1',
    [user.id]
  )
  if (rows[0]) {
    // Checkout 会用 customer 上的邮箱预填收据地址。老的 customer 可能是在用户还没绑邮箱时
    // 建的，这里补一次，否则每次结账都要用户手填
    if (user.email) {
      try {
        const existing = await stripe().customers.retrieve(rows[0].stripe_customer_id)
        if (!existing.deleted && existing.email !== user.email) {
          await stripe().customers.update(rows[0].stripe_customer_id, { email: user.email })
        }
      } catch (err) {
        // 同步邮箱失败不该挡住付款
      }
    }
    return rows[0].stripe_customer_id
  }

  const customer = await stripe().customers.create({
    email: user.email || undefined,
    name: user.name || user.username || undefined,
    metadata: { user_id: String(user.id), sso_user_id: String(user.sso_user_id) },
  })
  await query(
    `INSERT INTO billing_customers (user_id, stripe_customer_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
    [user.id, customer.id]
  )
  return customer.id
}

async function upsertSubscription(userId, sub) {
  const priceId = subscriptionPriceId(sub)
  const plan = planByPriceId(priceId)
  await query(
    `INSERT INTO billing_subscriptions
       (user_id, stripe_subscription_id, stripe_customer_id, stripe_price_id, plan_key,
        status, current_period_end, cancel_at_period_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET
       stripe_price_id      = EXCLUDED.stripe_price_id,
       plan_key             = EXCLUDED.plan_key,
       status               = EXCLUDED.status,
       current_period_end   = EXCLUDED.current_period_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       updated_at           = NOW()`,
    [userId, sub.id, customerId(sub), priceId, plan?.key || null,
     sub.status, subscriptionPeriodEnd(sub), Boolean(sub.cancel_at_period_end)]
  )
}

/** 订阅相关对象上的 user_id：优先 metadata，其次靠 customer 反查 */
async function resolveUserId(obj) {
  const fromMeta = obj.metadata?.user_id || obj.client_reference_id
  if (fromMeta && /^\d+$/.test(String(fromMeta))) return parseInt(fromMeta, 10)
  return userIdForCustomer(customerId(obj))
}

/**
 * webhook 验签要拿原始报文 —— 这个 parser 只作用在调用它的插件封装作用域内，
 * 顺带照常把 JSON 解出来给同插件里的其它路由用
 */
function attachRawBodyParser(fastify) {
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body
    if (!body || body.length === 0) return done(null, {})
    try {
      done(null, JSON.parse(body.toString('utf8')))
    } catch (err) {
      err.statusCode = 400
      done(err, undefined)
    }
  })
}

async function billingRoutes(fastify) {
  attachRawBodyParser(fastify)

  function requireUser(request, reply) {
    if (!request.user) {
      reply.code(401).send({ success: false, error: '未登录' })
      return null
    }
    return request.user
  }

  // ---- 套餐列表 ----
  fastify.get('/plans', async () => ({
    success: true,
    data: {
      currency: CURRENCY,
      enabled: stripeConfigured(),
      plans: listPlans(),
      packs: listPacks(),
      // 前端据此在次数包上标出可用支付方式
      one_time_methods: ONE_TIME_METHODS,
    },
  }))

  // ---- 当前订阅 + 额度 ----
  fastify.get('/subscription', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { rows } = await query(
      `SELECT * FROM billing_subscriptions
        WHERE user_id = $1
        ORDER BY (status IN ('active','trialing')) DESC, updated_at DESC
        LIMIT 1`,
      [user.id]
    )
    const sub = rows[0] || null
    const plan = sub ? listPlans().find(p => p.key === sub.plan_key) || null : null

    const { rows: history } = await query(
      `SELECT stripe_event_id, type, credits_granted, amount, currency, created_at
         FROM billing_events
        WHERE user_id = $1 AND credits_granted > 0
        ORDER BY created_at DESC LIMIT 20`,
      [user.id]
    )

    return {
      success: true,
      data: {
        quota: user.quota,
        used: user.used,
        subscription: sub && {
          plan_key: sub.plan_key,
          plan_name: plan?.name || sub.plan_key,
          status: sub.status,
          current_period_end: sub.current_period_end,
          cancel_at_period_end: sub.cancel_at_period_end,
        },
        history,
      },
    }
  })

  // ---- 发起订阅：建 Checkout Session，前端跳过去 ----
  fastify.post('/checkout', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return
    if (!stripeConfigured()) {
      return reply.code(503).send({ success: false, error: '支付未配置，请联系管理员' })
    }

    // 一次性次数包：支付宝/微信只能走这条（Stripe 不允许它们用于 subscription 模式）
    const pack = packByKey(request.body?.pack)
    const plan = pack ? null : planByKey(request.body?.plan)
    const item = pack || plan
    if (!item) return reply.code(400).send({ success: false, error: '未知套餐' })

    const priceId = process.env[item.priceEnv]
    if (!priceId) {
      return reply.code(503).send({ success: false, error: `「${item.name}」尚未配置价格` })
    }

    const base = appBase()
    if (!base) return reply.code(503).send({ success: false, error: '未配置 APP_BASE_URL' })

    const customer = await ensureCustomer(user)
    const common = {
      customer,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: String(user.id),
      // 结账页填的姓名回写到 customer，下次就不用再填
      customer_update: { name: 'auto' },
      success_url: `${base}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/billing?checkout=cancel`,
      locale: 'zh',
    }

    const session = pack
      ? await stripe().checkout.sessions.create({
          ...common,
          mode: 'payment',
          payment_method_types: ONE_TIME_METHODS,
          payment_method_options: { wechat_pay: { client: 'web' } },
          metadata: { user_id: String(user.id), pack_key: pack.key, credits: String(pack.credits) },
          // 支付宝/微信可能异步确认，成功事件走 async_payment_succeeded
          payment_intent_data: { metadata: { user_id: String(user.id), pack_key: pack.key } },
        })
      : await stripe().checkout.sessions.create({
          ...common,
          mode: 'subscription',
          metadata: { user_id: String(user.id), plan_key: plan.key },
          // 续费产生的发票上没有 session 的 metadata，得挂到订阅上才追得回人
          subscription_data: { metadata: { user_id: String(user.id), plan_key: plan.key } },
        })

    return { success: true, data: { url: session.url, id: session.id } }
  })

  // ---- 管理订阅：Stripe 自带的客户门户（改套餐/退订/发票） ----
  fastify.post('/portal', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return
    if (!stripeConfigured()) {
      return reply.code(503).send({ success: false, error: '支付未配置，请联系管理员' })
    }

    const { rows } = await query(
      'SELECT stripe_customer_id FROM billing_customers WHERE user_id = $1',
      [user.id]
    )
    if (!rows[0]) return reply.code(400).send({ success: false, error: '还没有订阅记录' })

    const session = await stripe().billingPortal.sessions.create({
      customer: rows[0].stripe_customer_id,
      return_url: `${appBase()}/billing`,
    })
    return { success: true, data: { url: session.url } }
  })

  // ---- Stripe webhook ----
  fastify.post('/stripe/webhook', stripeWebhookHandler)
}

// 注意：这条路由不带鉴权，靠签名验证身份。Stripe 不会带 Authorization 头
async function stripeWebhookHandler(request, reply) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET
    if (!secret) return reply.code(503).send({ success: false, error: '未配置 STRIPE_WEBHOOK_SECRET' })

    let event
    try {
      event = stripe().webhooks.constructEvent(
        request.rawBody, request.headers['stripe-signature'], secret
      )
    } catch (err) {
      request.log.warn({ err: err.message }, 'stripe webhook 验签失败')
      return reply.code(400).send({ success: false, error: `签名校验失败: ${err.message}` })
    }

    // 幂等：主键抢占失败 = 这条事件处理过了。Stripe 会重投同一事件，充值不能重复入账
    const claimed = await query(
      `INSERT INTO billing_events (stripe_event_id, type) VALUES ($1, $2)
       ON CONFLICT (stripe_event_id) DO NOTHING`,
      [event.id, event.type]
    )
    if (claimed.rowCount === 0) return { received: true, duplicate: true }

    try {
      await handleEvent(request, event)
    } catch (err) {
      // 处理失败要把占位删掉，否则 Stripe 重投时会被当成重复事件直接跳过，钱收了额度没到
      await query('DELETE FROM billing_events WHERE stripe_event_id = $1', [event.id])
      request.log.error({ err, eventId: event.id, type: event.type }, 'stripe webhook 处理失败')
      return reply.code(500).send({ success: false, error: err.message })
    }

    return { received: true }
}

/**
 * 一次性次数包入账。支付宝/微信是异步确认的，钱到没到看 payment_status ——
 * `checkout.session.completed` 可能在 unpaid 状态就来了，真正到账走
 * `checkout.session.async_payment_succeeded`，两条都会调到这里
 */
async function grantPack(request, event, session) {
  if (session.payment_status !== 'paid') {
    request.log.info({ session: session.id, status: session.payment_status }, '次数包尚未付款，等异步确认')
    return
  }

  const pack = packByKey(session.metadata?.pack_key)
  const credits = parseInt(session.metadata?.credits || '', 10) || pack?.credits
  if (!credits) {
    request.log.warn({ session: session.id }, '一次性订单没带次数信息，未发放额度')
    return
  }

  const userId = await resolveUserId(session)
  if (!userId) {
    request.log.warn({ session: session.id }, '一次性订单找不到对应用户')
    return
  }

  // 按 session 去重：completed 和 async_payment_succeeded 是两条事件、事件 ID 不同
  try {
    await query(
      'UPDATE billing_events SET source_id = $1 WHERE stripe_event_id = $2',
      [session.id, event.id]
    )
  } catch (err) {
    if (err.code === '23505') {
      request.log.info({ session: session.id }, '该订单已入过账，跳过')
      return
    }
    throw err
  }

  await query('UPDATE users SET quota = quota + $1, updated_at = NOW() WHERE id = $2', [credits, userId])
  await query(
    `UPDATE billing_events SET user_id = $1, credits_granted = $2, amount = $3, currency = $4
      WHERE stripe_event_id = $5`,
    [userId, credits, session.amount_total ?? null, session.currency || CURRENCY, event.id]
  )
  request.log.info({ userId, credits, pack: session.metadata?.pack_key }, '次数包到账')
}

async function handleEvent(request, event) {
    const obj = event.data.object

    switch (event.type) {
      // 首次订阅成交：把 customer 和用户绑上，并落一条订阅记录。
      // 额度不在这里加 —— 首期发票同样会触发 invoice.paid，两边都加就是双倍
      case 'checkout.session.completed': {
        if (obj.mode === 'payment') {   // 一次性次数包
          await grantPack(request, event, obj)
          break
        }
        if (obj.mode !== 'subscription') break
        const userId = await resolveUserId(obj)
        if (!userId) {
          request.log.warn({ session: obj.id }, 'checkout 完成但找不到对应用户')
          break
        }
        const cid = customerId(obj)
        if (cid) {
          await query(
            `INSERT INTO billing_customers (user_id, stripe_customer_id) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
            [userId, cid]
          )
        }
        const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id
        if (subId) {
          const sub = await stripe().subscriptions.retrieve(subId)
          await upsertSubscription(userId, sub)
        }
        await query('UPDATE billing_events SET user_id = $1 WHERE stripe_event_id = $2', [userId, event.id])
        break
      }

      // 每个账期付款成功都会来一次（含首期）—— 额度在这里发放
      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        const subId = invoiceSubscriptionId(obj)
        if (!subId) break   // 一次性发票，与订阅无关

        const sub = await stripe().subscriptions.retrieve(subId)
        let userId = await resolveUserId(sub)
        if (!userId) userId = await userIdForCustomer(customerId(obj))
        if (!userId) {
          const { rows } = await query(
            'SELECT user_id FROM billing_subscriptions WHERE stripe_subscription_id = $1', [subId]
          )
          userId = rows[0]?.user_id || null
        }
        if (!userId) {
          request.log.warn({ invoice: obj.id, subId }, '发票已付但找不到对应用户')
          break
        }

        await upsertSubscription(userId, sub)

        // 按发票占位：invoice.paid 与 invoice.payment_succeeded 会为同一张发票各来一次，
        // 事件 ID 不同、去重锁拦不住，靠 invoice_id 的唯一索引兜住
        try {
          await query(
            'UPDATE billing_events SET source_id = $1 WHERE stripe_event_id = $2',
            [obj.id, event.id]
          )
        } catch (err) {
          if (err.code === '23505') {
            request.log.info({ invoice: obj.id }, '该发票已入过账，跳过')
            break
          }
          throw err
        }

        const plan = planByPriceId(subscriptionPriceId(sub) || invoicePriceId(obj))
        if (!plan) {
          request.log.warn({ invoice: obj.id, price: subscriptionPriceId(sub) }, '发票对应不到套餐，未发放额度')
          break
        }

        await query(
          'UPDATE users SET quota = quota + $1, updated_at = NOW() WHERE id = $2',
          [plan.credits, userId]
        )
        await query(
          `UPDATE billing_events
              SET user_id = $1, credits_granted = $2, amount = $3, currency = $4
            WHERE stripe_event_id = $5`,
          [userId, plan.credits, obj.amount_paid ?? obj.total ?? null, obj.currency || CURRENCY, event.id]
        )
        request.log.info({ userId, credits: plan.credits, plan: plan.key }, 'stripe 订阅到账')
        break
      }

      // 支付宝/微信延迟确认后才真正到账
      case 'checkout.session.async_payment_succeeded': {
        await grantPack(request, event, obj)
        break
      }

      case 'checkout.session.async_payment_failed': {
        request.log.warn({ session: obj.id }, '一次性订单支付失败')
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const userId = await resolveUserId(obj)
        if (!userId) break
        await upsertSubscription(userId, obj)
        await query('UPDATE billing_events SET user_id = $1 WHERE stripe_event_id = $2', [userId, event.id])
        break
      }

      case 'invoice.payment_failed': {
        const subId = invoiceSubscriptionId(obj)
        if (!subId) break
        await query(
          `UPDATE billing_subscriptions SET status = 'past_due', updated_at = NOW()
            WHERE stripe_subscription_id = $1`,
          [subId]
        )
        break
      }

      default:
        break
    }
}

/**
 * Stripe 后台里配的回调地址是 https://v.xingke888.com/webhooks/buy，
 * 和本项目的 /billing/stripe/webhook 指向同一个处理逻辑 —— 两条路径都收。
 */
async function webhookAliasRoutes(fastify) {
  attachRawBodyParser(fastify)
  fastify.post('/webhooks/buy', stripeWebhookHandler)
}

module.exports = billingRoutes
module.exports.billingRoutes = billingRoutes
module.exports.webhookAliasRoutes = webhookAliasRoutes
