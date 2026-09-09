'use strict'

// 把库里存量的预设素材地址换成本机 ASCII 地址。
//
//   node backend/scripts/relink-material-urls.js           # 演练，只打印
//   node backend/scripts/relink-material-urls.js --apply   # 真的写库
//
// 背景：预设素材原来存的是 volces 的外链（路径里全是中文），或者早先转存时用中文文件名
// 落地的本机地址。中文地址交给 Seedance / ffmpeg 去取，中间谁少做一次 URL 编码就取不到。
// 现在本机副本一律是 ASCII（materials.js 的 asciiRel），这个脚本把存量数据也指过去。
//
// **两处必须一起改**：video_media.url（参考素材本身）和 videos.params.scriptAnalysis[].linkedAudioUrl
// （角色绑的音色，按 url 认人）—— 只改一边，角色的音色绑定就断了。

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const { query } = require('../src/db')
const { load } = require('../src/lib/materials')

const APPLY = process.argv.includes('--apply')

;(async () => {
  const remote = load({ local: false })   // 原始外链
  const local  = load()                   // 本机 ASCII 地址（没副本的仍是外链）

  // 旧地址（外链，以及早先中文文件名的本机地址）→ 新的本机 ASCII 地址
  const map = new Map()
  for (const kind of ['audios', 'videos', 'images']) {
    remote[kind].forEach((r, i) => {
      const now = local[kind].find(x => x.name === r.name)?.url
      if (!now || !now.includes('/uploads/materials/') || now === r.url) return
      map.set(r.url, now)                                   // volces 外链
      map.set(encodeURI(r.url), now)                        // 转义写法
      const legacy = r.url.replace(/^.*\/materials\//, '')  // 中文相对路径
      map.set(`__legacy__/${legacy}`, now)
    })
  }
  const remap = (u) => {
    const s = String(u || '')
    if (!s || s.includes('/uploads/materials/audio/') || s.includes('/uploads/materials/video/') || s.includes('/uploads/materials/image/')) return null
    const direct = map.get(s) || map.get(decodeURI(s))
    if (direct) return direct
    const m = s.match(/\/uploads\/materials\/(.+)$/)         // 本机中文文件名的老地址
    if (m) return map.get(`__legacy__/${decodeURIComponent(m[1])}`) || null
    return null
  }

  // ① video_media
  const media = await query(`SELECT id, url FROM video_media WHERE url LIKE '%materials%'`)
  const mediaFix = media.rows.map(r => ({ id: r.id, from: r.url, to: remap(r.url) })).filter(x => x.to)
  console.log(`video_media：${media.rows.length} 条含 materials，其中 ${mediaFix.length} 条要改`)
  mediaFix.slice(0, 8).forEach(x => console.log(`  ${x.from}\n    → ${x.to}`))

  // ② videos.params.scriptAnalysis[].linkedAudioUrl
  const vids = await query(`SELECT id, params FROM videos WHERE params::text LIKE '%linkedAudioUrl%'`)
  const vidFix = []
  for (const v of vids.rows) {
    const p = v.params || {}
    const arr = Array.isArray(p.scriptAnalysis) ? p.scriptAnalysis : []
    let touched = false
    const next = arr.map(a => {
      const to = remap(a.linkedAudioUrl)
      if (!to) return a
      touched = true
      return { ...a, linkedAudioUrl: to }
    })
    if (touched) vidFix.push({ id: v.id, params: { ...p, scriptAnalysis: next } })
  }
  console.log(`videos.params：${vids.rows.length} 条带音色绑定，其中 ${vidFix.length} 条要改`)

  if (!APPLY) {
    console.log('\n演练结束，没有写库。确认无误后加 --apply')
    process.exit(0)
  }
  for (const x of mediaFix) await query(`UPDATE video_media SET url=$1 WHERE id=$2`, [x.to, x.id])
  for (const v of vidFix)   await query(`UPDATE videos SET params=$1 WHERE id=$2`, [JSON.stringify(v.params), v.id])
  console.log(`\n已写库：video_media ${mediaFix.length} 条，videos ${vidFix.length} 条`)
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
