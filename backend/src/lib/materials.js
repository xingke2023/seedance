'use strict'

// 方舟体验中心的预设素材库（从控制台扒下来的清单，存在仓库根的 materials/）。
// 音色 80 条、图片 71 张（服饰/环境/画风/角色）、视频 35 段（动作/运镜）。
//
// ⚠️ JSON 里的 `videoUrl` / `imageUrl` 两个字段是坏的 —— 少了 `动作/`「服饰/」这层
// 子目录，扩展名也可能不对（.png 实际是 .jpg）。能用的地址在 `thumbnail` 里：
// 去掉 `?x-tos-process=…` 查询串就是原图/原片，带着它就是缩略图。
// 音频的 `audioUrl` 是对的。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { UPLOAD_ROOT } = require('./uploads')

const ROOT = process.env.MATERIALS_DIR || path.join(__dirname, '..', '..', '..', 'materials')

const stripQuery = u => String(u || '').split('?')[0]

// 路径里的中文以 %XX 存在清单里（%E5%9B%BE%E7%89%87 = 图片），存进库、拼进提示词、
// 显示在素材列表上都是一长串转义。这里逐段解回中文，**交出去的地址里不留百分号转义** ——
// 只动 path，query 原样保留（签名串里的 %2F 之类有语义，解了就废）。
// TOS 对两种写法都返回 200（raw UTF-8 路径也认）。
//
// 清单里唯一一条带空格的是 `%20华尔兹.mp4`（文件名前面多一个空格）：去掉空格取到的是
// 同一个对象（ETag 一致），而 URL 里留一个裸空格谁都用不了 —— 所以解开后 trim 一次。
// trim 完仍带空格/#/?/%//\ 这类必须转义的字符，才退回原来的转义写法。
function prettyPath(url) {
  const s = String(url || '')
  const q = s.indexOf('?')
  const head = q < 0 ? s : s.slice(0, q)
  const tail = q < 0 ? '' : s.slice(q)
  const pretty = head.split('/').map(seg => {
    try {
      const dec = decodeURIComponent(seg).trim()
      return dec && !/[\s#?%/\\]/.test(dec) ? dec : seg
    } catch { return seg }
  }).join('/')
  return pretty + tail
}

// 分类从 URL 路径里取：…/materials/视频/动作/华尔兹.mp4 → 动作
function categoryFromUrl(url, kind) {
  const parts = decodeURIComponent(stripQuery(url)).split('/')
  const i = parts.lastIndexOf(kind)
  return i >= 0 && parts.length > i + 2 ? parts[i + 1].trim() : ''
}

// 清单地址 → 转存到本机后的相对路径（materials/ 之后的那截，中文原样）：
//   …/gen_video/materials/视频/动作/华尔兹.mp4 → 视频/动作/华尔兹.mp4
function materialRelPath(url) {
  const p = prettyPath(stripQuery(url))
  const i = p.indexOf('/materials/')
  return i < 0 ? '' : p.slice(i + '/materials/'.length)
}

// 本机副本的落地路径**一律用 ASCII**：`音频/音色/青年-女-亲切女声.mp3` → `audio/<sha1前16位>.mp3`。
// 清单里的中文路径原样落地的话，交出去的地址里就带一串中文（或 %E9%9F%B3 这种转义），
// 取这个地址的是 Seedance / ffmpeg / 各种客户端，谁在中间少做一次编码就取不到 ——
// 「音频链接失效」多半就是这么来的。名字看不懂没关系：列表上显示的 name 来自清单，
// 和文件名无关；hash 由中文相对路径算出，同一条素材每次算出来都一样。
const KIND_DIR = { '音频': 'audio', '视频': 'video', '图片': 'image' }

function asciiRel(rel) {
  if (!rel) return ''
  const ext = (path.extname(rel) || '').toLowerCase() || '.bin'
  const kind = KIND_DIR[String(rel).split('/')[0]] || 'misc'
  const hash = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16)
  return `${kind}/${hash}${ext}`
}

