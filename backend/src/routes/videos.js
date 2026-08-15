'use strict'

const { query } = require('../db')

async function videoRoutes(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ success: false, error: '未登录' })
  })

  fastify.post('/projects/:projectId/videos', async (request, reply) => {
    const { projectId } = request.params
    const { name, script, subtitle_input, style, ratio, seed, params, voice } = request.body || {}
    if (!name) return reply.code(400).send({ success: false, error: '视频名称不能为空' })
    try {
      const proj = await query(`SELECT id FROM projects WHERE id=$1 AND user_id=$2`, [projectId, request.user.id])
      if (proj.rows.length === 0) return reply.code(404).send({ success: false, error: '项目不存在' })

      const sortResult = await query(`SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM videos WHERE project_id=$1`, [projectId])
      const sortOrder = sortResult.rows[0].next

      const result = await query(
        `INSERT INTO videos (project_id, user_id, name, script, subtitle_input, style, ratio, seed, params, voice, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [projectId, request.user.id, name, script || null, subtitle_input || null, style || null, ratio || '9:16', seed || null, JSON.stringify(params || {}), voice || null, sortOrder]
      )
      await query(`UPDATE projects SET updated_at=NOW() WHERE id=$1`, [projectId])
      return { success: true, data: result.rows[0] }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/projects/:projectId/videos', async (request, reply) => {
    const { projectId } = request.params
    try {
      const proj = await query(`SELECT id FROM projects WHERE id=$1 AND user_id=$2`, [projectId, request.user.id])
      if (proj.rows.length === 0) return reply.code(404).send({ success: false, error: '项目不存在' })

      const result = await query(
        `SELECT v.*, (SELECT COUNT(*) FROM shots s WHERE s.video_id = v.id)::int AS shot_count
         FROM videos v WHERE v.project_id = $1 ORDER BY v.sort_order ASC, v.created_at ASC`,
        [projectId]
      )
      return { success: true, data: result.rows }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/videos/:id', async (request, reply) => {
    const { id } = request.params
    try {
      const result = await query(`SELECT * FROM videos WHERE id=$1 AND user_id=$2`, [id, request.user.id])
      if (result.rows.length === 0) return reply.code(404).send({ success: false, error: '视频不存在' })
      const video = result.rows[0]
      const shotsResult = await query(`SELECT * FROM shots WHERE video_id=$1 ORDER BY shot_number ASC`, [id])
      const mediaResult = await query(`SELECT * FROM video_media WHERE video_id=$1 ORDER BY sort_order ASC`, [id])
      const subjectsResult = await query(
        `SELECT ps.* FROM video_subjects vs JOIN project_subjects ps ON ps.id = vs.subject_id WHERE vs.video_id=$1`,
        [id]
      )
      return { success: true, data: { ...video, shots: shotsResult.rows, media_items: mediaResult.rows, video_subjects: subjectsResult.rows } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.put('/videos/:id', async (request, reply) => {
    const { id } = request.params
    const { name, script, subtitle_input, style, ratio, seed, params, voice, audio_url, merged_video_url, status, subject_ids, media_items } = request.body || {}
    try {
      const fields = []
      const values = []
      let idx = 1

      const addField = (col, val) => {
        if (val !== undefined) { fields.push(`${col}=$${idx++}`); values.push(col === 'params' ? JSON.stringify(val) : val) }
      }
      addField('name', name)
      addField('script', script)
      addField('subtitle_input', subtitle_input)
      addField('style', style)
      addField('ratio', ratio)
      addField('seed', seed)
      addField('params', params)
      addField('voice', voice)
      addField('audio_url', audio_url)
      addField('merged_video_url', merged_video_url)
      addField('status', status)

      if (fields.length === 0 && subject_ids === undefined && media_items === undefined) {
        return reply.code(400).send({ success: false, error: '无更新字段' })
      }

      // Update video fields if any
      let video
      if (fields.length > 0) {
        fields.push(`updated_at=NOW()`)
        values.push(id, request.user.id)
        const result = await query(
          `UPDATE videos SET ${fields.join(', ')} WHERE id=$${idx++} AND user_id=$${idx} RETURNING *`,
          values
        )
        if (result.rows.length === 0) return reply.code(404).send({ success: false, error: '视频不存在' })
        video = result.rows[0]
      } else {
        const check = await query(`SELECT * FROM videos WHERE id=$1 AND user_id=$2`, [id, request.user.id])
        if (check.rows.length === 0) return reply.code(404).send({ success: false, error: '视频不存在' })
        video = check.rows[0]
      }

      // Save video subjects
      if (Array.isArray(subject_ids)) {
        await query(`DELETE FROM video_subjects WHERE video_id=$1`, [id])
        for (const subjectId of subject_ids) {
          await query(`INSERT INTO video_subjects (video_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, subjectId])
        }
      }

      // Save media items
      if (Array.isArray(media_items)) {
        await query(`DELETE FROM video_media WHERE video_id=$1`, [id])
        for (let i = 0; i < media_items.length; i++) {
          const m = media_items[i]
          await query(
            `INSERT INTO video_media (video_id, media_type, url, name, description, sort_order) VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, m.media_type || m.mediaType, m.url, m.name || null, m.description || null, i]
          )
        }
      }

      return { success: true, data: video }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.delete('/videos/:id', async (request, reply) => {
    const { id } = request.params
    try {
      const result = await query(`DELETE FROM videos WHERE id=$1 AND user_id=$2 RETURNING id, project_id`, [id, request.user.id])
      if (result.rows.length === 0) return reply.code(404).send({ success: false, error: '视频不存在' })
      await query(`UPDATE projects SET updated_at=NOW() WHERE id=$1`, [result.rows[0].project_id])
      return { success: true, data: { id } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.put('/projects/:projectId/videos/reorder', async (request, reply) => {
    const { projectId } = request.params
    const { ids } = request.body || {}
    if (!Array.isArray(ids)) return reply.code(400).send({ success: false, error: 'ids必须为数组' })
    try {
      for (let i = 0; i < ids.length; i++) {
        await query(`UPDATE videos SET sort_order=$1 WHERE id=$2 AND project_id=$3 AND user_id=$4`, [i, ids[i], projectId, request.user.id])
      }
      return { success: true, data: { reordered: ids.length } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })
}

module.exports = videoRoutes
