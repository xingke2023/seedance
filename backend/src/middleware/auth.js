'use strict'

const jwt = require('jsonwebtoken')
const { query } = require('../db')

const JWT_SECRET = process.env.SSO_JWT_SECRET || ''

const PROTECTED_PATHS = ['/video/generate']

async function authMiddleware(request, reply) {
  const url = request.url.split('?')[0]

  const authHeader = request.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    if (PROTECTED_PATHS.includes(url)) {
      return reply.code(401).send({ success: false, error: '未登录' })
    }
    return
  }

  const token = authHeader.slice(7)
  let payload
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] })
  } catch (err) {
    if (PROTECTED_PATHS.includes(url)) {
      if (err.name === 'TokenExpiredError') {
        return reply.code(401).send({ success: false, error: 'token已过期', code: 'TOKEN_EXPIRED' })
      }
      return reply.code(401).send({ success: false, error: '无效token' })
    }
    return
  }

  const { rows } = await query(
    'SELECT * FROM users WHERE sso_user_id = $1',
    [payload.userId]
  )

  let user
  if (rows.length === 0) {
    const result = await query(
      `INSERT INTO users (sso_user_id, username, name, email, avatar)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [payload.userId, payload.username, payload.name, payload.email, payload.avatar]
    )
    user = result.rows[0]
    await query(
      `INSERT INTO projects (user_id, name, description) VALUES ($1, $2, $3)`,
      [user.id, '默认视频项目', '系统自动创建的默认项目']
    )
  } else {
    user = rows[0]
    await query(
      `UPDATE users SET username=$1, name=$2, email=$3, avatar=$4, updated_at=NOW() WHERE id=$5`,
      [payload.username, payload.name, payload.email, payload.avatar, user.id]
    )
    const { rows: projRows } = await query(
      `SELECT id FROM projects WHERE user_id=$1 AND name=$2 LIMIT 1`,
      [user.id, '默认视频项目']
    )
    if (projRows.length === 0) {
      await query(
        `INSERT INTO projects (user_id, name, description) VALUES ($1, $2, $3)`,
        [user.id, '默认视频项目', '系统自动创建的默认项目']
      )
    }
  }

  request.user = user
}

module.exports = { authMiddleware }
