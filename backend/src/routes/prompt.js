'use strict'

const { randomUUID } = require('crypto')
const { callClaude, parseJson, MODEL } = require('../prompt/engine')
const {
  SINGLE_SHOT_SYSTEM,
  QCZH_SYSTEM,
  STORYBOARD_SYSTEM,
  ENHANCE_SYSTEM,
  NARRATION_SYSTEM,
} = require('../prompt/prompts')
const { buildContext, buildCraft, selectSkills, describeSkills } = require('../prompt/skills')
const { parseSubjectDefs, lockSubjectAnchors, harvestDefs } = require('../prompt/anchor')
const { writeScript } = require('../prompt/script')

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
// speakerToSubjectNum：dialogue.speaker（外貌指代，如「穿深蓝西装的中年男人」）→ 绑定的
// 图片编号（拼装见调用处）。原来对话行只写 speaker_en 这句自由英文描述——同一个人
// 「说话人」和「画面描述里的这个人」靠一句相似的措辞去对，容易对不上，Seedance 也不确定
// 到底是画面里哪一个人在开口。有绑定角色时改成明确点出 <主体N>（和场景描述头部
// 「将@图片N中…定义为<主体N>」用的是同一个标签），说话人身份直接靠标签锁定，
// 不再依赖自由描述是否措辞一致。第三人称旁白的 speaker 固定是「旁白」，不会绑定任何
// 图片编号，查不到就是没绑定角色（含真正的第三人称旁白），跳过标签、走原来的写法；
// 角色的心理旁白 speaker 和该角色说台词时一致，同样能查到标签——见 shotSplitDialogueRules
// 规则 8/9：心理旁白复用该角色本人的 speaker/voice，不会被当成一个新的「旁白」声音。
function appendSpeech(promptEn, lines, voices, speakerToSubjectNum) {
  const dialogue  = lines.filter(l => l.type !== 'narration')
  const narration = lines.filter(l => l.type === 'narration')

  const withTag = (sp, base) => {
    const n = speakerToSubjectNum?.get(sp)
    return n ? `<主体${n}> (${base})` : base
  }

  // 音色行：每个说话人（含旁白）一句，全片一字不改
  const voiceLine = sp => {
    const v = voices.get(sp)
    if (!v || (!v.audioRef && !v.voiceEn)) return ''
    const who = withTag(sp, lines.find(l => l.speaker === sp).speaker_en || sp)
    // 写法照官方规范：`使用 @音频1 低厚温润…的音色说`（编号两边留空格）
    return v.audioRef
      ? `${who} 使用 @音频${v.audioRef} ${v.voiceZh}的音色说话`
      : `Voice of ${who}: ${v.voiceEn}`
  }
  const voiceLinesFor = ls => [...new Set(ls.map(l => l.speaker))].map(voiceLine).filter(Boolean)

  // 身份对应行：把这个块里每个说话人钉到 content 里的具体素材编号上。
  // 台词行只写 `<主体1> (the man in the navy blazer) says: “…”` —— 这个标签指的是
  // content 里第几个 image_url、嗓子取自第几个 audio_url，全靠模型自己从 prompt
  // 前半段的定义句去推。推错一次，这一镜就是别人的脸配别人的嗓子。所以在块开头
  // 用一句话把对应关系写死（`<主体N>` 的编号已经归一到图片编号，见 lockSubjectAnchors）。
  const identityLine = ls => {
    const items = [...new Set(ls.map(l => l.speaker))].map(sp => {
      const n  = speakerToSubjectNum?.get(sp)
      const v  = voices.get(sp)
      const en = lines.find(l => l.speaker === sp)?.speaker_en || sp
      const bits = [n ? `即 @图片${n} 中的人物` : '画外音，不出现在画面中']
      if (v?.audioRef) bits.push(`音色取自 @音频${v.audioRef}`)
      return `${n ? `<主体${n}>` : en}（${bits.join('，')}）`
    })
    return items.length > 0 ? `说话人身份对应：${items.join('；')}。` : ''
  }
  const headLinesFor = ls => [identityLine(ls), ...voiceLinesFor(ls)].filter(Boolean)

  const speechLines = ls => ls.map((l, i) => {
    const who  = withTag(l.speaker, l.speaker_en || l.speaker)
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
      [...headLinesFor(dialogue), ...speechLines(dialogue)].join('\n')
    )
  }
  // 旁白也要出声：它原来只进字幕，画面里没人说、提示词里也没写，成片就是有字无声。
  // 写成画外音块 —— 不要口型、不要谁对着镜头念，这句话对第三人称旁白和角色的心理
  // 旁白都成立（心理旁白也是"没人对镜头念"，区别只在音色是不是沿用了这个角色本人的）。
  if (narration.length > 0) {
    blocks.push(
      'Off-screen voiceover (not spoken aloud by anyone visibly moving their lips in ' +
      'the shot, no lip sync — may be third-person narration or a character\'s own ' +
      'inner-thought monologue; spoken audio only, ' +
      'never rendered as on-screen text or subtitles):\n' +
      [...headLinesFor(narration), ...speechLines(narration)].join('\n')
    )
  }
  return blocks.length > 0 ? `${str(promptEn)}\n\n${blocks.join('\n\n')}` : str(promptEn)
}

