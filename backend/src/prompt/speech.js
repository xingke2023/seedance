'use strict'

// 台词块与字幕的对齐。
//
// 分镜生成时，第二步（DIALOGUE）会把台词同时写进 `shot.subtitle`（烧字幕用）和
// `prompt_en` 末尾的台词块（Seedance 照着它出人声和口型）。但结构化的 dialogue 没有落库
// —— shots 表只有 subtitle 一列。于是页面上改一次字幕，prompt 里那段台词就对不上了：
// 画面里的人说的还是旧词，烧上去的字幕是新词。
//
// 所以提交生成任务时再对齐一次：字幕是准的，台词块跟着它重建。
// 块开头那几行（说话人身份对应 `<主体1>（即 @图片1 中的人物，音色取自 @音频1）`、
// 音色锁 `X 使用 @音频1 …的音色说话` / `Voice of X: …`）**原样保留** —— 身份和音色
// 都不该跟着字幕改；音色措辞一改，同一个角色逐镜的嗓子就漂了。

const str = v => String(v ?? '').trim()

const DIALOGUE_HEAD  = 'Dialogue (spoken aloud on camera, lip-synced; ' +
  'spoken audio only, never rendered as on-screen text or subtitles):'
const VOICEOVER_HEAD = 'Off-screen voiceover (narrator is NOT visible in frame, no lip sync, ' +
  'no character in the shot speaks these words; spoken audio only, ' +
  'never rendered as on-screen text or subtitles):'

// 台词块从这里起到 prompt 末尾（生成时就是追加在末尾的）
const BLOCK_START = /\n{1,2}(?:Dialogue \(spoken aloud on camera|Off-screen voiceover \(narrator)/

// 一行台词：`X says: “…”`，动词有 says / replies / continues
const SPEECH_LINE = /^(.*?)\s+(?:says|replies|continues)\s*[:：]\s*[“"](.*)[”"]\s*$/
// 块里除台词行以外的行（身份对应行、音色行）—— 逐条按原样搬回重建后的块里。
// 不再用「长得像音色行」的正则去挑：身份对应行也是这种非台词行，
// 与其为每一种新写法加一条正则，不如把「不是台词的都留着」当规则。

// 只比可读内容，标点空白不算 —— 改个标点不该触发重建
const norm = t => String(t || '').replace(/[\s\p{P}\p{S}]/gu, '')

function splitBlocks(prompt) {
  const text = String(prompt || '')
  const m = text.match(BLOCK_START)
  if (!m) return { body: text.trimEnd(), blocks: '' }
  return { body: text.slice(0, m.index).trimEnd(), blocks: text.slice(m.index) }
}

// 从已有台词块里把音色行和说话人捞出来（重建时要沿用）
function parseBlocks(blocks) {
  const headDialogue = []
  const headNarration = []
  const speakers = { dialogue: [], narration: [] }
  const texts = []
  let kind = null
  for (const raw of String(blocks || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('Dialogue (spoken aloud'))       { kind = 'dialogue';  continue }
    if (line.startsWith('Off-screen voiceover (narrator')) { kind = 'narration'; continue }
    if (!kind) continue
    const sp = line.match(SPEECH_LINE)
    if (sp) {
      texts.push(sp[2])
      const who = str(sp[1])
      if (who && !speakers[kind].includes(who)) speakers[kind].push(who)
      continue
    }
    ;(kind === 'dialogue' ? headDialogue : headNarration).push(line)
  }
  return { headDialogue, headNarration, speakers, spokenText: texts.join('') }
}

function buildBlock(head, headLines, speaker, lines) {
  const speech = lines.map((t, i) => `${speaker} ${i === 0 ? 'says' : 'continues'}: “${t}”`)
  return `${head}\n${[...headLines, ...speech].join('\n')}`
}

// 字幕按句号问号感叹号断句，一句一行 —— 和字幕烧上去的断法无关，只是别把一大段挤成一行
function splitSubtitle(subtitle) {
  return String(subtitle || '')
    .split(/(?<=[。！？!?])/)
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * 让 prompt 末尾的台词块和这一镜的字幕一致。
 * - 字幕为空：原样返回（可能是纯空镜，也可能这条链路根本没有字幕）
 * - 已经一致：原样返回
 * - 不一致：沿用原来的音色行和说话人重建；原来没有台词块时，
 *   a_roll 按角色台词写、b_roll 按画外旁白写
 */
function syncSpeechWithSubtitle(prompt, subtitle, opts = {}) {
  const sub = str(subtitle)
  const text = String(prompt || '')
  if (!sub) return text

  const { body, blocks } = splitBlocks(text)
  const parsed = parseBlocks(blocks)
  if (norm(parsed.spokenText) === norm(sub)) return text     // 本来就对得上

  const lines = splitSubtitle(sub)
  // 走对白还是画外旁白，看**画面里有没有人**，而不是看 roll_type：
  // 库里一批分镜当初被判成旁白（roll_type=b_roll），可字幕明明是第一人称的台词，
  // 而 prompt 里也确实有 <主体N> 在场 —— 那就该让他开口说，不是找个画外音来念。
  const subjectTag = String(body).match(/[<【]\s*主体\s*(\d+)\s*[>】]/)
  const hasSpeakerOnScreen = parsed.speakers.dialogue.length > 0 || !!subjectTag
  const isNarration = !hasSpeakerOnScreen
  const fallback = str(opts.fallbackSpeaker)
    || (isNarration ? 'narrator' : `<主体${subjectTag ? subjectTag[1] : 1}>`)
  const speaker = (isNarration ? parsed.speakers.narration[0] : parsed.speakers.dialogue[0]) || fallback

  // 块开头那几行（身份对应 + 音色）：原来那段有就原样沿用；没有（存量分镜、旁白从前
  // 根本不进 prompt）就按角色绑定补上 —— 每一镜都是独立生成，缺了这两句，
  // 模型既不知道这个标签指的是哪张图，也会给同一个角色逐镜配不同的嗓子
  let headLines = isNarration ? parsed.headNarration : parsed.headDialogue
  if (headLines.length === 0 && !isNarration && subjectTag) {
    const no = Number(subjectTag[1])
    headLines = [
      typeof opts.identityOf === 'function' ? opts.identityOf(no, speaker) : '',
      typeof opts.voiceOf    === 'function' ? opts.voiceOf(no, speaker)    : '',
    ].filter(Boolean)
  }

  const block = isNarration
    ? buildBlock(VOICEOVER_HEAD, headLines, speaker, lines)
    : buildBlock(DIALOGUE_HEAD, headLines, speaker, lines)
  return `${body}\n\n${block}`
}

module.exports = { syncSpeechWithSubtitle }
