'use strict'

// Seedance 提示词写作指南 — structured form of the guide page from the
// fenjing-script Flask app, so the frontend can render it natively instead of
// embedding HTML.

const STRUCTURE = {
  formula: '[镜头语言] + [主体描述] + [动作/运动] + [场景/环境] + [光线氛围] + [视觉风格] + [质量词]',
  example:
    'Slow push-in medium shot. A young woman in a white linen dress walks slowly through a lavender ' +
    'field at golden hour. Her hair flows gently in the warm breeze. Soft golden backlight creates a ' +
    'dreamy rim glow. Wide rolling hills in background. Cinematic, shallow depth of field, film grain, ' +
    'romantic and serene atmosphere.',
}

const CAMERA_MOVES = [
  { zh: '固定',   en: 'static shot / locked-off' },
  { zh: '推镜头', en: 'slow push in / dolly in' },
  { zh: '拉镜头', en: 'pull back / dolly out' },
  { zh: '平移',   en: 'pan left / pan right' },
  { zh: '跟拍',   en: 'tracking shot / follow cam' },
  { zh: '环绕',   en: 'orbital shot / 360 circle' },
  { zh: '上升',   en: 'crane up / camera rises' },
  { zh: '手持',   en: 'handheld / shaky cam' },
  { zh: '航拍',   en: "aerial / drone shot / bird's eye" },
  { zh: '倾斜',   en: 'tilt up / tilt down' },
]

const SHOT_TYPES = [
  { zh: '极致特写', en: 'extreme close-up (ECU)' },
  { zh: '特写',     en: 'close-up (CU)' },
  { zh: '近景',     en: 'medium close-up (MCU)' },
  { zh: '中景',     en: 'medium shot (MS)' },
  { zh: '全景',     en: 'wide shot / full shot' },
  { zh: '大远景',   en: 'extreme wide shot (EWS)' },
]

const RULES = [
  { kind: 'do',   title: '使用英文',        detail: 'Seedance 对英文提示词响应更好，用词精准具体' },
  { kind: 'do',   title: '具体胜于抽象',    detail: '❌ beautiful scene　✅ golden sunset over misty mountains' },
  { kind: 'do',   title: '镜头描述放前面',  detail: '将镜头语言作为提示词的开头，模型响应更稳定' },
  { kind: 'do',   title: '长度控制 50-150 词', detail: '过长会使模型混乱，过短效果不稳定' },
  { kind: 'dont', title: '避免负面描述',    detail: '不用 "no X" "without X"，直接描述想要的' },
  { kind: 'dont', title: '避免矛盾指令',    detail: '不要同时要求 static shot 和 camera movement' },
]

const QUALITY_PRESETS = [
  { name: '电影级别',   words: 'cinematic, film grain, 4K, anamorphic, shallow depth of field' },
  { name: '商业广告',   words: 'commercial style, clean, polished, high-end, professional lighting' },
  { name: '自然纪录片', words: 'documentary style, natural light, raw, authentic, 4K nature' },
  { name: '产品展示',   words: 'studio lighting, ultra-detailed, 8K, product photography, clean background' },
]

const COMPOSITIONS = [
  { zh: '三分法',     en: 'rule of thirds' },
  { zh: '对称构图',   en: 'symmetrical composition' },
  { zh: '黄金比例',   en: 'golden ratio / spiral' },
  { zh: '中心构图',   en: 'centered composition' },
  { zh: '对角线构图', en: 'diagonal lines' },
  { zh: '引导线构图', en: 'leading lines' },
  { zh: '框中框',     en: 'frame within frame' },
  { zh: '留白',       en: 'negative space' },
]

module.exports = {
  structure: STRUCTURE,
  cameraMoves: CAMERA_MOVES,
  shotTypes: SHOT_TYPES,
  compositions: COMPOSITIONS,
  rules: RULES,
  qualityPresets: QUALITY_PRESETS,
}
