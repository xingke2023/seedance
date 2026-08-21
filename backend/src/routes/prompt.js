'use strict'

const { randomUUID } = require('crypto')
const { callClaude, parseJson, MODEL } = require('../prompt/engine')
const {
  SINGLE_SHOT_SYSTEM,
  QCZH_SYSTEM,
  STORYBOARD_SYSTEM,
  ENHANCE_SYSTEM,
  NARRATION_SYSTEM,
  DIALOGUE_SYSTEM,
} = require('../prompt/prompts')
const { buildContext, buildCraft, selectSkills, describeSkills } = require('../prompt/skills')

const str = v => String(v ?? '').trim()

// 对白直接写进 prompt_en —— 叙事短片开着 generate_audio，Seedance 会照着提示词里的
// 台词生成人声和口型。句式固定用 `X says: “台词”`：口型是按引号里的字对齐的，
// 而这个英文句式是 Seedance 识别台词的钩子（见 OpenMontage 的 seedance-2-0/SKILL.md）。
// 台词本身保留中文原文 —— 翻成英文就改动了要说出口的字。
// 音色是**条件句不是素材**：同一个角色的那句音色描述要一字不改地贴进他说话的每一个镜头，
// 换措辞音色就会漂 —— 我们每个分镜是一次独立生成，不贴的话人声逐镜都不一样。
//
// 音色条件句有两种写法，取决于这条片子挂没挂参考音频：
//   挂了 → `X 使用@音频N<中文音色描述>的音色说话`（Seedance 官方约定：光给编号不描述音色
//          会飘，中文描述要覆盖音高/质感/年龄性别）
//   没挂 → `Voice of X: <英文音色描述>`
// 两者只取其一 —— 同时给两套音色说明会互相打架。台词行 `X says: “…”` 两种情况都不动。
function appendSpeech(promptEn, lines, voices) {
  const speakers = [...new Set(lines.map(l => l.speaker))]
  const voiceLines = speakers
    .map(sp => [sp, voices.get(sp)])
    .filter(([, v]) => v && (v.voiceZh && v.audioRef || v.voiceEn))
    .map(([sp, v]) => {
      const who = lines.find(l => l.speaker === sp).speaker_en || sp
      return v.audioRef && v.voiceZh
        ? `${who} 使用@音频${v.audioRef}${v.voiceZh}的音色说话`
        : `Voice of ${who}: ${v.voiceEn}`
    })
  const speech = lines.map((l, i) => {
    const who  = l.speaker_en || l.speaker
    const verb = i === 0 ? 'says'
      : lines[i - 1].speaker === l.speaker ? 'continues' : 'replies'
    return `${who} ${verb}: “${l.text}”`
  })
  // 「spoken aloud only, never rendered as on-screen text」是踩坑后加的：
  // 提示词里带引号的台词会诱使模型把台词渲成画面里的字幕，和后期烧的那层重叠。
  return `${str(promptEn)}\n\nDialogue (spoken aloud on camera, lip-synced; ` +
    `spoken audio only, never rendered as on-screen text or subtitles):\n` +
    [...voiceLines, ...speech].join('\n')
}

