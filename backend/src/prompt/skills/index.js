'use strict'

// 分镜提示词的「手艺」不写在代码里，写成这个目录下的 markdown skill —— 每个文件一段手艺，
// front matter 声明它在什么情况下生效。加一条手艺 = 丢一个 .md 进来，不用改代码。
//
// front matter：
//   name / title / priority / when（人读的说明）/ source（出处，改写时要能追回上游）
//   when_<字段>[_lte|_gte]  生效条件，全部满足才装载（AND）。不写就是不限制。
//
// 支持的 <字段> 就是 buildContext() 造出来的那些：
//   video_type            story | narration
//   narrative_structure   free | qczh
//   ratio                 16:9 / 9:16 / 21:9 …
//   shot_count            镜头数
//   total_seconds         总时长（秒，解析自 duration_total）
//   has_subjects          有没有绑定角色
//   has_reference_media   有没有参考视频/音频
//   has_dialogue          这条片子会不会有人物对白（叙事短片才有）
//   has_slogan            有没有指定要渲进画面的广告语
//
// 条件值是逗号分隔的候选（命中其一即可），布尔写 true/false，
// 数值用 _lte / _gte 后缀比较。上下文里缺这个字段 = 不匹配 —— 宁可少装一条手艺，
// 也不要在信息不全时把不相干的规则塞给模型。

const fs = require('fs')
const path = require('path')

const SKILL_DIR = __dirname

function parseSkill(file) {
  const raw = fs.readFileSync(path.join(SKILL_DIR, file), 'utf8')
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) throw new Error(`skill ${file} 缺少 front matter`)
  const meta = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  const conditions = Object.entries(meta)
    .filter(([k]) => k.startsWith('when_'))
    .map(([k, v]) => {
      const raw = k.slice(5)
      const op = raw.endsWith('_lte') ? 'lte' : raw.endsWith('_gte') ? 'gte' : 'in'
      const field = op === 'in' ? raw : raw.slice(0, -4)
      return { field, op, value: v.split(',').map(x => x.trim()).filter(Boolean) }
    })
  return {
    file,
    name: meta.name || file.replace(/\.md$/, ''),
    title: meta.title || '',
    when: meta.when || '',
    source: meta.source || '',
    priority: parseInt(meta.priority, 10) || 50,
    conditions,
    body: raw.slice(m[0].length).trimEnd(),
  }
}

// 启动时读一次。skill 是随代码发布的静态资源，热加载只会让「当前跑的是哪一版」变得说不清。
const SKILLS = fs.readdirSync(SKILL_DIR)
  .filter(f => f.endsWith('.md') && f !== 'SOURCES.md')
  .map(parseSkill)
  .sort((a, b) => a.priority - b.priority)

function matches(cond, ctx) {
  const actual = ctx[cond.field]
  if (actual === undefined || actual === null || actual === '') return false
  if (cond.op === 'in') return cond.value.includes(String(actual))
  const n = Number(actual)
  const bound = Number(cond.value[0])
  if (!Number.isFinite(n) || !Number.isFinite(bound)) return false
  return cond.op === 'lte' ? n <= bound : n >= bound
}

/** "约50秒" / "1分30秒" / "90" → 秒。解析不出来返回 undefined，条件就不会命中。 */
function parseSeconds(text) {
  const s = String(text || '')
  const min = s.match(/(\d+(?:\.\d+)?)\s*(?:分钟|分|min)/i)
  const sec = s.match(/(\d+(?:\.\d+)?)\s*(?:秒|s\b)/i)
  if (min || sec) return (min ? parseFloat(min[1]) * 60 : 0) + (sec ? parseFloat(sec[1]) : 0)
  const bare = s.match(/(\d+(?:\.\d+)?)/)
  return bare ? parseFloat(bare[1]) : undefined
}

/** 把一次分镜请求归纳成 skill 的选择依据。 */
function buildContext({
  videoType, narrativeStructure, ratio, shotCount, durationTotal,
  subjectDefinitions, mediaDescriptions, slogan,
}) {
  const media = String(mediaDescriptions || '')
  return {
    video_type: videoType === 'narration' ? 'narration' : 'story',
    narrative_structure: narrativeStructure === 'qczh' ? 'qczh' : 'free',
    ratio: String(ratio || '').trim() || undefined,
    shot_count: shotCount,
    total_seconds: parseSeconds(durationTotal),
    has_subjects: String(!!String(subjectDefinitions || '').trim()),
    has_reference_media: String(/视频\s*\d|音频\s*\d/.test(media)),
    has_dialogue: String(videoType !== 'narration'),
    has_slogan: String(!!String(slogan || '').trim()),
  }
}

/** 这次请求会装载哪些 skill，已按 priority 排好。 */
function selectSkills(ctx) {
  return SKILLS.filter(s => s.conditions.every(c => matches(c, ctx)))
}

/** 直接拼成追加到 user message 末尾的那段文本。 */
function buildCraft(ctx) {
  return selectSkills(ctx).map(s => `\n${s.body}\n`).join('')
}

/**
 * 给 /prompt/skills 用：不含正文，正文是喂模型的。
 * 传 ctx 就额外标出这次会不会装载，不传只列清单。
 */
function describeSkills(ctx) {
  return SKILLS.map(s => ({
    name: s.name,
    title: s.title,
    when: s.when,
    source: s.source,
    priority: s.priority,
    conditions: s.conditions.map(c => `${c.field} ${c.op} ${c.value.join('|')}`),
    ...(ctx ? { active: s.conditions.every(c => matches(c, ctx)) } : {}),
  }))
}

module.exports = { buildContext, selectSkills, buildCraft, describeSkills }
