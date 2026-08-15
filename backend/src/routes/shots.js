'use strict'

const { query } = require('../db')

async function shotRoutes(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ success: false, error: '未登录' })
  })

  async function verifyVideoOwner(videoId, userId) {
    const r = await query(`SELECT id FROM videos WHERE id=$1 AND user_id=$2`, [videoId, userId])
    return r.rows.length > 0
  }

  fastify.post('/videos/:videoId/shots', async (request, reply) => {
    const { videoId } = request.params
    const { shots } = request.body || {}
    if (!Array.isArray(shots) || shots.length === 0) return reply.code(400).send({ success: false, error: '分镜数据不能为空' })
    try {
      if (!await verifyVideoOwner(videoId, request.user.id)) return reply.code(404).send({ success: false, error: '视频不存在' })

      const maxResult = await query(`SELECT COALESCE(MAX(shot_number),0) AS max_num FROM shots WHERE video_id=$1`, [videoId])
      let num = maxResult.rows[0].max_num

      const inserted = []
      for (const shot of shots) {
        num++
        const r = await query(
          `INSERT INTO shots (video_id, shot_number, title, description, prompt, subtitle, duration, ratio, mood, camera_movement, reference_images, subjects)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [videoId, num, shot.title || null, shot.description || null, shot.prompt || null, shot.subtitle || null, shot.duration || 8, shot.ratio || null, shot.mood || null, shot.camera_movement || null, JSON.stringify(shot.reference_images || []), JSON.stringify(shot.subjects || [])]
        )
        inserted.push(r.rows[0])
      }
      return { success: true, data: inserted }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/videos/:videoId/shots', async (request, reply) => {
    const { videoId } = request.params
    try {
      if (!await verifyVideoOwner(videoId, request.user.id)) return reply.code(404).send({ success: false, error: '视频不存在' })
      const result = await query(`SELECT * FROM shots WHERE video_id=$1 ORDER BY shot_number ASC`, [videoId])
      return { success: true, data: result.rows }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.put('/shots/:id', async (request, reply) => {
    const { id } = request.params
    const body = request.body || {}
    try {
      const shotCheck = await query(
        `SELECT s.id FROM shots s JOIN videos v ON s.video_id=v.id WHERE s.id=$1 AND v.user_id=$2`,
        [id, request.user.id]
      )
      if (shotCheck.rows.length === 0) return reply.code(404).send({ success: false, error: '分镜不存在' })

      const fields = []
      const values = []
      let idx = 1

      const addField = (col, val, isJson) => {
        if (val !== undefined) { fields.push(`${col}=$${idx++}`); values.push(isJson ? JSON.stringify(val) : val) }
      }
      addField('title', body.title)
      addField('description', body.description)
      addField('prompt', body.prompt)
      addField('subtitle', body.subtitle)
      addField('duration', body.duration)
      addField('ratio', body.ratio)
      addField('mood', body.mood)
      addField('shot_type', body.shot_type)
      addField('lighting', body.lighting)
      addField('camera_movement', body.camera_movement)
      addField('camera_position_x', body.camera_position_x)
      addField('camera_position_y', body.camera_position_y)
      addField('camera_position_z', body.camera_position_z)
      addField('camera_target_x', body.camera_target_x)
      addField('camera_target_y', body.camera_target_y)
      addField('camera_target_z', body.camera_target_z)
      addField('camera_fov', body.camera_fov)
      addField('camera_movement_type', body.camera_movement_type)
      addField('camera_movement_path', body.camera_movement_path, true)
      addField('reference_images', body.reference_images, true)
      addField('subjects', body.subjects, true)
      addField('image_url', body.image_url)
      addField('task_id', body.task_id)
      addField('task_status', body.task_status)
      addField('video_url', body.video_url)
      addField('local_url', body.local_url)
      addField('video_duration', body.video_duration)
      addField('task_error', body.task_error)

      if (fields.length === 0) return reply.code(400).send({ success: false, error: '无更新字段' })
      fields.push(`updated_at=NOW()`)

      values.push(id)
      const result = await query(`UPDATE shots SET ${fields.join(', ')} WHERE id=$${idx} RETURNING *`, values)
      return { success: true, data: result.rows[0] }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.delete('/shots/:id', async (request, reply) => {
    const { id } = request.params
    try {
      const shotCheck = await query(
        `SELECT s.id, s.video_id FROM shots s JOIN videos v ON s.video_id=v.id WHERE s.id=$1 AND v.user_id=$2`,
        [id, request.user.id]
      )
      if (shotCheck.rows.length === 0) return reply.code(404).send({ success: false, error: '分镜不存在' })
      await query(`DELETE FROM shots WHERE id=$1`, [id])
      const videoId = shotCheck.rows[0].video_id
      await query(
        `WITH numbered AS (SELECT id, ROW_NUMBER() OVER (ORDER BY shot_number) AS new_num FROM shots WHERE video_id=$1)
         UPDATE shots SET shot_number=numbered.new_num FROM numbered WHERE shots.id=numbered.id`,
        [videoId]
      )
      return { success: true, data: { id } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.delete('/videos/:videoId/shots', async (request, reply) => {
    const { videoId } = request.params
    try {
      if (!await verifyVideoOwner(videoId, request.user.id)) return reply.code(404).send({ success: false, error: '视频不存在' })
      await query(`DELETE FROM shots WHERE video_id=$1`, [videoId])
      return { success: true, data: { videoId } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.put('/videos/:videoId/shots/reorder', async (request, reply) => {
    const { videoId } = request.params
    const { ids } = request.body || {}
    if (!Array.isArray(ids)) return reply.code(400).send({ success: false, error: 'ids必须为数组' })
    try {
      if (!await verifyVideoOwner(videoId, request.user.id)) return reply.code(404).send({ success: false, error: '视频不存在' })
      for (let i = 0; i < ids.length; i++) {
        await query(`UPDATE shots SET shot_number=$1 WHERE id=$2 AND video_id=$3`, [i + 1, ids[i], videoId])
      }
      return { success: true, data: { reordered: ids.length } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })
}

module.exports = shotRoutes
