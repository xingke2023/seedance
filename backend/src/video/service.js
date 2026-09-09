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

// 参考素材还有**条数之外**的三条硬规则（2026-09 拿官方 API ark.cn-beijing.volces.com 实测）：
//   ① 所有参考音频**加起来** ≤ 15.2 秒
//      → `audio total duration (seconds) … must be less than or equal to 15.2`
//   ② 所有参考视频**加起来** ≤ 15.2 秒（**和音频各算各的**，不是合计：
//      实测「视频 8.2s + 音频 11.4s」合计 19.6s 照样成功）
//      → `video total duration (seconds) … must be less than or equal to 15.2 … in r2v`
//   ③ 音频**不能是唯一的参考素材**，同一请求里至少还要有一张图（或一段视频）
//      → `reference_audio cannot be the only reference input`
// 违反任何一条，任务提交后立刻 failed。⚠️ 国内站代理（vidgen.fidelityai.cn）**不会**如实转达
// 这几句，它一律报成 `The parameter image_url … resource download failed` ——
// 内容里一张图都没有时也这么报，查起来会以为是素材地址失效。所以只能在这里挡住。
const MEDIA_SECONDS_CAP = 15.2
// 实际分配时留一点余量：截短是按 ffmpeg 的关键帧切的，比目标秒数长个零点几秒很正常，
// 卡着 15.2 切就有概率仍旧超标被拒
const MEDIA_BUDGET_SECONDS = 14.4

const mediaDurCache = new Map()   // url → 秒数（同一条素材逐镜都要发，别每次都去问）

// 素材时长：预设音色库的清单里现成就有；其它（视频、用户自己传的音频）用 ffprobe 现问一次。
// 问不出来的按 0 算 —— 宁可放过去让接口自己判，也不要凭猜把用户的素材丢掉。
async function mediaSeconds(url) {
  if (!url) return 0
  if (mediaDurCache.has(url)) return mediaDurCache.get(url)
  let sec = 0
  try {
    const { load } = require('../lib/materials')
    const hit = (load().audios || []).find(a => a.url === url)
    if (hit) sec = parseFloat(hit.duration) || 0
  } catch {}
  if (!sec && !url.startsWith('data:')) {
    try {
      const { execFile } = require('child_process')
      sec = await new Promise(resolve => {
        execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', url],
          { timeout: 15000 }, (err, stdout) => resolve(err ? 0 : parseFloat(String(stdout).trim()) || 0))
      })
    } catch {}
  }
  mediaDurCache.set(url, sec)
  return sec
}

