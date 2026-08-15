'use strict'

require('dotenv').config()

const fs   = require('fs')
const path = require('path')
const fastify    = require('fastify')
const multipart  = require('@fastify/multipart')
const cors       = require('@fastify/cors')
const { UPLOAD_ROOT } = require('./lib/uploads')

const videoRoutes     = require('./routes/video')
const voiceoverRoutes = require('./routes/voiceover')
const assetRoutes     = require('./routes/assets')
const manageRoutes    = require('./routes/manage')
const projectRoutes   = require('./routes/projects')
const videoRoutes2    = require('./routes/videos')
const shotRoutes      = require('./routes/shots')
const subjectRoutes   = require('./routes/subjects')
const authRoutes      = require('./routes/auth')
const { authMiddleware } = require('./middleware/auth')

function buildApp(opts = {}) {
  const app = fastify({ logger: true, bodyLimit: 30 * 1024 * 1024, ...opts })

  app.register(cors, { origin: true })
  app.register(multipart)

  app.addHook('onRequest', authMiddleware)

  app.get('/', async () => ({ message: 'Seedance backend is running' }))
  app.get('/health', async () => ({ status: 'ok' }))

  // Static file serving for uploads
  const UPLOAD_MIME = {
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  }
  app.get('/uploads/*', async (request, reply) => {
    const rel = request.params['*'] || ''
    const filePath = path.join(UPLOAD_ROOT, rel)
    if (filePath !== UPLOAD_ROOT && !filePath.startsWith(UPLOAD_ROOT + path.sep)) {
      return reply.code(403).send({ success: false, error: 'Forbidden' })
    }
    let stat
    try { stat = fs.statSync(filePath) } catch { return reply.code(404).send({ success: false, error: 'Not found' }) }
    if (!stat.isFile()) return reply.code(404).send({ success: false, error: 'Not found' })
    const mime = UPLOAD_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
    const fileSize = stat.size
    const range = request.headers.range
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      reply.code(206)
      reply.headers({
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mime,
      })
      return reply.send(fs.createReadStream(filePath, { start, end }))
    }
    reply.headers({ 'Accept-Ranges': 'bytes', 'Content-Length': fileSize })
    reply.type(mime)
    return reply.send(fs.createReadStream(filePath))
  })

  // File upload endpoint
  app.post('/upload', async (request, reply) => {
    const data = await request.file()
    if (!data) return reply.code(400).send({ success: false, error: 'No file provided' })

    fs.mkdirSync(UPLOAD_ROOT, { recursive: true })
    const ext = path.extname(data.filename) || '.bin'
    const name = `upload-${Date.now()}${ext}`
    const dest = path.join(UPLOAD_ROOT, name)

    const writeStream = fs.createWriteStream(dest)
    await new Promise((resolve, reject) => {
      data.file.pipe(writeStream)
      data.file.on('end', resolve)
      data.file.on('error', reject)
    })

    const base = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '')
    return { success: true, data: { url: `${base}/uploads/${name}` } }
  })

  app.register(authRoutes,      { prefix: '/auth' })
  app.register(videoRoutes,     { prefix: '/video' })
  app.register(voiceoverRoutes, { prefix: '/voiceover' })
  app.register(assetRoutes,     { prefix: '/assets' })
  app.register(manageRoutes,    { prefix: '/manage' })
  app.register(projectRoutes,   { prefix: '/projects' })
  app.register(videoRoutes2,    { prefix: '' })
  app.register(shotRoutes,      { prefix: '' })
  app.register(subjectRoutes,   { prefix: '' })

  return app
}

async function start() {
  const { initDB } = require('./db')
  await initDB()
  const app = buildApp()
  const port = parseInt(process.env.PORT || '8112')
  try {
    await app.listen({ port, host: '0.0.0.0' })
    console.log(`Server listening on http://0.0.0.0:${port}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
