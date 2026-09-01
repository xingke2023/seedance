#!/usr/bin/env node
'use strict'

// 存量分镜的角色定义原文锁（见 CLAUDE.md「角色定义原文锁」）。
//
// 原文锁上线之前生成的分镜，定义句是模型逐镜自己写的 —— 同一个人这镜「穿深蓝色衬衫」、
// 下镜「穿深蓝色衬衫袖口挽起」。新生成的分镜和新提交的任务都会被锁住，这个脚本管的是
// **已经存在库里、还没重新提交过**的那批。
//
//   node backend/scripts/relock-shot-anchors.js            # 演练，只打印会改什么
//   node backend/scripts/relock-shot-anchors.js --apply    # 真的写库
//   node backend/scripts/relock-shot-anchors.js --video <id> [--apply]   # 只处理一条视频
//
// 角色原文按页面同一套规则重建：带图主体按 video_subjects 的顺序排 @图片1..N，
// 外貌取 videos.params.scriptAnalysis 里关联到该主体的 appearance，没有就退回
// project_subjects.description。编号规则和 `/videos/:id` 的返回顺序一致 —— 这两处
// 一旦漂移，角色就会锚到别人的图上，所以那条查询已经钉死了 ORDER BY。

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { query } = require('../src/db')
const { parseSubjectDefs, lockSubjectAnchors, harvestDefs } = require('../src/prompt/anchor')

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const videoArg = args.indexOf('--video')
const ONLY_VIDEO = videoArg >= 0 ? args[videoArg + 1] : null

const oneLine = v => String(v || '').replace(/\s*\n+\s*/g, '，').trim()

async function buildDefs(video) {
  const { rows: subjects } = await query(
    `SELECT ps.* FROM video_subjects vs JOIN project_subjects ps ON ps.id = vs.subject_id
      WHERE vs.video_id=$1 ORDER BY vs.created_at, vs.id`,
    [video.id]
  )
  const withImage = subjects.filter(s => s.image_url)
  if (withImage.length === 0) return null

  const analysis = Array.isArray(video.params?.scriptAnalysis) ? video.params.scriptAnalysis : []
  const lines = withImage.map((s, i) => {
    const a = analysis.find(x => x.linkedSubjectId === s.id)
    const label = a?.label || s.label
    const desc = oneLine(a?.appearance || s.description) || '见图片'
    return `角色「${label}」绑定@图片${i + 1}，外貌描述：${desc}`
  })
  return parseSubjectDefs(lines.join('\n'))
}

async function main() {
  const { rows: videos } = await query(
    ONLY_VIDEO
      ? `SELECT id, name, params FROM videos WHERE id=$1`
      : `SELECT id, name, params FROM videos ORDER BY created_at`,
    ONLY_VIDEO ? [ONLY_VIDEO] : []
  )

  let scanned = 0, changed = 0, videosTouched = 0
  for (const video of videos) {
    const defs = (await buildDefs(video)) || new Map()

    const { rows: shots } = await query(
      `SELECT id, shot_number, prompt FROM shots WHERE video_id=$1 ORDER BY shot_number`,
      [video.id]
    )
    // 没有原文的角色：从这条视频自己的分镜里捞一句最全的当原文
    const allDefs = harvestDefs(shots.map(sh => sh.prompt), defs)
    if (allDefs.size === 0) continue
    const updates = []
    for (const shot of shots) {
      scanned++
      const locked = lockSubjectAnchors(shot.prompt, allDefs)
      if (locked && locked !== shot.prompt) updates.push({ ...shot, locked })
    }
    if (updates.length === 0) continue

    videosTouched++
    console.log(`\n── ${video.name || video.id}（${video.id}）`)
    console.log(`   原文：${[...allDefs.values()].map(d => d.anchor + (d.harvested ? '（捞自分镜）' : '')).join('  |  ')}`)
    for (const u of updates) {
      changed++
      // 只打定义句那一段 —— 前后都是没动过的运镜和画面描述，全打出来反而看不出差异
      const defSpan = t => { const i = t.indexOf('将@图片'); if (i < 0) return '（无定义句）'
        const j = t.indexOf('；', i); return j < 0 ? t.slice(i, i + 120) : t.slice(i, j) }
      console.log(`   镜${u.shot_number}: ${defSpan(u.prompt)}`)
      console.log(`        → ${defSpan(u.locked)}`)
      if (APPLY) await query('UPDATE shots SET prompt=$1, updated_at=NOW() WHERE id=$2', [u.locked, u.id])
    }
  }

  console.log(`\n扫描 ${scanned} 个分镜，涉及 ${videosTouched} 条视频，需要改写 ${changed} 个。`)
  console.log(APPLY ? '已写库。' : '这是演练 —— 加 --apply 才真的写库。')
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
