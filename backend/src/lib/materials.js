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

const ROOT = process.env.MATERIALS_DIR || path.join(__dirname, '..', '..', '..', 'materials')

const stripQuery = u => String(u || '').split('?')[0]

// 分类从 URL 路径里取：…/materials/视频/动作/华尔兹.mp4 → 动作
function categoryFromUrl(url, kind) {
  const parts = decodeURIComponent(stripQuery(url)).split('/')
  const i = parts.lastIndexOf(kind)
  return i >= 0 && parts.length > i + 2 ? parts[i + 1].trim() : ''
}

let cache = null

function load() {
  if (cache) return cache

  const readJson = f => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')) } catch { return null }
  }
  const all = readJson('all_materials.json') || {}
  const audioPresets = readJson('audio_presets.json') || {}

  const videos = (all.videos?.items || []).map(v => ({
    name: String(v.name || '').trim(),
    category: categoryFromUrl(v.thumbnail, '视频'),
    url: stripQuery(v.thumbnail),      // videoUrl 字段坏的，用 thumbnail 反推
    thumb: v.thumbnail || '',
  })).filter(v => v.url)

  const images = (all.images?.items || []).map(im => ({
    name: String(im.name || '').trim(),
    category: categoryFromUrl(im.thumbnail, '图片'),
    url: stripQuery(im.thumbnail),
    thumb: im.thumbnail || '',
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
      url: a.audioUrl || '',
      avatar: a.avatar || '',           // data URI，前端直接当头像用
    }
  }).filter(a => a.url)

  cache = {
    source: all.source || '',
    videos,
    images,
    audios,
    counts: { videos: videos.length, images: images.length, audios: audios.length },
  }
  return cache
}

module.exports = { load, reset: () => { cache = null } }
