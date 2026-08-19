'use strict'

const { getFidelityToken } = require('../video/service')
const { query } = require('../db')

const FIDELITY_BASE_URL = process.env.FIDELITY_BASE_URL || 'https://videogen.fidelityai.cn'
const FIDELITY_CN_BASE_URL = process.env.FIDELITY_CN_BASE_URL || 'https://vidgen.fidelityai.cn'
const FIDELITY_CN_ASSETS_URL = process.env.FIDELITY_CN_ASSETS_URL || 'https://assets-cn.fidelityai.cn'
const FIDELITY_CN_API_SK = process.env.FIDELITY_CN_API_SK

async function rawFetch(path, options = {}) {
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
  const json = await res.json().catch(() => ({ message: res.statusText }))
  if (!res.ok) {
    const msg = json.ResponseMetadata?.Error?.Message || json.error?.message || json.message || `API error ${res.status}`
    throw new Error(msg)
  }
  return json
}

async function rawFetchCN(path, options = {}) {
  if (!FIDELITY_CN_API_SK) throw new Error('未配置国内站 FIDELITY_CN_API_SK')
  const res = await fetch(`${FIDELITY_CN_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FIDELITY_CN_API_SK}`,
      ...(options.headers || {}),
    },
  })
  const json = await res.json().catch(() => ({ message: res.statusText }))
  if (!res.ok) {
    const msg = json.ResponseMetadata?.Error?.Message || json.error?.message || json.message || `API error ${res.status}`
    throw new Error(msg)
  }
  return json
}

async function assetFetch(action, body = {}) {
  const json = await rawFetch(`/api/v1/assets/Action=${action}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return json.Result !== undefined ? json.Result : json
}

async function assetFetchCN(action, body = {}) {
  if (!FIDELITY_CN_API_SK) throw new Error('未配置国内站 FIDELITY_CN_API_SK')
  const url = `${FIDELITY_CN_ASSETS_URL}/?Action=${action}&Version=2024-01-01`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FIDELITY_CN_API_SK}`,
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({ message: res.statusText }))
  if (!res.ok) {
    const msg = json.ResponseMetadata?.Error?.Message || json.error?.message || json.message || `API error ${res.status}`
    throw new Error(msg)
  }
  return json.Result !== undefined ? json.Result : json
}

function getAssetFetcher(region) {
  return region === 'cn' ? assetFetchCN : assetFetch
}

async function getUserGroupIds(userId, groupType) {
  const params = [userId]
  let sql = `SELECT group_id FROM user_asset_groups WHERE (user_id = $1 OR shared = TRUE)`
  if (groupType) {
    sql += ` AND group_type = $2`
    params.push(groupType)
  }
  const { rows } = await query(sql, params)
  return rows.map(r => r.group_id)
}

