'use strict'

// 写完整对白剧本（不管镜头）。两个地方共用同一份拼法，不能各写一遍：
//   /prompt/storyboard   叙事短片第一步——先写剧本，第二步再开拍成分镜（见 routes/prompt.js）
//   /voiceover/analyze-script（剧本分析按钮）——先写剧本，再从剧本里提取角色
// 两处对同一件事的理解必须一致，否则「剧本分析」写出来的剧本和「生成分镜脚本」
// 自己写的剧本会是两种腔调。

const { callClaude } = require('./engine')
const { SCRIPT_SYSTEM, SCRIPT_REWRITE_SYSTEM } = require('./prompts')
const { parseSubjectDefs } = require('./anchor')

const str = v => String(v ?? '').trim()

// stage 1（SCRIPT_SYSTEM）用的角色名单：只要名字+外貌，不要 @图片N 这套绑定语法——
// 这一步还没有镜头，模型不该也不需要知道图片编号。复用 anchor.js 的解析器而不是
// 另写一遍正则，两处对同一行文本的理解必须一致，否则角色名字会在两步之间对不上。
function scriptRoster(subjectDefs) {
  const defs = parseSubjectDefs(subjectDefs)
  return [...defs.values()]
    .filter(d => d.name && d.desc)
    .map(d => `${d.name}：${d.desc}`)
    .join('\n')
}

async function writeScript({
  concept, creativeGoal, targetAudience, overallTone, keyMessages, durationTotal,
  subjectDefs, apiKey, onText,
}) {
  const parts = [`故事种子：${str(concept)}`]
  const opt = (label, v) => { if (str(v)) parts.push(`${label}：${str(v)}`) }
  opt('创作目标', creativeGoal)
  opt('目标受众', targetAudience)
  opt('整体基调', overallTone)
  opt('核心信息', keyMessages)
  opt('总时长',   durationTotal)
  const roster = scriptRoster(subjectDefs)
  if (roster) parts.push(`\n出场角色：\n${roster}`)

  const { text } = await callClaude({
    system: SCRIPT_SYSTEM, user: parts.join('\n'),
    maxTokens: 12000, effort: 'medium', apiKey, onText,
  })
  return text
}

// 「AI改写」按钮：拿已经写好（或用户手改过）的剧本原文 + 一句改写要求，让模型只按
// 要求改，其余照抄。和 writeScript 是两个不同的系统提示词——写剧本是从零构思，
// 改写是带着约束的编辑，两件事的原则不一样，不能共用一个 system。
async function rewriteScript({ script, instruction, apiKey, onText }) {
  const user = `原剧本：\n${str(script)}\n\n修改要求：\n${str(instruction)}`
  const { text } = await callClaude({
    system: SCRIPT_REWRITE_SYSTEM, user,
    maxTokens: 12000, effort: 'medium', apiKey, onText,
  })
  return text
}

module.exports = { writeScript, scriptRoster, rewriteScript }
