'use strict'

// 清理项目角色里因「换头像」重复建出来的 project_subjects 行。
//
// 起因：voiceover-v3 的 assignAssetAvatar() 原来每点一次换头像就 POST 一条新主体，
// 同一个 Asset ID 换来换去就堆出十几行同名同图的重复项（已修：前端先查复用，
// 后端 POST /projects/:id/subjects 也按 asset_id 幂等）。这个脚本收拾存量。
//
//   node backend/scripts/dedupe-project-subjects.js                       # 全库演练
//   node backend/scripts/dedupe-project-subjects.js --project <id>        # 只看一个项目
//   node backend/scripts/dedupe-project-subjects.js --project <id> --apply
//
// 规则（保守，只删确定没用的）：
//   - 只处理 asset_id 非空、且同一项目里同一个 asset_id 出现多行的组
//   - 组内**被 video_subjects 引用过的行一律保留**（删了会让那条视频的角色消失）
//   - 其余没被任何视频引用的行删掉；如果整组都没被引用，保留最早建的那一行
//   - asset_id 为空的行（手工建的项目角色）一概不动

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { query } = require('../src/db')

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const projectId = args.includes('--project') ? args[args.indexOf('--project') + 1] : null

;(async () => {
  const rows = (await query(
    `SELECT ps.id, ps.project_id, ps.label, ps.asset_id, ps.created_at,
            (SELECT count(*) FROM video_subjects vs WHERE vs.subject_id = ps.id) AS refs
       FROM project_subjects ps
      WHERE ps.asset_id IS NOT NULL AND ps.asset_id <> ''
        ${projectId ? 'AND ps.project_id = $1' : ''}
      ORDER BY ps.project_id, ps.asset_id, ps.created_at, ps.id`,
    projectId ? [projectId] : []
  )).rows

  const groups = new Map()
  for (const r of rows) {
    const key = `${r.project_id}|${r.asset_id}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }

  const doomed = []
  for (const [key, list] of groups) {
    if (list.length < 2) continue                       // 不是重复组
    const used = list.filter(r => Number(r.refs) > 0)
    const keep = used.length > 0 ? used : [list[0]]     // 全没引用就留最早的那行
    const drop = list.filter(r => !keep.includes(r))
    if (drop.length === 0) continue
    const [proj, asset] = key.split('|')
    console.log(`\n项目 ${proj} · ${asset} —— 共 ${list.length} 行，保留 ${keep.length}，删除 ${drop.length}`)
    keep.forEach(r => console.log(`  保留 ${r.id}  refs=${r.refs}  ${r.label}`))
    drop.forEach(r => console.log(`  删除 ${r.id}  refs=${r.refs}  ${r.label}`))
    doomed.push(...drop.map(r => r.id))
  }

  if (doomed.length === 0) {
    console.log('\n没有需要清理的重复角色。')
    process.exit(0)
  }

  if (!APPLY) {
    console.log(`\n【演练】以上 ${doomed.length} 行会被删除。确认无误后加 --apply 真正执行。`)
    process.exit(0)
  }

  const res = await query(`DELETE FROM project_subjects WHERE id = ANY($1::uuid[])`, [doomed])
  console.log(`\n已删除 ${res.rowCount} 行。`)
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