async function promptRoutes(fastify) {

  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ success: false, error: '未登录' })
  })

  fastify.get('/model', async () => ({ success: true, data: { model: MODEL } }))

  // 当前装了哪些拍摄手艺、各自什么时候生效、出处是哪 —— 不含正文，正文是喂模型的。
  // 带上和 /storyboard 同名的 query（video_type / ratio / …）可以预览这一组条件会装载哪几条。
  fastify.get('/skills', async (request) => {
    const q = request.query || {}
    const hasCtx = Object.keys(q).length > 0
    const ctx = hasCtx ? buildContext({
      videoType: str(q.video_type), narrativeStructure: str(q.narrative_structure),
      ratio: str(q.ratio), shotCount: parseInt(q.shot_count, 10) || undefined,
      durationTotal: str(q.duration_total),
      subjectDefinitions: str(q.subject_definitions), mediaDescriptions: str(q.image_descriptions),
    }) : null
    return { success: true, data: { context: ctx, skills: describeSkills(ctx) } }
  })

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
    // 视觉风格要进 user message —— 不给，模型会跟着参考图的风格走（见 style-lock）
    opt('视觉风格', str(b.style))
    // 广告语：唯一允许 Seedance 直接渲进画面的文字（见 in-video-slogan）
    const slogan = str(b.slogan)
    if (slogan) parts.push(`画面内广告语（只放在收尾镜，一字不改）：${slogan}`)

    // 角色/素材锚定。系统提示词是逐字移植的，不动它 —— 这些和创作目标一样
    // 走 user message。没有这段，产出的 prompt_en 不会引用已上传的人像，
    // Seedance 也就锁不住角色形象。
    const subjectDefs = str(b.subject_definitions)
    const imageDescs  = str(b.image_descriptions)
    // 参考音频清单（素材说明里的「音频N：…」行）。挂了音频，补台词那一步就改用
    // @音频N 锁音色，而不是让模型凭空写一句英文音色描述。
    const audioAssets = [...imageDescs.matchAll(/^\s*音频\s*(\d+)\s*[：:]\s*(.*)$/gm)]
      .map(m => ({ n: Number(m[1]), desc: str(m[2]) }))
      .filter(a => a.n > 0)
    if (subjectDefs || imageDescs) {
      parts.push('')
      parts.push('本视频已绑定以下角色/参考素材：')
      if (subjectDefs) parts.push(subjectDefs)
      if (imageDescs)  parts.push(imageDescs)
      parts.push(
        '要求：Seedance 提示词里可以用 @图片N / @视频N / @音频N 直接指代随请求发出的第 N 个' +
        '该类型素材（三种类型各自从 1 开始编号，与上面列出的编号一致）。' +
        '凡是画面中出现上述角色的镜头，prompt_en 必须以 @图片N 引用对应素材' +
        '（例如 The woman in @图片1 walks through …），保证多个镜头之间人物形象一致；' +
        '参考视频用来对齐运镜或动作时写 @视频N，参考音频写 @音频N；未用到素材的空镜不必引用。'
      )
    }

    // 拍摄手艺按这次请求的情况从技能库里挑（backend/src/prompt/skills/*.md，选择逻辑在
    // 那个目录的 index.js）：视频类型、画幅、有没有角色、有没有参考视频音频…
    // 系统提示词管叙事框架和 JSON 结构，skill 管一个镜头怎么写成提示词。
    const skillCtx = buildContext({
      videoType, narrativeStructure, ratio: str(b.ratio), shotCount,
      durationTotal: str(b.duration_total),
      subjectDefinitions: subjectDefs, mediaDescriptions: imageDescs, slogan,
    })
    const craft = buildCraft(skillCtx)

    let system, user
    if (videoType === 'narration') {
      parts.push(`镜头数量：${shotCount}个镜头`)
      system = NARRATION_SYSTEM
      user = '请用旁白解说风格生成分镜脚本：\n\n' + parts.join('\n') + '\n' + craft
    } else if (narrativeStructure === 'qczh') {
      // 起承转合 needs at least one shot per movement.
      parts.push(`总镜头数：${Math.max(4, shotCount)}个（按起承转合四段分配，其中'转'只有1个镜头）`)
      system = QCZH_SYSTEM
      user = '请用起承转合结构生成分镜脚本：\n\n' + parts.join('\n') + '\n' + craft
    } else {
      parts.push(`镜头数量：${shotCount}个镜头`)
      system = STORYBOARD_SYSTEM
      user = parts.join('\n') + '\n' + craft
    }

    try {
      // Storyboards are the longest output here, and max_tokens caps thinking +
      // text together on adaptive-thinking models — hence the wide ceiling.
      // SEEDANCE_CRAFT 把每镜的 prompt_en 从 50-120 词提到 80-220 词，上限跟着抬。
      const { text, usage, truncated } = await callClaude({
        system, user, maxTokens: 24000, effort: 'medium', apiKey: str(b.api_key) || undefined,
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

      // roll_type 兜底。解说纪录片全片没有 A-roll（无演员出镜说话），叙事短片模型
      // 漏写时也先按 b_roll 算 —— 补完对白后有台词的镜头会被改回 a_roll。
      // 放在补台词之前：第二步要靠它判断哪些镜头有人能开口。
      for (const shot of storyboard.shots || []) {
        shot.roll_type = shot.roll_type === 'a_roll' ? 'a_roll' : 'b_roll'
      }

      // voice_style 兜底（只有解说纪录片会用到，它驱动 Azure 的 express-as）。
      // 漏写或写了表外的值一律按平铺直叙处理 —— 宁可没情绪，也不要瞎给一个。
      const VOICE_STYLES = ['calm', 'serious', 'worried', 'warm', 'uplifting']
      if (videoType === 'narration') {
        for (const shot of storyboard.shots || []) {
          shot.voice_style = VOICE_STYLES.includes(shot.voice_style) ? shot.voice_style : 'calm'
        }
      }

      // 叙事短片第二步：补台词。STORYBOARD / QCZH 只产画面，没有台词字段，
      // 而换引擎前 /voiceover/init 是会逐镜生成字幕的 —— 不补这一步，叙事短片
      // 就没有字幕也没法配音。解说纪录片自带 narration_script，跳过。
      // 台词以人物对白为主：说得出口的那几句还会回写进 prompt_en，交给 Seedance
      // 的 generate_audio 生成人声，所以这一步同时决定了成片里能听见什么。
      // 失败不阻断：宁可交付没台词的分镜，也不要整个请求失败。
      if (videoType !== 'narration' && Array.isArray(storyboard.shots) && storyboard.shots.length > 0) {
        try {
          const outline = storyboard.shots
            .map(sh => `${sh.shot_number}. [${sh.duration}][${sh.shot_type || ''}]` +
              `[${sh.roll_type === 'a_roll' ? '有人物出镜说话' : '空镜/无人出镜'}] ${sh.description_zh || ''}`)
            .join('\n')
          // 角色定义一并给过去，speaker 才描述得出画面里真实存在的那个人
          // 挂了参考音频就让模型给每个角色挑一条并写中文音色描述；没挂则沿用 voice_en。
          const voiceClone = audioAssets.length > 0
            ? '\n可用参考音频（用来锁音色）：\n' +
              audioAssets.map(a => `音频${a.n}：${a.desc || '（无说明）'}`).join('\n') +
              '\n要求：voices 里每个角色除 voice_en 外，再给两个字段 ——\n' +
              '  audio_ref：上面某条音频的编号，挑音色最贴近这个角色的一条；' +
              '没有合适的写 0（写 0 就继续用 voice_en）\n' +
              '  voice_zh：中文音色特征描述，至少覆盖音高（低厚/清亮）、' +
              '质感（温润/沙哑/带颗粒感）、年龄性别（中年男声）三项，' +
              '连写成一个短语，例：低厚温润带细碎颗粒感中年男声\n' +
              '同一条音频可以给多个角色，但音色差异大的角色不要共用一条。'
            : ''
          const dialogueUser = [
            `视频概念：${concept}`,
            subjectDefs ? `\n出场角色：\n${subjectDefs}` : '',
            `\n分镜画面：\n${outline}`,
            voiceClone,
          ].filter(Boolean).join('\n')
          const { text: dText } = await callClaude({
            system: DIALOGUE_SYSTEM,
            user: dialogueUser,
            maxTokens: 8000,
            effort: 'low',
            apiKey: str(b.api_key) || undefined,
          })
          const parsed = parseJson(dText)
          // 音色条件句：speaker → 音色，同一角色每镜贴同一句。
          // audio_ref 必须真的在这次的音频清单里 —— 模型编一个不存在的编号，
          // Seedance 那边就是个悬空引用，宁可退回 voice_en。
          const audioNums = new Set(audioAssets.map(a => a.n))
          const voices = new Map(
            (parsed.voices || [])
              .map(v => {
                const ref = Number(v.audio_ref)
                const zh  = str(v.voice_zh)
                return [str(v.speaker), {
                  voiceEn:  str(v.voice_en),
                  voiceZh:  zh,
                  audioRef: audioNums.has(ref) && zh ? ref : 0,
                }]
              })
              .filter(([sp, v]) => sp && (v.voiceEn || v.audioRef))
          )
          const byNumber = new Map()
          ;(parsed.subtitles || []).forEach((x, i) => {
            // 老结构（单条 subtitle 字符串）也认，模型偶尔会退回去写
            const raw = Array.isArray(x.lines) ? x.lines
              : (x.subtitle ? [{ speaker: '旁白', type: 'narration', text: x.subtitle }] : [])
            const lines = raw
              .map(l => ({
                speaker: str(l.speaker) || '旁白',
                // 拼进 prompt_en 的英文指代；模型漏写就退回中文，口型仍按引号里的字对齐
                speaker_en: str(l.speaker_en) || str(l.speaker) || 'the character',
                type: l.type === 'narration' ? 'narration' : 'dialogue',
                text: str(l.text ?? l.subtitle),
              }))
              .filter(l => l.text)
            byNumber.set(Number(x.shot_number) || i + 1, lines)
          })
          storyboard.shots.forEach((sh, i) => {
            const lines = byNumber.get(Number(sh.shot_number)) || byNumber.get(i + 1) || []
            sh.dialogue = lines
            sh.subtitle = lines.map(l => l.text).join('')
            const spoken = lines.filter(l => l.type === 'dialogue')
            if (spoken.length > 0) {
              // 有人在画面里说话，按定义就是 A-roll —— 第一步的判断以此为准修正
              sh.roll_type = 'a_roll'
              sh.prompt_en = appendSpeech(sh.prompt_en, spoken, voices)
            }
          })
        } catch (e) {
          request.log.warn({ err: e }, 'dialogue pass failed; shots keep empty subtitles')
        }
      }

      // 把 prompt_en 里的素材引用提成结构化的 refs，导入分镜时才能把真实素材挂上去。
      // 从文本解析而不是让模型多输出一个字段：系统提示词规定了严格的 JSON 结构，
      // 模型漏写一个新字段的概率，远高于漏写它刚写进 prompt 的引用。
      // 前缀和尖括号都可有可无 —— @图片1（官方写法）、<图片1>（本项目旧写法）、
      // 裸写 图片1 都算引用。prompt_en 是英文，里面出现的中文「图片N」只可能是素材引用。
      // 库里存量分镜用的是尖括号那套，所以两种都得认。
      const REF_KINDS = [['image_refs', '图片'], ['video_refs', '视频'], ['audio_refs', '音频']]
      for (const shot of storyboard.shots || []) {
        for (const [field, label] of REF_KINDS) {
          const re = new RegExp(`[<@]?\\s*${label}\\s*(\\d+)\\s*>?`, 'g')
          const refs = new Set()
          for (const m of String(shot.prompt_en || '').matchAll(re)) refs.add(parseInt(m[1], 10))
          shot[field] = [...refs].sort((a, b) => a - b)
        }
      }

      storyboard.narrative_structure = narrativeStructure
      storyboard.video_type = videoType
      const skills = selectSkills(skillCtx).map(s => s.name)
      return { success: true, data: { result: storyboard, usage, skills } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: `分镜生成失败：${err.message}` })
    }
  })

  // ── 异步分镜生成 ──────────────────────────────────────────────────────
  // 一次分镜要 30-80s，浏览器一离开页面请求就断了（Next 的 rewrite 代理也会跟着断）。
  // 做成任务：提交拿 jobId，轮询取结果 —— 关掉页面、切走、再回来都还能接着取。
  // 存内存里，和 /voiceover/merge-async 同一套路；后端重启会丢，所以给了明确的过期提示。
  const sbJobs = new Map()
  const JOB_TTL = 30 * 60 * 1000

  const sweepJobs = () => {
    const now = Date.now()
    for (const [id, job] of sbJobs) if (now - job.startedAt > JOB_TTL) sbJobs.delete(id)
  }

  fastify.post('/storyboard-async', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ success: false, error: '未登录' })
    sweepJobs()
    const jobId = randomUUID()
    sbJobs.set(jobId, { status: 'processing', startedAt: Date.now(), userId: request.user.id })

    const body = request.body
    // 注入时要把 Authorization 带上 —— /storyboard 自己会查 request.user
    const auth = request.headers.authorization
    ;(async () => {
      try {
        const res = await fastify.inject({
          method: 'POST',
          url: `${fastify.prefix}/storyboard`,
          payload: body,
          headers: auth ? { authorization: auth } : {},
        })
        const data = JSON.parse(res.payload)
        const prev = sbJobs.get(jobId)
        if (!prev) return                       // 已过期被扫掉，结果直接丢弃
        sbJobs.set(jobId, data.success
          ? { ...prev, status: 'done', data: data.data }
          : { ...prev, status: 'failed', error: data.error || '分镜生成失败' })
      } catch (err) {
        const prev = sbJobs.get(jobId)
        if (prev) sbJobs.set(jobId, { ...prev, status: 'failed', error: err.message || '分镜生成失败' })
      }
    })()

    return { success: true, data: { jobId } }
  })

  // 取结果**不删任务** —— 刷新页面、重复轮询都要能再拿到，靠 TTL 过期
  fastify.get('/storyboard-status/:jobId', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ success: false, error: '未登录' })
    const job = sbJobs.get(request.params.jobId)
    if (!job) return { success: true, data: { status: 'expired', error: '任务不存在或已过期（超过 30 分钟或服务重启）' } }
    if (job.userId !== request.user.id) return reply.code(404).send({ success: false, error: '任务不存在' })
    if (job.status === 'done')   return { success: true, data: { status: 'done', ...job.data } }
    if (job.status === 'failed') return { success: true, data: { status: 'failed', error: job.error } }
    return { success: true, data: { status: 'processing', elapsed: Math.round((Date.now() - job.startedAt) / 1000) } }
  })
}

module.exports = promptRoutes
