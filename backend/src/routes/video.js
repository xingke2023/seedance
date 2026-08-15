'use strict'

const fs   = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { promisify } = require('util')
const { createVideoTask, getVideoTask } = require('../video/service')
const store = require('../video/store')
const { setProvider, getProvider } = store
const { UPLOAD_ROOT } = require('../lib/uploads')
const { query } = require('../db')

const execFileAsync = promisify(execFile)
const VIDEO_CACHE = path.join(UPLOAD_ROOT, '.video-cache')

async function probeDuration(filePath) {
  const r = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ])
  return parseFloat(r.stdout.trim()) || 0
}

// 下载视频到本地缓存，返回本地 URL + 精确时长
async function cacheVideo(videoUrl) {
  if (!videoUrl) return null
  fs.mkdirSync(VIDEO_CACHE, { recursive: true })
  const key  = crypto.createHash('md5').update(videoUrl.split('?')[0]).digest('hex')
  const metaPath = path.join(VIDEO_CACHE, `${key}.json`)

  if (fs.existsSync(metaPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      if (fs.existsSync(info.path)) return info
    } catch {}
  }

  const dest = path.join(VIDEO_CACHE, `${key}.mp4`)
  const res  = await fetch(videoUrl, { signal: AbortSignal.timeout(90_000), redirect: 'follow' })
  if (!res.ok) return null
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))

  const duration = await probeDuration(dest)
  const size     = fs.statSync(dest).size
  const base     = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '')
  const localUrl = `${base}/uploads/.video-cache/${key}.mp4`
  const info     = { url: videoUrl, localUrl, path: dest, duration, size, cachedAt: Date.now() }
  fs.writeFileSync(metaPath, JSON.stringify(info))
  return info
}

const mediaItemSchema = {
  type: 'object',
  properties: {
    url:      { type: 'string' },
    data:     { type: 'string' },
    mimeType: { type: 'string' },
  },
}

const FIDELITYAI_PATH = '/api/v3/contents/generations/tasks'

function normaliseApiUrl(url) {
  if (!url) return url
  const u = url.replace(/\/$/, '')
  if (u.endsWith('/tasks')) return u
  if (u.endsWith('/generations')) return `${u}/tasks`
  return `${u}${FIDELITYAI_PATH}`
}

function autoCallbackUrl() {
  const base = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '')
  return base ? `${base}/video/webhook` : null
}

function extractVideoUrl(content) {
  if (!content) return null
  if (typeof content === 'string') return content
  if (typeof content.video_url === 'string') return content.video_url
  if (Array.isArray(content)) {
    const item = content.find(c => c.type === 'video_url')
    return item?.video_url?.url || item?.video_url || null
  }
  return null
}

function normaliseStatus(s) {
  if (!s) return 'running'
  const lower = String(s).toLowerCase()
  if (['succeed', 'success', 'succeeded', 'completed', 'complete'].includes(lower)) return 'succeeded'
  if (['failed', 'failure', 'fail'].includes(lower)) return 'failed'
  if (lower === 'expired') return 'expired'
  if (['cancelled', 'canceled'].includes(lower)) return 'cancelled'
  if (['queued', 'pending', 'submitted'].includes(lower)) return 'queued'
  return lower
}

function normaliseTask(result) {
  // FidelityAI direct format: { id, status, content: { video_url } }
  if (result.id && result.status !== undefined && !result.data) {
    return {
      taskId:   result.id,
      status:   normaliseStatus(result.status),
      videoUrl: extractVideoUrl(result.content),
      error:    result.error?.message || result.error || null,
    }
  }
  // Legacy fidelity wrapper: { code, data: { task_id, status, data: { ... } } }
  const fidelityOuter = result?.code !== undefined ? result?.data : null
  const fidelityInner = fidelityOuter?.data
  const src = fidelityInner || fidelityOuter || result

  return {
    taskId:     src.id || fidelityOuter?.task_id || result.id,
    status:     normaliseStatus(src.status || fidelityOuter?.status),
    videoUrl:   extractVideoUrl(src.content) || fidelityOuter?.result_url || null,
    error:      src.error?.message || null,
  }
}

const TERMINAL = new Set(['succeeded', 'failed', 'expired', 'cancelled'])

