'use strict'

const { query } = require('../db')

const SSO_BASE_URL = (process.env.SSO_BASE_URL || 'https://mo.xingke888.com').replace(/\/$/, '')

async function authRoutes(fastify) {
  fastify.get('/me', async (request, reply) => {
    const user = request.user
    if (!user) {
      return reply.code(401).send({ success: false, error: '未登录' })
    }
    return {
      success: true,
      data: {
        id: user.id,
        sso_user_id: user.sso_user_id,
        username: user.username,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        quota: user.quota,
        used: user.used,
      },
    }
  })

  fastify.post('/logout', async (request, reply) => {
    const { refreshToken } = request.body || {}
    if (refreshToken) {
      try {
        await fetch(`${SSO_BASE_URL}/api/token/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        })
      } catch {}
    }
    return { success: true }
  })

  fastify.post('/login', async (request, reply) => {
    const { identifier, password } = request.body || {}
    if (!identifier || !password) {
      return reply.code(400).send({ success: false, error: '请输入用户名和密码' })
    }
    try {
      const res = await fetch(`${SSO_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      })
      const json = await res.json()
      if (!res.ok || json.success === false) {
        return reply.code(res.status).send({ success: false, error: json.message || json.error || '登录失败' })
      }
      const tokenData = json.data || json
      return { success: true, data: tokenData }
    } catch (err) {
      return reply.code(500).send({ success: false, error: '登录服务异常' })
    }
  })

  fastify.post('/refresh', async (request, reply) => {
    const { refreshToken } = request.body || {}
    if (!refreshToken) {
      return reply.code(400).send({ success: false, error: '缺少refreshToken' })
    }
    try {
      const res = await fetch(`${SSO_BASE_URL}/api/token/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
      const json = await res.json()
      if (!res.ok || json.success === false) {
        return reply.code(res.status).send({ success: false, error: json.message || json.error || '刷新失败' })
      }
      const tokenData = json.data || json
      return { success: true, data: tokenData }
    } catch (err) {
      return reply.code(500).send({ success: false, error: '刷新服务异常' })
    }
  })

  fastify.get('/wechat', async (request, reply) => {
    const redirectUri = request.query.redirect_uri || ''
    const url = `${SSO_BASE_URL}/api/oauth/wechat?redirect_uri=${encodeURIComponent(redirectUri)}`
    return reply.redirect(url)
  })

  fastify.post('/register', async (request, reply) => {
    const { username, password, email } = request.body || {}
    if (!username || !password) {
      return reply.code(400).send({ success: false, error: '请输入用户名和密码' })
    }
    try {
      const res = await fetch(`${SSO_BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, email }),
      })
      const json = await res.json()
      if (!res.ok || json.success === false) {
        return reply.code(res.status).send({ success: false, error: json.message || json.error || '注册失败' })
      }
      const tokenData = json.data || json
      return { success: true, data: tokenData }
    } catch (err) {
      return reply.code(500).send({ success: false, error: '注册服务异常' })
    }
  })
}

module.exports = authRoutes
