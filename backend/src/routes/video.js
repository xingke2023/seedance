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
const { parseSubjectDefs, lockSubjectAnchors } = require('../prompt/anchor')
const { syncSpeechWithSubtitle } = require('../prompt/speech')
const { CN_ONLY } = require('../lib/region')
const { QUOTA_ENFORCED } = require('../lib/quota')

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
const FIDELITY_CN_BASE_URL = process.env.FIDELITY_CN_BASE_URL || 'https://vidgen.fidelityai.cn'
const FIDELITY_CN_API_SK = process.env.FIDELITY_CN_API_SK

// 火山方舟直连不认「doubao-seedance-2-0」这种不带版本号的通用名——
// FidelityAI 代理会帮你转换成账号下实际可用的带版本号 ID，直连时得自己补上。
// 版本号来自 GET /api/v3/models 在这个 ARK_API_KEY 账号下实测可用的那几个
const ARK_MODEL_REMAP = {
  'doubao-seedance-2-0':      'doubao-seedance-2-0-260128',
  'doubao-seedance-2-0-fast': 'doubao-seedance-2-0-fast-260128',
  'doubao-seedance-2-5':      'doubao-seedance-2-5-260628',
}

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

function resolveRegionOverrides(region) {
  // 只用国内站模式：不管前端传的 region 是什么（包括默认的 undefined/'overseas'），
  // 一律走国内站——这是唯一会强制覆盖调用方显式选择的地方，其它 region==='cn' 分支
  // 仍按用户手动选择走。
  if (CN_ONLY || region === 'cn') {
    if (!FIDELITY_CN_API_SK) throw new Error('已开启仅国内站模式，但未配置 FIDELITY_CN_API_SK')
    return {
      apiKey: FIDELITY_CN_API_SK,
      apiUrl: normaliseApiUrl(FIDELITY_CN_BASE_URL),
    }
  }
  return {}
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
        properties: {
          prompt:        { type: 'string', minLength: 1, maxLength: 5000 },
          // 手改「查看提交 JSON」时带上——有它就整个跳过 prompt/orderedMedia 拼装和
          // 锚定锁/字幕对台词，原样交给 Seedance（用户已经在框里看到最终会发的样子）
          content:       { type: 'array', maxItems: 32 },
          tools:         { type: 'array', maxItems: 4 },
          images:        { type: 'array', items: mediaItemSchema, maxItems: 8 },
          videos:        { type: 'array', items: mediaItemSchema, maxItems: 4 },
          audios:        { type: 'array', items: mediaItemSchema, maxItems: 4 },
          orderedMedia:  { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, mediaType: { type: 'string' } } }, maxItems: 16 },
          imageDescriptions: { type: 'string', maxLength: 3000 },
          subject_definitions: { type: 'string', maxLength: 3000 },
          subtitle:      { type: 'string', maxLength: 2000 },
          roll_type:     { type: 'string' },
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
          region:        { type: 'string', enum: ['overseas', 'cn'] },
        },
      },
    },
  }, async (request, reply) => {
    const {
      prompt, content: contentOverride, tools: toolsOverride,
      images = [], videos = [], audios = [], orderedMedia, imageDescriptions,
      subject_definitions: subjectDefs,
      subtitle, roll_type: rollType,
      model, resolution, ratio, duration,
      seed, generateAudio, watermark, webSearch,
      cameraFixed, returnLastFrame, draft, serviceTier, priority,
      apiKey, apiUrl, region,
    } = request.body

    const hasContentOverride = Array.isArray(contentOverride) && contentOverride.length > 0
    if (!prompt && !hasContentOverride) {
      return reply.code(400).send({ success: false, error: 'prompt 或 content 至少需要一项' })
    }

    const regionOverrides = resolveRegionOverrides(region)
    // 只用国内站模式下国内站覆盖优先于「接口配置」里手填的 apiKey/apiUrl——开这个开关
    // 就是要连自定义 key 都一并管住，不留一条能绕开国内站的路。
    const effectiveApiKey = (CN_ONLY ? regionOverrides.apiKey : (apiKey || regionOverrides.apiKey)) || undefined
    const effectiveApiUrl = (CN_ONLY ? regionOverrides.apiUrl : (normaliseApiUrl(apiUrl) || regionOverrides.apiUrl)) || undefined
    let effectiveModel = ((CN_ONLY || region === 'cn') && (!model || model === 'doubao-seedance-2-0-fast')) ? 'doubao-seedance-2-0' : model
    // 没有 cn 覆盖、也没有显式 apiKey/apiUrl 时会落到直连火山方舟（ARK_API_KEY）——
    // 这条路不认通用模型名，换成账号下实测可用的带版本号 ID
    if (!effectiveApiKey && !effectiveApiUrl && ARK_MODEL_REMAP[effectiveModel]) {
      effectiveModel = ARK_MODEL_REMAP[effectiveModel]
    }
    const callbackUrl = effectiveApiUrl ? null : autoCallbackUrl()

    // 额度目前不限制（`QUOTA_ENFORCED` 默认关，见 lib/quota.js）——用量仍在下面照常累加
    if (QUOTA_ENFORCED && request.user && request.user.used >= request.user.quota) {
      return reply.code(403).send({ success: false, error: '额度已用完' })
    }

    let finalPrompt = prompt
    if (!hasContentOverride) {
      // 角色定义原文锁的最后一道闸。分镜生成时已经锁过一次，但这里还要再锁：
      // 存量分镜（锁上线之前生成的）和手动改过的 prompt 都只经过这一条路 ——
      // 定义句在这里统一换成原文，同一个角色在每一镜才真的一字不差。
      finalPrompt = subjectDefs
        ? lockSubjectAnchors(prompt, parseSubjectDefs(subjectDefs))
        : prompt

      // 台词块跟字幕对齐。字幕在页面上可以改，而结构化的 dialogue 没有落库 ——
      // 不同步的话，画面里的人念的是旧词、烧上去的字幕是新词。音色行保留不动。
      //
      // 重建时若这一镜原来就没有音色行，按角色定义里的音色绑定补一句：
      // `角色「小李」绑定@图片1、音色@音频1` → `<主体1> 使用 @音频1 …的音色说话`。
      // 音色描述取素材说明里那条音频的说明（`音频1：角色「小李」的音色 — 预设音色：青年-男-…`）
      // —— 官方约定：只给编号不描述音色会飘。
      const audioDescs = new Map(
        [...String(imageDescriptions || '').matchAll(/^\s*音频\s*(\d+)\s*[：:]\s*(.*)$/gm)]
          .map(m => [Number(m[1]), String(m[2] || '').replace(/^.*?—\s*/, '').trim()])
      )
      const anchorMap = subjectDefs ? parseSubjectDefs(subjectDefs) : new Map()
      finalPrompt = syncSpeechWithSubtitle(finalPrompt, subtitle, {
        rollType,
        // 身份对应行：`<主体1>` 指的是 content 里第几个 image_url、嗓子取自第几个
        // audio_url —— 台词行本身没说，缺了这句模型只能从画面描述里猜
        identityOf: (subjectNo, speaker) => {
          const def = anchorMap.get(subjectNo)
          const bits = [`即 @图片${subjectNo} 中的人物`]
          if (def?.audioRef) bits.push(`音色取自 @音频${def.audioRef}`)
          return `说话人身份对应：${speaker}（${bits.join('，')}）。`
        },
        voiceOf: (subjectNo, speaker) => {
          const def = anchorMap.get(subjectNo)
          if (!def?.audioRef) return ''
          const zh = audioDescs.get(def.audioRef) || ''
          return `${speaker} 使用 @音频${def.audioRef} ${zh}的音色说话`
        },
      })
    }

    try {
      const result = await createVideoTask({
        prompt: finalPrompt, content: hasContentOverride ? contentOverride : undefined,
        tools: toolsOverride, images, videos, audios, orderedMedia, imageDescriptions,
        model: effectiveModel, resolution, ratio, duration,
        seed, generateAudio, watermark, webSearch,
        cameraFixed, returnLastFrame, draft, serviceTier, priority,
        callbackUrl,
        apiKey: effectiveApiKey,
        apiUrl: effectiveApiUrl,
      })
      const taskId = result.id ?? result.task_id ?? result.data?.id ?? result.data?.task_id
      if (effectiveApiKey || effectiveApiUrl) setProvider(taskId, { apiKey: effectiveApiKey, apiUrl: effectiveApiUrl })
      const status = result.status ?? 'queued'

      if (request.user) {
        await query('UPDATE users SET used = used + 1, updated_at = NOW() WHERE id = $1', [request.user.id])
      }

      return {
        success: true,
        // prompt 回传：定义句可能被原文锁改写过，页面拿它回写分镜，
        // 免得列表里显示的还是旧文本、下次提交又要再锁一遍
        data: { taskId, status, callbackUrl: callbackUrl || null, prompt: hasContentOverride ? null : finalPrompt },
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
    // provider 是**内存里的**（video/store.js），后端一重启就全没了 —— 重启前提交的任务
    // 再来查，provider 就成了空对象。所以没记录时按 resolveRegionOverrides 重算一次：
    //   · CN_ONLY 开着（当前部署）：所有任务都是国内站建的，这里拿回国内站的 key/url。
    //     退回「apiFetch 默认链」等于没有 key，直接 500 —— 页面上那一镜就永远停在
    //     「队列中」，而任务其实早就跑完了。
    //   · CN_ONLY 关着：仍然返回 {}，和以前一样让 apiFetch 走自己的默认链，
    //     不会拿国内站的 key 去查一个不是国内站创建的任务（那会永远 404 task not found）
    const effectiveProvider = (provider.apiKey || provider.apiUrl) ? provider : resolveRegionOverrides()
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
      const result = await getVideoTask(taskId, effectiveProvider)
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