// 把一条参考素材（音频或视频）截短到 sec 秒，落到 uploads/trimmed/ 下，交回公网地址。
// 同一条素材 + 同一个目标秒数只截一次（文件名带 hash），逐镜提交时直接命中。
// 本机的素材直接读文件（省一次下载）；外链让 ffmpeg 自己去取。
async function trimMedia(url, sec, kind = 'audio') {
  if (!url || url.startsWith('data:') || !(sec > 0.5)) return ''
  const fs = require('fs')
  const path = require('path')
  const crypto = require('crypto')
  const { UPLOAD_ROOT } = require('./../lib/uploads')
  const base = (process.env.MATERIALS_BASE_URL || process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '')
  const secs = sec.toFixed(1)
  const ext = kind === 'video' ? 'mp4' : 'mp3'
  const name = `${crypto.createHash('sha1').update(`${url}|${secs}`).digest('hex').slice(0, 16)}.${ext}`
  const dir = path.join(UPLOAD_ROOT, 'trimmed')
  const dest = path.join(dir, name)
  const publicUrl = `${base}/uploads/trimmed/${name}`
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return publicUrl

  // 本机副本走文件路径：ffmpeg 不用再从公网绕一圈回来取自己的文件
  let input = url
  const localPrefix = '/uploads/'
  const i = url.indexOf(localPrefix)
  if (i >= 0 && base && url.startsWith(base)) {
    const p = path.join(UPLOAD_ROOT, decodeURIComponent(url.slice(i + localPrefix.length)))
    if (fs.existsSync(p)) input = p
  }

  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${dest}.part`
  const ok = await new Promise(resolve => {
    const { execFile } = require('child_process')
    // 输出文件名是 xxx.part，ffmpeg 靠扩展名猜格式会失败，-f 必须显式给。
    // 视频直接 copy 流（快，且参考视频不需要重编码）；音频统一转 mp3。
    const args = kind === 'video'
      ? ['-hide_banner', '-y', '-t', secs, '-i', input, '-c', 'copy', '-f', 'mp4', '-movflags', '+faststart', tmp]
      : ['-hide_banner', '-y', '-t', secs, '-i', input, '-vn', '-acodec', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', tmp]
    execFile('ffmpeg', args,
      { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) console.warn('[video] ffmpeg 截短失败:', err.message, String(stderr || '').split('\n').slice(-4).join(' '))
        resolve(!err)
      })
  })
  if (!ok || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) { try { fs.unlinkSync(tmp) } catch {} ; return '' }
  fs.renameSync(tmp, dest)
  return publicUrl
}

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

    // ── 音频：总时长超上限时**不丢音频，按条数分摊着截短** ──
    // 丢掉一条等于那个角色没了音色，而克隆音色只需要几秒样本，截短几乎无损。
    // 分配用「最大最小公平」：短的拿满自己的时长，省下来的额度再匀给长的
    //（3 条各 4.8s；若其中一条只有 3s，另外两条就能各拿 5.7s）。
    if (used.audio_url > 0) {
      const items = content.filter(c => c.type === 'audio_url')
      const secs = []
      for (const c of items) secs.push(await mediaSeconds(c.audio_url?.url))
      if (secs.reduce((a, b) => a + b, 0) > MEDIA_BUDGET_SECONDS) {
        const alloc = new Array(secs.length).fill(0)
        let left = MEDIA_BUDGET_SECONDS
        const order = secs.map((v, i) => i).sort((a, b) => secs[a] - secs[b])
        order.forEach((i, k) => {
          const share = left / (order.length - k)
          alloc[i] = Math.min(secs[i] || share, share)
          left -= alloc[i]
        })
        for (let i = 0; i < items.length; i++) {
          if (!secs[i] || secs[i] <= alloc[i] + 0.05) continue
          const cut = await trimMedia(items[i].audio_url.url, alloc[i], 'audio')
          if (cut) {
            console.warn(`[video] 参考音频截短：${secs[i].toFixed(1)}s → ${alloc[i].toFixed(1)}s ${cut}`)
            items[i].audio_url = { url: cut }
          } else {
            console.warn(`[video] 参考音频截短失败，只能丢掉这一条：${items[i].audio_url.url}`)
            items[i].__drop = true
          }
        }
        content = content.filter(c => !c.__drop)
        used.audio_url = content.filter(c => c.type === 'audio_url').length
      }
    }

    // ── 视频：**不截短**，超了就整段丢掉靠后的 ──
    // 参考视频给的是运镜/动作的完整节奏，从中间切一刀这条参考就废了（不像音色，
    // 几秒样本就够）。所以宁可少给一段完整的，也不给两段残的。
    // 丢靠后的：素材按「重要的排前面」入列（角色头像 → 参考素材按入列顺序）。
    if (used.video_url > 0) {
      let total = 0
      const dropUrls = []
      for (const c of content) {
        if (c.type !== 'video_url') continue
        const sec = await mediaSeconds(c.video_url?.url)
        if (total + sec > MEDIA_BUDGET_SECONDS) { c.__drop = true; dropUrls.push(c.video_url?.url); continue }
        total += sec
      }
      if (dropUrls.length) {
        console.warn(`[video] 参考视频总时长超过 ${MEDIA_SECONDS_CAP}s，已整段丢掉靠后的 ${dropUrls.length} 条`
          + `（保留 ${total.toFixed(1)}s）：`, dropUrls.join(' '))
        content = content.filter(c => !c.__drop)
        used.video_url = content.filter(c => c.type === 'video_url').length
      }
    }

    // 音频不能是唯一的参考素材：没有图也没有视频时，音频一并去掉 ——
    // 留着必然 failed，而没有音色只是声音会飘，还能交付
    if (used.audio_url > 0 && used.image_url === 0 && used.video_url === 0) {
      console.warn('[video] 这一条只有参考音频、没有图片/视频，音频会让整个任务失败，已去掉')
      content = content.filter(c => c.type !== 'audio_url')
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
