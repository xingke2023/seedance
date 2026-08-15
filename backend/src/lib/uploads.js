'use strict'

const fs   = require('fs')
const path = require('path')

const UPLOAD_ROOT = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(__dirname, '..', '..', 'uploads')

function localUploadPath(fileUrl) {
  if (!fileUrl) return null
  const m = String(fileUrl).match(/\/uploads\/([^/?#]+)(?:[?#].*)?$/)
  if (!m) return null
  const p = path.join(UPLOAD_ROOT, m[1])
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
