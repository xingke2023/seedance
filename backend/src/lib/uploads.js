'use strict'

const fs   = require('fs')
const path = require('path')

const UPLOAD_ROOT = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(__dirname, '..', '..', 'uploads')

function localUploadPath(fileUrl) {
  if (!fileUrl) return null
  // 转存的预设素材带子目录（/uploads/materials/视频/动作/华尔兹.mp4），所以吃整段路径 ——
  // 拼完必须仍在 UPLOAD_ROOT 里（挡 ../ 穿越），中文用 decodeURIComponent 解回来
  const m = String(fileUrl).match(/\/uploads\/([^?#]+)(?:[?#].*)?$/)
  if (!m) return null
  let rel
  try { rel = decodeURIComponent(m[1]) } catch { rel = m[1] }
  const p = path.join(UPLOAD_ROOT, rel)
  if (p !== UPLOAD_ROOT && !p.startsWith(UPLOAD_ROOT + path.sep)) return null
  return fs.existsSync(p) ? p : null
}

async function fetchMediaBuffer(fileUrl, { timeout = 60000 } = {}) {
  const local = localUploadPath(fileUrl)
  if (local) return fs.readFileSync(local)
  const res = await fetch(fileUrl, { signal: AbortSignal.timeout(timeout) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

module.exports = { UPLOAD_ROOT, localUploadPath, fetchMediaBuffer }
