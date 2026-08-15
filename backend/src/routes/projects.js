'use strict'

const { query } = require('../db')

async function projectRoutes(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ success: false, error: '未登录' })
  })

  fastify.get('/default', async (request, reply) => {
    try {
      let result = await query(
        `SELECT id FROM projects WHERE user_id=$1 AND name=$2 LIMIT 1`,
        [request.user.id, '默认视频项目']
      )
      if (result.rows.length === 0) {
        result = await query(
          `INSERT INTO projects (user_id, name, description) VALUES ($1, $2, $3) RETURNING id`,
          [request.user.id, '默认视频项目', '系统自动创建的默认项目']
        )
      }
      return { success: true, data: { id: result.rows[0].id } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.post('/', async (request, reply) => {
    const { name, description, cover_url } = request.body || {}
    if (!name) return reply.code(400).send({ success: false, error: '项目名称不能为空' })
    try {
      const result = await query(
        `INSERT INTO projects (user_id, name, description, cover_url) VALUES ($1, $2, $3, $4) RETURNING *`,
        [request.user.id, name, description || null, cover_url || null]
      )
      return { success: true, data: result.rows[0] }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/', async (request, reply) => {
    try {
      const result = await query(
        `SELECT p.*, (SELECT COUNT(*) FROM videos v WHERE v.project_id = p.id)::int AS video_count
         FROM projects p WHERE p.user_id = $1 ORDER BY p.updated_at DESC`,
        [request.user.id]
      )
      return { success: true, data: result.rows }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params
    try {
      const result = await query(
        `SELECT * FROM projects WHERE id = $1 AND user_id = $2`,
        [id, request.user.id]
      )
      if (result.rows.length === 0) return reply.code(404).send({ success: false, error: '项目不存在' })
      return { success: true, data: result.rows[0] }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params
    const { name, description, cover_url } = request.body || {}
    try {
      const result = await query(
        `UPDATE projects SET name=COALESCE($1,name), description=COALESCE($2,description), cover_url=COALESCE($3,cover_url), updated_at=NOW()
         WHERE id=$4 AND user_id=$5 RETURNING *`,
        [name, description, cover_url, id, request.user.id]
      )
      if (result.rows.length === 0) return reply.code(404).send({ success: false, error: '项目不存在' })
      return { success: true, data: result.rows[0] }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params
    try {
      const result = await query(
        `DELETE FROM projects WHERE id = $1 AND user_id = $2 RETURNING id`,
        [id, request.user.id]
      )
      if (result.rows.length === 0) return reply.code(404).send({ success: false, error: '项目不存在' })
      return { success: true, data: { id } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })
}

module.exports = projectRoutes
