'use strict'

const { query } = require('../db')

async function batchRoutes(fastify) {
  fastify.post('/', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ success: false, error: '未登录' })
    const { name, script, style, ratio, seed, shots, media_items, params, subject_defs, subtitle_input, tasks, merged_video_url, audio_url, init_result } = request.body
    try {
      const result = await query(
        `INSERT INTO batch_tasks (user_id, name, script, style, ratio, seed, shots, media_items, params, subject_defs, subtitle_input, tasks, merged_video_url, audio_url, init_result)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
        [request.user.id, name, script, style, ratio, seed, JSON.stringify(shots || []), JSON.stringify(media_items || []), JSON.stringify(params || {}), subject_defs, subtitle_input, JSON.stringify(tasks || {}), merged_video_url, audio_url || null, JSON.stringify(init_result || {})]
      )
      return { success: true, data: result.rows[0] }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ success: false, error: '未登录' })
    try {
      const result = await query(
        `SELECT id, name, script, style, ratio, seed, shots, tasks, created_at, updated_at FROM batch_tasks WHERE user_id = $1 ORDER BY updated_at DESC`,
        [request.user.id]
      )
      return { success: true, data: result.rows }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/:id', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ success: false, error: '未登录' })
    const { id } = request.params
    try {
      const result = await query(`SELECT * FROM batch_tasks WHERE id = $1 AND user_id = $2`, [id, request.user.id])
      if (result.rows.length === 0) return reply.code(404).send({ success: false, error: 'Not found' })
      return { success: true, data: result.rows[0] }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.put('/:id', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ success: false, error: '未登录' })
    const { id } = request.params
    const { name, script, style, ratio, seed, shots, media_items, params, subject_defs, subtitle_input, tasks, merged_video_url, audio_url, init_result } = request.body
    try {
      const result = await query(
        `UPDATE batch_tasks SET name=$1, script=$2, style=$3, ratio=$4, seed=$5, shots=$6, media_items=$7, params=$8, subject_defs=$9, subtitle_input=$10, tasks=$11, merged_video_url=$12, audio_url=$13, init_result=$14, updated_at=NOW()
         WHERE id=$15 AND user_id=$16 RETURNING *`,
        [name, script, style, ratio, seed, JSON.stringify(shots || []), JSON.stringify(media_items || []), JSON.stringify(params || {}), subject_defs, subtitle_input, JSON.stringify(tasks || {}), merged_video_url, audio_url || null, JSON.stringify(init_result || {}), id, request.user.id]
      )
      if (result.rows.length === 0) return reply.code(404).send({ success: false, error: 'Not found' })
      return { success: true, data: result.rows[0] }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.delete('/:id', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ success: false, error: '未登录' })
    const { id } = request.params
    try {
      const result = await query(`DELETE FROM batch_tasks WHERE id = $1 AND user_id = $2 RETURNING id`, [id, request.user.id])
      if (result.rows.length === 0) return reply.code(404).send({ success: false, error: 'Not found' })
      return { success: true, data: { id } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })
}

module.exports = batchRoutes
