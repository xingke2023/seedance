'use strict'

const str = v => String(v ?? '').trim()

// ═══ 角色定义原文锁 ═══
//
// 每个分镜都是一次独立生成，上一镜的角色定义一点都带不过来，所以每镜的 prompt_en
// 都要把角色重新定义一遍。问题是这句话原来由模型逐镜自己写 —— 同一个人这镜是
// 「穿深蓝色衬衫」，下镜就成了「穿深蓝色衬衫袖口挽起」，标签编号也可能对不上，
// 于是脸和衣服跟着一镜一变。
//
// 改成：定义句由后端拿**页面传来的角色原文**拼一次，逐镜一字不改地贴（和音色锁同一套路）。
// 模型仍旧要写它自己那句 —— 让它写是为了逼它想清楚这一镜有谁出场，句子本身不作数，
// 会被整句换掉。
//
// 页面拼给我们的角色原文，一行一个角色（voiceover-v3 和视频编辑器同一格式）：
//   角色「小李」绑定@图片1，外貌描述：30岁左右的都市白领男性，短发，戴细框眼镜
// `绑定@图片1` 后面可能还跟着音色绑定（`、音色@音频1`），一并放过
const DEF_LINE = /^\s*角色\s*[「『"']?(.*?)[」』"']?\s*绑定\s*[<@]?\s*图片\s*(\d+)\s*>?[^，,]*[，,]\s*外貌描述\s*[：:]\s*(.+)$/

// 模型逐镜自己写的定义句，连同它后面那串补充外貌的中文短句一起吃掉，到 `；` 为止 ——
// 分号后面是锁定短语（the same character, …），那些要留着。
// 逗号后紧跟英文的不吃：那已经是英文正文，不再是定义句的一部分。
// 捕获组：1=图片编号 2=定义为之前的外貌 3=主体编号 4=标签之后补写的中文短句（也是外貌）
const MODEL_DEF = /将[^；;。\n]{0,30}?[<@]?\s*图片\s*(\d+)\s*>?\s*中([^；;。\n]*?)定义为\s*[<【]?\s*主体\s*(\d+)\s*[>】]?((?:\s*[，,](?!\s*[A-Za-z])[^；;。，,\n]*)*)\s*[；;]?\s*/g

const SUBJ_TAG = /[<【]\s*主体\s*(\d+)\s*[>】]/g
const IMG_REF  = /[<@]?\s*图片\s*(\d+)\s*>?/g

function parseSubjectDefs(text) {
  const defs = new Map()
  for (const line of String(text || '').split('\n')) {
    const m = line.match(DEF_LINE)
    if (!m) continue
    const n = Number(m[2])
    const desc = str(m[3])
    // 没写外貌的（「见图片」「未提供」）不锁 —— 贴一句空定义还不如让模型照着图写
    if (!n || !desc || desc === '见图片' || desc === '未提供') continue
    // 同一行里可能还绑了音色：`角色「小李」绑定@图片1、音色@音频1，外貌描述：…`
    const av = line.match(/音色\s*[<@]?\s*音频\s*(\d+)/)
    defs.set(n, {
      name: str(m[1]),
      desc,
      audioRef: av ? Number(av[1]) : 0,
      anchor: `将@图片${n}中${desc}定义为<主体${n}>`,
    })
  }
  return defs
}

// 把一镜 prompt_en 里的角色定义换成原文，并把标签编号归一到图片编号。
function lockSubjectAnchors(promptEn, defs) {
  const text = String(promptEn || '')
  if (!text.trim() || defs.size === 0) return text

  const found = [...text.matchAll(MODEL_DEF)].filter(m => defs.has(Number(m[1])))
  const relabel = new Map()   // 模型给的主体编号 → 该角色绑定的图片编号
  const used = new Set()      // 这一镜出场的角色（按图片编号）
  for (const m of found) {
    relabel.set(Number(m[3]), Number(m[1]))
    used.add(Number(m[1]))
  }

  // 删掉模型写的定义句；第一句的位置留个记号，原文锚定句贴回原处 ——
  // 它前面通常是运镜和画幅、后面是锁定短语，两头都不该被挪动
  const MARK = '\u0002ANCHORS\u0002'
  let out = ''
  let cursor = 0
  found.forEach((m, i) => {
    out += text.slice(cursor, m.index) + (i === 0 ? MARK : '')
    cursor = m.index + m[0].length
  })
  out += text.slice(cursor)

  // 标签归一：<主体M> → 该角色的 <主体N>。先落成占位符，否则 1↔2 这种互换会自己撞上自己
  out = out
    .replace(SUBJ_TAG, (whole, label) => {
      const n = relabel.get(Number(label))
      return n ? `\u0001${n}\u0001` : whole
    })
    .replace(/\u0001(\d+)\u0001/g, '<主体$1>')

  // 定义句删掉后还提到谁，谁就得有定义 —— 模型漏写定义句、只用标签指代也算出场
  for (const re of [SUBJ_TAG, IMG_REF]) {
    for (const m of out.matchAll(re)) if (defs.has(Number(m[1]))) used.add(Number(m[1]))
  }

  const anchors = [...used].sort((a, b) => a - b).map(n => defs.get(n).anchor).join('；')
  if (!anchors) return out.replace(MARK, '')
  return out.includes(MARK) ? out.replace(MARK, `${anchors}；`) : `${anchors}；${out}`
}

// 没有原文时的兜底：从这条视频**自己的分镜**里把角色定义捞出来，挑最完整的一句当原文。
// 老数据（原文锁上线前生成的）根本没留下角色描述，唯一的外貌信息就散在各镜的定义句里 ——
// 与其让它们继续一镜一个样，不如统一到其中写得最全的那句。
function harvestDefs(prompts, existing = new Map()) {
  const best = new Map()
  for (const p of prompts) {
    for (const m of String(p || '').matchAll(MODEL_DEF)) {
      const n = Number(m[1])
      if (!n || existing.has(n)) continue          // 有原文的角色不动
      const desc = [str(m[2]), str(m[4]).replace(/^[，,]\s*/, '')].filter(Boolean).join('，')
      if (!desc) continue
      const prev = best.get(n)
      if (!prev || desc.length > prev.length) best.set(n, desc)
    }
  }
  const defs = new Map(existing)
  for (const [n, desc] of best) {
    defs.set(n, { name: '', desc, anchor: `将@图片${n}中${desc}定义为<主体${n}>`, harvested: true })
  }
  return defs
}

module.exports = { parseSubjectDefs, lockSubjectAnchors, harvestDefs }
