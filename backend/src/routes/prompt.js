'use strict'

const { callClaude, parseJson, MODEL } = require('../prompt/engine')
const {
  SINGLE_SHOT_SYSTEM,
  QCZH_SYSTEM,
  STORYBOARD_SYSTEM,
  ENHANCE_SYSTEM,
  NARRATION_SYSTEM,
  DIALOGUE_SYSTEM,
} = require('../prompt/prompts')

const str = v => String(v ?? '').trim()

async function promptRoutes(fastify) {

  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ success: false, error: '未登录' })
  })

  fastify.get('/model', async () => ({ success: true, data: { model: MODEL } }))

  // ═══ 单镜头提示词生成 ═══

  fastify.post('/generate', async (request, reply) => {
    const b = request.body || {}
    const fields = [
      ['主体',     str(b.subject)],
      ['动作',     str(b.action)],
      ['场景',     str(b.scene)],
      ['镜头',     str(b.camera)],
      ['构图',     str(b.composition)],
      ['视觉风格', str(b.style)],
      ['光线',     str(b.lighting)],
      ['色调',     str(b.color_tone)],
      ['氛围',     str(b.mood)],
      ['质量词',   str(b.quality)],
      ['时长',     str(b.duration)],
      ['首帧',     str(b.first_frame)],
      ['末帧',     str(b.last_frame)],
      ['补充',     str(b.description)],
    ]

    if (!fields[0][1] && !fields[1][1]) {
      return reply.code(400).send({ success: false, error: '请填写主体描述或动作' })
    }

    try {
      const user = '生成 Seedance 提示词：\n\n' +
        fields.filter(([, v]) => v).map(([k, v]) => `${k}：${v}`).join('\n')
      // Markdown output, not JSON — no repair step needed.
      const { text, usage } = await callClaude({
        system: SINGLE_SHOT_SYSTEM, user, maxTokens: 4096, effort: 'low', apiKey: str(b.api_key) || undefined,
      })
      return { success: true, data: { result: text, usage } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: `生成失败：${err.message}` })
    }
  })

  // ═══ 提示词优化 ═══

  fastify.post('/enhance', async (request, reply) => {
    const b = request.body || {}
    const raw = str(b.prompt)
    if (!raw) return reply.code(400).send({ success: false, error: '请输入需要优化的提示词' })

    try {
      const { text, usage } = await callClaude({
        system: ENHANCE_SYSTEM, user: `优化：${raw}`, maxTokens: 4096, effort: 'low',
        apiKey: str(b.api_key) || undefined,
      })
      let parsed
      try {
        parsed = parseJson(text)
      } catch {
        // The prompt asks for JSON but a plain rewrite is still usable output.
        parsed = { prompt: text, explanation: '', tags: [] }
      }
      return { success: true, data: { result: parsed, usage } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: `优化失败：${err.message}` })
    }
  })

  // ═══ 多镜头分镜脚本 ═══

  fastify.post('/storyboard', async (request, reply) => {
    const b = request.body || {}
    const concept = str(b.concept)
    if (!concept) return reply.code(400).send({ success: false, error: '请输入视频概念描述' })

    const narrativeStructure = str(b.narrative_structure) || 'free'  // free | qczh
    const videoType          = str(b.video_type) || 'story'          // story | narration
    const shotCount          = Math.min(20, Math.max(1, parseInt(b.shot_count, 10) || 5))

    const parts = [`视频概念：${concept}`]
    const opt = (label, v) => { if (v) parts.push(`${label}：${v}`) }
    opt('创作目标', str(b.creative_goal))
    opt('目标受众', str(b.target_audience))
    opt('整体基调', str(b.overall_tone))
    opt('核心信息', str(b.key_messages))
    opt('总时长',   str(b.duration_total))

    // 角色/素材锚定。系统提示词是逐字移植的，不动它 —— 这些和创作目标一样
    // 走 user message。没有这段，产出的 prompt_en 不会引用已上传的人像，
    // Seedance 也就锁不住角色形象。
    const subjectDefs = str(b.subject_definitions)
    const imageDescs  = str(b.image_descriptions)
    if (subjectDefs || imageDescs) {
      parts.push('')
      parts.push('本视频已绑定以下角色/参考素材：')
      if (subjectDefs) parts.push(subjectDefs)
      if (imageDescs)  parts.push(imageDescs)
      parts.push(
        '要求：凡是画面中出现上述角色的镜头，prompt_en 必须以 <图片N> 的形式引用对应素材编号' +
        '（例如 The woman in <图片 1> walks through …），保证多个镜头之间人物形象一致；' +
        '未出现角色的空镜不必引用。'
      )
    }

    let system, user
    if (videoType === 'narration') {
      parts.push(`镜头数量：${shotCount}个镜头`)
      system = NARRATION_SYSTEM
      user = '请用旁白解说风格生成分镜脚本：\n\n' + parts.join('\n')
    } else if (narrativeStructure === 'qczh') {
      // 起承转合 needs at least one shot per movement.
      parts.push(`总镜头数：${Math.max(4, shotCount)}个（按起承转合四段分配，其中'转'只有1个镜头）`)
      system = QCZH_SYSTEM
      user = '请用起承转合结构生成分镜脚本：\n\n' + parts.join('\n')
    } else {
      parts.push(`镜头数量：${shotCount}个镜头`)
      system = STORYBOARD_SYSTEM
      user = parts.join('\n')
    }

    try {
      // Storyboards are the longest output here, and max_tokens caps thinking +
      // text together on adaptive-thinking models — hence the wide ceiling.
      const { text, usage, truncated } = await callClaude({
        system, user, maxTokens: 16000, effort: 'medium', apiKey: str(b.api_key) || undefined,
      })

      let storyboard
      try {
        storyboard = parseJson(text)
      } catch (e) {
        request.log.error({ err: e, raw: text.slice(0, 500) }, 'storyboard JSON parse failed')
        return reply.code(500).send({
          success: false,
          error: truncated ? '分镜结果被截断，请减少镜头数量后重试' : `解析分镜结果失败：${e.message}`,
          raw: text,
        })
      }

      // 叙事短片第二步：补台词。STORYBOARD / QCZH 只产画面，没有台词字段，
      // 而换引擎前 /voiceover/init 是会逐镜生成字幕的 —— 不补这一步，叙事短片
      // 就没有字幕也没法配音。解说纪录片自带 narration_script，跳过。
      // 失败不阻断：宁可交付没台词的分镜，也不要整个请求失败。
      if (videoType !== 'narration' && Array.isArray(storyboard.shots) && storyboard.shots.length > 0) {
        try {
          const outline = storyboard.shots
            .map(sh => `${sh.shot_number}. [${sh.duration}] ${sh.description_zh || ''}`)
            .join('\n')
          const { text: dText } = await callClaude({
            system: DIALOGUE_SYSTEM,
            user: `视频概念：${concept}\n\n分镜画面：\n${outline}`,
            maxTokens: 8000,
            effort: 'low',
            apiKey: str(b.api_key) || undefined,
          })
          const byNumber = new Map(
            (parseJson(dText).subtitles || []).map(x => [Number(x.shot_number), str(x.subtitle)])
          )
          storyboard.shots.forEach((sh, i) => {
            sh.subtitle = byNumber.get(Number(sh.shot_number)) || byNumber.get(i + 1) || ''
          })
        } catch (e) {
          request.log.warn({ err: e }, 'dialogue pass failed; shots keep empty subtitles')
        }
      }

      // 把 prompt_en 里的 <图片N> 提成结构化的 image_refs，导入分镜时才能把真实
      // 素材挂上去。从文本解析而不是让模型多输出一个字段：系统提示词规定了严格的
      // JSON 结构，模型漏写一个新字段的概率，远高于漏写它刚写进 prompt 的引用。
      const IMG_REF = /<图片\s*(\d+)\s*>/g
      for (const shot of storyboard.shots || []) {
        const refs = new Set()
        for (const m of String(shot.prompt_en || '').matchAll(IMG_REF)) {
          refs.add(parseInt(m[1], 10))
        }
        shot.image_refs = [...refs].sort((a, b) => a - b)
      }

      storyboard.narrative_structure = narrativeStructure
      storyboard.video_type = videoType
      return { success: true, data: { result: storyboard, usage } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: `分镜生成失败：${err.message}` })
    }
  })
}

module.exports = promptRoutes
