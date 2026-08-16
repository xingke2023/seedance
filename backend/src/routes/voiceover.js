'use strict'

const fs            = require('fs')
const path          = require('path')
const os            = require('os')
const crypto        = require('crypto')
const { execFile }  = require('child_process')
const { promisify } = require('util')
const { jsonrepair } = require('jsonrepair')
const sdk = require('microsoft-cognitiveservices-speech-sdk')
const jieba = require('jieba-wasm')

const { UPLOAD_ROOT, localUploadPath, fetchMediaBuffer } = require('../lib/uploads')

const execFileAsync = promisify(execFile)
const UPLOAD_DIR    = UPLOAD_ROOT
const VIDEO_CACHE   = path.join(UPLOAD_ROOT, '.video-cache')

// 视频下载缓存：URL → 本地文件 + JSON 元数据（含精确时长）
function cacheKey(url) {
  return crypto.createHash('md5').update(url.split('?')[0]).digest('hex')
}

function getCacheInfo(url) {
  const key  = cacheKey(url)
  const meta = path.join(VIDEO_CACHE, `${key}.json`)
  if (!fs.existsSync(meta)) return null
  try {
    const info = JSON.parse(fs.readFileSync(meta, 'utf8'))
    if (!fs.existsSync(info.path)) return null
    return info
  } catch { return null }
}

async function downloadWithCache(url) {
  fs.mkdirSync(VIDEO_CACHE, { recursive: true })

  // 如果是本地 .video-cache URL，直接查找本地文件
  const cacheMatch = url.match(/\.video-cache\/([a-f0-9]+)\.mp4/)
  if (cacheMatch) {
    const dest = path.join(VIDEO_CACHE, `${cacheMatch[1]}.mp4`)
    const meta = path.join(VIDEO_CACHE, `${cacheMatch[1]}.json`)
    if (fs.existsSync(dest) && fs.existsSync(meta)) {
      return JSON.parse(fs.readFileSync(meta, 'utf8'))
    }
  }

  const existing = getCacheInfo(url)
  if (existing) return existing

  const key  = cacheKey(url)
  const dest = path.join(VIDEO_CACHE, `${key}.mp4`)

  const local = localUploadPath(url)
  if (local) {
    fs.copyFileSync(local, dest)
  } else {
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000), redirect: 'follow' })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  }

  const duration = await probeDuration(dest)
  const size     = fs.statSync(dest).size
  const info     = { url, path: dest, duration, size, cachedAt: Date.now() }
  fs.writeFileSync(path.join(VIDEO_CACHE, `${key}.json`), JSON.stringify(info))
  return info
}

const DEFAULT_API_URL   = 'https://api.deepseek.com'
const DEFAULT_MODEL     = 'deepseek-chat'

function estimateDuration(text) {
  const chars = (text || '').replace(/\s/g, '').length
  return Math.min(15, Math.max(4, Math.ceil(chars / 3.5)))
}

const SEEDANCE_QUALITY = '电影质感、4K 超高清、细节丰富、色彩自然、画面稳定、无抖动、无模糊无重影'
const CHAR_CONSISTENCY = '同一角色，服装一致，发型不变，保持人物样貌与服装一致'

function toSRTTime(sec) {
  const h  = Math.floor(sec / 3600)
  const m  = Math.floor((sec % 3600) / 60)
  const s  = Math.floor(sec % 60)
  const ms = Math.round((sec % 1) * 1000)
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`
}

function chunkSubtitle(text, maxChars = 30) {
  const result = []
  let remaining = text.trim()
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) { result.push(remaining); break }
    let splitAt = -1
    for (let i = maxChars; i >= 1; i--) {
      if (/[。！？…，；、]/.test(remaining[i - 1])) { splitAt = i; break }
    }
    if (splitAt === -1) splitAt = Math.ceil(remaining.length / 2)
    result.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  return result
}

function wrapSubtitleLine(text, maxPerLine = 14) {
  if (text.length <= maxPerLine) return text
  // 最多2行，在词边界断开
  const words = jieba.cut(text)
  let line1 = '', line2 = ''
  let onSecond = false
  for (const word of words) {
    if (!onSecond && line1.length + word.length > maxPerLine && line1.length > 0) {
      onSecond = true
    }
    if (onSecond) {
      line2 += word
    } else {
      line1 += word
    }
  }
  if (!line2) return line1
  return line1 + '\n' + line2
}

function calcMaxCharsPerLine(videoWidth, videoHeight = 1920, fontSize = 16, marginLR = 20) {
  const scale = videoHeight / 384
  const scaledFontSize = fontSize * scale
  const scaledMargin = marginLR * 2 * scale
  const availWidth = videoWidth - scaledMargin
  const charWidth = scaledFontSize * 1.15
  return Math.max(6, Math.floor(availWidth / charWidth))
}

function buildForceStyle(subtitleStyle = {}) {
  const font = subtitleStyle.font || 'Noto Sans CJK SC'
  const fontSizePct = subtitleStyle.fontSize || 4.2
  const fontSize = Math.round(fontSizePct * 3.84)
  const hexColor = (subtitleStyle.color || '#FFFFFF').replace('#', '')
  const r = hexColor.slice(0, 2), g = hexColor.slice(2, 4), b = hexColor.slice(4, 6)
  const alpha = subtitleStyle.alpha !== undefined ? subtitleStyle.alpha : 1.0
  const alphaHex = Math.round((1 - alpha) * 255).toString(16).padStart(2, '0').toUpperCase()
  const assColor = `&H${alphaHex}${b}${g}${r}`
  const pos = subtitleStyle.position || 'bottom'
  const alignment = pos === 'top' ? 8 : pos === 'center' ? 5 : 2
  const marginV = pos === 'center' ? 10 : 50

  const borderW = subtitleStyle.borderW !== undefined ? subtitleStyle.borderW : 1
  const borderHex = (subtitleStyle.borderColor || '#000000').replace('#', '')
  const br = borderHex.slice(0, 2), bg = borderHex.slice(2, 4), bb = borderHex.slice(4, 6)
  const borderAlpha = subtitleStyle.borderAlpha !== undefined ? subtitleStyle.borderAlpha : 0.5
  const borderAlphaHex = Math.round((1 - borderAlpha) * 255).toString(16).padStart(2, '0').toUpperCase()
  const assOutlineColor = `&H${borderAlphaHex}${bb}${bg}${br}`

  return `FontName=${font},FontSize=${fontSize},PrimaryColour=${assColor},OutlineColour=${assOutlineColor},BackColour=&H80000000,BorderStyle=1,Outline=${borderW},Shadow=0,Alignment=${alignment},MarginV=${marginV},MarginL=20,MarginR=20,WrapStyle=0`
}

function buildBannerFilter(bannerText, videoWidth, videoHeight, style = {}, tmpDir = null) {
  if (!bannerText || !bannerText.trim()) return null
  const lines = bannerText.split('\n').filter(l => l.trim())
  if (!lines.length) return null
  const fontFile = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
  const fallbackFont = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
  const font = fs.existsSync(fontFile) ? fontFile : fallbackFont

  const fontSizePct = style.fontSize ?? 2.8
  const fontSize = Math.round(videoHeight * fontSizePct / 100)
  const lineSpacing = Math.round(fontSize * 0.6)
  const topPadding = Math.round(videoHeight * 0.06)

  const hexToFF = (hex, a) => {
    const clean = (hex || '#ffffff').replace('#', '0x')
    return (a !== undefined && a < 1.0) ? `${clean}@${Number(a).toFixed(2)}` : clean
  }

  const fontcolor   = hexToFF(style.color ?? '#ffffff', style.alpha ?? 1.0)
  const borderW     = style.borderW ?? 2
  const bordercolor = hexToFF(style.borderColor ?? '#000000', style.borderAlpha ?? 0.6)
  const shadowX     = style.shadowX ?? 0
  const shadowY     = style.shadowY ?? 0
  const shadowcolor = hexToFF(style.shadowColor ?? '#000000', 0.8)
  const boxEnabled  = style.boxEnabled ?? false
  const boxcolor    = hexToFF(style.boxColor ?? '#000000', style.boxAlpha ?? 0.5)

  const dir = tmpDir || os.tmpdir()
  const textFilePath = path.join(dir, 'banner_text.txt')
  fs.writeFileSync(textFilePath, lines.join('\n'), 'utf8')

  let f = `drawtext=textfile='${textFilePath.replace(/'/g, "'\\''")}':fontfile='${font}':fontsize=${fontSize}:fontcolor=${fontcolor}`
  f += `:line_spacing=${lineSpacing}`
  f += `:borderw=${borderW}:bordercolor=${bordercolor}`
  if (shadowX > 0 || shadowY > 0) f += `:shadowx=${shadowX}:shadowy=${shadowY}:shadowcolor=${shadowcolor}`
  if (boxEnabled) f += `:box=1:boxcolor=${boxcolor}:boxborderw=8`
  f += `:x=(w-text_w)/2:y=${topPadding}`
  return f
}

