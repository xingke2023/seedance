'use strict'

const { query } = require('../db')
const guide = require('../prompt/guide')

// Preset/fragment tables are read-mostly reference data shared by all users.
// Ranking is use_count desc so the presets people actually pick float up.
const PRESET_TABLES = {
  'shot-presets':  'lib_shot_presets',
  'style-presets': 'lib_style_presets',
  templates:       'lib_prompt_templates',
  fragments:       'lib_fragments',
}

function clampPage(query_) {
  const page = Math.max(1, parseInt(query_.page || '1', 10) || 1)
  const size = Math.min(100, Math.max(1, parseInt(query_.page_size || '20', 10) || 20))
  return { page, size, offset: (page - 1) * size }
}

async function libraryRoutes(fastify) {

  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ success: false, error: '未登录' })
  })

  // ═══ 提示词指南 ═══

  fastify.get('/guide', async () => ({ success: true, data: guide }))

  // ═══ 素材库 ═══

  fastify.get('/shot-presets', async (request, reply) => {
    try {
      const { category } = request.query || {}
      const params = []
      let sql = `SELECT * FROM lib_shot_presets WHERE 1=1`
      if (category) { params.push(category); sql += ` AND category = $${params.length}` }
      sql += ` ORDER BY use_count DESC, id ASC`
      const { rows } = await query(sql, params)
      return { success: true, data: { Items: rows } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/style-presets', async (request, reply) => {
    try {
      const { category } = request.query || {}
      const params = []
      let sql = `SELECT * FROM lib_style_presets WHERE 1=1`
      if (category) { params.push(category); sql += ` AND category = $${params.length}` }
      sql += ` ORDER BY use_count DESC, id ASC`
      const { rows } = await query(sql, params)
      return { success: true, data: { Items: rows } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/templates', async (request, reply) => {
    try {
      const { category } = request.query || {}
      const params = []
      let sql = `SELECT * FROM lib_prompt_templates WHERE 1=1`
      if (category) { params.push(category); sql += ` AND category = $${params.length}` }
      sql += ` ORDER BY use_count DESC, id ASC`
      const { rows } = await query(sql, params)
      return { success: true, data: { Items: rows } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/fragments', async (request, reply) => {
    try {
      const { type } = request.query || {}
      const params = []
      let sql = `SELECT * FROM lib_fragments WHERE 1=1`
      if (type) { params.push(type); sql += ` AND type = $${params.length}` }
      sql += ` ORDER BY type ASC, use_count DESC, id ASC`
      const { rows } = await query(sql, params)
      return { success: true, data: { Items: rows } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // Bump use_count so the ranking above reflects real usage.
  fastify.post('/use/:table/:id', async (request, reply) => {
    try {
      const { table, id } = request.params
      const tbl = PRESET_TABLES[table]
      if (!tbl) return reply.code(400).send({ success: false, error: `未知素材类型：${table}` })
      await query(`UPDATE ${tbl} SET use_count = use_count + 1 WHERE id = $1`, [id])
      return { success: true, data: {} }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ═══ 港险资料库 ═══

  fastify.get('/cases', async (request, reply) => {
    try {
      const { q, tag, featured } = request.query || {}
      const { page, size, offset } = clampPage(request.query || {})
      const params = []
      let where = `WHERE 1=1`
      if (q)   { params.push(`%${q}%`); where += ` AND (title ILIKE $${params.length} OR description ILIKE $${params.length})` }
      if (tag) { params.push([tag]);   where += ` AND tags && $${params.length}` }
      if (featured === 'true') where += ` AND is_featured = TRUE`

      const { rows: countRows } = await query(`SELECT count(*)::int AS total FROM lib_insurance_cases ${where}`, params)
      params.push(size, offset)
      const { rows } = await query(
        `SELECT id, title, tags, customer_age, family_structure, insurance_needs,
                description, is_featured, sort_order
           FROM lib_insurance_cases ${where}
          ORDER BY is_featured DESC, sort_order ASC, id ASC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      )
      return { success: true, data: { Items: rows, Total: countRows[0].total, Page: page, PageSize: size } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/cases/tags', async (request, reply) => {
    try {
      const { rows } = await query(
        `SELECT tag, count(*)::int AS count
           FROM lib_insurance_cases, unnest(tags) AS tag
          GROUP BY tag ORDER BY count DESC, tag ASC`
      )
      return { success: true, data: { Items: rows } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/cases/:id', async (request, reply) => {
    try {
      const { rows } = await query(`SELECT * FROM lib_insurance_cases WHERE id = $1`, [request.params.id])
      if (!rows[0]) return reply.code(404).send({ success: false, error: '案例不存在' })
      return { success: true, data: rows[0] }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/qa', async (request, reply) => {
    try {
      const { q, tag } = request.query || {}
      const { page, size, offset } = clampPage(request.query || {})
      const params = []
      let where = `WHERE 1=1`
      if (q)   { params.push(`%${q}%`); where += ` AND (title ILIKE $${params.length} OR content ILIKE $${params.length})` }
      if (tag) { params.push([tag]);   where += ` AND tags && $${params.length}` }

      const { rows: countRows } = await query(`SELECT count(*)::int AS total FROM lib_insurance_qa ${where}`, params)
      params.push(size, offset)
      const { rows } = await query(
        `SELECT id, title, tags, sort_order FROM lib_insurance_qa ${where}
          ORDER BY sort_order ASC, id ASC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      )
      return { success: true, data: { Items: rows, Total: countRows[0].total, Page: page, PageSize: size } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/qa/tags', async (request, reply) => {
    try {
      const { rows } = await query(
        `SELECT tag, count(*)::int AS count
           FROM lib_insurance_qa, unnest(tags) AS tag
          GROUP BY tag ORDER BY count DESC, tag ASC`
      )
      return { success: true, data: { Items: rows } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/qa/:id', async (request, reply) => {
    try {
      const { rows } = await query(`SELECT * FROM lib_insurance_qa WHERE id = $1`, [request.params.id])
      if (!rows[0]) return reply.code(404).send({ success: false, error: '问答不存在' })
      return { success: true, data: rows[0] }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })
}

module.exports = libraryRoutes
