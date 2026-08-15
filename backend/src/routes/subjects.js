'use strict'

const { query } = require('../db')

async function subjectRoutes(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ success: false, error: '未登录' })
  })

  // ─── Project Subject Library CRUD ──────────────────────────────────────────

  fastify.get('/projects/:projectId/subjects', async (request, reply) => {
    const { projectId } = request.params
    try {
      const proj = await query(`SELECT id FROM projects WHERE id=$1 AND user_id=$2`, [projectId, request.user.id])
      if (proj.rows.length === 0) return reply.code(404).send({ success: false, error: '项目不存在' })
      const result = await query(
        `SELECT * FROM project_subjects WHERE project_id=$1 ORDER BY sort_order ASC, created_at ASC`,
        [projectId]
      )
      return { success: true, data: result.rows }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.post('/projects/:projectId/subjects', async (request, reply) => {
    const { projectId } = request.params
    const { label, description, image_url, asset_id, action_url, sound_url } = request.body || {}
    if (!label) return reply.code(400).send({ success: false, error: '主体名称不能为空' })
    try {
      const proj = await query(`SELECT id FROM projects WHERE id=$1 AND user_id=$2`, [projectId, request.user.id])
      if (proj.rows.length === 0) return reply.code(404).send({ success: false, error: '项目不存在' })

      const sortResult = await query(`SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM project_subjects WHERE project_id=$1`, [projectId])
      const result = await query(
        `INSERT INTO project_subjects (project_id, label, description, image_url, asset_id, sort_order, action_url, sound_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [projectId, label, description || null, image_url || null, asset_id || null, sortResult.rows[0].next, action_url || null, sound_url || null]
      )
      return { success: true, data: result.rows[0] }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.post('/projects/:projectId/subjects/batch', async (request, reply) => {
    const { projectId } = request.params
    const { subjects } = request.body || {}
    if (!Array.isArray(subjects) || subjects.length === 0) return reply.code(400).send({ success: false, error: '主体数据不能为空' })
    try {
      const proj = await query(`SELECT id FROM projects WHERE id=$1 AND user_id=$2`, [projectId, request.user.id])
      if (proj.rows.length === 0) return reply.code(404).send({ success: false, error: '项目不存在' })

      const sortResult = await query(`SELECT COALESCE(MAX(sort_order),0) AS max_sort FROM project_subjects WHERE project_id=$1`, [projectId])
      let sortOrder = sortResult.rows[0].max_sort

      const inserted = []
      for (const s of subjects) {
        if (!s.label) continue
        sortOrder++
        const r = await query(
          `INSERT INTO project_subjects (project_id, label, description, image_url, asset_id, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [projectId, s.label, s.description || null, s.image_url || null, s.asset_id || null, sortOrder]
        )
        inserted.push(r.rows[0])
      }
      return { success: true, data: inserted }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.put('/subjects/:id', async (request, reply) => {
    const { id } = request.params
    const { label, description, image_url, asset_id, action_url, sound_url } = request.body || {}
    try {
      const check = await query(
        `SELECT ps.id FROM project_subjects ps JOIN projects p ON ps.project_id=p.id WHERE ps.id=$1 AND p.user_id=$2`,
        [id, request.user.id]
      )
      if (check.rows.length === 0) return reply.code(404).send({ success: false, error: '主体不存在' })

      const fields = []
      const values = []
      let idx = 1
      if (label !== undefined) { fields.push(`label=$${idx++}`); values.push(label) }
      if (description !== undefined) { fields.push(`description=$${idx++}`); values.push(description) }
      if (image_url !== undefined) { fields.push(`image_url=$${idx++}`); values.push(image_url) }
      if (asset_id !== undefined) { fields.push(`asset_id=$${idx++}`); values.push(asset_id) }
      if (action_url !== undefined) { fields.push(`action_url=$${idx++}`); values.push(action_url) }
      if (sound_url !== undefined) { fields.push(`sound_url=$${idx++}`); values.push(sound_url) }
      if (fields.length === 0) return reply.code(400).send({ success: false, error: '无更新字段' })
      fields.push(`updated_at=NOW()`)
      values.push(id)

      const result = await query(`UPDATE project_subjects SET ${fields.join(', ')} WHERE id=$${idx} RETURNING *`, values)
      return { success: true, data: result.rows[0] }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.delete('/subjects/:id', async (request, reply) => {
    const { id } = request.params
    try {
      const check = await query(
        `SELECT ps.id FROM project_subjects ps JOIN projects p ON ps.project_id=p.id WHERE ps.id=$1 AND p.user_id=$2`,
        [id, request.user.id]
      )
      if (check.rows.length === 0) return reply.code(404).send({ success: false, error: '主体不存在' })
      await query(`DELETE FROM project_subjects WHERE id=$1`, [id])
      return { success: true, data: { id } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ─── Video Subject Selection ───────────────────────────────────────────────

  fastify.get('/videos/:videoId/subjects', async (request, reply) => {
    const { videoId } = request.params
    try {
      const vCheck = await query(`SELECT id FROM videos WHERE id=$1 AND user_id=$2`, [videoId, request.user.id])
      if (vCheck.rows.length === 0) return reply.code(404).send({ success: false, error: '视频不存在' })
      const result = await query(
        `SELECT ps.* FROM project_subjects ps
         JOIN video_subjects vs ON vs.subject_id = ps.id
         WHERE vs.video_id = $1
         ORDER BY ps.sort_order ASC`,
        [videoId]
      )
      return { success: true, data: result.rows }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.post('/videos/:videoId/subjects', async (request, reply) => {
    const { videoId } = request.params
    const { subject_ids } = request.body || {}
    if (!Array.isArray(subject_ids)) return reply.code(400).send({ success: false, error: 'subject_ids必须为数组' })
    try {
      const vCheck = await query(`SELECT id FROM videos WHERE id=$1 AND user_id=$2`, [videoId, request.user.id])
      if (vCheck.rows.length === 0) return reply.code(404).send({ success: false, error: '视频不存在' })

      for (const sid of subject_ids) {
        await query(
          `INSERT INTO video_subjects (video_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [videoId, sid]
        )
      }
      const result = await query(
        `SELECT ps.* FROM project_subjects ps JOIN video_subjects vs ON vs.subject_id=ps.id WHERE vs.video_id=$1 ORDER BY ps.sort_order ASC`,
        [videoId]
      )
      return { success: true, data: result.rows }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.delete('/videos/:videoId/subjects/:subjectId', async (request, reply) => {
    const { videoId, subjectId } = request.params
    try {
      const vCheck = await query(`SELECT id FROM videos WHERE id=$1 AND user_id=$2`, [videoId, request.user.id])
      if (vCheck.rows.length === 0) return reply.code(404).send({ success: false, error: '视频不存在' })
      await query(`DELETE FROM video_subjects WHERE video_id=$1 AND subject_id=$2`, [videoId, subjectId])
      return { success: true, data: { videoId, subjectId } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })
}

module.exports = subjectRoutes