// 在标点符号处断句（完整句子不拆开）
function splitAtPunctuation(text) {
  const sentences = []
  let remaining = text.trim()
  while (remaining.length > 0) {
    const m = remaining.match(/^(.*?[。！？…；，、,;.!?]+)/)
    if (m) {
      sentences.push(m[1].trim())
      remaining = remaining.slice(m[1].length).trim()
    } else {
      sentences.push(remaining)
      break
    }
  }
  return sentences.filter(s => s.length > 0)
}

function jiebaSegmentSubtitle(text, maxPerLine) {
  const maxChars = maxPerLine * 2

  // 1. 先在标点处强制断句（标点断句不合并）
  const sentences = splitAtPunctuation(text)
  const cleaned = sentences.map(s => s.replace(/[。！？…；，、,;.!?：:\s]+/g, '')).filter(s => s.length > 0)

  // 2. 超长句用 jieba 再切，jieba 产生的过短段可合并
  const segments = []
  for (const sent of cleaned) {
    if (sent.length <= maxChars) {
      segments.push(sent)
    } else {
      const words = jieba.cut(sent)
      const subs = []
      let current = ''
      let remaining = sent.length
      for (const word of words) {
        remaining -= word.length
        if (current.length + word.length > maxChars && current.length > 0 && remaining >= 4) {
          subs.push(current)
          current = word
        } else {
          current += word
        }
      }
      if (current) subs.push(current)
      // 只在同一句内合并过短的 jieba 子段
      for (let i = 0; i < subs.length; i++) {
        if (subs[i].length < 4 && i > 0 && segments[segments.length - 1].length + subs[i].length <= maxChars) {
          segments[segments.length - 1] += subs[i]
        } else if (subs[i].length < 4 && i + 1 < subs.length && subs[i].length + subs[i + 1].length <= maxChars) {
          subs[i + 1] = subs[i] + subs[i + 1]
        } else {
          segments.push(subs[i])
        }
      }
    }
  }

  console.log('[jiebaSegment] 成功', { total: text.length, segments: segments.length, maxChars })
  return segments
}

// 用 wordBoundaries 精确计算每个字幕段的起止时间
function alignSegmentsWithWordBoundaries(segments, wordBoundaries) {
  if (!wordBoundaries || !wordBoundaries.length) return null

  const wbClean = wordBoundaries.filter(w => w.text && w.text.trim()).map(w => ({
    text: w.text.replace(/[。！？…；，、,;.!?：:\s]+/g, ''),
    offset: w.offset,
    duration: w.duration,
  })).filter(w => w.text.length > 0)

  const result = []
  let wbIdx = 0

  for (const seg of segments) {
    let matched = 0
    const startWbIdx = wbIdx
    while (matched < seg.length && wbIdx < wbClean.length) {
      const wb = wbClean[wbIdx]
      matched += wb.text.length
      wbIdx++
    }
    if (startWbIdx < wbClean.length) {
      const startTime = wbClean[startWbIdx].offset
      const lastWb = wbClean[Math.min(wbIdx - 1, wbClean.length - 1)]
      const endTime = lastWb.offset + lastWb.duration
      result.push({ text: seg, start: startTime, end: endTime })
    } else {
      result.push({ text: seg, start: 0, end: 0 })
    }
  }
  return result
}

function buildSRT(videos, videoDurs) {
  const lines = []
  let idx = 1
  let offset = 0
  videos.forEach((v, i) => {
    const dur = videoDurs[i] || v.duration || 5
    const text = (v.subtitle || '').trim()
    if (text) {
      const chunks = chunkSubtitle(text)
      const totalChars = chunks.reduce((sum, c) => sum + c.length, 0)
      let chunkOffset = offset
      chunks.forEach(chunk => {
        const display = wrapSubtitleLine(chunk.replace(/[。！？…；，、,;.!?：:]+$/, ''))
        lines.push(`${idx++}`)
        lines.push(`${toSRTTime(chunkOffset)} --> ${toSRTTime(chunkOffset + chunkDur)}`)
        lines.push(display)
        lines.push('')
        chunkOffset += chunkDur
      })
    }
    offset += dur
  })
  return lines.join('\n')
}

async function probeDuration(filePath) {
  const r = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ])
  return parseFloat(r.stdout.trim()) || 0
}

async function probeWidth(filePath) {
  const r = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0',
    filePath,
  ])
  const [w, h] = r.stdout.trim().split(',').map(Number)
  return { width: w || 0, height: h || 0 }
}