async function assetRoutes(fastify) {

  // ═══ Asset Groups ═══

  // List groups (from local DB, syncs from remote CN API if region=cn)
  fastify.get('/groups', async (request, reply) => {
    try {
      const { groupType, region } = request.query || {}

      // Sync CN groups from remote API to local DB
      if (region === 'cn' && request.user) {
        try {
          const filter = groupType ? { GroupType: groupType } : {}
          const remote = await assetFetchCN('ListAssetGroups', { PageNumber: 1, PageSize: 100, Filter: filter })
          const remoteItems = remote.Items || []
          for (const item of remoteItems) {
            await query(
              `INSERT INTO user_asset_groups (user_id, group_id, group_type, name, region)
               VALUES ($1, $2, $3, $4, 'cn') ON CONFLICT DO NOTHING`,
              [request.user.id, item.Id, item.GroupType || 'AIGC', item.Name || null]
            )
          }
        } catch (syncErr) {
          // Don't fail the whole request if sync fails
        }
      }

      const params = []
      let sql = `SELECT group_id, group_type, name, region, created_at FROM user_asset_groups WHERE 1=1`

      if (request.user) {
        sql += ` AND (user_id = $${params.length + 1} OR shared = TRUE)`
        params.push(request.user.id)
      }
      if (groupType) {
        sql += ` AND group_type = $${params.length + 1}`
        params.push(groupType)
      }
      if (region) {
        sql += ` AND (region = $${params.length + 1} OR region IS NULL)`
        params.push(region)
      }
      sql += ` ORDER BY created_at DESC`

      const { rows } = await query(sql, params)
      const items = rows.map(r => ({
        Id: r.group_id,
        Name: r.name,
        GroupType: r.group_type,
        Region: r.region || 'global',
        CreateTime: Math.floor(new Date(r.created_at).getTime() / 1000),
      }))

      return { success: true, data: { Items: items, TotalCount: items.length } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // Create group (虚拟人像: AIGC, 真人: LivenessFace via visual-validate)
  fastify.post('/groups', {
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          groupType: { type: 'string', enum: ['AIGC', 'LivenessFace'] },
          description: { type: 'string' },
          region: { type: 'string', enum: ['global', 'cn'] },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { name, groupType = 'AIGC', description, region = 'global' } = request.body || {}
      const fetcher = getAssetFetcher(region)
      const body = { GroupType: groupType }
      if (name) body.Name = name
      if (description) body.Description = description
      const result = await fetcher('CreateAssetGroup', body)

      if (request.user && result.Id) {
        await query(
          `INSERT INTO user_asset_groups (user_id, group_id, group_type, name, region) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [request.user.id, result.Id, groupType, name || null, region]
        )
      }

      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // Rename group
  fastify.patch('/groups/:groupId', async (request, reply) => {
    try {
      const { groupId } = request.params
      const { name, region = 'global' } = request.body || {}
      const fetcher = getAssetFetcher(region)
      const result = await fetcher('UpdateAssetGroup', { Id: groupId, Name: name })
      if (request.user) {
        await query(`UPDATE user_asset_groups SET name=$1 WHERE group_id=$2 AND user_id=$3`, [name, groupId, request.user.id])
      }
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // Delete group (remote + local)
  fastify.delete('/groups/:groupId', async (request, reply) => {
    try {
      const { groupId } = request.params
      const { region } = request.query || {}
      const fetcher = getAssetFetcher(region)
      try {
        await fetcher('DeleteAssetGroup', { Id: groupId })
      } catch (e) {
        if (!e.message.includes('not found')) throw e
      }
      await query(`DELETE FROM user_asset_groups WHERE group_id=$1`, [groupId])
      return { success: true, data: {} }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ═══ Assets within Groups ═══

  // List assets (optionally filter by groupId or groupType)
  fastify.get('/groups/:groupId/assets', async (request, reply) => {
    try {
      const { groupId } = request.params
      const { region } = request.query || {}
      const fetcher = getAssetFetcher(region)
      const body = { PageNumber: 1, PageSize: 100, Filter: { GroupIds: [groupId] } }
      const result = await fetcher('ListAssets', body)
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // List all assets (for picker) - filtered by user's groups + shared
  fastify.get('/all', async (request, reply) => {
    try {
      const { groupType, region } = request.query || {}
      const fetcher = getAssetFetcher(region)
      const body = { PageNumber: 1, PageSize: 200 }
      if (groupType) body.Filter = { GroupType: groupType }

      if (request.user) {
        const allowedIds = await getUserGroupIds(request.user.id, groupType)
        if (allowedIds.length > 0) {
          body.Filter = { ...(body.Filter || {}), GroupIds: allowedIds }
        } else {
          return { success: true, data: { TotalCount: 0, Items: [] } }
        }
      }

      const result = await fetcher('ListAssets', body)
      const items = result.Items || []

      const enriched = await Promise.all(
        items.map(async (item) => {
          try {
            const detail = await fetcher('GetAsset', { Id: item.Id })
            return { ...item, URL: detail.URL || null, Status: detail.Status || null }
          } catch {
            return item
          }
        })
      )

      return { success: true, data: { ...result, Items: enriched } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // Create asset in group
  fastify.post('/groups/:groupId/assets', {
    schema: {
      body: {
        type: 'object',
        required: ['fileUrl'],
        properties: {
          fileUrl: { type: 'string' },
          assetType: { type: 'string', enum: ['Image', 'Video', 'Audio'] },
          name: { type: 'string' },
          region: { type: 'string', enum: ['global', 'cn'] },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { groupId } = request.params
      const { fileUrl, assetType = 'Image', name, region = 'global' } = request.body
      const fetcher = getAssetFetcher(region)
      const body = { GroupId: groupId, AssetType: assetType, URL: fileUrl }
      if (name) body.Name = name
      const result = await fetcher('CreateAsset', body)
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // Get single asset
  fastify.get('/item/:assetId', async (request, reply) => {
    try {
      const { assetId } = request.params
      const { region } = request.query || {}
      const fetcher = getAssetFetcher(region)
      const result = await fetcher('GetAsset', { Id: assetId })
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // Rename asset
  fastify.patch('/item/:assetId', async (request, reply) => {
    try {
      const { assetId } = request.params
      const { name, region = 'global' } = request.body || {}
      const fetcher = getAssetFetcher(region)
      const result = await fetcher('UpdateAsset', { Id: assetId, Name: name })
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // Delete asset
  fastify.delete('/item/:assetId', async (request, reply) => {
    try {
      const { assetId } = request.params
      const { region } = request.query || {}
      const fetcher = getAssetFetcher(region)
      const result = await fetcher('DeleteAsset', { Id: assetId })
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ═══ Admin: Mark group as shared (备用人像库) ═══
  fastify.post('/groups/:groupId/share', async (request, reply) => {
    try {
      const { groupId } = request.params
      const { shared = true, groupType = 'AIGC', name } = request.body || {}
      if (shared) {
        await query(
          `INSERT INTO user_asset_groups (user_id, group_id, group_type, name, shared)
           VALUES (NULL, $1, $2, $3, TRUE)
           ON CONFLICT (group_id) WHERE shared = TRUE DO UPDATE SET name = $3`,
          [groupId, groupType, name || null]
        )
      } else {
        await query(`DELETE FROM user_asset_groups WHERE group_id = $1 AND shared = TRUE`, [groupId])
      }
      return { success: true }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ═══ Visual Validate (真人验证 H5 流程) ═══

  fastify.post('/visual-validate/start', {
    schema: { body: { type: 'object', properties: {} } },
  }, async (request, reply) => {
    try {
      const result = await rawFetch('/api/v1/assets/visual-validate/sessions', {
        method: 'POST',
        body: '{}',
      })
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/visual-validate/:sessionId', async (request, reply) => {
    try {
      const { sessionId } = request.params
      const result = await rawFetch(`/api/v1/assets/visual-validate/sessions/${encodeURIComponent(sessionId)}`)

      if (request.user && result.group_id) {
        await query(
          `INSERT INTO user_asset_groups (user_id, group_id, group_type, name) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [request.user.id, result.group_id, 'LivenessFace', null]
        )
      }

      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/visual-validate/:sessionId/qr', async (request, reply) => {
    try {
      const { sessionId } = request.params
      const token = await getFidelityToken()
      const res = await fetch(
        `${FIDELITY_BASE_URL}/api/v1/assets/visual-validate/sessions/${encodeURIComponent(sessionId)}/qr.svg`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`)
      const svg = await res.text()
      reply.type('image/svg+xml').send(svg)
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ═══ Visual Validate CN (国内站真人验证) ═══

  fastify.post('/visual-validate-cn/start', {
    schema: { body: { type: 'object', properties: {} } },
  }, async (request, reply) => {
    try {
      const result = await rawFetchCN('/api/v1/assets/visual-validate/sessions', {
        method: 'POST',
        body: '{}',
      })
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/visual-validate-cn/:sessionId', async (request, reply) => {
    try {
      const { sessionId } = request.params
      const result = await rawFetchCN(`/api/v1/assets/visual-validate/sessions/${encodeURIComponent(sessionId)}`)

      if (request.user && result.group_id) {
        await query(
          `INSERT INTO user_asset_groups (user_id, group_id, group_type, name, region) VALUES ($1, $2, $3, $4, 'cn') ON CONFLICT DO NOTHING`,
          [request.user.id, result.group_id, 'LivenessFace', null]
        )
      }

      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/visual-validate-cn/:sessionId/qr', async (request, reply) => {
    try {
      const { sessionId } = request.params
      const res = await fetch(
        `${FIDELITY_CN_BASE_URL}/api/v1/assets/visual-validate/sessions/${encodeURIComponent(sessionId)}/qr.svg`,
        { headers: { Authorization: `Bearer ${FIDELITY_CN_API_SK}` } }
      )
      if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`)
      const svg = await res.text()
      reply.type('image/svg+xml').send(svg)
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ═══ File Upload ═══

  fastify.post('/upload', async (request, reply) => {
    try {
      const token = await getFidelityToken()
      const data = await request.file()
      if (!data) return reply.code(400).send({ success: false, error: '未提供文件' })

      const formData = new FormData()
      const chunks = []
      for await (const chunk of data.file) chunks.push(chunk)
      const buffer = Buffer.concat(chunks)
      const blob = new Blob([buffer], { type: data.mimetype })
      formData.append('file', blob, data.filename)

      const res = await fetch(`${FIDELITY_BASE_URL}/api/v1/assets/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error?.message || json.message || `Upload failed ${res.status}`)
      return { success: true, data: json }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.post('/upload-cn', async (request, reply) => {
    try {
      if (!FIDELITY_CN_API_SK) throw new Error('未配置国内站 FIDELITY_CN_API_SK')
      const data = await request.file()
      if (!data) return reply.code(400).send({ success: false, error: '未提供文件' })

      const formData = new FormData()
      const chunks = []
      for await (const chunk of data.file) chunks.push(chunk)
      const buffer = Buffer.concat(chunks)
      const blob = new Blob([buffer], { type: data.mimetype })
      formData.append('file', blob, data.filename)

      const res = await fetch(`${FIDELITY_CN_BASE_URL}/api/v1/assets/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${FIDELITY_CN_API_SK}` },
        body: formData,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error?.message || json.message || `Upload failed ${res.status}`)
      return { success: true, data: json }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })
}

module.exports = assetRoutes
