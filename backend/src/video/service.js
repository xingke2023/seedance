'use strict'

const { CN_ONLY } = require('../lib/region')

const ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const FIDELITY_BASE_URL = process.env.FIDELITY_BASE_URL || 'https://videogen.fidelityai.cn'
const DEFAULT_MODEL = 'doubao-seedance-2-0'

// Seedance 一次请求里的素材硬上限。超出会被接口拒掉，所以在这里按类型截断 ——
// 「重要素材前置」是我们一贯的排法（角色头像在最前、参考素材按上传顺序），
// 截尾丢的就是最不重要的那几个。手改过的 content（contentOverride）不动：
// 那是用户在「查看提交 JSON」里亲手写的，看到什么就发什么。
const MEDIA_CAPS = { image_url: 9, video_url: 3, audio_url: 3 }

let _fidelityToken = null
let _fidelityTokenExp = 0

async function getFidelityToken() {
  // 单一拦截点：国际站登录只有这一条路，挡在这里就把 rawFetch/authFetch/QR 下载/
  // apiFetch 的国际站兜底全部一并挡掉，不用逐个功能点各自加判断。
  if (CN_ONLY) throw new Error('已开启仅国内站模式（FIDELITY_CN_ONLY=true），国际站功能不可用')
  if (_fidelityToken && Date.now() < _fidelityTokenExp) return _fidelityToken
  const username = process.env.FIDELITY_USERNAME
  const password = process.env.FIDELITY_PASSWORD
  if (!username || !password) return null
  const res = await fetch(`${FIDELITY_BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: username, password }),
  })
  if (!res.ok) return null
  const data = await res.json()
  _fidelityToken = data.session_token
  _fidelityTokenExp = Date.now() + 23 * 3600 * 1000
  return _fidelityToken
}

function buildMediaUrl(item) {
  if (item.url) return item.url
  if (item.data && item.mimeType) return `data:${item.mimeType};base64,${item.data}`
  return null
}

async function apiFetch(urlPath, options = {}, overrides = {}) {
  // 只用国内站模式下，火山方舟直连 (ARK_API_KEY) 也算「其他」——一并禁用，逼调用方
  // 必须显式传 overrides.apiKey/baseUrl（video.js 的 resolveRegionOverrides 已经改成
  // 无条件给国内站覆盖，所以正常情况下这里走的就是国内站的 apiKey，不会碰到这条分支）。
  let apiKey = overrides.apiKey || (CN_ONLY ? null : process.env.ARK_API_KEY)
  let baseUrl = overrides.baseUrl || ARK_BASE_URL

  // If using FidelityAI platform (no explicit apiKey and FIDELITY creds exist)
  if (!apiKey && !overrides.fullUrl && !CN_ONLY) {
    const token = await getFidelityToken()
    if (token) {
      apiKey = token
      baseUrl = `${FIDELITY_BASE_URL}/api/v3`
    }
  }

  if (!apiKey) {
    throw new Error(CN_ONLY
      ? '已开启仅国内站模式，但没有可用的国内站 apiKey（请检查 FIDELITY_CN_API_SK 是否配置）'
      : '请填写接口配置中的 API Key，或配置 FidelityAI 登录凭据')
  }
  if (/[^\x00-\xFF]/.test(apiKey)) {
    throw new Error('API Key 包含非法字符（如中文），请检查并重新输入正确的 API Key')
  }

  const url = overrides.fullUrl
    ? overrides.fullUrl
    : `${baseUrl.replace(/\/$/, '')}${urlPath}`

  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(options.headers || {}),
    },
  })

  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { message: text || res.statusText } }
  if (!res.ok) {
    const detail = json.error?.message || json.detail || json.message || text.slice(0, 200) || `API error ${res.status}`
    if (res.status === 403 && detail.includes('not registered')) {
      const match = detail.match(/asset '([^']+)'/)
      throw new Error(`素材 ${match ? match[1] : ''} 已失效或不存在，请移除后重试`)
    }
    throw new Error(detail)
  }
  return json
}

async function createVideoTask({
  prompt,
  content: contentOverride,
  tools: toolsOverride,
  images = [],
  videos = [],
  audios = [],
  orderedMedia,
  imageDescriptions,
  model,
  resolution = '720p',
  ratio = '16:9',
  duration = 5,
  seed,
  generateAudio = false,
  watermark = false,
  webSearch = false,
  cameraFixed = false,
  returnLastFrame = false,
  draft = false,
  serviceTier,
  priority,
  callbackUrl,
  apiKey,
  apiUrl,
}) {
  // 「查看提交 JSON」被手改过时带着现成的 content 数组来——原样用，
  // 不再从 prompt/orderedMedia 拼一遍（用户在框里看到的就是最终会发的）
  let content = Array.isArray(contentOverride) ? contentOverride : null

  if (!content) {
    content = []

    // 国内站 (vidgen.fidelityai.cn) 不接受 content 里出现多个 type:"text" 块 —
    // 任务会提交成功但同一秒变 failed,且错误信息被屏蔽。合并成一段文本。
    const textParts = [prompt, imageDescriptions].filter(Boolean)
    if (textParts.length > 0) {
      content.push({ type: 'text', text: textParts.join('\n\n') })
    }

    if (orderedMedia && orderedMedia.length > 0) {
      // Use ordered media array (maintains upload order)
      for (const item of orderedMedia) {
        const url = buildMediaUrl(item)
        if (!url) continue
        if (item.mediaType === 'image') {
          content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
        } else if (item.mediaType === 'video') {
          content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
        } else if (item.mediaType === 'audio') {
          content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
        }
      }
    } else {
      // Fallback: legacy separate arrays
      for (const img of images) {
        const url = buildMediaUrl(img)
        if (url) content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
      }

      for (const vid of videos) {
        const url = buildMediaUrl(vid)
        if (url) content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
      }

      for (const aud of audios) {
        const url = buildMediaUrl(aud)
        if (url) content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
      }
    }

    // 超额的截掉（保留靠前的），否则整个任务被接口拒绝
    const used = { image_url: 0, video_url: 0, audio_url: 0 }
    const dropped = []
    content = content.filter(c => {
      const cap = MEDIA_CAPS[c.type]
      if (cap === undefined) return true
      if (used[c.type] >= cap) { dropped.push(c.type); return false }
      used[c.type]++
      return true
    })
    if (dropped.length) {
      console.warn(`[video] 素材超过上限，已截掉 ${dropped.length} 个：`,
        Object.entries(MEDIA_CAPS).map(([t, cap]) => `${t} ${used[t]}/${cap}`).join('，'))
    }
  }

  const body = {
    model: model || DEFAULT_MODEL,
    content,
    generate_audio: generateAudio,
    resolution,
    ratio,
    duration,
    watermark,
  }
  if (seed !== undefined && seed !== null) body.seed = seed
  if (cameraFixed) body.camera_fixed = true
  if (returnLastFrame) body.return_last_frame = true
  if (draft) body.draft = true
  if (serviceTier) body.service_tier = serviceTier
  if (priority !== undefined && priority !== null && priority > 0) body.priority = priority
  if (Array.isArray(toolsOverride) && toolsOverride.length > 0) body.tools = toolsOverride
  else if (webSearch) body.tools = [{ type: 'web_search' }]
  if (callbackUrl) body.callback_url = callbackUrl

  console.log('[createVideoTask] content:', JSON.stringify(body.content))
  return apiFetch('/contents/generations/tasks', {
    method: 'POST',
    body: JSON.stringify(body),
  }, apiUrl ? { apiKey, fullUrl: apiUrl } : { apiKey })
}

async function getVideoTask(taskId, overrides = {}) {
  const { apiKey, apiUrl } = overrides
  if (apiUrl) {
    const base = apiUrl.replace(/\/$/, '')
    return apiFetch('', {}, { apiKey, fullUrl: `${base}/${taskId}` })
  }
  return apiFetch(`/contents/generations/tasks/${taskId}`, {}, apiKey ? { apiKey } : {})
}

module.exports = { createVideoTask, getVideoTask, getFidelityToken }