function escapeXml(str) {
  return (str || '').replace(/[<>&'"]/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ))
}

async function generateVoiceoverShots(script, suggestedCount, style, ratio, mediaInfo = {}) {
  const apiKey  = process.env.STORYBOARD_API_KEY || ''
  const baseUrl = (process.env.STORYBOARD_API_URL || DEFAULT_API_URL).replace(/\/$/, '')
  const model   = process.env.STORYBOARD_MODEL   || DEFAULT_MODEL

  if (!apiKey) throw new Error('请配置 STORYBOARD_API_KEY 环境变量')

  const { imageCount = 0, subjectImageCount = 0, videoCount = 0, audioCount = 0, subjectDefinitions = '', imageDescriptions = '', subtitleMode = 'on', subtitleInput = '' } = mediaInfo

  // subtitleInput provided → distribute exact text; empty → AI auto-generates narration
  const hasUserSubtitle = !!(subtitleInput && subtitleInput.trim())


  const systemMsg = `你是专业电影分镜导演，任务是把视频需求转化为一组有叙事深度的 Seedance 2.0 分镜提示词。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【第一步：规划角色与故事弧线（生成任何分镜之前必须先做）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
拿到视频需求后，先在脑海中完成：

① 角色设计：出场的人物有哪些？每个人物的外貌特征、性格、在故事中的角色/处境是什么？
② 故事弧线：这组分镜要讲一个什么故事？
   - 开幕：什么情境/冲突引入故事？
   - 发展：主角经历了什么转变/挣扎/行动？
   - 结尾：如何收尾，留下什么感受？
③ 场景规划：需要几个不同的地点/时间段/环境？每个场景承担什么叙事功能？
④ 情节设计：故事中的关键事件/转折点是什么？每个分镜处于哪个叙事阶段？

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【第二步：每个分镜的四层叙事（缺任何一层为不合格）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【A 前景主体层】人物/主体是谁、正在做什么、动作细节到身体部位
  - 拆解到身体部位：不写"她在思考"，写"右手食指轻触太阳穴，目光微微上移，嘴唇微张"
  - 动作有弧度：描述开始→过程变化→结束姿态，不是静止瞬间
  - 情绪外化为行为：不写"他很焦虑"，写"他将合同翻到最后一页，停顿，食指快速翻回第一页重看一遍"
【B 背景环境层】场景里同时存在的具体元素（至少2个道具/背景细节）
  - 具体道具：名字+状态（"凉透的咖啡杯"不是"杯子"；"积满灰的奖杯"不是"奖品"）
  - 背景行为：其他人物在做什么、屏幕显示什么、窗外发生什么
  - 空间纵深：前景/中景/背景各有内容
【C 隐喻信息层】画面中什么细节在暗示更深的意义
  - 道具隐喻：空置的椅子暗示离开、未接来电暗示压力、半开的门暗示选择
  - 时间信息：天光颜色/时钟/日历/影子长度暗示时间推移
  - 对比叙事：主角的状态与背景环境形成对比或呼应
【D 运动光影层】镜头运动如何配合情绪，光影如何强化叙事
  - 运镜选一种并说清方向速度：不写"推入"，写"从桌面文件特写缓慢推入至人物侧脸"
  - 光影说具体：不写"柔光"，写"左侧单一冷白主光，右侧深阴影，人物轮廓与背景分离"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【第三步：场景多样性（强制规则，违反为不合格）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 严禁连续2个分镜使用同一地点/场景类型
2. 全片场景必须覆盖至少3种以下类型：
   A. 人物情绪特写（面部/手部/局部肢体，填满画面）
   B. 室内叙事场景（有具体道具和背景故事的室内空间）
   C. 户外/城市/自然（街道/航拍/公园/天空）
   D. 空镜B-roll（无主角，用环境/道具/群体画面推进叙事）
   E. 象征/隐喻（时钟/数字/植物/光影/对比构图）
3. 每4个分镜中至少1个纯空镜/B-roll（无主角入画）
4. 禁止用"人物坐桌前朝镜头微笑/点头"超过1次

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【技术规范（全部为必须项，没有可选）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 主体描述：每段 prompt 开头必须重新描述主体外貌（年龄/性别/发型/服装/体态），不得用"主角""他""她"等代词代替，不使用人名。${imageCount + videoCount > 0 ? '有参考素材时用「<图片 N>中的...」格式锚定。' : ''}
- 景别节奏：相邻段景别交替变化（全景→中景→特写→空镜→特写...）
- 运镜多样：避免连续2段同向运镜，之间插固定镜头或反向运镜
- 光影统一：全片统一光影基调，每段用具体方向/颜色/强度描述
- 末尾约束：每段 prompt 末尾必须加"无水印，无Logo"
- prompt 长度：每段 150-220字，禁止用泛化词（"干净背景""整洁办公室""明亮环境"）代替具体场景描写
${imageCount + videoCount > 0 || subjectDefinitions.trim() ? '- 素材引用：每段都用「<图片 N>中的...」引用参考素材锚定人物外貌，防止 ID 漂移' : imageCount + videoCount === 0 && !subjectDefinitions.trim() ? '- 禁止出现「<图片 N>」「<视频 N>」等素材引用标记（本次无参考素材）' : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【✅ 合格 prompt 示例（必须达到这个丰富程度）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
示例A（叙事转折镜头）：
"35岁男性，短发略显凌乱，深蓝色西装领带松开，站在办公室落地窗前，窗外是阴天城市天际线，铅灰色云层低压。他左手持一份厚达数十页的合同，右手拇指缓缓摩挲文件边缘，视线从最后一页缓缓抬起移向窗外，眉头微蹙，嘴角轻抿。背景虚化处：会议室长桌上散落着其他合同文件，空置的椅子仍留有坐过的压痕，白板上'Q3目标'数字被划掉重写了两次。左侧冷白主光将人物轮廓从灰暗背景中分离，右脸深阴影。固定镜头缓缓推入，从合同页边特写起，终止于人物疲惫侧脸。电影级4K画面，无水印，无Logo。"

示例B（空镜叙事镜头）：
"城市金融区俯拍，清晨6:45分，写字楼大堂玻璃门外排队等候的西装人群，每人手持咖啡杯或手机，面朝同一方向，背包和公文包整齐悬挂。地面积水倒映着写字楼玻璃幕墙，反射的人影在水中轻微颤动。门卫刚刷开大堂，人群开始缓缓涌入，第一排的人低头看手机，后排的人踮脚望向门口。早晨冷蓝色天光从左侧照入，玻璃幕墙反射出对面楼宇灯光。摄影机缓慢下降，从俯拍全景降至人群头顶高度。纪录片质感，高清，无水印，无Logo。"

❌ 不合格示例（禁止产出）：
"男性坐在办公桌前翻看文件，神情专注，背景是干净明亮的办公室，柔光，推入镜头，高清，无水印，无Logo。"（无叙事层次，场景泛化，无具体细节）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${hasUserSubtitle ? `【字幕分配规则（严禁修改原文）】
1. 按视觉场景归组台词——同一地点/情绪的多句台词合入同一分镜，prompt 用四层叙事充分表现
2. 所有分镜 subtitle 拼接后必须逐字逐句100%等于原文，严禁改写、增删任何字词标点
3. 单个分镜最多约15秒（≈52字），只有视觉场景需要切换时才拆分，不因字幕稍长就拆
4. 禁止把单句话拆成多个分镜；只在句子边界（句号/问号/感叹号/省略号）处断开` : `【字幕生成规则】
1. 根据视频需求自动生成旁白/解说词，填入每个分镜的 subtitle 字段
2. 字幕语言自然流畅，贴合主题，适合作为画外音；每段约15-50字，不可留空
3. 全部分镜字幕拼接后构成一段完整连贯的解说/旁白`}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【输出格式（纯JSON，不含任何其他文字或代码块标记）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "story_arc": "一句话描述本组分镜的叙事弧线（开篇情境→核心冲突→结尾落点）",
  "character_anchor": "全片视觉锚点（80-120字）：所有出场角色的外貌描述 + 视觉风格 + 画质词 + 主导光影色调，不写固定地点",
  "shots": [
    {
      "shot_number": 1,
      "narrative_stage": "开幕/铺垫/发展/转折/高潮/结尾（选一个）",
      "title": "分镜标题（8字以内）",
      "subtitle": "${hasUserSubtitle ? '该分镜对应的字幕原文精确子串，严禁修改' : '自动生成的旁白解说词（15-50字）'}",
      "description": "本格叙事功能（30字以内）：这个镜头推进了什么——处境变化/情绪转折/信息揭示",
      "prompt": "Seedance 2.0 提示词（150-220字，必须包含四层叙事：A前景主体+B背景环境+C隐喻信息+D运动光影）${imageCount + videoCount > 0 || subjectDefinitions.trim() ? '，用<图片N>引用参考素材' : ''}",
      "duration": "秒数（整数，ceil(subtitle字数/3.5)，范围4-15）",
      "ratio": "${ratio}",
      "camera_movement": "镜头运动（中文，描述方向和速度，如：从文件特写缓慢推入至人物侧脸）",
      "mood": "情绪基调（中文）",
      "subjects": []
    }
  ]
}

JSON字段中英文双引号必须转义为\\"，只输出纯JSON对象。`


  let mediaHint = ''
  if (imageCount + videoCount + audioCount > 0) {
    const parts = []
    if (subjectImageCount > 0 && imageCount > subjectImageCount) {
      // Subject images are 图片1..subjectImageCount, uploaded images follow after
      const uploadedStart = subjectImageCount + 1
      const uploadedEnd = imageCount
      parts.push(`角色参考图片为「图片 1」到「图片 ${subjectImageCount}」（已在角色定义中说明），额外参考图片为「图片 ${uploadedStart}」到「图片 ${uploadedEnd}」`)
    } else if (subjectImageCount > 0) {
      parts.push(`角色参考图片为「图片 1」到「图片 ${subjectImageCount}」（已在角色定义中说明），无额外参考图片`)
    } else if (imageCount > 0) {
      parts.push(`参考图片 ${imageCount} 张（引用方式：「图片 1」到「图片 ${imageCount}」）`)
    }
    if (videoCount > 0) parts.push(`参考视频 ${videoCount} 条（引用方式：「视频 1」到「视频 ${videoCount}」）`)
    if (audioCount > 0) parts.push(`参考音频 ${audioCount} 条（引用方式：「音频 1」到「音频 ${audioCount}」）`)
    mediaHint = `\n- 用户提供了${parts.join('、')}。严禁引用不存在的图片编号（最大为图片 ${imageCount}）`
  }

  let subjectHint = ''
  if (subjectDefinitions.trim()) {
    subjectHint = `\n\n【已定义的角色（每段prompt必须严格引用）】\n${subjectDefinitions.trim()}\n\n重要规则：\n1. 每段 prompt 中出现角色时，必须写「<图片 N>中的角色名」来锚定角色外貌（N对应上面的编号），防止角色 ID 漂移\n2. 每段 prompt 都必须引用所有角色的图片编号，即使该角色在画面之外也要在 prompt 末尾注明「角色参考：<图片 1>xxx、<图片 2>xxx」\n3. 严禁省略图片引用，严禁使用代词代替角色描述`
  }

  let imageDescHint = ''
  if (imageDescriptions.trim()) {
    imageDescHint = `\n\n【参考图片编号与内容说明（每段prompt必须结合以下描述）】\n${imageDescriptions.trim()}\n\n重要：每段 prompt 中引用图片时，必须结合上述描述来丰富画面内容。例如引用角色图片时需融合其外貌/性格描述，引用参考素材时需体现其用途说明。`
  }

  let userMsgParts = []
  if (script && !subtitleInput) {
    userMsgParts.push(`口播文案：\n${script}`)
  } else if (script && subtitleInput) {
    userMsgParts.push(`视频需求：\n${script}`)
    userMsgParts.push(`视频字幕（必须完整拆分到各分镜的 subtitle 字段，不得遗漏或修改任何文字）：\n${subtitleInput}`)
  } else if (subtitleInput) {
    userMsgParts.push(`视频字幕（必须完整拆分到各分镜的 subtitle 字段，不得遗漏或修改任何文字）：\n${subtitleInput}`)
  }

  const userMsg = `${userMsgParts.join('\n\n')}

要求：
- 视觉风格：${style || '根据内容自动判断最合适的风格'}
- 画面比例：${ratio}
- 建议分镜数量：约 ${suggestedCount} 个（优先按叙事节奏分段，可 ±2 调整）${mediaHint}${hasUserSubtitle ? '\n- 字幕文本必须100%完整覆盖到各分镜的subtitle字段中，每个分镜尽量多承载字幕（单个分镜最多约15秒≈52字），只有叙事场景需要切换时才拆分' : '\n- 每个分镜必须生成字幕（subtitle不可为空），根据视频需求自动生成合适的旁白/解说词'}

按照导演思维完成以下步骤再输出JSON：
1. 先规划角色：出场人物各自的外貌、身份、处境
2. 再规划故事弧线：开篇冲突 → 中段发展 → 结尾落点
3. 设计场景序列：哪些地点/时间/环境承担哪些叙事功能
4. 为每个分镜写四层叙事（前景主体+背景环境+隐喻信息+运动光影），prompt 150-220字
5. 输出 story_arc + character_anchor + shots 的JSON${imageCount > 0 || subjectDefinitions.trim() ? '\n6. 每段都要用「<图片 N>中的...」格式引用参考素材，防止人物 ID 漂移' : ''}${subjectHint}${imageDescHint}`

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }],
      temperature: 0.9,
      max_tokens: 8192,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`AI API error ${res.status}: ${errText.slice(0, 300)}`)
  }

  const data    = await res.json()
  const rawText = (data?.choices?.[0]?.message?.content || '').trim()
  if (!rawText) throw new Error('API 返回内容为空')

  const cleaned = rawText
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()

  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    // Try to extract JSON object from mixed text+JSON response
    const jsonMatch = rawText.match(/\{[\s\S]*"shots"\s*:\s*\[[\s\S]*\]\s*\}/)
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0])
      } catch {
        try { parsed = JSON.parse(jsonrepair(jsonMatch[0])) } catch {}
      }
    }
    if (!parsed) {
      try {
        parsed = JSON.parse(jsonrepair(cleaned))
      } catch {
        throw new Error('返回的 JSON 格式无效，请重试。原始：' + rawText.slice(0, 300))
      }
    }
  }

  let rawShots, characterAnchor
  if (Array.isArray(parsed)) {
    rawShots = parsed
    characterAnchor = ''
  } else if (parsed && Array.isArray(parsed.shots)) {
    rawShots = parsed.shots
    characterAnchor = parsed.character_anchor || ''
  } else {
    throw new Error('返回格式无效：缺少 shots 数组')
  }

  // 强制保证：当用户提供了视频字幕时，分镜subtitle拼接必须严格等于原文
  if (hasUserSubtitle) {
    // 去掉所有空白后比较，确保内容完全一致
    const normalize = s => s.replace(/\s+/g, '')
    const combined = rawShots.map(s => normalize(s.subtitle || '')).join('')
    const original = normalize(subtitleInput)
    if (combined !== original) {
      // AI没有严格遵守，强制用原文按标点边界重新分配
      // 支持在所有中文标点处断开：句号、逗号、问号、感叹号、分号、冒号、省略号
      const segments = subtitleInput.match(/[^。！？…，；：\n]+[。！？…，；：\n]?/g) || [subtitleInput]
      const shotCount = rawShots.length
      const totalLen = subtitleInput.replace(/\s+/g, '').length
      const charsPerShot = Math.ceil(totalLen / shotCount)
      let chunks = []
      let current = ''
      for (const seg of segments) {
        if (current.replace(/\s+/g, '').length + seg.replace(/\s+/g, '').length > charsPerShot && current.trim().length > 0 && chunks.length < shotCount - 1) {
          chunks.push(current.trim())
          current = seg
        } else {
          current += seg
        }
      }
      if (current.trim()) chunks.push(current.trim())
      // 块数不足shots数时后面补空
      while (chunks.length < shotCount) chunks.push('')
      // 块数超过shots数时合并尾部
      while (chunks.length > shotCount) {
        const last = chunks.pop()
        chunks[chunks.length - 1] += last
      }
      // 强制覆盖每个shot的subtitle
      for (let i = 0; i < rawShots.length; i++) {
        rawShots[i].subtitle = chunks[i] || ''
      }
    }
  }

  return {
    characterAnchor,
    shots: rawShots.map(shot => {
      let prompt = String(shot.prompt || '').trim()
      const subtitleLen = (shot.subtitle || '').trim().length
      const minDuration = Math.max(4, Math.ceil(subtitleLen / 3.5))
      const duration = typeof shot.duration === 'number' && shot.duration >= minDuration && shot.duration <= 15
        ? shot.duration
        : Math.min(15, Math.max(4, minDuration))
      return {
        ...shot,
        prompt,
        duration,
      }
    }),
  }
}

