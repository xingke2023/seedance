'use strict'

const Anthropic = require('@anthropic-ai/sdk')
const { jsonrepair } = require('jsonrepair')

// tokens.fidelityai.net is a proxy in front of Bedrock-served Claude models.
// It does NOT carry claude-opus-5 — claude-sonnet-5 is the most capable model
// available through it (verified 2026-08-19).
const MODEL     = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'
const BASE_URL  = (process.env.ANTHROPIC_BASE_URL || 'https://tokens.fidelityai.net').replace(/\/$/, '')
const API_KEY   = process.env.ANTHROPIC_API_KEY

let _client
function getClient(apiKey) {
  const key = apiKey || API_KEY
  if (!key) throw new Error('未配置 ANTHROPIC_API_KEY')
  if (apiKey) return new Anthropic({ apiKey, baseURL: BASE_URL })
  if (!_client) _client = new Anthropic({ apiKey: key, baseURL: BASE_URL })
  return _client
}

/**
 * One-shot Claude call.
 * max_tokens caps thinking + response text together, so callers that ask for
 * long JSON need headroom well above the expected output size.
 */
async function callClaude({ system, user, maxTokens = 4096, effort = 'medium', apiKey }) {
  const client = getClient(apiKey)
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      thinking: { type: 'adaptive' },
      output_config: { effort },
      messages: [{ role: 'user', content: user }],
    })

    if (res.stop_reason === 'refusal') {
      throw new Error('模型拒绝了该请求，请调整输入内容')
    }

    const text = res.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')

    if (res.stop_reason === 'max_tokens' && !text.trim()) {
      throw new Error('输出被 max_tokens 截断，请减少输入或提高上限')
    }

    return {
      text,
      truncated: res.stop_reason === 'max_tokens',
      usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
    }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('Anthropic API Key 无效')
    if (err instanceof Anthropic.RateLimitError)      throw new Error('请求过于频繁，请稍后重试')
    if (err instanceof Anthropic.NotFoundError)       throw new Error(`模型 ${MODEL} 不可用，请检查 ANTHROPIC_MODEL`)
    throw err
  }
}

/**
 * The JSON-emitting prompts tell the model to output bare JSON, but it may still
 * wrap it in prose or code fences, and long Chinese strings occasionally carry raw
 * control characters. Slice to the outermost braces, then let jsonrepair fix the rest.
 */
function parseJson(text) {
  let s = String(text || '').trim()
  const start = s.indexOf('{')
  const end   = s.lastIndexOf('}')
  if (start !== -1 && end > start) s = s.slice(start, end + 1)

  try {
    return JSON.parse(s)
  } catch {
    return JSON.parse(jsonrepair(s))
  }
}

module.exports = { callClaude, parseJson, MODEL }
