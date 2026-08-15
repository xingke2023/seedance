'use strict'

const { getFidelityToken } = require('../video/service')

const FIDELITY_BASE_URL = process.env.FIDELITY_BASE_URL || 'https://videogen.fidelityai.cn'

async function authFetch(path, options = {}) {
  const token = await getFidelityToken()
  if (!token) throw new Error('未配置 FidelityAI 登录凭据')
  const res = await fetch(`${FIDELITY_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { message: text } }
  if (!res.ok) {
    const msg = json.detail || json.error?.message || json.message || `API error ${res.status}`
    throw new Error(msg)
  }
  return json
}

async function manageRoutes(fastify) {

  // ═══ Task List ═══

  fastify.get('/tasks', async (request, reply) => {
    try {
      const { page = 1, page_size = 20, status } = request.query || {}
      let url = `/api/v3/contents/generations/tasks?page=${page}&page_size=${page_size}`
      if (status) url += `&status=${status}`
      const result = await authFetch(url)
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ═══ Token Management ═══

  fastify.get('/tokens', async (request, reply) => {
    try {
      const result = await authFetch('/api/tokens')
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.post('/tokens', {
    schema: { body: { type: 'object', properties: { label: { type: 'string' } } } },
  }, async (request, reply) => {
    try {
      const { label = '' } = request.body || {}
      const result = await authFetch('/api/tokens', {
        method: 'POST',
        body: JSON.stringify({ label }),
      })
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.delete('/tokens/:tokenId', async (request, reply) => {
    try {
      const { tokenId } = request.params
      const result = await authFetch(`/api/tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' })
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // Toggle token active status
  fastify.patch('/tokens/:tokenId', async (request, reply) => {
    try {
      const { tokenId } = request.params
      const { is_active } = request.body || {}
      const result = await authFetch(`/api/tokens/${encodeURIComponent(tokenId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active }),
      })
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ═══ Billing ═══

  fastify.get('/billing/summary', async (request, reply) => {
    try {
      const result = await authFetch('/api/billing/summary')
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ═══ Resource Keys (AKSK for asset API) ═══

  fastify.get('/keys', async (request, reply) => {
    try {
      const result = await authFetch('/api/keys')
      return { success: true, data: result }
    } catch (err) {
      // If endpoint not found, return stored keys from env
      if (err.message.includes('Not Found')) {
        const keys = []
        if (process.env.VOLC_ACCESS_KEY) {
          keys.push({
            id: 'env-default',
            label: '默认 AKSK (环境变量)',
            access_key: process.env.VOLC_ACCESS_KEY,
            secret_key_masked: process.env.VOLC_SECRET_KEY ? '***' + process.env.VOLC_SECRET_KEY.slice(-6) : '',
            source: 'env',
            created_at: null,
          })
        }
        return { success: true, data: keys }
      }
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.post('/keys', {
    schema: { body: { type: 'object', properties: { label: { type: 'string' }, access_key: { type: 'string' }, secret_key: { type: 'string' } } } },
  }, async (request, reply) => {
    try {
      const result = await authFetch('/api/keys', {
        method: 'POST',
        body: JSON.stringify(request.body || {}),
      })
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.delete('/keys/:keyId', async (request, reply) => {
    try {
      const { keyId } = request.params
      const result = await authFetch(`/api/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' })
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })
}

module.exports = manageRoutes