async function analyzeSubjects(mediaList) {
  const geminiKey = process.env.GEMINI_API_KEY || ''
  const geminiModel = process.env.GEMINI_MODEL || 'gemini-3-flash-preview'

  if (!geminiKey) throw new Error('请配置 GEMINI_API_KEY 环境变量')

  const systemPrompt = `你是 Seedance 2.0 视频生成的主体定义助手。你的任务是分析用户提供的参考素材（图片/视频），识别其中的所有主体，并输出结构化的主体定义。

【主体定义规则】
1. 主体可以是：人物、动物、道具、场景元素等
2. 每个主体用 2-3 个清晰、稳定的静态特征描述（如服饰、发型、外观、类别），确保唯一可识别性
3. 定义格式：将<图片N>中的[主体核心特征]定义为<主体N>
4. 如果一张图片中有多个主体，分别定义每个
5. 特征描述要具体（不说"一个人"，要说"穿白衬衫、戴眼镜的中年男性"）
6. 避免使用可能变化的特征（如表情、姿势），优先用服饰、发型、体型等稳定特征

【输出格式】
严格输出纯JSON对象，包含：
- definitions: 数组，每个元素是一条主体定义字符串
- summary: 一句话概括（如"共识别3个主体：1位女性、1位男性、1只猫"）
- usage_hint: 简短的使用提示，说明后续 prompt 中如何引用这些主体

示例输出：
{
  "definitions": [
    "将<图片 1>中穿红色连衣裙、长卷发的年轻女性定义为<主体1>",
    "将<图片 1>中穿灰色西装、短发的中年男性定义为<主体2>",
    "将<图片 2>中白色毛发、蓝眼睛的布偶猫定义为<主体3>"
  ],
  "summary": "共识别3个主体：1位年轻女性、1位中年男性、1只布偶猫",
  "usage_hint": "在分镜 prompt 中使用 <主体1>@<图片 1> 格式引用，确保每次提及主体时都带上素材绑定关系"
}

只输出纯JSON对象，不包含任何其他文字或代码块标记。`

  // Build Gemini parts array - download images and send as inlineData (base64)
  const parts = [{ text: systemPrompt + '\n\n请分析以下参考素材中的所有主体，输出结构化的主体定义：\n' }]
  let imgIdx = 0
  for (const item of mediaList) {
    if (item.mediaType === 'image' && item.previewUrl) {
      imgIdx++
      parts.push({ text: `\n--- 图片 ${imgIdx} ---\n` })
      try {
        const imgRes = await fetch(item.previewUrl, { signal: AbortSignal.timeout(10_000) })
        if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`)
        const buffer = Buffer.from(await imgRes.arrayBuffer())
        const mimeType = imgRes.headers.get('content-type') || 'image/jpeg'
        parts.push({ inlineData: { mimeType, data: buffer.toString('base64') } })
      } catch (e) {
        parts.push({ text: `[图片 ${imgIdx} 加载失败: ${e.message}]` })
      }
    }
  }

  if (imgIdx === 0) {
    throw new Error('没有可分析的图片素材（需要图片的预览URL）')
  }

  // Use OpenAI-compatible chat completions format (for third-party proxies like fidelityai)
  const geminiBaseUrl = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '')
  const url = `${geminiBaseUrl}/v1/chat/completions`

  // Build OpenAI-compatible content array with image_url (base64 data URI)
  const userContent = [{ type: 'text', text: systemPrompt + '\n\n请分析以下参考素材中的所有主体，输出结构化的主体定义：' }]
  let idx2 = 0
  for (const p of parts) {
    if (p.text && p.text.startsWith('\n--- 图片')) {
      idx2++
      userContent.push({ type: 'text', text: `图片 ${idx2}：` })
    } else if (p.inlineData) {
      userContent.push({ type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } })
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${geminiKey}` },
    body: JSON.stringify({
      model: geminiModel,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.3,
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`)
  }

  const data = await res.json()
  const rawText = (data?.choices?.[0]?.message?.content || '').trim()
  if (!rawText) throw new Error('Gemini API 返回内容为空')

  const cleaned = rawText
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()

  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(cleaned))
    } catch {
      throw new Error('返回的 JSON 格式无效：' + rawText.slice(0, 200))
    }
  }

  return {
    definitions: parsed.definitions || [],
    summary: parsed.summary || '',
    usageHint: parsed.usage_hint || '',
  }
}

async function voiceoverRoutes(fastify) {

  fastify.post('/analyze-subjects', {
    schema: {
      body: {
        type: 'object', required: ['media'],
        properties: {
          media: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url:        { type: 'string' },
                mediaType:  { type: 'string' },
                previewUrl: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const result = await analyzeSubjects(request.body.media || [])
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.post('/analyze-script', {
    schema: {
      body: {
        type: 'object',
        required: ['script'],
        properties: {
          script: { type: 'string', maxLength: 5000 },
        },
      },
    },
  }, async (request, reply) => {
    const apiKey  = process.env.STORYBOARD_API_KEY || ''
    const baseUrl = (process.env.STORYBOARD_API_URL || 'https://api.deepseek.com').replace(/\/$/, '')
    const model   = process.env.STORYBOARD_MODEL   || DEFAULT_MODEL
    if (!apiKey) return reply.code(500).send({ success: false, error: '请配置 STORYBOARD_API_KEY' })

    const script = (request.body.script || '').trim()
    if (!script) return reply.code(400).send({ success: false, error: '请输入剧本内容' })

    const prompt = `你是专业的影视剧本分析师。请分析以下剧本/视频需求，提取出所有需要出现的角色（真人、虚拟人物、动物等有生命的主体）。不要提取场景、物品、建筑等非角色元素。

对每个角色，请给出：
1. 名称（简短标识）
2. 类型（真人/虚拟人物/动物）
3. 外貌/形象描述（详细的视觉特征，适合AI生成图像时使用）
4. 性格/特质描述

请以JSON格式返回，格式如下：
{
  "subjects": [
    {
      "label": "角色名称",
      "type": "真人|虚拟人物|动物",
      "appearance": "详细外貌/形象描述（50-100字，包含发型、衣着、体态、年龄等）",
      "personality": "性格/特质描述（30-60字）"
    }
  ]
}

注意：
- 只提取角色（有生命的主体），不提取场景、道具、建筑
- 外貌描述要具体，包含发型、衣着、体态、颜色、年龄等视觉细节
- 如果剧本没有明确描述外貌，请根据角色定位合理推断
- 直接输出JSON，不要加其他文字

剧本内容：
${script}`

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 2048,
        }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`AI API error ${res.status}: ${errText.slice(0, 200)}`)
      }
      const data = await res.json()
      const rawText = data.choices?.[0]?.message?.content?.trim() || ''
      const jsonMatch = rawText.match(/\{[\s\S]*"subjects"\s*:\s*\[[\s\S]*\]\s*\}/)
      if (!jsonMatch) throw new Error('AI 返回格式异常')
      const parsed = JSON.parse(jsonMatch[0])
      return { success: true, data: { subjects: parsed.subjects || [] } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.post('/generate-script', {
    schema: {
      body: {
        type: 'object',
        properties: {
          topic: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    const apiKey  = process.env.STORYBOARD_API_KEY || ''
    const baseUrl = (process.env.STORYBOARD_API_URL || 'https://api.deepseek.com').replace(/\/$/, '')
    const model   = process.env.STORYBOARD_MODEL   || DEFAULT_MODEL
    if (!apiKey) return reply.code(500).send({ success: false, error: '请配置 STORYBOARD_API_KEY' })

    const topic = (request.body.topic || '').trim()
    const prompt = topic
      ? `你是一个短视频文案专家。请根据以下主题，生成一段适合AI视频生成的口播文案（100-200字）。要求：节奏紧凑、画面感强、适合配音朗读、适合拆分为多个分镜画面。直接输出文案，不要加标题或前缀。\n\n主题：${topic}`
      : '你是一个短视频文案专家。请随机选择一个有吸引力的话题，生成一段适合AI视频生成的口播文案（100-200字）。要求：节奏紧凑、画面感强、适合配音朗读、适合拆分为多个分镜画面。直接输出文案，不要加标题或前缀。'

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.9,
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`AI API error ${res.status}: ${errText.slice(0, 200)}`)
      }
      const data = await res.json()
      const text = data.choices?.[0]?.message?.content?.trim() || ''
      return { success: true, data: { script: text } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.post('/init', {
    schema: {
      body: {
        type: 'object',
        properties: {
          script:    { type: 'string', maxLength: 5000 },
          style:     { type: 'string', maxLength: 200 },
          ratio:     { type: 'string' },
          shotCount: { type: 'integer', minimum: 2, maximum: 20 },
          imageCount: { type: 'integer', minimum: 0 },
          subjectImageCount: { type: 'integer', minimum: 0 },
          videoCount: { type: 'integer', minimum: 0 },
          audioCount: { type: 'integer', minimum: 0 },
          subjectDefinitions: { type: 'string', maxLength: 2000 },
          imageDescriptions: { type: 'string', maxLength: 3000 },
          subtitleMode: { type: 'string', enum: ['on', 'off'] },
          subtitleInput: { type: 'string', maxLength: 5000 },
        },
      },
    },
  }, async (request, reply) => {
    const {
      script = '',
      style      = '',
      ratio      = '9:16',
      shotCount: overrideCount,
      imageCount = 0,
      subjectImageCount = 0,
      videoCount = 0,
      audioCount = 0,
      subjectDefinitions = '',
      imageDescriptions = '',
      subtitleMode = 'on',
      subtitleInput = '',
    } = request.body

    if (!script.trim() && !subtitleInput.trim()) {
      return reply.code(400).send({ success: false, error: '视频需求和视频字幕不能全为空' })
    }

    try {
      const CPS = 3.5
      const primaryText = subtitleInput.trim() || script
      const scriptChars = primaryText.replace(/\s/g, '').length
      const estimatedDuration = scriptChars / CPS

      const AUTO_SHOT_MAX = 20
      const rawShotCount  = Math.round(estimatedDuration / 13)
      const autoShotCount = Math.max(2, Math.min(AUTO_SHOT_MAX, rawShotCount))
      const shotCount     = overrideCount ?? autoShotCount

      const { shots, characterAnchor } = await generateVoiceoverShots(
        script.trim() || `根据以下字幕内容生成对应的视频画面：${subtitleInput.trim()}`,
        shotCount, style, ratio,
        { imageCount, subjectImageCount, videoCount, audioCount, subjectDefinitions, imageDescriptions, subtitleMode, subtitleInput: subtitleInput.trim() }
      )

      // Duration based on each shot's subtitle length (always present)
      const shotsWithDuration = shots.map(shot => {
        const subtitleLen = (shot.subtitle || '').replace(/\s/g, '').length
        const minDuration = Math.max(4, Math.ceil(subtitleLen / 3.5))
        const duration = typeof shot.duration === 'number' && shot.duration >= minDuration && shot.duration <= 15
          ? shot.duration : Math.min(15, minDuration)
        return { ...shot, duration }
      })

      return {
        success: true,
        data: {
          autoShotCount,
          shotCount,
          characterAnchor,
          shots:              shotsWithDuration,
          totalVideoDuration: shotsWithDuration.reduce((a, s) => a + s.duration, 0),
        },
      }
    } catch (err) {
      fastify.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ── TTS: 生成整条语音 + 逐词时间戳 ──────────────────
  fastify.post('/tts', {
    schema: {
      body: {
        type: 'object', required: ['script', 'shots'],
        properties: {
          script: { type: 'string', minLength: 1, maxLength: 5000 },
          voice:  { type: 'string' },
          shots: {
            type: 'array', minItems: 1, maxItems: 20,
            items: {
              type: 'object', required: ['subtitle'],
              properties: { subtitle: { type: 'string' } },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { script, voice = 'zh-CN-XiaoxiaoNeural', shots } = request.body

    const azureKey    = process.env.AZURE_SPEECH_KEY    || ''
    const azureRegion = process.env.AZURE_SPEECH_REGION || 'eastasia'

    if (!azureKey) return reply.code(500).send({ success: false, error: '请配置 AZURE_SPEECH_KEY 环境变量' })

    try {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true })

      const audioName = `voiceover-tts-${Date.now()}.mp3`
      const audioPath = path.join(UPLOAD_DIR, audioName)

      const speechConfig = sdk.SpeechConfig.fromSubscription(azureKey, azureRegion)
      speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio48Khz96KBitRateMonoMp3
      const audioConfig = sdk.AudioConfig.fromAudioFileOutput(audioPath)
      const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig)

      const wordBoundaries = []
      synthesizer.wordBoundary = (s, e) => {
        wordBoundaries.push({
          text: e.text,
          offset: e.audioOffset / 10000000,
          duration: e.duration / 10000000,
        })
      }

      const ssml = `<speak version='1.0' xml:lang='zh-CN'><voice name='${voice}'>${escapeXml(script)}</voice></speak>`

      const result = await new Promise((resolve, reject) => {
        synthesizer.speakSsmlAsync(ssml,
          r => { synthesizer.close(); resolve(r) },
          err => { synthesizer.close(); reject(new Error(err)) },
        )
      })

      if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
        throw new Error(`TTS 合成失败: ${sdk.ResultReason[result.reason]}`)
      }

      const totalDuration = await probeDuration(audioPath)
      if (!totalDuration || totalDuration <= 0) throw new Error('无法读取语音时长')

      const charCounts = shots.map(s => (s.subtitle || '').replace(/\s/g, '').length)
      const totalChars = charCounts.reduce((a, b) => a + b, 0) || 1

      let shotDurations = charCounts.map(chars => {
        const raw = totalDuration * (chars / totalChars)
        return Math.max(4, Math.ceil(raw))
      })
      let videoDurSum = shotDurations.reduce((a, b) => a + b, 0)
      if (videoDurSum < Math.ceil(totalDuration)) {
        const deficit = Math.ceil(totalDuration) - videoDurSum
        let maxIdx = 0
        shotDurations.forEach((d, i) => { if (d > shotDurations[maxIdx]) maxIdx = i })
        shotDurations[maxIdx] += deficit
      }

      const base = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '')
      return {
        success: true,
        data: {
          audioUrl:      `${base}/uploads/${audioName}`,
          totalDuration,
          shotDurations,
          totalVideoDuration: shotDurations.reduce((a, b) => a + b, 0),
          wordBoundaries,
        },
      }
    } catch (err) {
      fastify.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.post('/merge', {
    schema: {
      body: {
        type: 'object', required: ['videos', 'audioUrl'],
        properties: {
          videos: {
            type: 'array', minItems: 1, maxItems: 20,
            items: {
              type: 'object', required: ['url'],
              properties: {
                url:      { type: 'string' },
                subtitle: { type: 'string' },
                duration: { type: 'number' },
              },
            },
          },
          audioUrl: { type: 'string' },
          voice:    { type: 'string' },
          subtitle: { type: 'string' },
          subtitleStyle: {
            type: 'object',
            properties: {
              font:     { type: 'string' },
              fontSize: { type: 'number' },
              color:    { type: 'string' },
              position: { type: 'string' },
            },
          },
          banner: { type: 'string', maxLength: 500 },
          bannerStyle: {
            type: 'object',
            properties: {
              fontSize: { type: 'number' }, color: { type: 'string' }, alpha: { type: 'number' },
              borderW: { type: 'number' }, borderColor: { type: 'string' }, borderAlpha: { type: 'number' },
              shadowX: { type: 'number' }, shadowY: { type: 'number' }, shadowColor: { type: 'string' },
              boxEnabled: { type: 'boolean' }, boxColor: { type: 'string' }, boxAlpha: { type: 'number' },
            },
          },
          wordBoundaries: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, offset: { type: 'number' }, duration: { type: 'number' } } } },
        },
      },
    },
  }, async (request, reply) => {
    const { videos, audioUrl, voice, subtitle: fullSubtitle, subtitleStyle, banner, bannerStyle = {}, wordBoundaries } = request.body
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceover-merge-'))

    try {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true })

      // ── 1. 并行下载所有分镜视频（有缓存，不重复下载） ──────────────────────
      const downloadResults = await Promise.all(
        videos.map(async ({ url }, i) => {
          try {
            const info = await downloadWithCache(url)
            if (!info) return { path: null, duration: 0, index: i }
            return { path: info.path, duration: info.duration, index: i }
          } catch (e) {
            fastify.log.warn(`分镜 ${i + 1} 下载失败: ${e.message}`)
            return { path: null, duration: 0, index: i }
          }
        })
      )

      const succeeded = downloadResults.filter(r => r.path)
      if (succeeded.length < 1) {
        return reply.code(400).send({ success: false, error: '没有分镜视频下载成功，无法合并' })
      }
      const videoPaths = succeeded.map(r => r.path)
      const validVideos = succeeded.map(r => videos[r.index])

      // ── 2. 音频 & SRT ──────────────────────────────────────────────────────
      let audioPath
      const hasSubtitles = validVideos.some(v => v.subtitle && v.subtitle.trim())

      // 使用已有的整块音频（不重新 TTS）
      const localPath = localUploadPath(audioUrl)
      if (localPath) {
        audioPath = localPath
      } else {
        audioPath = path.join(tmpDir, 'voiceover.mp3')
        const buf = await fetchMediaBuffer(audioUrl, { timeout: 30_000 })
        fs.writeFileSync(audioPath, buf)
      }

      // ── 3. 测量音频时长 & 各分镜时长（缓存已记录精确时长） ─────────────────
      const audioDur   = await probeDuration(audioPath)
      const videoDurs  = succeeded.map(r => r.duration)
      const videoTotal = videoDurs.reduce((a, b) => a + b, 0)
      const gap = audioDur - videoTotal

      // ── 4. 生成 SRT（AI 断句 → 回退机械断句）──────────────
      const { width: videoWidth, height: videoHeight } = await probeWidth(videoPaths[0])
      const assFontSize = Math.round(((subtitleStyle && subtitleStyle.fontSize) || 4.2) * 3.84)
      const maxPerLine = calcMaxCharsPerLine(videoWidth || 720, videoHeight || 1280, assFontSize)
      let srtContent = null
      const fullText = (fullSubtitle || '').trim() || validVideos.map(v => (v.subtitle || '').trim()).join('')
      if (fullText) {
        let segments = jiebaSegmentSubtitle(fullText, maxPerLine)

        // 用 wordBoundaries 精确对齐，否则按字数比例
        const aligned = alignSegmentsWithWordBoundaries(segments, wordBoundaries)

        const srtLines = []
        let srtIdx = 1
        if (aligned && aligned.some(a => a.end > 0)) {
          for (const { text, start, end } of aligned) {
            if (end <= start) continue
            const display = wrapSubtitleLine(text, maxPerLine)
            srtLines.push(`${srtIdx++}`)
            srtLines.push(`${toSRTTime(start)} --> ${toSRTTime(end)}`)
            srtLines.push(display)
            srtLines.push('')
          }
        } else {
          const totalChars = segments.reduce((a, s) => a + s.length, 0) || 1
          let timeOffset = 0
          for (const seg of segments) {
            const dur = audioDur * (seg.length / totalChars)
            const display = wrapSubtitleLine(seg, maxPerLine)
            srtLines.push(`${srtIdx++}`)
            srtLines.push(`${toSRTTime(timeOffset)} --> ${toSRTTime(timeOffset + dur)}`)
            srtLines.push(display)
            srtLines.push('')
            timeOffset += dur
          }
        }
        srtContent = srtLines.join('\n')
      }

      // ── 5. concat 所有分镜（无音频） ──────────────────────────────────────────
      const concatTxt = path.join(tmpDir, 'concat.txt')
      const videoOnly = path.join(tmpDir, 'video_only.mp4')
      fs.writeFileSync(concatTxt, videoPaths.map(p => `file '${p}'`).join('\n'))

      await execFileAsync('ffmpeg', [
        '-y', '-f', 'concat', '-safe', '0', '-i', concatTxt,
        '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        videoOnly,
      ], { timeout: 600_000 })

      // ── 6. 对齐时长 + 烧字幕 + 叠加语音 ─────────────────────────────────────
      const outName = `voiceover-${Date.now()}.mp4`
      const outPath = path.join(UPLOAD_DIR, outName)
      const base    = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '')

      const srtPath = path.join(tmpDir, 'subtitles.srt')
      if (srtContent) {
        fs.writeFileSync(srtPath, srtContent, 'utf8')
      }

      const subtitleFilter = srtContent
        ? `subtitles='${srtPath.replace(/'/g, "'\\''")}':force_style='${buildForceStyle(subtitleStyle)}'`
        : null
      const bannerFilter = buildBannerFilter(banner, videoWidth || 720, videoHeight || 1280, bannerStyle, tmpDir)
      const vfParts = [subtitleFilter, bannerFilter].filter(Boolean)
      const vfFilter = vfParts.length ? vfParts.join(',') : null

      if (gap > 0.3) {
        const freezePath = path.join(tmpDir, 'video_freeze.mp4')
        await execFileAsync('ffmpeg', [
          '-y', '-i', videoOnly,
          '-vf', `tpad=stop_mode=clone:stop_duration=${(gap + 0.3).toFixed(2)}`,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-an',
          freezePath,
        ], { timeout: 300_000 })

        if (vfFilter) {
          const withSubs = path.join(tmpDir, 'video_subs.mp4')
          await execFileAsync('ffmpeg', [
            '-y', '-i', freezePath, '-vf', vfFilter,
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-an',
            withSubs,
          ], { timeout: 300_000 })
          await execFileAsync('ffmpeg', [
            '-y', '-i', withSubs, '-i', audioPath,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
            '-shortest', outPath,
          ], { timeout: 300_000 })
        } else {
          await execFileAsync('ffmpeg', [
            '-y', '-i', freezePath, '-i', audioPath,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
            '-shortest', outPath,
          ], { timeout: 300_000 })
        }
      } else {
        if (vfFilter) {
          const withSubs = path.join(tmpDir, 'video_subs.mp4')
          await execFileAsync('ffmpeg', [
            '-y', '-i', videoOnly, '-vf', vfFilter,
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-an',
            withSubs,
          ], { timeout: 300_000 })
          await execFileAsync('ffmpeg', [
            '-y', '-i', withSubs, '-i', audioPath,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
            '-t', audioDur.toFixed(3), outPath,
          ], { timeout: 300_000 })
        } else {
          await execFileAsync('ffmpeg', [
            '-y', '-i', videoOnly, '-i', audioPath,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
            '-t', audioDur.toFixed(3), outPath,
          ], { timeout: 300_000 })
        }
      }

      return {
        success: true,
        data: {
          url: `${base}/uploads/${outName}`,
          audioDur: Math.round(audioDur * 10) / 10,
          videoDur: Math.round(videoTotal * 10) / 10,
          gapSeconds: Math.round(Math.max(0, gap) * 10) / 10,
        },
      }
    } catch (err) {
      fastify.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  fastify.post('/merge-images', {
    schema: {
      body: {
        type: 'object', required: ['shots', 'audioUrl'],
        properties: {
          shots: {
            type: 'array', minItems: 1, maxItems: 20,
            items: {
              type: 'object',
              properties: {
                imageUrl: { type: 'string' },
                subtitle: { type: 'string' },
                duration: { type: 'number' },
              },
            },
          },
          audioUrl: { type: 'string' },
          voice:    { type: 'string' },
          ratio:    { type: 'string' },
          subtitleStyle: {
            type: 'object',
            properties: {
              font:     { type: 'string' },
              fontSize: { type: 'number' },
              color:    { type: 'string' },
              position: { type: 'string' },
            },
          },
          banner: { type: 'string', maxLength: 500 },
          bannerStyle: {
            type: 'object',
            properties: {
              fontSize: { type: 'number' }, color: { type: 'string' }, alpha: { type: 'number' },
              borderW: { type: 'number' }, borderColor: { type: 'string' }, borderAlpha: { type: 'number' },
              shadowX: { type: 'number' }, shadowY: { type: 'number' }, shadowColor: { type: 'string' },
              boxEnabled: { type: 'boolean' }, boxColor: { type: 'string' }, boxAlpha: { type: 'number' },
            },
          },
          wordBoundaries: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, offset: { type: 'number' }, duration: { type: 'number' } } } },
        },
      },
    },
  }, async (request, reply) => {
    const { shots, audioUrl, voice, ratio = '9:16', subtitleStyle, banner, bannerStyle = {}, wordBoundaries } = request.body
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceover-imgmerge-'))

    const RATIO_MAP = { '9:16': [1080,1920], '16:9': [1920,1080], '1:1': [1080,1080], '4:3': [1440,1080], '3:4': [1080,1440], '21:9': [2520,1080] }
    const [W, H] = RATIO_MAP[ratio] || [1080, 1920]

    try {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true })

      // 下载音频
      let audioPath
      const localPath = localUploadPath(audioUrl)
      if (localPath) {
        audioPath = localPath
      } else {
        audioPath = path.join(tmpDir, 'voiceover.mp3')
        fs.writeFileSync(audioPath, await fetchMediaBuffer(audioUrl, { timeout: 30_000 }))
      }

      const audioDur = await probeDuration(audioPath)

      // 按字幕字数分配时长使总时长匹配音频
      const charCounts = shots.map(s => (s.subtitle || '').replace(/\s/g, '').length)
      const totalChars = charCounts.reduce((a, b) => a + b, 0) || 1
      const shotDurs = charCounts.map(chars => {
        const raw = audioDur * (chars / totalChars)
        return Math.max(0.5, Math.round(raw * 100) / 100)
      })

      const imgAssFontSize = Math.round(((subtitleStyle && subtitleStyle.fontSize) || 4.2) * 3.84)
      const imgMaxPerLine = calcMaxCharsPerLine(W, H, imgAssFontSize)

      // AI 断句整段字幕
      const imgFullText = shots.map(s => (s.subtitle || '').trim()).join('')
      let imgSegments = imgFullText ? jiebaSegmentSubtitle(imgFullText, imgMaxPerLine) : null

      const srtLines = []
      let srtIdx = 1, srtOffset = 0

      if (imgSegments && imgSegments.length > 0) {
        const aligned = alignSegmentsWithWordBoundaries(imgSegments, wordBoundaries)
        if (aligned && aligned.some(a => a.end > 0)) {
          for (const { text, start, end } of aligned) {
            if (end <= start) continue
            const display = wrapSubtitleLine(text, imgMaxPerLine)
            srtLines.push(`${srtIdx++}`)
            srtLines.push(`${toSRTTime(start)} --> ${toSRTTime(end)}`)
            srtLines.push(display)
            srtLines.push('')
          }
        } else {
          const segTotalChars = imgSegments.reduce((a, s) => a + s.length, 0) || 1
          let timeOff = 0
          for (const seg of imgSegments) {
            const dur = audioDur * (seg.length / segTotalChars)
            const display = wrapSubtitleLine(seg, imgMaxPerLine)
            srtLines.push(`${srtIdx++}`)
            srtLines.push(`${toSRTTime(timeOff)} --> ${toSRTTime(timeOff + dur)}`)
            srtLines.push(display)
            srtLines.push('')
            timeOff += dur
          }
        }
      }
      const preciseSRT = srtLines.join('\n')

      const videoPaths = await Promise.all(
        shots.map(async ({ imageUrl }, i) => {
          const dest = path.join(tmpDir, `shot_${String(i + 1).padStart(3,'0')}.mp4`)
          const dur  = shotDurs[i]

          if (imageUrl) {
            const imgExt  = path.extname(imageUrl.split('?')[0]) || '.jpg'
            const imgPath = path.join(tmpDir, `img_${i}${imgExt}`)
            fs.writeFileSync(imgPath, await fetchMediaBuffer(imageUrl, { timeout: 30_000 }))
            await execFileAsync('ffmpeg', [
              '-y', '-loop', '1', '-i', imgPath,
              '-t', dur.toFixed(3),
              '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
              '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-r', '25', '-an',
              dest,
            ], { timeout: 120_000 })
          } else {
            await execFileAsync('ffmpeg', [
              '-y', '-f', 'lavfi', '-i', `color=black:size=${W}x${H}:rate=25`,
              '-t', dur.toFixed(3),
              '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an',
              dest,
            ], { timeout: 120_000 })
          }
          return dest
        })
      )

      const concatTxt = path.join(tmpDir, 'concat.txt')
      fs.writeFileSync(concatTxt, videoPaths.map(p => `file '${p}'`).join('\n'))

      const outName = `voiceover-img-${Date.now()}.mp4`
      const outPath = path.join(UPLOAD_DIR, outName)
      const base    = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '')

      const hasSubtitles = shots.some(s => s.subtitle?.trim())

      const videoOnly = path.join(tmpDir, 'video_only.mp4')
      await execFileAsync('ffmpeg', [
        '-y', '-f', 'concat', '-safe', '0', '-i', concatTxt,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-an',
        videoOnly,
      ], { timeout: 600_000 })

      const imgBannerFilter = buildBannerFilter(banner, W, H, bannerStyle, tmpDir)

      if (hasSubtitles || imgBannerFilter) {
        let vfParts = []
        if (hasSubtitles) {
          const srtPath = path.join(tmpDir, 'subtitles.srt')
          fs.writeFileSync(srtPath, preciseSRT, 'utf8')
          vfParts.push(`subtitles='${srtPath.replace(/'/g, "'\\''")}':force_style='${buildForceStyle(subtitleStyle)}'`)
        }
        if (imgBannerFilter) vfParts.push(imgBannerFilter)
        const vfFilter = vfParts.join(',')

        const withSubs = path.join(tmpDir, 'video_subs.mp4')
        await execFileAsync('ffmpeg', [
          '-y', '-i', videoOnly, '-vf', vfFilter,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-an',
          withSubs,
        ], { timeout: 300_000 })

        await execFileAsync('ffmpeg', [
          '-y', '-i', withSubs, '-i', audioPath,
          '-map', '0:v:0', '-map', '1:a:0',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
          '-shortest', outPath,
        ], { timeout: 300_000 })
      } else {
        await execFileAsync('ffmpeg', [
          '-y', '-i', videoOnly, '-i', audioPath,
          '-map', '0:v:0', '-map', '1:a:0',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
          '-shortest', outPath,
        ], { timeout: 300_000 })
      }

      return { success: true, data: { url: `${base}/uploads/${outName}` } }
    } catch (err) {
      fastify.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // ── 异步合并任务 ─────────────────────────────────────────────────────────
  const mergeTasks = new Map()

  fastify.post('/merge-async', {
    schema: {
      body: {
        type: 'object', required: ['videos', 'audioUrl'],
        properties: {
          videos: {
            type: 'array', minItems: 1, maxItems: 20,
            items: {
              type: 'object', required: ['url'],
              properties: {
                url:      { type: 'string' },
                subtitle: { type: 'string' },
                duration: { type: 'number' },
              },
            },
          },
          audioUrl: { type: 'string' },
          voice:    { type: 'string' },
          subtitle: { type: 'string' },
          subtitleStyle: { type: 'object' },
          banner: { type: 'string', maxLength: 500 },
          bannerStyle: { type: 'object' },
          wordBoundaries: { type: 'array' },
        },
      },
    },
  }, async (request, reply) => {
    const mergeId = crypto.randomUUID()
    mergeTasks.set(mergeId, { status: 'processing', startedAt: Date.now() })

    const body = request.body
    ;(async () => {
      try {
        const res = await fastify.inject({
          method: 'POST',
          url: '/merge',
          payload: body,
        })
        const data = JSON.parse(res.payload)
        if (data.success) {
          mergeTasks.set(mergeId, { status: 'done', url: data.data.url, data: data.data, startedAt: mergeTasks.get(mergeId)?.startedAt })
        } else {
          mergeTasks.set(mergeId, { status: 'failed', error: data.error || '合并失败', startedAt: mergeTasks.get(mergeId)?.startedAt })
        }
      } catch (err) {
        mergeTasks.set(mergeId, { status: 'failed', error: err.message || '合并失败', startedAt: mergeTasks.get(mergeId)?.startedAt })
      }
    })()

    return { success: true, mergeId }
  })

  fastify.get('/merge-status/:mergeId', async (request, reply) => {
    const { mergeId } = request.params
    const task = mergeTasks.get(mergeId)
    if (!task) return { success: true, data: { status: 'failed', error: '任务不存在或已过期' } }
    if (task.status === 'done') {
      mergeTasks.delete(mergeId)
      return { success: true, data: { status: 'done', url: task.url } }
    }
    if (task.status === 'failed') {
      mergeTasks.delete(mergeId)
      return { success: true, data: { status: 'failed', error: task.error } }
    }
    return { success: true, data: { status: 'processing' } }
  })

  // AI创作 - 角色图片生成/迭代编辑 (OpenAI-compatible proxy, Gemini image model)
  fastify.post('/ai-image', {
    schema: {
      body: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: { type: 'string', minLength: 1, maxLength: 2000 },
          priorImageUrl: { type: 'string' },
          priorImage: {
            type: 'object',
            properties: {
              mimeType: { type: 'string' },
              data: { type: 'string' },
            },
          },
          referenceImages: {
            type: 'array',
            maxItems: 5,
            items: {
              type: 'object',
              properties: {
                mimeType: { type: 'string' },
                data: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const geminiKey = process.env.GEMINI_IMAGE_API_KEY || process.env.GEMINI_API_KEY || ''
    const baseUrl = (process.env.GEMINI_IMAGE_BASE_URL || process.env.GEMINI_BASE_URL || 'https://tokens.fidelityai.net').replace(/\/$/, '')
    const imageModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image-preview'

    if (!geminiKey) {
      return reply.code(503).send({ success: false, error: '未配置 GEMINI_API_KEY' })
    }

    const { prompt, priorImage, priorImageUrl, referenceImages } = request.body
    const trimmed = prompt.trim()
    if (!trimmed) {
      return reply.code(422).send({ success: false, error: '请输入描述' })
    }

    const isEdit = !!(priorImage && priorImage.data) || !!priorImageUrl

    try {
      const userContent = []
      if (isEdit) {
        userContent.push({ type: 'text', text: `在所给图片的基础上做如下修改：${trimmed}。\n\n只改动要求的部分，尽量保持其余构图、主体与风格一致。` })
        if (priorImage && priorImage.data) {
          userContent.push({ type: 'image_url', image_url: { url: `data:${priorImage.mimeType};base64,${priorImage.data}` } })
        } else if (priorImageUrl) {
          const buf = await fetchMediaBuffer(priorImageUrl)
          const mimeType = priorImageUrl.endsWith('.webp') ? 'image/webp' : priorImageUrl.endsWith('.jpg') || priorImageUrl.endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
          userContent.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${buf.toString('base64')}` } })
        }
      } else {
        userContent.push({ type: 'text', text: `${trimmed}\n\n要求：人物角色形象图，适合作为视频主体参考，高清，面部清晰，半身或全身像，纯色或简约背景。` })
      }
      // Append reference images
      if (referenceImages && referenceImages.length > 0) {
        userContent.push({ type: 'text', text: '\n\n以下是参考图片，请参考其中的风格、人物特征来生成：' })
        for (const img of referenceImages.slice(0, 5)) {
          if (img.mimeType && img.data) {
            userContent.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } })
          }
        }
      }

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${geminiKey}` },
        body: JSON.stringify({
          model: imageModel,
          messages: [{ role: 'user', content: userContent }],
          modalities: ['text', 'image'],
        }),
        signal: AbortSignal.timeout(120_000),
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`API error ${res.status}: ${errText.slice(0, 300)}`)
      }

      const data = await res.json()
      const msg = data?.choices?.[0]?.message
      const content = msg?.content

      let imageData = null
      let description = ''
      // Format 1: image in message.audio.data (proxy returns base64 PNG here)
      if (msg?.audio?.data) {
        imageData = `data:image/png;base64,${msg.audio.data}`
      }
      // Format 2: content is a data URL string
      else if (typeof content === 'string' && content.startsWith('data:')) {
        imageData = content
      }
      // Format 3: content is array with image_url parts
      else if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'image_url' && part.image_url?.url) {
            imageData = part.image_url.url
          } else if (part.type === 'text' && part.text) {
            description += part.text
          }
        }
      }

      if (!imageData) {
        const textResp = typeof content === 'string' ? content.slice(0, 100) : ''
        throw new Error(textResp ? `模型返回文本而非图片: ${textResp}` : '未能生成图片，请重试')
      }

      // Save base64 image to uploads directory and return a public URL
      const base64Match = imageData.match(/^data:([^;]+);base64,(.*)$/)
      if (base64Match) {
        const mimeType = base64Match[1]
        const extMap = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }
        const ext = extMap[mimeType] || '.png'
        const fileName = `ai-character-${Date.now()}${ext}`
        fs.mkdirSync(UPLOAD_ROOT, { recursive: true })
        fs.writeFileSync(path.join(UPLOAD_ROOT, fileName), Buffer.from(base64Match[2], 'base64'))
        const base = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '')
        imageData = `${base}/uploads/${fileName}`
      }

      return { success: true, data: { image: imageData, description: description.trim() || null } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })
}

module.exports = voiceoverRoutes