// 角色/素材锚定说明，story 的第二步（开拍分镜）和 narration 共用同一段话——
// 系统提示词不逐字移植了，但 @图片N/<主体N> 这套语法和它的措辞不动。
function appendAnchoringInstructions(parts, subjectDefs, imageDescs) {
  if (!subjectDefs && !imageDescs) return
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

// 参考音频锁音色的说明，原来是第二步（补台词）专用的 user message，现在挂进
// story 的分镜开拍这一步——job 没变（还是给 voices 补 audio_ref/voice_zh/subject_label），
// 只是搬了个位置。没挂参考音频就不用这段。
function voiceCloneBlock(audioAssets, voiceBindings) {
  if (audioAssets.length === 0) return ''
  const bindingLines = [...voiceBindings.entries()]
    .map(([name, n]) => `角色「${name}」使用@音频${n}`).join('\n')
  return '\n可用参考音频（用来锁音色）：\n' +
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
}

// 提示词已经要求「同一场戏的对话默认装一个镜头」，但这终究是概率性的——实测模型还是会
// 习惯性地一句台词切一镜。两版靠猜的兜底都失败了：
//   v1「景别/运镜/构图必须逐字相同才合并」—— 模型每镜措辞顺手就写得不一样，抓不住
//   v2「相邻镜头说话人有没有重叠」—— 真正的一来一回对话（A、B、A、B…）里，相邻两镜
//      说话人从来不是同一个人，重叠检测对最常见的这种情况反而失效
// 所以改成不猜：提示词现在直接要求模型给每镜标 `camera_setup_id`（同一次机位延续用
// 同一个数字，见 shotSplitDialogueRules 第 4 条），这里就按这个字段合并——模型只需要
// 做「这镜跟上一镜是不是同一次拍摄」这一个二元判断，比让它把景别措辞写得逐字一致，
// 或者让我们从说话人模式反推「像不像同一场戏」都可靠得多。
// 模型没给这个字段（旧提示词缓存、或漏写）时退回宽松兜底：roll_type 一致就当同一场戏，
// 宁可合并多了，也不要放过一句台词一镜——这是从实测里学到的教训，「宁可漏合并」
// 这条老原则在真实分布下几乎从不生效，不如反过来默认合并。
// 合并条件：camera_setup_id 相同（缺失则退化为都不检查）、roll_type 一致（不把有人
// 说话的镜头并进纯空镜）、qczh 的话 phase 也要一致（不跨起承转合的段落合并）、合并后
// 时长仍在 15 秒硬顶内。取前一镜的摄影机参数与 prompt_en 基础描述，两镜的 dialogue
// 拼起来——反正后面会照着合并后的 dialogue 重新生成台词块，说的话不会丢。
// 只用于 story：narration 是一步到位、没有逐镜 dialogue 数组，套用同一条合并逻辑没有意义。
function mergeSameSetupShots(shots) {
  if (!Array.isArray(shots) || shots.length < 2) return shots || []
  const parseDur = d => parseFloat(String(d ?? '').replace(/[^\d.]/g, '')) || 0
  const setupIdOf = sh => {
    const n = Number(sh.camera_setup_id)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const merged = []
  for (const shot of shots) {
    const prev = merged[merged.length - 1]
    let canMerge = false
    if (prev) {
      const prevId = setupIdOf(prev)
      const curId  = setupIdOf(shot)
      // 两边都给了 id 就必须相等；只要有一边没给（模型漏写），就不拿它当阻拦条件——
      // 缺信息时默认偏向合并，而不是默认偏向保留（教训见上面的函数注释）
      const sameSetup = (prevId !== null && curId !== null) ? prevId === curId : true
      canMerge =
        prev.roll_type === shot.roll_type &&
        str(prev.phase || '') === str(shot.phase || '') &&
        sameSetup
    }
    const combinedDur = parseDur(prev?.duration) + parseDur(shot.duration)
    if (canMerge && combinedDur > 0 && combinedDur <= 15) {
      prev.duration = `${combinedDur}s`
      prev.dialogue = [
        ...(Array.isArray(prev.dialogue) ? prev.dialogue : []),
        ...(Array.isArray(shot.dialogue) ? shot.dialogue : []),
      ]
      prev.last_frame = shot.last_frame || prev.last_frame
      prev.description_zh = [prev.description_zh, shot.description_zh].filter(Boolean).join('；')
      continue
    }
    merged.push({ ...shot })
  }
  merged.forEach((s, i) => { s.shot_number = i + 1 })
  return merged
}

// 一段对话写满 15 秒装不下、必须另起一镜接着说时，**这两镜必须是同一个场景**——
// 每个分镜是一次独立生成，场景措辞差一个词，背景/光线/服装就跟着变，成片里是两个人
// 说着说着换了个房间。提示词里已经要求模型把延续的镜头标同一个 camera_setup_id、
// 场景措辞逐字照抄（shotSplitDialogueRules 第 4、5 条），但那是概率性的，这里做确定性兜底。
//
// 做法：相邻且 camera_setup_id 相同的镜头，prompt_en 一律用这一串里**第一镜的原文**，
// 只把「时间轴节拍」那一段换成它自己写的（神态/微动作按台词走，这正是逐镜该变的东西）；
// 技术字段（景别/运镜/构图/光线/色调）也一并对齐到第一镜。
// 台词不在这一步——后面 appendSpeech 会按每镜自己的 dialogue 重新贴。
// 节拍段靠时间码认（`0-4s:` / `4-9s：`），两边有一边认不出来就只对齐技术字段、
// 不动 prompt_en——宁可放过一镜，也不要把不是节拍的句子换掉。
// 只对 story 生效：narration 是一步到位的旁白解说，没有「一段对话拆两镜」这回事。
const BEAT_RE = /\d+\s*[-–~至]\s*\d+\s*s\s*[:：]/g

function beatsSpan(text) {
  const t = str(text)
  if (!t) return null
  const marks = [...t.matchAll(BEAT_RE)]
  if (marks.length === 0) return null
  const last = marks[marks.length - 1]
  const tailFrom = last.index + last[0].length
  // 节拍写到最后一个时间码那句话的句号为止。中文句号是明确的句末（后面常常直接跟英文，
  // 不留空格）；英文句点要后面跟空白或到头才算，`1.5s` 里的小数点才不会被当成句末
  const m = /。|\.(?=\s|$)/.exec(t.slice(tailFrom))
  return { start: marks[0].index, end: m ? tailFrom + m.index + 1 : t.length }
}

function lockSceneContinuity(shots) {
  if (!Array.isArray(shots) || shots.length < 2) return shots || []
  const CARRY = ['shot_type', 'camera_move', 'composition', 'lighting', 'color_tone']
  const idOf = sh => {
    const n = Number(sh?.camera_setup_id)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  let base = null
  for (const shot of shots) {
    const id = idOf(shot)
    if (id === null) { base = null; continue }          // 没标 id 的镜头不参与，也断开上一串
    if (!base || idOf(base) !== id) { base = shot; continue }
    for (const k of CARRY) if (base[k]) shot[k] = base[k]
    const baseSpan = beatsSpan(base.prompt_en)
    const ownSpan  = beatsSpan(shot.prompt_en)
    if (baseSpan && ownSpan) {
      shot.prompt_en =
        str(base.prompt_en).slice(0, baseSpan.start) +
        str(shot.prompt_en).slice(ownSpan.start, ownSpan.end) +
        str(base.prompt_en).slice(baseSpan.end)
    }
  }
  return shots
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
  //
  // 提取成独立函数是因为同步路由（/storyboard）和后台任务（/storyboard-async）现在共用它——
  // 后台任务不再靠 fastify.inject 转发 HTTP 请求，而是直接调这个函数，这样 onScript 才能
  // 在第一步剧本刚流式写完（甚至写的过程中）就把内容送回任务状态，供页面轮询展示
  // 「正在写的对白剧本」，而不是等整个两步都跑完才有东西可看。
  //
  // log 用 request.log 或 fastify.log（后台任务没有 request）。onScript(text) 在叙事短片
  // 第一步每收到一段新文本时调用（text 是累计到目前的全文，不是增量）——JSON 结构的第二步
  // 不流式暴露：半截的 JSON 对用户来说是读不懂的噪音，不像剧本正文那样能读。
  async function generateStoryboard(b, { log, onScript } = {}) {
    const concept = str(b.concept)
    if (!concept) { const e = new Error('请输入视频概念描述'); e.status = 400; throw e }

    const narrativeStructure = str(b.narrative_structure) || 'free'  // free | qczh
    const videoType          = str(b.video_type) || 'story'          // story | narration
    const shotCount          = Math.min(20, Math.max(1, parseInt(b.shot_count, 10) || 5))
    const slogan             = str(b.slogan)

    // 角色/素材锚定 + 参考音频。narration 是一步到位，story 现在是两步——
    // 这两块下面两条链路都要用，提到前面来共享。
    const subjectDefs = str(b.subject_definitions)
    const imageDescs  = str(b.image_descriptions)
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
    let script = null   // 叙事短片第一步产出的剧本正文，随结果一并返回，便于核对/展示

    if (videoType === 'narration') {
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
      if (slogan) parts.push(`画面内广告语（只放在收尾镜，一字不改）：${slogan}`)
      appendAnchoringInstructions(parts, subjectDefs, imageDescs)
      parts.push(`镜头数量：${shotCount}个镜头`)
      system = NARRATION_SYSTEM
      user = '请用旁白解说风格生成分镜脚本：\n\n' + parts.join('\n') + '\n' + craft
    } else {
      // ─── 第一步：先把完整对白剧本写完，这一步完全不管镜头/运镜 ───
      // 「剧本分析」按钮已经调过 writeScript 写过一次了，页面把结果原样带过来（b.script）——
      // 直接用，不用再花一次模型调用重写；没带就是老流程，这里自己写。
      const scriptText = str(b.script) || await writeScript({
        concept, creativeGoal: str(b.creative_goal), targetAudience: str(b.target_audience),
        overallTone: str(b.overall_tone), keyMessages: str(b.key_messages),
        durationTotal: str(b.duration_total), subjectDefs,
        apiKey: str(b.api_key) || undefined, onText: onScript,
      })
      script = scriptText
      onScript?.(scriptText)   // 流式回调可能因为网络细节漏掉最后一点尾巴，收尾时补一次完整值（跳过重写时这是唯一一次回调）

      // ─── 第二步：把这份剧本开拍成分镜——切镜、配运镜、把台词原文分配进去 ───
      const parts = [`完整剧本（对白/旁白原文，禁止改写，只能拆分到镜头里）：\n${scriptText}`]
      const opt2 = (label, v) => { if (v) parts.push(`${label}：${v}`) }
      opt2('总时长',   str(b.duration_total))
      opt2('视觉风格', str(b.style))
      if (slogan) parts.push(`画面内广告语（只放在收尾镜，一字不改）：${slogan}`)
      parts.push(narrativeStructure === 'qczh'
        ? `至少 ${Math.max(4, shotCount)} 个镜头，按起承转合四段自然分配（不强制总数，按剧本内容需要来定）`
        : `参考镜头数：约 ${shotCount} 个（不强制，按剧本内容实际需要来定镜头数）`)
      appendAnchoringInstructions(parts, subjectDefs, imageDescs)
      const vc = voiceCloneBlock(audioAssets, voiceBindings)
      if (vc) parts.push(vc)

      system = narrativeStructure === 'qczh' ? QCZH_SYSTEM : STORYBOARD_SYSTEM
      user = parts.join('\n') + '\n' + craft
    }

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
      log?.error({ err: e, raw: text.slice(0, 500) }, 'storyboard JSON parse failed')
      const wrapped = new Error(truncated ? '分镜结果被截断，请减少镜头数量后重试' : `解析分镜结果失败：${e.message}`)
      wrapped.raw = text
      throw wrapped
    }

    // 合并景别/运镜/构图完全相同的相邻镜头（见 mergeSameSetupShots 顶部注释）——放在最前面，
    // 让锚定锁/roll_type 兜底/台词分配这些后续步骤都在最终镜头数上跑，不用再关心合并。
    if (videoType !== 'narration') {
      storyboard.shots = mergeSameSetupShots(storyboard.shots)
      // 合并之后还挨在一起的同机位镜头 = 一段对话被 15 秒硬顶拆开的那种，
      // 把场景锁成同一份（见 lockSceneContinuity 顶部注释）
      lockSceneContinuity(storyboard.shots)
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
      // 角色名（剧本里的人物名，等于 subject_definitions 那份角色单的 name）→ 图片编号。
      // dialogue.speaker 本身不是人名（规则 9 要求写外貌指代），所以这份表还不能直接拿来
      // 认 speaker——要经 storyboard.voices[].subject_label 转一道，见下面 speakerToSubjectNum。
      const subjectNumByName = new Map(
        [...anchorDefs].filter(([, d]) => d.name).map(([n, d]) => [d.name, n])
      )

      // roll_type 兜底。解说纪录片全片没有 A-roll（无演员出镜说话），叙事短片模型
      // 漏写时也先按 b_roll 算 —— 下面分配台词后有台词的镜头会被改回 a_roll。
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

      // 叙事短片：台词/旁白和音色现在直接来自第二步（STORYBOARD/QCZH 的 voices + 每镜的
      // dialogue），不用再单独打一次 DIALOGUE_SYSTEM——这里只做音色条件句拼接、speaker_en
      // 全片归一、把台词贴回 prompt_en，逻辑和原来的第二步完全一样，只是数据来源变了。
      // 失败不阻断：宁可交付没台词的分镜，也不要整个请求失败。
      if (videoType !== 'narration' && Array.isArray(storyboard.shots) && storyboard.shots.length > 0) {
        try {
          // 音色条件句：speaker → 音色，同一角色每镜贴同一句。
          // audio_ref 必须真的在这次的音频清单里 —— 模型编一个不存在的编号，
          // Seedance 那边就是个悬空引用，宁可退回 voice_en。
          const audioNums = new Set(audioAssets.map(a => a.n))
          const audioDesc = new Map(audioAssets.map(a => [a.n, a.desc]))
          const entries = (storyboard.voices || []).map(v => {
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

          // speaker（外貌指代）→ 图片编号：voices[].speaker 是同一个外貌指代，
          // voices[].subject_label 是这个声音对应的角色名（模型按规则 8 填，角色的心理
          // 旁白也填自己的名字，不会是「旁白」）——两段拼起来才能把 dialogue.speaker
          // 接到 subjectNumByName 上。查不到就是没绑定角色的人（或真正的第三人称旁白），
          // appendSpeech 里 withTag 对这种 speaker 直接跳过标签，不受影响。
          const speakerToSubjectNum = new Map(
            (storyboard.voices || [])
              .map(v => [str(v.speaker), subjectNumByName.get(str(v.subject_label))])
              .filter(([sp, n]) => sp && n)
          )

          const byNumber = new Map()
          storyboard.shots.forEach((sh, i) => {
            const raw = Array.isArray(sh.dialogue) ? sh.dialogue : []
            const lines = raw
              .map(l => ({
                speaker: str(l.speaker) || '旁白',
                // 拼进 prompt_en 的英文指代；模型漏写就退回中文，口型仍按引号里的字对齐
                speaker_en: str(l.speaker_en) || str(l.speaker) || 'the character',
                type: l.type === 'narration' ? 'narration' : 'dialogue',
                text: str(l.text),
              }))
              .filter(l => l.text)
            byNumber.set(Number(sh.shot_number) || i + 1, lines)
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
              sh.prompt_en = appendSpeech(sh.prompt_en, lines, voices, speakerToSubjectNum)
            }
          })
        } catch (e) {
          log?.warn({ err: e }, 'dialogue post-processing failed; shots keep model-given dialogue')
        }
      }

    // 把 prompt_en 里的素材引用提成结构化的 refs，导入分镜时才能把真实素材挂上去。
    // 从文本解析而不是让模型多输出一个字段：系统提示词规定了严格的 JSON 结构，
    // 模型漏写一个新字段的概率，远高于漏写它刚写进 prompt 的引用。
    // 前缀和尖括号都可有可无 —— @图片1（官方写法）、<图片1>（本项目旧写法)、
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
    if (script) storyboard.script = script
    const skills = selectSkills(skillCtx).map(s => s.name)
    return { result: storyboard, usage, skills }
  }

  fastify.post('/storyboard', async (request, reply) => {
    try {
      const data = await generateStoryboard(request.body || {}, { log: request.log })
      return { success: true, data }
    } catch (err) {
      const status = err.status || 500
      const payload = { success: false, error: status === 400 ? err.message : `分镜生成失败：${err.message}` }
      if (err.raw !== undefined) payload.raw = err.raw
      return reply.code(status).send(payload)
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
    const body = request.body || {}
    if (!str(body.concept)) return reply.code(400).send({ success: false, error: '请输入视频概念描述' })
    sweepJobs()
    const jobId = randomUUID()
    // stage: 'script'（第一步在写剧本，story 才有；narration 没有第二段，页面不看这个字段）
    // → 'shots'（剧本写完/在写，第二步在拆分镜配运镜）
    sbJobs.set(jobId, { status: 'processing', stage: 'script', startedAt: Date.now(), userId: request.user.id })

    // 直接调用共享函数，不再用 fastify.inject 转发一次 HTTP 请求给 /storyboard——
    // 少一层 JSON 序列化往返，更重要的是能拿到 onScript 回调：叙事短片第一步流式写
    // 剧本时，每收到一段新文本就把当前全文写回任务状态，页面轮询就能看到「正在写的
    // 对白剧本」，不用等两步都跑完才有内容可看。
    ;(async () => {
      try {
        const data = await generateStoryboard(body, {
          log: fastify.log,
          onScript: (scriptText) => {
            const prev = sbJobs.get(jobId)
            if (prev) sbJobs.set(jobId, { ...prev, stage: 'shots', script: scriptText })
          },
        })
        const prev = sbJobs.get(jobId)
        if (!prev) return                       // 已过期被扫掉，结果直接丢弃
        sbJobs.set(jobId, { ...prev, status: 'done', data })
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
    return {
      success: true,
      data: {
        status: 'processing',
        elapsed: Math.round((Date.now() - job.startedAt) / 1000),
        stage: job.stage,
        script: job.script,
      },
    }
  })
}

module.exports = promptRoutes