async function videoRoutes(fastify) {

  fastify.post('/generate', {
    schema: {
      body: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt:        { type: 'string', minLength: 1, maxLength: 5000 },
          images:        { type: 'array', items: mediaItemSchema, maxItems: 8 },
          videos:        { type: 'array', items: mediaItemSchema, maxItems: 4 },
          audios:        { type: 'array', items: mediaItemSchema, maxItems: 4 },
          orderedMedia:  { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, mediaType: { type: 'string' } } }, maxItems: 16 },
          imageDescriptions: { type: 'string', maxLength: 3000 },
          model:         { type: 'string' },
          resolution:    { type: 'string', enum: ['480p', '720p', '1080p'] },
          ratio:         { type: 'string' },
          duration:      { type: 'number', minimum: 4, maximum: 15 },
          seed:          { type: 'integer', minimum: 0, maximum: 2147483647 },
          generateAudio: { type: 'boolean' },
          watermark:     { type: 'boolean' },
          webSearch:     { type: 'boolean' },
          cameraFixed:   { type: 'boolean' },
          returnLastFrame: { type: 'boolean' },
          draft:         { type: 'boolean' },
          serviceTier:   { type: 'string' },
          priority:      { type: 'integer', minimum: 0, maximum: 9 },
          apiKey:        { type: 'string' },
          apiUrl:        { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const {
      prompt, images = [], videos = [], audios = [], orderedMedia, imageDescriptions,
      model, resolution, ratio, duration,
      seed, generateAudio, watermark, webSearch,
      cameraFixed, returnLastFrame, draft, serviceTier, priority,
      apiKey, apiUrl,
    } = request.body

    const normalisedApiUrl = normaliseApiUrl(apiUrl)
    const callbackUrl = normalisedApiUrl ? null : autoCallbackUrl()

    if (request.user && request.user.used >= request.user.quota) {
      return reply.code(403).send({ success: false, error: '额度已用完' })
    }

    try {
      const result = await createVideoTask({
        prompt, images, videos, audios, orderedMedia, imageDescriptions,
        model, resolution, ratio, duration,
        seed, generateAudio, watermark, webSearch,
        cameraFixed, returnLastFrame, draft, serviceTier, priority,
        callbackUrl,
        apiKey: apiKey || undefined,
        apiUrl: normalisedApiUrl || undefined,
      })
      const taskId = result.id ?? result.task_id ?? result.data?.id ?? result.data?.task_id
      if (apiKey || normalisedApiUrl) setProvider(taskId, { apiKey, apiUrl: normalisedApiUrl })
      const status = result.status ?? 'queued'

      if (request.user) {
        await query('UPDATE users SET used = used + 1, updated_at = NOW() WHERE id = $1', [request.user.id])
      }

      return {
        success: true,
        data: { taskId, status, callbackUrl: callbackUrl || null },
      }
    } catch (err) {
      fastify.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.get('/task/:taskId', async (request, reply) => {
    const { taskId } = request.params

    const cached = store.get(taskId)
    const provider = getProvider(taskId)
    if (cached) {
      const cachedData = normaliseTask(cached)
      if (TERMINAL.has(cachedData.status)) {
        // 成功的任务：尝试下载到本地缓存
        if (cachedData.status === 'succeeded' && cachedData.videoUrl) {
          try {
            const info = await cacheVideo(cachedData.videoUrl)
            if (info) {
              return { success: true, data: { ...cachedData, localUrl: info.localUrl, duration: info.duration, webhookReceived: true } }
            }
          } catch (e) {
            fastify.log.warn(`视频缓存失败: ${e.message}`)
          }
        }
        return { success: true, data: { ...cachedData, webhookReceived: true } }
      }
    }

    try {
      const result = await getVideoTask(taskId, provider)
      store.set(taskId, result)
      const data = normaliseTask(result)

      // 成功的任务：尝试下载到本地缓存
      if (data.status === 'succeeded' && data.videoUrl) {
        try {
          const info = await cacheVideo(data.videoUrl)
          if (info) {
            return { success: true, data: { ...data, localUrl: info.localUrl, duration: info.duration, webhookReceived: cached != null } }
          }
        } catch (e) {
          fastify.log.warn(`视频缓存失败: ${e.message}`)
        }
      }

      return {
        success: true,
        data: { ...data, webhookReceived: cached != null },
      }
    } catch (err) {
      fastify.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.post('/webhook', async (request, reply) => {
    const body = request.body
    if (!body || !body.id) {
      return reply.code(400).send({ code: 400, msg: 'Missing task id' })
    }
    const taskId = body.id
    fastify.log.info(`[webhook] task=${taskId} status=${body.status}`)
    store.set(taskId, body)
    return { code: 200, msg: 'ok', task_id: taskId }
  })
}

module.exports = videoRoutes
