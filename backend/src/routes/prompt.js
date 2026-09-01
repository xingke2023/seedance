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
const { parseSubjectDefs, lockSubjectAnchors, harvestDefs } = require('../prompt/anchor')

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
  const dialogue  = lines.filter(l => l.type !== 'narration')
  const narration = lines.filter(l => l.type === 'narration')

  // 音色行：每个说话人（含旁白）一句，全片一字不改
  const voiceLine = sp => {
    const v = voices.get(sp)
    if (!v || (!v.audioRef && !v.voiceEn)) return ''
    const who = lines.find(l => l.speaker === sp).speaker_en || sp
    // 写法照官方规范：`使用 @音频1 低厚温润…的音色说`（编号两边留空格）
    return v.audioRef
      ? `${who} 使用 @音频${v.audioRef} ${v.voiceZh}的音色说话`
      : `Voice of ${who}: ${v.voiceEn}`
  }
  const voiceLinesFor = ls => [...new Set(ls.map(l => l.speaker))].map(voiceLine).filter(Boolean)

  const speechLines = ls => ls.map((l, i) => {
    const who  = l.speaker_en || l.speaker
    const verb = i === 0 ? 'says'
      : ls[i - 1].speaker === l.speaker ? 'continues' : 'replies'
    return `${who} ${verb}: “${l.text}”`
  })

  const blocks = []
  // 「spoken aloud only, never rendered as on-screen text」是踩坑后加的：
  // 提示词里带引号的台词会诱使模型把台词渲成画面里的字幕，和后期烧的那层重叠。
  if (dialogue.length > 0) {
    blocks.push(
      'Dialogue (spoken aloud on camera, lip-synced; ' +
      'spoken audio only, never rendered as on-screen text or subtitles):\n' +
      [...voiceLinesFor(dialogue), ...speechLines(dialogue)].join('\n')
    )
  }
  // 旁白也要出声：它原来只进字幕，画面里没人说、提示词里也没写，成片就是有字无声。
  // 写成画外音块 —— 说话人不在画面里，所以不要求口型，也不要让谁对着镜头念。
  if (narration.length > 0) {
    blocks.push(
      'Off-screen voiceover (narrator is NOT visible in frame, no lip sync, ' +
      'no character in the shot speaks these words; spoken audio only, ' +
      'never rendered as on-screen text or subtitles):\n' +
      [...voiceLinesFor(narration), ...speechLines(narration)].join('\n')
    )
  }
  return blocks.length > 0 ? `${str(promptEn)}\n\n${blocks.join('\n\n')}` : str(promptEn)
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
    // 页面上「选音色」绑好的角色 → 音频编号（一行一个：角色「小李」使用@音频1）。
    // 绑了就由我们说了算，不再采信模型自己挑的 audio_ref —— 挑错一个角色，
    // 整条片子他都用别人的嗓子说话。
    const voiceBindings = new Map(
      [...str(b.voice_bindings).matchAll(/^\s*角色\s*[「『"']?(.*?)[」』"']?\s*使用\s*[<@]?\s*音频\s*(\d+)\s*>?\s*$/gm)]
        .map(m => [str(m[1]), Number(m[2])])
        .filter(([name, n]) => name && n > 0)
    )
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
        '参考视频用来对齐运镜或动作时写 @视频N，参考音频写 @音频N；未用到素材的空镜不必引用。' +
        (/音色\s*[<@]?\s*音频\s*\d+/.test(subjectDefs)
          ? '上面每个角色都标了它的 @图片N（形象）和 音色@音频M（声音）—— 那是同一个人的两半，' +
            '编号已按角色顺序排好；该角色开口说话的镜头，prompt_en 里形象引用 @图片N、' +
            '音色引用 @音频M，两个都要写，不要张冠李戴。'
          : '') +
        '角色定义句一律写成「将@图片N中<上面那行外貌描述原文>定义为<主体N>；」并放在该镜画面描述之前：' +
        '外貌描述**逐字照抄上面给的原文**，不要改写、增删或翻译，也不要再补写原文里没有的外貌细节；' +
        '主体编号必须等于它绑定的图片编号（@图片2 的角色只能叫 <主体2>），全片每一镜都用同一套定义和标签。'
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

      // 角色定义原文锁：把模型逐镜自写的定义句换成页面传来的原文，标签编号归一到图片编号。
      // 放在提 image_refs 之前 —— refs 要反映最终文本（归一可能改掉编号）。
      // 页面没给原文的角色（主体没填描述、也没做过剧本分析），就从模型这一批分镜里
      // 挑写得最全的那句当原文 —— 没有原文可依时，至少全片统一到同一句
      const shotPrompts = (storyboard.shots || []).map(sh => sh.prompt_en)
      const anchorDefs = harvestDefs(shotPrompts, parseSubjectDefs(subjectDefs))
      if (anchorDefs.size > 0) {
        for (const shot of storyboard.shots || []) {
          shot.prompt_en = lockSubjectAnchors(shot.prompt_en, anchorDefs)
        }
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
          const bindingLines = [...voiceBindings.entries()]
            .map(([name, n]) => `角色「${name}」使用@音频${n}`).join('\n')
          const voiceClone = audioAssets.length > 0
            ? '\n可用参考音频（用来锁音色）：\n' +
              audioAssets.map(a => `音频${a.n}：${a.desc || '（无说明）'}`).join('\n') +
              '\n要求：voices 里每个角色除 voice_en 外，再给两个字段 ——\n' +
              '  audio_ref：上面某条音频的编号，挑音色最贴近这个角色的一条；' +
              '没有合适的写 0（写 0 就继续用 voice_en）\n' +
              '  voice_zh：中文音色特征描述，至少覆盖音高（低厚/清亮）、' +
              '质感（温润/沙哑/带颗粒感）、年龄性别（中年男声）三项，' +
              '连写成一个短语，例：低厚温润带细碎颗粒感中年男声\n' +
              '同一条音频可以给多个角色，但音色差异大的角色不要共用一条。\n' +
              '  subject_label：这个角色在「出场角色」里的名字（原样照抄），' +
              '用来把音色和角色对上 —— 漏写的话页面上绑好的音色就落不到人头上\n' +
              (bindingLines
                ? '\n以下角色的音色**页面已经绑定，必须照用**（audio_ref 只能填这个编号）：\n' +
                  bindingLines + '\n绑定的角色仍要写 voice_zh：照着那条音频的说明描述音色。\n'
                : '')
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
          const audioDesc = new Map(audioAssets.map(a => [a.n, a.desc]))
          const entries = (parsed.voices || []).map(v => {
            // 页面绑定优先；模型漏写 subject_label 时才退回它自己挑的 audio_ref
            const bound = voiceBindings.get(str(v.subject_label)) || 0
            const own   = Number(v.audio_ref)
            const ref   = bound || (audioNums.has(own) ? own : 0)
            // 只给编号不描述音色会飘（官方约定）—— 模型漏写就拿页面给这条音频的说明兜底
            const zh = str(v.voice_zh) || (ref ? str(audioDesc.get(ref)) : '')
            return [str(v.speaker), { voiceEn: str(v.voice_en), voiceZh: zh, audioRef: ref }]
          }).filter(([sp, v]) => sp && (v.voiceEn || v.audioRef))
          // 只绑了一个角色、这条片子也只有一个人说话时，模型漏写 subject_label 也认
          if (voiceBindings.size === 1 && entries.length === 1 && !entries[0][1].audioRef) {
            const [, n] = [...voiceBindings.entries()][0]
            entries[0][1].audioRef = n
            entries[0][1].voiceZh = entries[0][1].voiceZh || str(audioDesc.get(n))
          }
          const voices = new Map(entries)
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
          // speaker_en 归一（和角色定义原文锁同一个道理）：同一个人的英文指代必须全片一致。
          // 模型逐句自由写的话，这镜是 the man in the navy shirt、下镜成了 the young
          // office worker —— 每镜独立生成，Seedance 会当成两个人，配出两把嗓子。
          // 取出现次数最多的那个写法（同频取更具体的长句），其余全部换成它。
          const enTally = new Map()
          for (const lines of byNumber.values()) {
            for (const l of lines) {
              if (!l.speaker_en) continue
              const tally = enTally.get(l.speaker) || new Map()
              tally.set(l.speaker_en, (tally.get(l.speaker_en) || 0) + 1)
              enTally.set(l.speaker, tally)
            }
          }
          const canonEn = new Map()
          for (const [sp, tally] of enTally) {
            const [best] = [...tally.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
            if (best) canonEn.set(sp, best[0])
          }
          for (const lines of byNumber.values()) {
            for (const l of lines) l.speaker_en = canonEn.get(l.speaker) || l.speaker_en
          }
          storyboard.shots.forEach((sh, i) => {
            const lines = byNumber.get(Number(sh.shot_number)) || byNumber.get(i + 1) || []
            sh.dialogue = lines
            sh.subtitle = lines.map(l => l.text).join('')
            if (lines.length > 0) {
              // 对白和旁白都要进 prompt_en：字幕两类都会烧，声音也得两类都有。
              // A-roll 只看有没有人在画面里开口 —— 画外旁白不改变镜头性质。
              if (lines.some(l => l.type !== 'narration')) sh.roll_type = 'a_roll'
              sh.prompt_en = appendSpeech(sh.prompt_en, lines, voices)
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