// 转存过的素材优先交本机地址 —— 外链直接甩给 Seedance 偶尔取不到，
// 而且它随时可能变。没转存的（没跑过 scripts/download-materials.js）照旧给外链。
// 缩略图不动：视频靠 TOS 的 ?x-tos-process=video/snapshot 现取首帧，本机没有这能力。
// 地址前缀取 MATERIALS_BASE_URL，没配就退回 WEBHOOK_BASE_URL。
function localUrl(url) {
  const rel = materialRelPath(url)
  if (!rel) return ''
  const base = (process.env.MATERIALS_BASE_URL || process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '')
  const ascii = asciiRel(rel)
  if (fs.existsSync(path.join(UPLOAD_ROOT, 'materials', ascii))) return `${base}/uploads/materials/${ascii}`
  // 迁移之前下的中文文件名副本仍然认（存量数据里存的就是这种地址）
  if (fs.existsSync(path.join(UPLOAD_ROOT, 'materials', rel))) return `${base}/uploads/materials/${rel}`
  return ''
}

let cache = null

// opts.local=false 时不查本地转存，强行返回原始外链（转存脚本自己要用）
function load({ local = true } = {}) {
  if (local && cache) return cache
  const pick = u => (local && localUrl(u)) || u

  const readJson = f => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')) } catch { return null }
  }
  const all = readJson('all_materials.json') || {}
  const audioPresets = readJson('audio_presets.json') || {}

  const videos = (all.videos?.items || []).map(v => ({
    name: String(v.name || '').trim(),
    category: categoryFromUrl(v.thumbnail, '视频'),
    url: pick(prettyPath(stripQuery(v.thumbnail))),   // videoUrl 字段坏的，用 thumbnail 反推
    thumb: prettyPath(v.thumbnail || ''),
  })).filter(v => v.url)

  const images = (all.images?.items || []).map(im => ({
    name: String(im.name || '').trim(),
    category: categoryFromUrl(im.thumbnail, '图片'),
    url: pick(prettyPath(stripQuery(im.thumbnail))),   // 转存过就交本机 ASCII 地址
    thumb: prettyPath(im.thumbnail || ''),             // 缩略图仍走 TOS（带 ?x-tos-process 缩放）
  })).filter(im => im.url)

  // 音色名字形如「青年-女-亲切女声」，第一段就是年龄段分组
  const audios = (audioPresets.items || all.audios?.items || []).map(a => {
    const name = String(a.name || '').trim()
    const [group = '', gender = ''] = name.split('-')
    return {
      name,
      category: group.trim(),
      gender: gender.trim(),
      duration: String(a.duration || '').trim(),
      url: pick(prettyPath(a.audioUrl || '')),
      avatar: a.avatar || '',           // data URI，前端直接当头像用
    }
  }).filter(a => a.url)

  // 转存过之后，视频/音频只交本机有副本的 —— 清单里有 6 条音色在 TOS 上已经 404
  // （方舟自己的清单过期了，本地也没有副本），留在列表里只会让人挑到一条取不回来的音色。
  // 没转存过（没跑过 scripts/download-materials.js）就照旧全给外链，行为不变。
  const transferred = local && fs.existsSync(path.join(UPLOAD_ROOT, 'materials'))
  const isLocal = m => String(m.url || '').includes('/uploads/materials/')
  const okVideos = transferred ? videos.filter(isLocal) : videos
  const okAudios = transferred ? audios.filter(isLocal) : audios

  const built = {
    source: all.source || '',
    videos: okVideos,
    images,
    audios: okAudios,
    counts: { videos: okVideos.length, images: images.length, audios: okAudios.length },
  }
  if (local) cache = built
  return built
}

module.exports = { load, materialRelPath, asciiRel, reset: () => { cache = null } }
