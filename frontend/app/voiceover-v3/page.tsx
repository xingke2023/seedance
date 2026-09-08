'use client';

import { Fragment, useRef, useState, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams, useRouter } from 'next/navigation';
import { useVirtualizer } from '@tanstack/react-virtual';
import dynamic from 'next/dynamic';
import { api, ApiError } from '@/lib/api';
import { CameraState, ShotSubject, ProjectSubject } from '@/components/video-editor/types';
import { buildContentMedia, mediaNoOf, subjectImageNo, normalizeAssetUrl } from '@/lib/contentMedia';
import styles from './page.module.css';
import StoryboardGenerator, {
  toShotDrafts, DEFAULT_STORYBOARD_SETTINGS,
  type Storyboard, type StoryboardSettings,
} from '@/components/library/StoryboardGenerator';

const CameraEditor = dynamic(() => import('@/components/video-editor/CameraEditor'), { ssr: false });

// ─── Types ────────────────────────────────────────────────────────────────────

interface VoiceoverShot {
  id?:            string;
  shot_number:    number;
  title:          string;
  subtitle:       string;
  description:    string;
  prompt:         string;
  duration:       number;
  ratio:          string;
  shot_size:      string;
  camera_movement:string;
  mood:           string;
  roll_type?:     'a_roll' | 'b_roll';
  voice_style?:   string;   // 解说纪录片逐镜情绪 → Azure express-as
  imageUrl?:      string;
  subjects?:      string[];
  camera_pan?:    number;
  camera_tilt?:   number;
  camera_zoom?:   number;
  camera_roll?:   number;
  camera?:        CameraState;
  shot_subjects?: ShotSubject[];
  reference_images?: Array<{ url: string; name?: string }>;
  task_id?:       string | null;
  task_status?:   string;
  video_url?:     string | null;
  local_url?:     string | null;
  video_duration?:number | null;
  task_error?:    string | null;
}

interface ShotTask {
  shotIndex: number;
  taskId:    string | null;
  status:    string;
  videoUrl:  string | null;
  localUrl:  string | null;
  duration:  number | null;
  error:     string | null;
  submitting:boolean;
  startedAt?: number;      // 提交时刻（ms）。排太久时据此放出「重新生成」
}

interface InitResult {
  autoShotCount:      number;
  shotCount:          number;
  characterAnchor?:   string;
  shots:              VoiceoverShot[];
  totalVideoDuration: number;
}

// ─── Media types ──────────────────────────────────────────────────────────────

interface MediaItem {
  uid?: string;
  mediaType?: 'image' | 'video' | 'audio';
  url?: string;
  mimeType?: string;
  previewUrl?: string;
  name?: string;
  description?: string;
  uploading?: boolean;
  uploadProgress?: number;
}

// 剧本分析出来的角色卡：形象来自 AI 分析，头像和音色是人工绑的
type AnalysisItem = {
  label: string; type: string; appearance: string; personality: string;
  linkedSubjectId?: string; linkedAudioUrl?: string;
  _voicePickerOpen?: boolean;
};

// ─── 自动配音色 ──────────────────────────────────────────────────────────────
// 同一个角色全片必须是同一把嗓子。人工绑了就用人工的；没绑的，生成分镜时从预设音色库
// （方舟那 80 条）按性别年龄挑一条最合适的钉死 —— 让模型每镜自己发挥英文音色描述，
// 只能把范围收窄，收不死。
type VoicePreset = { name: string; category: string; gender: string; duration: string; url: string; avatar: string };

// 从角色卡的文字里读性别；读不出来按不限处理
function guessGender(a: AnalysisItem): '男' | '女' | '' {
  const t = `${a.label} ${a.appearance} ${a.personality}`;
  if (/女|母亲|妈妈|姐|妹|奶奶|外婆|阿姨|女士|女性/.test(t)) return '女';
  if (/男|父亲|爸爸|哥|弟|爷爷|外公|叔叔|先生|男性/.test(t)) return '男';
  return '';
}

// 年龄段映射到音色库的分组名（青年 / 少年_少女 / 中年 / 儿童 / 老年）
function guessAgeGroup(a: AnalysisItem): string {
  const t = `${a.label} ${a.appearance} ${a.personality}`;
  const m = t.match(/(\d{1,2})\s*(?:岁|多岁)/);
  const age = m ? Number(m[1]) : 0;
  if (age) {
    if (age < 13) return '儿童';
    if (age < 18) return '少年_少女';
    if (age < 36) return '青年';
    if (age < 60) return '中年';
    return '老年';
  }
  if (/儿童|小孩|孩子|幼儿|小男孩|小女孩/.test(t)) return '儿童';
  if (/少年|少女|中学生|高中生|青少年/.test(t)) return '少年_少女';
  if (/老人|老年|爷爷|奶奶|外公|外婆|老先生|老太太/.test(t)) return '老年';
  if (/中年|大叔|大妈|阿姨|叔叔/.test(t)) return '中年';
  return '青年';   // 剧本里最常见的默认
}

// 挑一条没被别的角色占用的音色：先按「分组+性别」，放宽到「分组」，再放宽到「性别」，
// 最后随便给一条。同一批角色里用 index 错开，两个同性别同龄的角色不会撞同一把嗓子。
function pickPresetVoice(a: AnalysisItem, presets: VoicePreset[], taken: Set<string>, seed: number): VoicePreset | null {
  if (presets.length === 0) return null;
  const group = guessAgeGroup(a);
  const gender = guessGender(a);
  const pools = [
    presets.filter(v => v.category === group && (!gender || v.gender === gender)),
    presets.filter(v => v.category === group),
    presets.filter(v => !gender || v.gender === gender),
    presets,
  ];
  for (const pool of pools) {
    const free = pool.filter(v => !taken.has(v.url));
    if (free.length > 0) return free[seed % free.length];
  }
  return null;
}

// 角色/素材上下文的构建（纯函数）。生成分镜那一刻可能刚给角色自动配了音色，
// state 还没落地，所以要能拿「算好的那份」直接构建，不能只依赖 useMemo 里的旧值。
function buildSubjectContext(videoSubjects: ProjectSubject[], mediaItems: MediaItem[], scriptAnalysis: AnalysisItem[]) {
    const contentMedia = buildContentMedia(videoSubjects, mediaItems);
    const readyImages = contentMedia.filter(x => x.from === 'media' && x.mediaType === 'image');
    const withImage    = videoSubjects.filter(s => s.image_url);
    const withoutImage = videoSubjects.filter(s => !s.image_url);
    const nameOf = (s: ProjectSubject) =>
      scriptAnalysis.find(a => a.linkedSubjectId === s.id)?.label || s.label;
    const descOf = (s: ProjectSubject) => {
      const a = scriptAnalysis.find(x => x.linkedSubjectId === s.id);
      return a ? `${a.appearance}；${a.personality}` : (s.description || '');
    };
    // 角色定义句用的**外貌原文**：剧本分析给的形象描述优先，没分析过才退回主体自带的描述。
    // 性格不进定义句 —— 定义要挑不随剧情变的静态特征（见 character-anchoring）。
    // 必须压成一行：后端按行解析这份原文，逐镜一字不改地贴进 prompt_en。
    const visualOf = (s: ProjectSubject) => {
      const a = scriptAnalysis.find(x => x.linkedSubjectId === s.id);
      return (a?.appearance || s.description || '').replace(/\s*\n+\s*/g, '，').trim();
    };
    // 角色的音色：@图片N 的那个人用哪一条 @音频M。绑定挂在剧本分析的角色卡上，
    // 这里按主体反查回去 —— 形象和音色是同一个人的两半，提示词里要一起写明。
    const readyAudios0 = contentMedia.filter(x => x.mediaType === 'audio');
    const audioNumOf = (s: ProjectSubject) => {
      const url = scriptAnalysis.find(a => a.linkedSubjectId === s.id)?.linkedAudioUrl;
      const n = url ? readyAudios0.findIndex(m => m.url === normalizeAssetUrl(url)) : -1;
      return n >= 0 ? n + 1 : 0;
    };
    // 角色的图片编号**从 content 的排布里查**，不按 withImage 的下标猜 ——
    // 两处各算各的，哪天排法改了就会指到别人的图上
    const imageNumOf = (s: ProjectSubject) => subjectImageNo(contentMedia, s.id);
    const characterLines = [
      ...withImage.map(s => {
        const an = audioNumOf(s);
        return `角色「${nameOf(s)}」绑定@图片${imageNumOf(s)}${an ? `、音色@音频${an}` : ''}，外貌描述：${visualOf(s) || '见图片'}`;
      }),
      ...withoutImage.map(s => {
        const an = audioNumOf(s);
        return `角色「${nameOf(s)}」${an ? `绑定音色@音频${an}` : ''}，外貌描述：${visualOf(s) || '未提供'}`;
      }),
    ];
    // 素材编号按类型各排各的 —— content 里图片/视频/音频是分开计数的，
    // Seedance 提示词里用 图片N / 视频N / 音频N 指代第 N 个该类型素材。
    const readyVideos = contentMedia.filter(x => x.mediaType === 'video');
    const readyAudios = readyAudios0;
    // 音频挂到了哪个角色身上，说明里就点名写出来（模型才知道这条音色是谁的）
    const audioOwner = new Map<string, string>();
    videoSubjects.forEach(s => {
      const url = scriptAnalysis.find(a => a.linkedSubjectId === s.id)?.linkedAudioUrl;
      if (url) audioOwner.set(normalizeAssetUrl(url), nameOf(s));
    });
    const descLines = [
      ...withImage.map(s => {
        const an = audioNumOf(s);
        return `图片${imageNumOf(s)}：角色「${nameOf(s)}」${an ? `（音色见@音频${an}）` : ''}— ${descOf(s) || '见图片'}`;
      }),
      ...readyImages.map(m => `图片${mediaNoOf(contentMedia, m)}：参考素材「${m.name || '素材'}」— ${m.description || ''}`),
      ...readyVideos.map((m, i) => `视频${i + 1}：参考视频「${m.name || '素材'}」— ${m.description || ''}`),
      ...readyAudios.map((m, i) => {
        const owner = audioOwner.get(m.url || '');
        return owner
          ? `音频${i + 1}：角色「${owner}」的音色 — ${m.description || m.name || ''}`
          : `音频${i + 1}：参考音频「${m.name || '素材'}」— ${m.description || ''}`;
      }),
    ];
    return {
      characterDefs:     characterLines.join('\n'),
      imageDescriptions: descLines.join('\n'),
      subjectsWithImage: withImage,   // 1-based 编号 → 角色，供 image_refs 反查
      contentMedia,                   // content 里素材的最终排布（编号的唯一依据）
    };
}


interface AvatarItem { assetId: string; label: string; thumb: string; }

// Seedance 一次请求里的素材硬上限：image_url 9 个、video_url / audio_url 各 3 个。
// ⚠️ 图片这 9 个是**整条请求**的额度，带图角色的头像也占位（提交时排在参考素材之前），
//    所以参考素材能上传几张图要减掉角色数 —— 见组件里的 mediaLimit()。
const MEDIA_CAPS   = { image: 9, video: 3, audio: 3 } as const;
const MEDIA_ZH     = { image: '图片', video: '视频', audio: '音频' } as const;

const API_BASE = '/api';

// ─── Upload helpers ────────────────────────────────────────────────────────────

function uploadWithProgress(file: File, onProgress: (pct: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/upload`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText).data.url); }
        catch { reject(new Error('响应解析失败')); }
      } else {
        try { reject(new Error(JSON.parse(xhr.responseText).error || `HTTP ${xhr.status}`)); }
        catch { reject(new Error(`HTTP ${xhr.status}`)); }
      }
    };
    xhr.onerror   = () => reject(new Error('网络错误'));
    xhr.ontimeout = () => reject(new Error('上传超时'));
    xhr.send(form);
  });
}

function getVideoInfo(file: File): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el  = document.createElement('video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve({ duration: el.duration, width: el.videoWidth, height: el.videoHeight }); };
    el.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取视频信息')); };
    el.src = url;
  });
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MODELS = [
  { value: 'doubao-seedance-2-0',             label: 'Seedance 2.0' },
  { value: 'doubao-seedance-2-0-260128',      label: 'Seedance 2.0 (260128)' },
  { value: 'doubao-seedance-2-5',             label: 'Seedance 2.5' },
];
// 新建视频用哪个型号。不写成 MODELS[0] —— 默认值和下拉里的排列顺序是两回事，
// 已存的视频仍以库里 params.model 为准。
const DEFAULT_MODEL = 'doubao-seedance-2-0-260128';

const RESOLUTIONS = [
  { value: '720p',  label: '720p' },
  { value: '1080p', label: '1080p' },
];

const RATIOS = [
  { value: '21:9', label: '21:9' },
  { value: '16:9', label: '16:9' },
  { value: '4:3',  label: '4:3' },
  { value: '1:1',  label: '1:1' },
  { value: '3:4',  label: '3:4' },
  { value: '9:16', label: '9:16' },
];

const STYLES = [
  { label: '专业商务', value: '专业简洁的商务感，柔光棚拍：均匀柔光、浅景深、干净背景，冷调为主，专业可信的讲解氛围' },
  { label: '高级冷调', value: '高级质感冷调，冷白主光加局部暖色点缀，玻璃与金属反光，极简深色背景，高端理财与资产配置氛围' },
  { label: '温暖生活', value: '温暖亲切的生活感，暖调黄金时刻侧光，自然通透，居家或户外场景，适合家庭、养老与传承主题' },
  { label: '个人IP', value: '个人品牌权威感，人物中近景，边缘光轮廓、深色背景突出主体，沉稳可信的顾问出镜风格' },
  { label: '电影质感', value: '电影级画面质感，戏剧化布光与浅景深，细腻颗粒感与高级色调，情绪饱满、叙事感强' },
  { label: '明亮活力', value: '明亮生活化风格，自然光通透明亮，节奏轻快，适合年轻客群与日常场景科普' },
];

const AZURE_VOICES = [
  { value: 'zh-CN-YunfengNeural',   label: '云枫（磁性男声）' },
  { value: 'zh-CN-XiaoxiaoNeural',  label: '晓晓（温柔女声）' },
  { value: 'zh-CN-YunxiNeural',     label: '云希（专业男声）' },
  { value: 'zh-CN-XiaoyiNeural',    label: '晓伊（活泼女声）' },
  { value: 'zh-CN-YunyangNeural',   label: '云扬（新闻男声）' },
  { value: 'zh-CN-XiaohanNeural',   label: '晓涵（成熟女声）' },
  { value: 'zh-CN-XiaoqiuNeural',   label: '晓秋（知性女声）' },
  { value: 'zh-CN-YunjianNeural',   label: '云健（激昂男声）' },
  { value: 'zh-CN-XiaochenNeural',  label: '晓辰（自然女声）' },
  { value: 'zh-CN-YunhaoNeural',    label: '云皓（活力男声）' },
  { value: 'zh-CN-XiaomoNeural',    label: '晓墨（多情感女声）' },
  { value: 'zh-CN-XiaoyanNeural',   label: '晓颜（甜美女声）' },
  { value: 'zh-HK-HiuMaanNeural',   label: '晓曼（粤语女声）' },
  { value: 'zh-HK-WanLungNeural',   label: '云龙（粤语男声）' },
  { value: 'zh-HK-HiuGaaiNeural',   label: '晓佳（粤语女声·活泼）' },
];

const SUBTITLE_FONTS = [
  { value: 'Noto Sans CJK SC',       label: '思源黑体' },
  { value: 'Noto Serif CJK SC',      label: '思源宋体' },
  { value: 'Noto Sans CJK SC Medium', label: '思源黑体 中粗' },
  { value: 'Noto Serif CJK SC SemiBold', label: '思源宋体 半粗' },
  { value: 'WenQuanYi Zen Hei',      label: '文泉驿正黑' },
  { value: 'DejaVu Sans',            label: 'DejaVu Sans' },
  { value: 'Liberation Sans',        label: 'Liberation Sans' },
];

// 逐镜情绪标签（解说纪录片）—— 值来自 /prompt/storyboard 的 voice_style
const VOICE_STYLE_TAGS: Record<string, { label: string; fg: string; bg: string }> = {
  calm:      { label: '平稳', fg: '#475569', bg: '#f1f5f9' },
  serious:   { label: '严肃', fg: '#7c2d12', bg: '#fef3c7' },
  worried:   { label: '担忧', fg: '#1e40af', bg: '#dbeafe' },
  warm:      { label: '温暖', fg: '#9d174d', bg: '#fce7f3' },
  uplifting: { label: '升华', fg: '#166534', bg: '#dcfce7' },
};

const SUBTITLE_POSITIONS = [
  { value: 'bottom', label: '底部' },
  { value: 'top',    label: '顶部' },
  { value: 'center', label: '居中' },
];

interface SubtitleStyle {
  font: string;
  fontSize: number;
  color: string;
  alpha: number;
  position: string;
  borderW: number;
  borderColor: string;
  borderAlpha: number;
}

const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  font: 'Noto Sans CJK SC',
  fontSize: 4.2,
  color: '#FFFFFF',
  alpha: 1.0,
  position: 'bottom',
  borderW: 1,
  borderColor: '#000000',
  borderAlpha: 0.5,
};

interface BannerStyle {
  fontSize:    number;
  color:       string;
  alpha:       number;
  borderW:     number;
  borderColor: string;
  borderAlpha: number;
  shadowX:     number;
  shadowY:     number;
  shadowColor: string;
  boxEnabled:  boolean;
  boxColor:    string;
  boxAlpha:    number;
}

const DEFAULT_BANNER_STYLE: BannerStyle = {
  fontSize:    2.8,
  color:       '#ffffff',
  alpha:       1.0,
  borderW:     2,
  borderColor: '#000000',
  borderAlpha: 0.6,
  shadowX:     0,
  shadowY:     0,
  shadowColor: '#000000',
  boxEnabled:  false,
  boxColor:    '#000000',
  boxAlpha:    0.5,
};

const TERMINAL = new Set(['succeeded', 'failed', 'expired', 'cancelled']);
// 分镜看法（横排标签 / 竖排列表）记在本地，换个视频、刷新页面都保持上次选的
const SHOT_VIEW_KEY = 'voiceover-v3:shot-view';

// 展开的分镜卡按页签分区：字幕放第一个（最常核对）；提交 JSON 是排查用的，放最后
const SHOT_TABS = [
  ['subtitle', '字幕'],
  ['prompt',   '提示词'],
  ['params',   '参数'],
  ['refs',     '参考图'],
  ['json',     'JSON'],
  ['preview',  '预览'],
] as const;
type ShotTabKey = typeof SHOT_TABS[number][0];

// 排队/生成超过这个时长就在分镜上放出「重新生成」。Seedance 正常一两分钟出片，
// 排队高峰会久一些 —— 3 分钟还没动静基本就是卡在队列里，等下去和重开一个没差别。
const STUCK_AFTER_MS = 3 * 60_000;

function fmtElapsed(ms: number) {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, '0')} 秒`;
}

const SHOT_SIZES = [
  { value: '特写', label: '特写' },
  { value: '近景', label: '近景' },
  { value: '中景', label: '中景' },
  { value: '全景', label: '全景' },
  { value: '远景', label: '远景' },
];

const CAMERA_MOVEMENTS = [
  { value: '固定', label: '固定' },
  { value: '推', label: '推' },
  { value: '拉', label: '拉' },
  { value: '摇', label: '摇' },
  { value: '移', label: '移' },
  { value: '跟', label: '跟' },
  { value: '升', label: '升' },
  { value: '降', label: '降' },
  { value: '环绕', label: '环绕' },
];

// 模型给的是影视术语代码（MCU / WS）和自由英文短语（handheld, unstabilized…），
// 而这两个字段在卡片里是 <select>：值对不上任何 option 就渲染成空白。
// 所以导入时归一化到上面的选项；实在认不出来的原样留着（select 那边会补一个 option）。
const SHOT_SIZE_RULES: Array<[RegExp, string]> = [
  [/\b(ecu|extreme close)/i, '特写'],
  [/\b(mcu|medium close)/i,  '近景'],
  [/\b(cu|close[- ]?up)\b/i, '特写'],
  [/\b(ews|els|extreme (wide|long))/i, '远景'],
  [/\b(ws|ls|wide|long) shot\b/i, '全景'],
  [/\b(ws|ls)\b/i, '全景'],
  [/\b(ms|mid|medium)\b/i, '中景'],
];
function normalizeShotSize(raw: string): string {
  const v = (raw || '').trim();
  if (!v) return '';
  if (SHOT_SIZES.some(o => o.value === v)) return v;          // 已经是中文
  for (const [re, label] of SHOT_SIZE_RULES) if (re.test(v)) return label;
  return v;
}

// 先长后短：push in 必须排在 in 前面，否则 zoom in / push in 会互相吃掉
// 连字符必须容忍：模型写 push-in 的频率和 push in 一样高，
// 漏判会一路掉到最后那条「固定」，把推镜标成不动
const CAMERA_MOVE_RULES: Array<[RegExp, string]> = [
  [/(push[- ]?in|dolly[- ]?in|zoom[- ]?in|move (in|closer)|creep[- ]?in|drift (in|closer))/i, '推'],
  [/(pull[- ]?(out|back)|dolly[- ]?out|zoom[- ]?out|move away|drift back)/i, '拉'],
  [/(orbit|arc[- ]|circle|around the|revolve)/i, '环绕'],
  [/(crane[- ]?up|boom[- ]?up|rise|tilt[- ]?up|lift)/i, '升'],
  [/(crane[- ]?down|boom[- ]?down|descend|tilt[- ]?down|lower)/i, '降'],
  [/(follow|tracking (the|her|him)|trail)/i, '跟'],
  [/(track|dolly|truck|slide|lateral|pedestal|move (left|right))/i, '移'],
  [/(pan\b|tilt\b|whip|swivel)/i, '摇'],
  [/(static|locked|fixed|tripod|handheld|steady|no camera|unstabilized)/i, '固定'],
];
function normalizeCameraMove(raw: string): string {
  const v = (raw || '').trim();
  if (!v) return '';
  if (CAMERA_MOVEMENTS.some(o => o.value === v)) return v;
  for (const [re, label] of CAMERA_MOVE_RULES) if (re.test(v)) return label;
  return v;
}

// ── 分镜提示词的分段 ────────────────────────────────────────────────────
// 一条 prompt_en 其实是四段拼起来的，来源和「谁说了算」各不相同（见 CLAUDE.md
// 「角色锚定」「字幕就是台词的准绳」）：
//   开场声明 —— 模型写的格式/风格声明句（skill seedance-2-0-prompting 的 ①）
//   角色定义 —— `将@图片N中<外貌原文>定义为<主体N>；` 固定句式。**后端按角色卡原文逐镜统一贴**
//               （lockSubjectAnchors），提交生成时还会再锁一次，所以在这里改只在本次提交前有效
//   画面描述 —— 真正属于这一镜的场景/动作/节拍，改这里才是改这一镜
//   台词     —— appendSpeech 追加的对白/画外音块，提交时按字幕重建（syncSpeechWithSubtitle）
// 全塞进一个 textarea 时，逐镜一字不差的定义句和逐镜都不同的画面描述混在一起，
// 眼睛得自己去找边界。拆成四个框只是**显示**上的拆分：join 回去仍是同一条 prompt，
// 不改任何提交逻辑。
//
// 定义句的正则和后端 anchor.js 的 MODEL_DEF 保持同一套写法（含标签后补写的中文短句），
// 一处放宽两处都要跟着改。多个角色的定义句是连着写的（`…<主体1>；将…<主体2>；`），
// 所以取第一句开头到最后一句结尾的整段 —— 中间万一夹了别的字也一并留在这一段里，
// 反正 join 是逐字拼回去的，不会丢。
const SHOT_DEF_RE = /将[^；;。\n]{0,30}?[<@]?\s*图片\s*\d+\s*>?\s*中[^；;。\n]*?定义为\s*[<【]?\s*主体\s*\d+\s*[>】]?(?:\s*[，,](?!\s*[A-Za-z])[^；;。，,\n]*)*\s*[；;]?/g;
// 台词块的抬头（appendSpeech 写的那两句），从它所在行的行首开始算台词段
const SHOT_SPEECH_RE = /Dialogue \(spoken|Off-screen voiceover \(/;

type ShotPromptParts = { head: string; defs: string; body: string; speech: string };

// 提示词分段用的输入框：**高度跟着内容走**，不给固定行数。
// 分段之后每段长短差得很远（开场一句话、画面描述一大段、台词块可能十几行），
// 固定行数不是空掉半个框就是要在小窗里滚 —— 电脑版屏幕宽，一行能放的字多，
// 按字数估行数更是估不准，所以直接量 scrollHeight。
// 窗口宽度变了要重量一次（换行数跟着变）；超过 70vh 才出滚动条，免得一段超长台词把页面撑爆。
function AutoTextarea({ value, onChange, placeholder, className }: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;   // +2 给上下边框
  }, []);
  useLayoutEffect(fit, [value, fit]);
  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [fit]);
  return (
    <textarea ref={ref} value={value} onChange={onChange} placeholder={placeholder} className={className}
      style={{ marginTop: 0, maxHeight: '70vh', overflowY: 'auto', resize: 'vertical' }} />
  );
}

// 「选取角色」用：把页面的角色原文（buildSubjectContext().characterDefs，一行一个角色）
// 解成可选项，并按**和后端 anchor.js 逐字相同**的句式拼出定义句 ——
// 句式不一致的话，这里插好的句子提交时又会被后端的原文锁换掉，等于白改。
const CHAR_LINE_RE = /^\s*角色\s*[「『"']?(.*?)[」』"']?\s*绑定\s*[<@]?\s*图片\s*(\d+)\s*>?[^，,]*[，,]\s*外貌描述\s*[：:]\s*(.+)$/;

function subjectAnchorOptions(characterDefs: string) {
  const out: Array<{ num: number; name: string; anchor: string }> = [];
  for (const line of (characterDefs || '').split('\n')) {
    const m = line.match(CHAR_LINE_RE);
    if (!m) continue;
    const num = Number(m[2]);
    const desc = m[3].trim();
    // 外貌写着「见图片」「未提供」的不给选 —— 贴一句空定义还不如不贴（后端也是这么判的）
    if (!num || !desc || desc === '见图片' || desc === '未提供') continue;
    out.push({ num, name: m[1].trim(), anchor: `将@图片${num}中${desc}定义为<主体${num}>` });
  }
  return out.sort((a, b) => a.num - b.num);
}

function splitShotPrompt(prompt: string): ShotPromptParts {
  const text = prompt || '';
  const sp = SHOT_SPEECH_RE.exec(text);
  let speechAt = text.length;
  if (sp) {
    const lineStart = text.lastIndexOf('\n', sp.index);
    speechAt = lineStart >= 0 ? lineStart + 1 : sp.index;
  }
  const main = text.slice(0, speechAt);
  const defs = [...main.matchAll(SHOT_DEF_RE)];
  if (defs.length === 0) {
    return { head: '', defs: '', body: main.trim(), speech: text.slice(speechAt).trim() };
  }
  const first = defs[0];
  const last = defs[defs.length - 1];
  const defEnd = (last.index ?? 0) + last[0].length;
  return {
    head:   main.slice(0, first.index ?? 0).trim(),
    defs:   main.slice(first.index ?? 0, defEnd).trim(),
    // 定义句后面常跟一个模型自己写的句末标点（锁定义句时只换到 `；` 为止，
    // 模型写的那个 `。` 会留下来，成了 `…<主体2>；。场景…`）—— 别让画面描述以它开头
    body:   main.slice(defEnd).replace(/^[\s。；;，,]+/, '').trim(),
    speech: text.slice(speechAt).trim(),
  };
}

function joinShotPrompt(parts: ShotPromptParts): string {
  const head = parts.head.trim();
  const defs = parts.defs.trim().replace(/[；;]\s*$/, '');
  const body = parts.body.trim();
  const speech = parts.speech.trim();
  // 定义句和后面的画面描述之间用「；」接上 —— 后端锁定义句时拼的就是这个形状
  const main = [head, defs ? `${defs}；` : '', body]
    .filter(Boolean)
    .join(' ')
    .replace(/；\s+/g, '；');
  return [main, speech].filter(Boolean).join('\n\n');
}

// 分镜属性标签条：景别 / A-B roll / 情绪 / 光影氛围 / 运镜 / 时长 / 主体 / 3D。
// 原来挂在收起的列表行上，但「光影氛围」存的是模型给的英文光线描述，一条就能把那行撑成两行，
// 所以整排挪进展开后的「参数」页签，收起行只留标题和一句话描述。
function ShotChips({ shot }: { shot: VoiceoverShot }) {
  return (<>
    {shot.shot_size && <span style={{ fontSize: 10, color: '#6b7280', background: '#f3f4f6', borderRadius: 3, padding: '1px 4px' }}>{shot.shot_size}</span>}
    {shot.roll_type && (
      <span title={shot.roll_type === 'a_roll' ? '画面里有人正对镜头说话' : '补充画面，不含正面口播'}
        style={{ fontSize: 10, borderRadius: 3, padding: '1px 4px',
          color: shot.roll_type === 'a_roll' ? '#9a3412' : '#0f766e',
          background: shot.roll_type === 'a_roll' ? '#ffedd5' : '#ccfbf1' }}>
        {shot.roll_type === 'a_roll' ? 'A-roll' : 'B-roll'}
      </span>
    )}
    {shot.voice_style && VOICE_STYLE_TAGS[shot.voice_style] && (
      <span title="这一镜旁白的情绪，配音时转成 Azure 的表达风格"
        style={{ fontSize: 10, borderRadius: 3, padding: '1px 4px',
          color: VOICE_STYLE_TAGS[shot.voice_style].fg,
          background: VOICE_STYLE_TAGS[shot.voice_style].bg }}>
        {VOICE_STYLE_TAGS[shot.voice_style].label}
      </span>
    )}
    {shot.mood && <span style={{ fontSize: 10, color: '#92400e', background: '#fef3c7', borderRadius: 3, padding: '1px 4px' }}>{shot.mood}</span>}
    {shot.camera_movement && <span style={{ fontSize: 10, color: '#1d4ed8', background: '#dbeafe', borderRadius: 3, padding: '1px 4px' }}>{shot.camera_movement}</span>}
    <span style={{ fontSize: 10, color: '#6b7280' }}>{shot.duration}s</span>
    {shot.subjects && shot.subjects.filter(displayLabel).length > 0 &&
      <span style={{ fontSize: 10, color: '#7c3aed', background: '#f5f3ff', borderRadius: 3, padding: '1px 4px' }}>{shot.subjects.filter(displayLabel).join('/')}</span>}
    {(shot.camera_pan || shot.camera_tilt || (shot.camera_zoom && shot.camera_zoom !== 1)) && <span style={{ fontSize: 10, color: '#059669', background: '#d1fae5', borderRadius: 3, padding: '1px 4px' }}>3D</span>}
  </>);
}

// 换头像建出来的主体，名字曾经直接取素材的文件名（`微信图片_20260903143611_672_356.jpg`、
// `bee8cdd3d1264296a566445ecc00e2f7.webp`）—— 当角色名显示毫无意义。新建的已改成用角色卡的
// 名字（见 assignAssetAvatar），存量数据靠这个判定在显示时藏掉，不用迁库。
const FILE_NAME_RE = /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif|mp4|mov|webm|mp3|wav|m4a)$/i;
const displayLabel = (label?: string | null) => {
  const v = String(label || '').trim();
  return FILE_NAME_RE.test(v) ? '' : v;
};

const STATUS_LABELS: Record<string, string> = {
  running:   '生成中…',
  queued:    '队列中…',
  pending:   '等待中…',
  succeeded: '生成成功',
  failed:    '生成失败',
  idle:      '待提交',
};

const EXAMPLE_SCRIPTS = [
  {
    label: '产品介绍',
    text: '你是否曾经困扰于每天上班通勤的漫长等待？今天，我要给你介绍一款彻底改变我生活的神器。这款便携式颈部按摩仪，专为上班族设计，只需五分钟，就能消除一天的疲劳。采用了日本进口的芯片技术，模拟专业按摩师的手法，拥有八种不同的按摩模式。更重要的是，它轻巧到可以放进口袋，随时随地享受专属按摩。已经有超过十万用户体验，好评率高达百分之九十八。现在下单，还享有三十天无理由退换货保障，错过真的会后悔！',
  },
  {
    label: '励志演讲',
    text: '每一个成功的背后，都有无数个不为人知的艰难时刻。你以为别人的成功是天赋，其实是他们在你看不见的地方，默默努力了无数个日夜。失败了没关系，重要的是你有没有从中学到了什么。人生最大的遗憾，不是努力了没有成功，而是本可以成功，却没有努力。从今天开始，不要再为昨天的错误而懊悔，把每一分钟都用来创造更好的明天。记住，你比你想象中更加强大。',
  },
  {
    label: '旅游攻略',
    text: '大家好，今天带大家云游号称"人间天堂"的西藏。这里海拔超过四千米，空气中的氧气含量只有平原的一半，但这并不妨碍它成为无数人心中的圣地。布达拉宫，傲立于玛布日山上已逾一千三百年，金色的屋顶在阳光下熠熠生辉，那一刻你会觉得，所有的跋涉都是值得的。纳木错，藏语意为"天湖"，湖水清澈见底，倒映着连绵雪山，那种蓝色是你此生见过最纯粹的颜色。去西藏，不仅是一场旅行，更是一次心灵的朝圣。',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtSeconds(s: number): string {
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m > 0 ? `${m}分${r}秒` : `${r}秒`;
}

function estimateScriptDuration(text: string): number {
  return Math.round(text.replace(/\s/g, '').length / 3.5);
}

function recommendShotCount(durationSec: number): number {
  return Math.max(2, Math.min(20, Math.round(durationSec / 10)));
}

// ─── AvatarLibrary ────────────────────────────────────────────────────────────

const AVATAR_GAP = 6;

function AvatarLibrary({ avatars, selectedIds, onAdd, onRemove }: {
  avatars: AvatarItem[];
  selectedIds: string[];
  onAdd: (assetId: string, label: string) => void;
  onRemove: (assetId: string) => void;
}) {
  const [open, setOpen]     = useState(false);
  const [search, setSearch] = useState('');
  const scrollRef           = useRef<HTMLDivElement>(null);
  const [cols, setCols]     = useState(7);
  const [rowH, setRowH]     = useState(120);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = (w: number) => {
      const c = Math.min(9, Math.max(4, Math.floor((w + AVATAR_GAP) / (72 + AVATAR_GAP))));
      const itemW = (w - (c - 1) * AVATAR_GAP) / c;
      setRowH(Math.round(itemW * 4 / 3) + AVATAR_GAP);
      setCols(c);
    };
    update(el.clientWidth);
    const ro = new ResizeObserver(([e]) => update(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const filtered = search.trim() ? avatars.filter(a => a.label.includes(search.trim())) : avatars;
  const rows: AvatarItem[][] = [];
  for (let i = 0; i < filtered.length; i += cols) rows.push(filtered.slice(i, i + cols));

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 4,
  });

  return (
    <div className={`${styles.card} ${styles.cardPurple}`}>
      <div className={styles.cardHead}>
        <button type="button" onClick={() => setOpen(v => !v)} className={styles.avatarToggle}>
          <span className={styles.cardTitle}>
            备用人像库{!open && <span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af', marginLeft: 4 }}>(点击展开)</span>}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>{open ? `点击添加（${filtered.length} 人）` : `${avatars.length} 人`}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ width: 16, height: 16, color: '#9ca3af', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>
              <path d="m6 9 6 6 6-6"/>
            </svg>
          </span>
        </button>
        {open && (
          <input type="text" placeholder="搜索职业、国籍、年龄…" value={search}
            onChange={e => setSearch(e.target.value)} className={styles.avatarSearch} />
        )}
      </div>
      {open && (
        <div style={{ padding: '0 0 12px' }}>
          <div ref={scrollRef} style={{ height: rowH * 2, overflowY: 'auto' }}>
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map(vRow => {
                const rowItems = rows[vRow.index];
                return (
                  <div key={vRow.index} style={{ position: 'absolute', top: vRow.start, left: 0, right: 0, height: rowH - AVATAR_GAP, display: 'flex', gap: AVATAR_GAP }}>
                    {rowItems.map(av => {
                      const selected = selectedIds.includes(av.assetId);
                      return (
                        <div key={av.assetId}
                          style={{ flex: '1 1 0', minWidth: 0, height: rowH - AVATAR_GAP, position: 'relative' }}
                          className={selected ? `${styles.avatarItem} ${styles.avatarItemSelected}` : styles.avatarItem}
                          onClick={() => selected ? onRemove(av.assetId) : onAdd(av.assetId, av.label)}>
                          <img src={av.thumb} alt={av.label} loading="lazy" className={styles.avatarImg} style={{ height: '100%' }} />
                          <div className={styles.avatarName}>{av.label.replace(/_/g, ' ')}</div>
                          {selected && <div className={styles.avatarCheck}><span style={{ background: '#7c3aed', color: '#fff', borderRadius: '50%', padding: '1px 4px', fontSize: 10 }}>✓</span></div>}
                        </div>
                      );
                    })}
                    {Array.from({ length: cols - rowItems.length }).map((_, i) => <div key={i} style={{ flex: '1 1 0' }} />)}
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{ pointerEvents: 'none', marginTop: -24, height: 24, background: 'linear-gradient(to top, #fff, transparent)' }} />
        </div>
      )}
    </div>
  );
}

// ─── MediaPanel ───────────────────────────────────────────────────────────────

// ─── AssetLibrary (真人资源 + 虚拟人像 from API) ─────────────────────────────

interface RemoteAsset {
  Id: string;
  Name: string | null;
  AssetType: string;
  Status?: string;
  PreviewUrl?: string;
  _thumbnail_url?: string;
  URL?: string;
  GroupId?: string;
}

interface RemoteAssetGroup { Id: string; Name: string | null; GroupType: 'AIGC' | 'LivenessFace'; }

// 换头像走 /assets/real、/assets/virtual 同一套逻辑（先取该 groupType 下用户可见的资源组，
// 再逐组取资源），不用 /assets/all——那条路径的 GetAsset 兜底不带 _thumbnail_url，图片列表里会丢缩略图。
// 真人（LivenessFace）只能经活体验证入库，这一步天然只认证过的资源；只取 Image 类型，头像要的是静态照片。
async function loadVerifiedAvatars(groupType: 'AIGC' | 'LivenessFace'): Promise<RemoteAsset[]> {
  try {
    const groupsRes = await api.get<{ Items: RemoteAssetGroup[] }>(`/assets/groups?groupType=${groupType}&region=cn`);
    const groups = groupsRes?.Items || [];
    const perGroup = await Promise.all(groups.map(async g => {
      try {
        const assetsRes = await api.get<{ Items: RemoteAsset[] }>(`/assets/groups/${g.Id}/assets?region=cn`);
        const images = (assetsRes?.Items || []).filter(a => a.AssetType === 'Image');
        return Promise.all(images.map(async item => {
          if (item._thumbnail_url) return item;
          try {
            const detail = await api.get<{ URL?: string; Status?: string; _thumbnail_url?: string }>(`/assets/item/${item.Id}?region=cn`);
            return { ...item, URL: detail.URL || item.URL, _thumbnail_url: detail._thumbnail_url, Status: detail.Status || item.Status };
          } catch { return item; }
        }));
      } catch { return []; }
    }));
    return perGroup.flat();
  } catch { return []; }
}

function AssetLibrary({ groupType, title, color, selectedIds, onAdd, onRemove }: {
  groupType: 'AIGC' | 'LivenessFace';
  title: string;
  color?: string;
  selectedIds: string[];
  onAdd: (assetId: string, label: string, previewUrl?: string) => void;
  onRemove: (assetId: string) => void;
}) {
  const [assets, setAssets] = useState<RemoteAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const loadAssets = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ Items: RemoteAsset[] }>(`/assets/all?groupType=${groupType}`);
      if (data?.Items) {
        setAssets(data.Items);
      }
    } catch {}
    setLoading(false);
    setLoaded(true);
  }, [groupType]);

  useEffect(() => { loadAssets(); }, [loadAssets]);

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div onClick={() => setExpanded(v => !v)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: color || '#1d4ed8' }}>{title}</span>
        <span style={{ fontSize: 11, color: '#9ca3af' }}>{expanded ? '▼' : '▶'} {assets.length}</span>
      </div>

      {expanded && (
        <>
          {loading && !loaded && <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>加载中...</p>}

          {loaded && assets.length === 0 && (
            <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
              暂无，到 <a href={groupType === 'LivenessFace' ? '/assets/real' : '/assets/virtual'} style={{ color: '#2563eb', fontSize: 11 }}>资源管理</a> 添加
            </p>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))', gap: 5, maxHeight: 220, overflowY: 'auto', marginTop: 8 }}>
            {assets.map(asset => {
              const selected = selectedIds.includes(asset.Id);
              const thumb = asset.PreviewUrl || asset._thumbnail_url || asset.URL || undefined;
              return (
                <div key={asset.Id}
                  onClick={() => selected ? onRemove(asset.Id) : onAdd(asset.Id, asset.Name || asset.Id, thumb)}
                  style={{
                    position: 'relative', borderRadius: 6, overflow: 'hidden', cursor: 'pointer',
                    border: selected ? '2px solid #2563eb' : '1px solid #e5e7eb',
                    aspectRatio: '3/4', background: '#f8fafc',
                  }}>
                  {thumb ? (
                    <img src={thumb} alt={asset.Name || ''} loading="lazy"
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#9ca3af', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 18 }}>👤</span>
                      <span style={{ fontSize: 10 }}>{asset.Name || asset.AssetType}</span>
                    </div>
                  )}
                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent, rgba(0,0,0,.6))', padding: '10px 3px 2px', fontSize: 9, color: '#fff', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {asset.Name || asset.Id.slice(0, 8)}
                  </div>
                  {selected && (
                    <div style={{ position: 'absolute', top: 3, right: 3 }}>
                      <span style={{ background: '#2563eb', color: '#fff', borderRadius: '50%', padding: '1px 3px', fontSize: 9 }}>✓</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── MediaPanel (file upload) ─────────────────────────────────────────────────

function MediaPanel({ items, onAddFiles, onRemove, onDescChange, uploadError, imageOffset = 0 }: {
  items: MediaItem[];
  onAddFiles: (files: File[]) => void;
  onRemove: (idx: number) => void;
  onDescChange: (idx: number, desc: string) => void;
  uploadError?: string;
  imageOffset?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<'image' | 'video' | 'audio'>('image');

  function typeLabel(idx: number): string {
    const t = items[idx].mediaType!;
    const n = items.slice(0, idx + 1).filter(m => m.mediaType === t).length;
    const offset = t === 'image' ? imageOffset : 0;
    return `${MEDIA_ZH[t]}${n + offset}`;
  }

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.map((item, idx) => {
          const label = typeLabel(idx);
          const pct = item.uploadProgress ?? 0;
          const t = item.mediaType || 'image';
          return (
            <div key={item.uid ?? idx} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
              {item.previewUrl ? (
                <div style={{ position: 'relative', width: 36, height: 36, flexShrink: 0, cursor: 'pointer' }} onClick={() => { setPreviewUrl(item.url || item.previewUrl || null); setPreviewType(t as any); }}>
                  <img src={item.previewUrl} alt="" style={{ width: 36, height: 36, borderRadius: 4, objectFit: 'cover' }} />
                  {item.uploading && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, background: 'rgba(0,0,0,.5)' }}>
                      <span style={{ fontSize: 9, fontWeight: 700, color: '#fff' }}>{pct}%</span>
                    </div>
                  )}
                </div>
              ) : (
                <span onClick={() => { if (item.url) { setPreviewUrl(item.url); setPreviewType(t as any); } }}
                  style={{ width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 18, background: '#f3f4f6', borderRadius: 4, cursor: item.url ? 'pointer' : 'default' }}>
                  {t === 'video' ? '🎞' : t === 'audio' ? '🎵' : '📷'}
                </span>
              )}
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', minWidth: 36, flexShrink: 0 }}>{item.uploading ? `${pct}%` : label}</span>
              <input type="text" value={item.description || ''} onChange={e => onDescChange(idx, e.target.value)}
                placeholder="素材说明（如：产品大图、主角特写）"
                style={{ flex: 1, fontSize: 12, padding: '4px 8px', border: '1px solid #d4d4d8', borderRadius: 4, outline: 'none', minWidth: 0 }} />
              <button type="button" onClick={() => onRemove(idx)} disabled={item.uploading}
                style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: item.uploading ? 'not-allowed' : 'pointer', fontSize: 16, padding: '0 4px', lineHeight: 1 }}>×</button>
            </div>
          );
        })}
      </div>
      <input ref={inputRef} type="file" accept="image/*,video/*,audio/*" multiple style={{ display: 'none' }}
        onChange={e => { onAddFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      {uploadError && <p className={styles.errInline} style={{ marginTop: 6 }}>{uploadError}</p>}
      {previewUrl && (
        <div onClick={() => setPreviewUrl(null)} style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <div onClick={e => e.stopPropagation()} style={{ maxWidth: '90vw', maxHeight: '85vh', position: 'relative' }}>
            {previewType === 'image' && <img src={previewUrl} alt="" style={{ maxWidth: '90vw', maxHeight: '85vh', borderRadius: 8, objectFit: 'contain' }} />}
            {previewType === 'video' && <video src={previewUrl} controls autoPlay style={{ maxWidth: '90vw', maxHeight: '85vh', borderRadius: 8 }} />}
            {previewType === 'audio' && <audio src={previewUrl} controls autoPlay style={{ width: 320 }} />}
            <button type="button" onClick={() => setPreviewUrl(null)}
              style={{ position: 'absolute', top: -12, right: -12, width: 28, height: 28, borderRadius: '50%', background: '#fff', border: 'none', fontSize: 16, cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ChipGroup({ label, options, value, onChange, pill }: {
  label: string; options: { value: string | number; label: string }[];
  value: string | number; onChange: (v: string | number) => void; pill?: boolean;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <span className={styles.paramLabel}>{label}</span>
      <div className={styles.chipGroup} style={{ marginBottom: 0 }}>
        {options.map(o => {
          const active = value === o.value;
          const cls = pill
            ? (active ? `${styles.chip} ${styles.chipPill} ${styles.chipPillActive}` : `${styles.chip} ${styles.chipPill}`)
            : (active ? `${styles.chip} ${styles.chipActive}` : styles.chip);
          return <button key={o.value} type="button" onClick={() => onChange(o.value)} className={cls}>{o.label}</button>;
        })}
      </div>
    </div>
  );
}

function Toggle({ enabled, onToggle, label }: { enabled: boolean; onToggle: () => void; label: string }) {
  return (
    <div className={styles.toggleRow} onClick={onToggle}>
      <div className={enabled ? `${styles.toggleTrack} ${styles.toggleTrackOn}` : styles.toggleTrack}>
        <span className={enabled ? `${styles.toggleKnob} ${styles.toggleKnobOn}` : styles.toggleKnob} />
      </div>
      <span className={styles.toggleLabel}>{label}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'succeeded' ? styles.statusSucceeded
    : status === 'failed'  ? styles.statusFailed
    : status === 'running' ? styles.statusRunning
    : status === 'queued'  ? styles.statusQueued
    : status === 'idle'    ? styles.statusIdle
    : styles.statusPending;
  return <span className={`${styles.statusBadge} ${cls}`}>{STATUS_LABELS[status] || status}</span>;
}

function VideoThumb({ src, ratio = '9:16', subtitle }: { src: string; ratio?: string; subtitle?: string }) {
  const [open, setOpen] = useState(false);
  const [w, h] = ratio.split(':').map(Number);
  return (
    <>
      <div className={styles.videoThumbWrap} onClick={() => setOpen(true)} style={{ cursor: 'pointer' }}>
        <video src={src} muted playsInline preload="metadata"
          style={{ aspectRatio: `${w||9}/${h||16}`, height: 100, width: 'auto', display: 'block', borderRadius: 6, border: '1px solid #e5e7eb', objectFit: 'cover' }}
          className={styles.videoThumb} title="点击预览" />
      </div>
      {open && (
        <div className={styles.lightbox} onClick={() => setOpen(false)}>
          <div className={styles.lightboxInner} onClick={e => e.stopPropagation()}>
            <button onClick={() => setOpen(false)} className={styles.lightboxClose}>关闭</button>
            <video src={src} controls autoPlay className={styles.lightboxVideo} />
          </div>
        </div>
      )}
    </>
  );
}

function ParamsPanel(p: {
  model: string; onModelChange: (v: string | number) => void;
  resolution: string; onResolutionChange: (v: string | number) => void;
  ratio: string; onRatioChange: (v: string) => void;
  style: string; onStyleChange: (v: string) => void;
  generateAudio: boolean; onToggleAudio: () => void;
  watermark: boolean; onToggleWatermark: () => void;
  seed: number | null; onSeedChange: (v: number | null) => void;
  serviceTier: string; onServiceTierChange: (v: string) => void;
  priority: number; onPriorityChange: (v: number) => void;
  returnLastFrame: boolean; onToggleReturnLastFrame: () => void;
  draft: boolean; onToggleDraft: () => void;
  webSearch: boolean; onToggleWebSearch: () => void;
  region: 'overseas' | 'cn'; onRegionChange: (v: 'overseas' | 'cn') => void;
  showJsonPreview: boolean; onToggleJsonPreview: () => void;
  subtitleMode: 'on' | 'off'; onSubtitleModeChange: (v: 'on' | 'off') => void;
  voice: string; onVoiceChange: (v: string) => void;
  banner: string; onBannerChange: (v: string) => void;
  bannerStyle: BannerStyle; onBannerStyleChange: (v: BannerStyle) => void;
  subtitleStyle: SubtitleStyle; onSubtitleStyleChange: (v: SubtitleStyle) => void;
  duration: number;
  mediaItems: MediaItem[];
  videoSubjects: ProjectSubject[];
  scriptAnalysis: Array<{ label: string; type: string; appearance: string; personality: string; linkedSubjectId?: string }>;
}) {
  const is2x = p.model.includes('2-0');
  const is15pro = p.model.includes('1-5') || p.model.includes('1.5');

  // content 的素材排布走公共的 buildContentMedia() —— 这个预览曾经自己排一套
  // （asset 图插到上传图前面），和它上面那段图片说明的编号对不上
  const contentMedia = buildContentMedia(p.videoSubjects, p.mediaItems);

  const contentItems: unknown[] = [{ type: 'text', text: '(prompt内容)' }];
  const subjectsWithImg = p.videoSubjects.filter(s => s.image_url);
  const imgDescLines: string[] = [];
  contentMedia.filter(x => x.mediaType === 'image').forEach(x => {
    const no = mediaNoOf(contentMedia, x);
    if (x.from === 'subject') {
      const sub = p.videoSubjects.find(s => s.id === x.subjectId);
      const analysis = p.scriptAnalysis.find(a => a.linkedSubjectId === x.subjectId);
      imgDescLines.push(`图片${no}：角色「${analysis?.label || sub?.label || ''}」— ${sub?.description || '见图片'}`);
    } else {
      imgDescLines.push(`图片${no}：参考素材「${x.name || '素材'}」— ${x.description || ''}`);
    }
  });
  if (imgDescLines.length > 0) contentItems.push({ type: 'text', text: imgDescLines.join('\n') });
  contentMedia.forEach(x => contentItems.push(
    x.mediaType === 'image' ? { type: 'image_url', image_url: { url: x.url }, role: 'reference_image' }
    : x.mediaType === 'video' ? { type: 'video_url', video_url: { url: x.url }, role: 'reference_video' }
    : { type: 'audio_url', audio_url: { url: x.url }, role: 'reference_audio' }));

  const previewBody: Record<string, unknown> = {
    model: p.model,
    content: contentItems,
    resolution: p.resolution,
    ratio: p.ratio,
    duration: p.duration,
    generate_audio: p.generateAudio,
    watermark: p.watermark,
  };
  if (p.seed !== null) previewBody.seed = p.seed;
  if (p.returnLastFrame) previewBody.return_last_frame = true;
  if (p.draft && is15pro) previewBody.draft = true;
  if (p.serviceTier !== 'default') previewBody.service_tier = p.serviceTier;
  if (p.priority > 0) previewBody.priority = p.priority;
  if (p.webSearch && is2x) previewBody.tools = [{ type: 'web_search' }];

  return (
    <div>
      <p className={styles.cardTitle} style={{ marginBottom: 8 }}>视频参数</p>
      <div>
          {/* 模型 + 分辨率 + 视觉风格 一行 */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <div style={{ flex: 2 }}>
              <span className={styles.paramLabel}>模型</span>
              <select value={p.model} onChange={e => p.onModelChange(e.target.value)}
                className={styles.select} style={{ width: '100%', marginTop: 2 }}>
                {MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <span className={styles.paramLabel}>分辨率</span>
              <select value={p.resolution} onChange={e => p.onResolutionChange(e.target.value)}
                className={styles.select} style={{ width: '100%', marginTop: 2 }}>
                {RESOLUTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <span className={styles.paramLabel}>风格</span>
              <select value={p.style} onChange={e => p.onStyleChange(e.target.value)}
                className={styles.select} style={{ width: '100%', marginTop: 2 }}>
                {STYLES.map(s => <option key={s.label} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>

          {/* 比例 + 配音音色 + 服务等级 一行 */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <div style={{ flex: 1 }}>
              <span className={styles.paramLabel}>比例</span>
              <select value={p.ratio} onChange={e => p.onRatioChange(e.target.value)}
                className={styles.select} style={{ width: '100%', marginTop: 2 }}>
                {RATIOS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 2 }}>
              <span className={styles.paramLabel}>配音音色</span>
              <select value={p.voice} onChange={e => p.onVoiceChange(e.target.value)}
                className={styles.select} style={{ width: '100%', marginTop: 2 }}>
                {AZURE_VOICES.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <span className={styles.paramLabel}>服务等级</span>
              <select value={p.serviceTier} onChange={e => p.onServiceTierChange(e.target.value)}
                className={styles.select} style={{ width: '100%', marginTop: 2 }}>
                <option value="default">default</option>
                <option value="standard">standard</option>
                <option value="priority">priority</option>
              </select>
            </div>
          </div>

          {/* Toggles 紧凑一行 */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
            <Toggle enabled={p.generateAudio} onToggle={p.onToggleAudio} label="音频" />
            <Toggle enabled={p.watermark} onToggle={p.onToggleWatermark} label="水印" />
            <Toggle enabled={p.returnLastFrame} onToggle={p.onToggleReturnLastFrame} label="尾帧" />
            {is15pro && <Toggle enabled={p.draft} onToggle={p.onToggleDraft} label="样片" />}
            {is2x && <Toggle enabled={p.webSearch} onToggle={p.onToggleWebSearch} label="联网" />}
            <Toggle enabled={p.region === 'cn'} onToggle={() => p.onRegionChange(p.region === 'cn' ? 'overseas' : 'cn')} label="国内" />
          </div>

          {/* 随机种子 + 优先级 一行 */}
          <div style={{ display: 'none', gap: 6, marginBottom: 6, alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <span className={styles.paramLabel}>种子</span>
              <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                <input type="number" placeholder="随机" min={0} max={2147483647}
                  value={p.seed ?? ''}
                  onChange={e => p.onSeedChange(e.target.value ? parseInt(e.target.value) : null)}
                  className={styles.input} style={{ padding: '4px 6px', fontSize: 12 }} />
                {p.seed !== null && <button onClick={() => p.onSeedChange(null)} style={{ fontSize: 10, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>清</button>}
              </div>
            </div>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>优先级</span>
              <input type="range" min={0} max={9} value={p.priority}
                onChange={e => p.onPriorityChange(parseInt(e.target.value))}
                style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: '#6b7280', minWidth: 12 }}>{p.priority}</span>
            </div>
          </div>

          <div style={{ height: 1, background: '#e5e7eb', margin: '8px 0' }} />

          {/* 视频标语（全程显示） */}
          <div style={{ marginBottom: 4 }}>
            <span className={styles.paramLabel}>视频标语（全程显示）</span>
            <textarea rows={2} value={p.banner} onChange={e => p.onBannerChange(e.target.value)}
              placeholder="输入标语，支持多行，全程显示在顶部…"
              className={styles.input} style={{ width: '100%', marginTop: 2, padding: '3px 5px', fontSize: 11, resize: 'vertical', lineHeight: 1.4 }} />
            {/* 标语样式控件 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '2px 4px', marginTop: 3 }}>
              <div>
                <span className={styles.paramLabel}>字号%</span>
                <input type="number" min={1} max={8} step={0.5}
                  value={p.bannerStyle.fontSize}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, fontSize: parseFloat(e.target.value) || 2.8 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>字色</span>
                <input type="color" value={p.bannerStyle.color}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, color: e.target.value })}
                  style={{ width: '100%', height: 20, marginTop: 1, cursor: 'pointer', border: '1px solid #e5e7eb', borderRadius: 3, padding: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>透明度</span>
                <input type="number" min={0} max={1} step={0.1}
                  value={p.bannerStyle.alpha}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, alpha: parseFloat(e.target.value) ?? 1 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>描边宽</span>
                <input type="number" min={0} max={8} step={1}
                  value={p.bannerStyle.borderW}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, borderW: parseInt(e.target.value) || 0 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>描边色</span>
                <input type="color" value={p.bannerStyle.borderColor}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, borderColor: e.target.value })}
                  style={{ width: '100%', height: 20, marginTop: 1, cursor: 'pointer', border: '1px solid #e5e7eb', borderRadius: 3, padding: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>描边透</span>
                <input type="number" min={0} max={1} step={0.1}
                  value={p.bannerStyle.borderAlpha}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, borderAlpha: parseFloat(e.target.value) ?? 0.6 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>阴影X</span>
                <input type="number" min={0} max={20} step={1}
                  value={p.bannerStyle.shadowX}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, shadowX: parseInt(e.target.value) || 0 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>阴影Y</span>
                <input type="number" min={0} max={20} step={1}
                  value={p.bannerStyle.shadowY}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, shadowY: parseInt(e.target.value) || 0 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>阴影色</span>
                <input type="color" value={p.bannerStyle.shadowColor}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, shadowColor: e.target.value })}
                  style={{ width: '100%', height: 20, marginTop: 1, cursor: 'pointer', border: '1px solid #e5e7eb', borderRadius: 3, padding: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>背景块</span>
                <select value={p.bannerStyle.boxEnabled ? '1' : '0'}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, boxEnabled: e.target.value === '1' })}
                  className={styles.select} style={{ width: '100%', marginTop: 1 }}>
                  <option value="0">关</option>
                  <option value="1">开</option>
                </select>
              </div>
              <div>
                <span className={styles.paramLabel}>背景色</span>
                <input type="color" value={p.bannerStyle.boxColor}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, boxColor: e.target.value })}
                  style={{ width: '100%', height: 20, marginTop: 1, cursor: 'pointer', border: '1px solid #e5e7eb', borderRadius: 3, padding: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>背景透</span>
                <input type="number" min={0} max={1} step={0.1}
                  value={p.bannerStyle.boxAlpha}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, boxAlpha: parseFloat(e.target.value) ?? 0.5 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: '#e5e7eb', margin: '6px 0' }} />

          {/* 字幕样式 */}
          <div style={{ marginBottom: 4 }}>
            <span className={styles.paramLabel}>字幕样式</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '2px 4px', marginTop: 3 }}>
              <div style={{ gridColumn: 'span 2' }}>
                <span className={styles.paramLabel}>字体</span>
                <select value={p.subtitleStyle.font} onChange={e => p.onSubtitleStyleChange({ ...p.subtitleStyle, font: e.target.value })}
                  className={styles.select} style={{ width: '100%', marginTop: 1 }}>
                  {SUBTITLE_FONTS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </div>
              <div>
                <span className={styles.paramLabel}>字号%</span>
                <input type="number" min={1} max={10} step={0.5}
                  value={p.subtitleStyle.fontSize}
                  onChange={e => p.onSubtitleStyleChange({ ...p.subtitleStyle, fontSize: parseFloat(e.target.value) || 4.2 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>位置</span>
                <select value={p.subtitleStyle.position} onChange={e => p.onSubtitleStyleChange({ ...p.subtitleStyle, position: e.target.value })}
                  className={styles.select} style={{ width: '100%', marginTop: 1 }}>
                  {SUBTITLE_POSITIONS.map(pos => <option key={pos.value} value={pos.value}>{pos.label}</option>)}
                </select>
              </div>
              <div>
                <span className={styles.paramLabel}>字色</span>
                <input type="color" value={p.subtitleStyle.color}
                  onChange={e => p.onSubtitleStyleChange({ ...p.subtitleStyle, color: e.target.value })}
                  style={{ width: '100%', height: 20, marginTop: 1, cursor: 'pointer', border: '1px solid #e5e7eb', borderRadius: 3, padding: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>透明度</span>
                <input type="number" min={0} max={1} step={0.1}
                  value={p.subtitleStyle.alpha}
                  onChange={e => p.onSubtitleStyleChange({ ...p.subtitleStyle, alpha: parseFloat(e.target.value) ?? 1 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>描边宽</span>
                <input type="number" min={0} max={8} step={1}
                  value={p.subtitleStyle.borderW}
                  onChange={e => p.onSubtitleStyleChange({ ...p.subtitleStyle, borderW: parseInt(e.target.value) || 0 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>描边色</span>
                <input type="color" value={p.subtitleStyle.borderColor}
                  onChange={e => p.onSubtitleStyleChange({ ...p.subtitleStyle, borderColor: e.target.value })}
                  style={{ width: '100%', height: 20, marginTop: 1, cursor: 'pointer', border: '1px solid #e5e7eb', borderRadius: 3, padding: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>描边透</span>
                <input type="number" min={0} max={1} step={0.1}
                  value={p.subtitleStyle.borderAlpha}
                  onChange={e => p.onSubtitleStyleChange({ ...p.subtitleStyle, borderAlpha: parseFloat(e.target.value) ?? 0.5 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: '#e5e7eb', margin: '8px 0' }} />

          {/* JSON Preview Toggle */}
          <button onClick={p.onToggleJsonPreview}
            style={{ width: '100%', padding: '5px 10px', border: '1px solid #e5e7eb', borderRadius: 6, background: p.showJsonPreview ? '#eff6ff' : '#fff', fontSize: 11, cursor: 'pointer', color: '#374151', textAlign: 'left' }}>
            {p.showJsonPreview ? '▼' : '▶'} 预览 JSON
          </button>
          {p.showJsonPreview && (
            <pre style={{ margin: '6px 0 0', padding: 8, background: '#1e293b', color: '#e2e8f0', borderRadius: 6, fontSize: 11, lineHeight: 1.4, overflow: 'auto', maxHeight: 300 }}>
              {JSON.stringify(previewBody, null, 2)}
            </pre>
          )}
        </div>
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

// AI改写浮窗里的常用要求，点一下追加进输入框
const REWRITE_PRESETS = ['更口语一点', '节奏更紧凑', '加强冲突', '结尾改成开放式', '台词再短一些', '语气更轻松'];

export default function VoiceoverPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [projectId, setProjectId] = useState<string | null>(searchParams.get('projectId'));
  const [videoId, setVideoId]     = useState<string | null>(searchParams.get('videoId'));
  const [videoName, setVideoName] = useState('');
  const [projectName, setProjectName] = useState('');

  const [script, setScript] = useState('');
  const [subtitleInput, setSubtitleInput] = useState('');
  const [style, setStyle]   = useState(STYLES[0].value);
  const [ratio, setRatio]   = useState('9:16');

  const [initResult, setInitResult]   = useState<InitResult | null>(null);
  const [initing, setIniting]         = useState(false);
  const [aiScriptLoading, setAiScriptLoading] = useState(false);
  const [showAiInput, setShowAiInput] = useState(false);
  const [aiTopic, setAiTopic] = useState('');
  const [initError, setInitError]     = useState('');

  const [shots, setShots] = useState<VoiceoverShot[]>([]);

  const [model, setModel]               = useState(DEFAULT_MODEL);
  const [resolution, setResolution]     = useState('720p');
  // 默认开：对白靠 Seedance 自己出人声（对白已写进 prompt），关掉就只剩哑画面。
  // 打开已存的视频也回到开 —— 见下面读库那一段为什么不采信库里的 false。
  const [generateAudio, setGenerateAudio] = useState(true);
  const [watermark, setWatermark]         = useState(false);
  const [seed, setSeed]                   = useState<number | null>(null);
  const [serviceTier, setServiceTier]     = useState('default');
  const [priority, setPriority]           = useState(0);
  const [returnLastFrame, setReturnLastFrame] = useState(false);
  const [draft, setDraft]                 = useState(false);
  const [webSearch, setWebSearch]         = useState(false);
  const [region, setRegion]               = useState<'overseas' | 'cn'>('overseas');
  const [subtitleMode, setSubtitleMode]   = useState<'on' | 'off'>('off');
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>(DEFAULT_SUBTITLE_STYLE);
  const [banner, setBanner]               = useState('');
  const [bannerStyle, setBannerStyle]     = useState<BannerStyle>(DEFAULT_BANNER_STYLE);
  const [showJsonPreview, setShowJsonPreview] = useState(false);
  const [voice, setVoice]                 = useState('zh-CN-XiaoqiuNeural');
  const [audioUrl, setAudioUrl]           = useState<string | null>(null);
  const [audioDuration, setAudioDuration] = useState<number>(0);
  const [wordBoundaries, setWordBoundaries] = useState<Array<{text: string; offset: number; duration: number}>>([]);
  const [ttsLoading, setTtsLoading]       = useState(false);
  // 分镜任务已经跑了多少秒（后端给的，回到页面时也能接着显示）
  const [initElapsed, setInitElapsed]     = useState(0);
  // 叙事短片第一步在写的对白剧本 —— 流式，后端每收到一段新文本就更新一次任务状态，
  // 这里跟着轮询往上刷；stage 从 'script' 变成 'shots' 就是剧本写完了、在拆分镜配运镜
  const [sbStage, setSbStage]             = useState<'script' | 'shots' | ''>('');
  // 后台任务回传的对白剧本正文：按钮下面已不再展示它，但流式片段仍要收下（不然
  // 轮询里那几处 setSbScript 得跟着删，任务协议也要动）—— 只是没有读取方
  const [, setSbScript]                   = useState('');
  const [tasks, setTasks]                 = useState<Record<number, ShotTask>>({});
  // 「查看提交 JSON」手改的内容——键上有值就说明这一镜被编辑过，提交时原样发它，
  // 不再从 prompt/orderedMedia 重新拼；没编辑过的镜头这里没有键，框里显示自动生成的默认值
  const [shotJsonEdits, setShotJsonEdits] = useState<Record<number, string>>({});
  const pollRefs = useRef<Record<number, ReturnType<typeof setInterval>>>({});
  // 分镜卡上的「已等待 X」要走秒 —— 只在有非终态任务时开这只表，全跑完就停
  const [taskNow, setTaskNow] = useState(() => Date.now());
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const batchSeedRef = useRef<number | null>(null);

  const [merging, setMerging]               = useState(false);
  const [mergedVideoUrl, setMergedVideoUrl] = useState<string | null>(null);
  const [mergeError, setMergeError]         = useState('');
  const [mergeId, setMergeId]               = useState<string | null>(null);
  const mergePollingRef = useRef<ReturnType<typeof setInterval> | null>(null);


  const [showMobileParams, setShowMobileParams] = useState(false);
  const [showExamples, setShowExamples] = useState(false);
  const [showMediaTip, setShowMediaTip] = useState(false);

  const [mediaItems, setMediaItems]   = useState<MediaItem[]>([]);
  const [uploadError, setUploadError] = useState('');
  const [realAvatars, setRealAvatars]     = useState<RemoteAsset[]>([]);
  const [virtualAvatars, setVirtualAvatars] = useState<RemoteAsset[]>([]);
  const [avatarLoading, setAvatarLoading] = useState(false);
  const [avatarSearch, setAvatarSearch] = useState('');
  const [avatarPickerIdx, setAvatarPickerIdx] = useState<number | null>(null);
  const [avatarPickerTab, setAvatarPickerTab] = useState<'real' | 'virtual'>('real');
  const [avatarExpanded, setAvatarExpanded] = useState(false);

  const [subjectDefs, setSubjectDefs]         = useState('');
  const [analyzingSubjects, setAnalyzingSubjects] = useState(false);
  const [subjectError, setSubjectError]       = useState('');
  const prevSubjectDefsRef = useRef('');

  const [resetKey, setResetKey]             = useState(0);
  const [dataLoaded, setDataLoaded] = useState(false);
  useEffect(() => {
    try { const v = localStorage.getItem(SHOT_VIEW_KEY); if (v === 'list' || v === 'tabs') setShotView(v); } catch {}
  }, []);
  // 分镜有两种看法，可以随时切换（选择记在 localStorage 里，下次进来还是这个）：
  //   tabs（默认）横排标签，点哪个看哪个 —— 分镜之间来回比对时不用滚来滚去
  //   list        竖排列表，每张卡各自展开/折叠 —— 想一眼扫完全部标题和状态时更好使
  const [activeShot, setActiveShot]         = useState(0);
  const [shotView, setShotView]             = useState<'tabs' | 'list'>('tabs');
  const [expandedShots, setExpandedShots]   = useState<Record<number, boolean>>({});
  const [allShotsExpanded, setAllShotsExpanded] = useState(false);
  // 展开的分镜卡分成几个页签，各记各的（默认「字幕」）
  const [shotTabs, setShotTabs]             = useState<Record<number, ShotTabKey>>({});
  const [cameraEditorIdx, setCameraEditorIdx] = useState<number | null>(null);
  const [shotMediaIdx, setShotMediaIdx] = useState<number | null>(null);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [showVideoPicker, setShowVideoPicker] = useState(false);
  const [projectList, setProjectList] = useState<Array<{ id: string; name: string }>>([]);
  const [videoList, setVideoList] = useState<Array<{ id: string; name: string }>>([]);
  const [projectSubjects, setProjectSubjects] = useState<ProjectSubject[]>([]);
  const [videoSubjects, setVideoSubjects] = useState<ProjectSubject[]>([]);
  const [showSubjectPicker, setShowSubjectPicker] = useState(false);
  const [scriptAnalysis, setScriptAnalysis] = useState<AnalysisItem[]>([]);
  const [analyzingScript, setAnalyzingScript] = useState(false);
  const [scriptAnalysisError, setScriptAnalysisError] = useState('');
  // 「剧本分析」按钮写出来的完整对白剧本 —— 和「生成分镜脚本」第一步是同一份东西，
  // 提前写好了就存这里，点「生成分镜脚本」时直接带过去，后端不用再重写一遍
  const [dialogueScript, setDialogueScript] = useState('');
  const [extractingRoles, setExtractingRoles] = useState(false);
  // 「AI改写」浮窗：改写要求 + 改写中的流式预览（复用剧本分析同一套流式轮询手法）
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [rewriteInstruction, setRewriteInstruction] = useState('');
  const [rewritingScript, setRewritingScript] = useState(false);
  const [rewritePreview, setRewritePreview] = useState('');
  const [rewriteError, setRewriteError] = useState('');
  // 对白剧本 / 角色 / 参考素材 三块合成页签（以前是三段顺排的折叠区，一屏塞不下）
  const [stepTab, setStepTab] = useState<'script' | 'roles' | 'media'>('script');
  // 页签内容整体折叠（页签条本身留着）—— 分镜多起来的时候这三块很占屏
  const [tabsCollapsed, setTabsCollapsed] = useState(false);
  // 分镜列表也能整体折叠（合并那一块留在外面，折起来照样能合并/下载）
  const [shotsCollapsed, setShotsCollapsed] = useState(false);
  const [scriptCollapsed, setScriptCollapsed] = useState(false);
  const [sbOpen, setSbOpen] = useState(false);
  const [sbSettings, setSbSettings] = useState<StoryboardSettings>(DEFAULT_STORYBOARD_SETTINGS);

  // 唯一那个 textarea 始终写 script，是视频描述；字幕交给后端按脚本自动生成。
  const conceptText = script;
  const setConceptText = (v: string) => {
    setScript(v);
    setInitResult(null); setShots([]); setMergedVideoUrl(null);
  };

  // 角色/素材上下文。两条分镜链路共用同一份 @图片N 编号 —— 各算各的迟早漂移，
  // 编号一错，提示词里的角色锚定就指到别的图上去了。
  const subjectContext = useMemo(
    () => buildSubjectContext(videoSubjects, mediaItems, scriptAnalysis),
    [videoSubjects, mediaItems, scriptAnalysis]);

  // 参考素材还能加几个。图片额度是**整条请求**的 9 个，带图角色的头像提交时排在参考素材
  // 前面、同样占 image_url 名额，所以这里要先扣掉；视频/音频没有别的来源，直接是 3。
  const subjectImageCount = videoSubjects.filter(s => s.image_url).length;
  const mediaLimit = (t: 'image' | 'video' | 'audio') =>
    t === 'image' ? Math.max(0, MEDIA_CAPS.image - subjectImageCount) : MEDIA_CAPS[t];

  // 方舟体验中心的预设音色（80 条）。文件托管在火山的公开 TOS 上，选中直接把地址
  // 塞进参考素材 —— 不用下载转存，编号照常按参考素材的顺序排。
  const [voiceQuery, setVoiceQuery] = useState('');
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [voicePresets, setVoicePresets] = useState<Array<{ name: string; category: string; gender: string; duration: string; url: string; avatar: string }>>([]);
  const [videoPresets, setVideoPresets] = useState<Array<{ name: string; category: string; url: string; thumb: string }>>([]);
  const [imagePresets, setImagePresets] = useState<Array<{ name: string; category: string; url: string; thumb: string }>>([]);
  useEffect(() => {
    api.get<{ audios: typeof voicePresets; videos: typeof videoPresets; images: typeof imagePresets }>('/library/materials')
      .then(d => { setVoicePresets(d.audios || []); setVideoPresets(d.videos || []); setImagePresets(d.images || []); })
      .catch(() => {});
  }, []);
  // url → 缩略图：音色是 base64 头像，视频/图片是火山那边带 x-tos-process 的缩略图。
  // 不落库（data URI 太大），每次按 url 现查现用。
  const presetThumbByUrl = useMemo(() => {
    const m = new Map<string, string>();
    voicePresets.forEach(v => v.avatar && m.set(v.url, v.avatar));
    videoPresets.forEach(v => v.thumb && m.set(v.url, v.thumb));
    imagePresets.forEach(v => v.thumb && m.set(v.url, v.thumb));
    return m;
  }, [voicePresets, videoPresets, imagePresets]);

  // 参考素材列表用的副本：非图片素材的缩略图在这里解析。
  // 原来重开页面时所有素材的 previewUrl 都被设成了 url，等于把 mp3 塞进 <img> —— 裂图。
  const mediaItemsForPanel = useMemo(() => mediaItems.map(m => {
    if (m.mediaType === 'image') return m.previewUrl ? m : { ...m, previewUrl: m.url };   // 图片自己就是缩略图
    // 存量素材存的是 %XX 转义过的地址（预设库现在给的是中文），查表前先归一
    const thumb = presetThumbByUrl.get(prettyUrl(m.url || ''))
      || (m.mediaType === 'video' && m.url?.includes('tos-cn-beijing')
        ? `${m.url}?x-tos-process=video/snapshot,t_0,h_600` : '');
    return { ...m, previewUrl: thumb || undefined };             // 没缩略图就退回图标
  }), [mediaItems, presetThumbByUrl]);

  // 素材库浮窗（参考素材那一栏的「素材库」按钮）
  const [libOpen, setLibOpen] = useState(false);
  const [libTab, setLibTab] = useState<'video' | 'audio' | 'image'>('video');
  const [libQuery, setLibQuery] = useState('');
  const [libUrlInput, setLibUrlInput] = useState('');

  // 已上传好的参考音频 —— 顺序就是提示词里 @音频N 的编号（全片不可重排）
  const audioItems = useMemo(
    () => mediaItems.filter(m => m.url && !m.uploading && m.mediaType === 'audio'),
    [mediaItems]
  );
  // 角色 → 音频编号的绑定，一行一个。后端拿它盖掉模型自己挑的 audio_ref，
  // 该角色说话的每一镜都贴同一句「使用@音频N…的音色说话」
  // 预设素材入列参考素材。地址是火山公开 TOS 的直链，不下载不转存 ——
  // 编号仍按参考素材里同类型的顺序排（@视频N / @音频N / @图片N）。
  function addPresetMedia(mediaType: 'image' | 'video' | 'audio', preset: { name: string; category?: string; url: string }) {
    setMediaItems(prev => {
      if (prev.some(m => prettyUrl(m.url || '') === preset.url)) return prev;   // 同一条只占一个编号
      if (prev.filter(m => m.mediaType === mediaType).length >= mediaLimit(mediaType)) {
        setUploadError(`${MEDIA_ZH[mediaType]}最多 ${mediaLimit(mediaType)} 个，先删掉一个再选`);
        return prev;
      }
      return [...prev, {
        uid: `preset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        mediaType,
        url: preset.url,
        name: preset.name,
        // 说明会拼进提示词的素材清单，模型靠它知道这条素材是干什么的
        description: `预设素材：${preset.category ? preset.category + '·' : ''}${preset.name}`,
      }];
    });
  }

  // 路径里的中文以 %XX 形式粘进来（%E5%9B%BE%E7%89%87 = 图片），存库、拼提示词、
  // 显示在素材列表上都是一长串转义。逐段解回中文，**留在 JSON 里的地址不带百分号转义** ——
  // 只动 path，query 原样保留（签名串里的 %2F 之类有语义）。解开后 trim：清单里那条
  // `%20华尔兹.mp4` 去掉前导空格取到的是同一个对象，而裸空格的 URL 谁都用不了。
  // trim 完仍含空格/#/?/%//\ 的段退回原样。后端 lib/materials.js 是同一条规则。
  function prettyUrl(url: string): string {
    const q = url.indexOf('?');
    const head = q < 0 ? url : url.slice(0, q);
    const tail = q < 0 ? '' : url.slice(q);
    const pretty = head.split('/').map(seg => {
      try {
        const dec = decodeURIComponent(seg).trim();
        return dec && !/[\s#?%/\\]/.test(dec) ? dec : seg;
      } catch { return seg; }
    }).join('/');
    return pretty + tail;
  }

  // 链接最后一段路径 → 文件名。用 decodeURIComponent（不是 unescape/escape）
  // 按 UTF-8 解码 %XX，中文文件名才不会变成乱码。解不出来就把原串照原样退回。
  function fileNameFromUrl(url: string): string {
    try {
      const path = new URL(url).pathname;
      const seg = path.split('/').filter(Boolean).pop() || url;
      try { return decodeURIComponent(seg); } catch { return seg; }
    } catch {
      return url;
    }
  }

  // 素材库浮窗里「粘贴链接」直接加一条外部素材 —— 不进预设库，地址原样交给 Seedance。
  function addUrlMedia(mediaType: 'image' | 'video' | 'audio', rawUrl: string) {
    const url = prettyUrl(rawUrl.trim());
    if (!/^https?:\/\//i.test(url)) {
      setUploadError('请粘贴以 http(s):// 开头的完整链接');
      return;
    }
    setMediaItems(prev => {
      if (prev.some(m => m.url === url)) return prev;
      if (prev.filter(m => m.mediaType === mediaType).length >= mediaLimit(mediaType)) {
        setUploadError(`${MEDIA_ZH[mediaType]}最多 ${mediaLimit(mediaType)} 个，先删掉一个再选`);
        return prev;
      }
      const name = fileNameFromUrl(url);
      return [...prev, {
        uid: `url-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        mediaType,
        url,
        name,
        description: `外部链接素材：${name}`,
      }];
    });
    setLibUrlInput('');
  }

  // 让音频编号跟着角色编号走：@图片1 的角色，音色就排成 @音频1。
  // 参考素材里可能还有环境音之类不属于任何角色的音频，那些排在角色音色之后。
  // 一一对应只在「每个角色都选了音色」时成立 —— 对不上也没关系，提示词里逐条写明了谁用哪条。
  useEffect(() => {
    setMediaItems(prev => {
      const audios = prev.filter(m => m.mediaType === 'audio');
      if (audios.length < 2) return prev;
      const ordered = [...videoSubjects.filter(s => s.image_url), ...videoSubjects.filter(s => !s.image_url)];
      const wanted: string[] = [];
      ordered.forEach(sub => {
        const url = scriptAnalysis.find(a => a.linkedSubjectId === sub.id)?.linkedAudioUrl;
        if (url && !wanted.includes(url)) wanted.push(url);
      });
      if (wanted.length === 0) return prev;
      const rank = (m: MediaItem) => {
        const i = wanted.indexOf(m.url || '');
        return i >= 0 ? i : wanted.length + audios.indexOf(m);
      };
      const sorted = [...audios].sort((a, b) => rank(a) - rank(b));
      if (sorted.every((m, i) => m === audios[i])) return prev;   // 顺序没变就别动 state
      let k = 0;
      return prev.map(m => m.mediaType === 'audio' ? sorted[k++] : m);
    });
  }, [scriptAnalysis, videoSubjects]);

  // 选一条预设音色给角色：它得先成为参考素材才有 @音频N 的编号，所以先入列再绑定。
  // 同一条音色多个角色共用时只入列一次（编号也就只占一个位）。
  // 一条预设音频还有没有别人在用；没有就该撤出参考素材（自己上传的不算，那是用户主动传的）
  function releasePresetAudio(url: string | undefined, analysis: typeof scriptAnalysis) {
    if (!url || analysis.some(a => a.linkedAudioUrl === url)) return;
    const item = mediaItems.find(m => m.url === url);
    if (item && (item.uid?.startsWith('preset-') || (item.description || '').startsWith('预设素材：'))) {
      setMediaItems(prev => prev.filter(m => m.url !== url));
    }
  }

  function pickVoicePreset(idx: number, preset: { name: string; url: string }) {
    setMediaItems(prev => prev.some(m => m.url === preset.url) ? prev : [...prev, {
      uid: `preset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      mediaType: 'audio' as const,
      url: preset.url,
      name: preset.name,
      description: `预设音色：${preset.name}`,   // 模型漏写 voice_zh 时后端拿它兜底
    }]);
    const prevUrl = scriptAnalysis[idx]?.linkedAudioUrl;
    const next = scriptAnalysis.map((s, i) => i === idx ? { ...s, linkedAudioUrl: preset.url, _voicePickerOpen: false } : s);
    setScriptAnalysis(next);
    if (prevUrl && prevUrl !== preset.url) releasePresetAudio(prevUrl, next);   // 换掉的那条别占编号
  }

  const [dirtyShotIdxs, setDirtyShotIdxs] = useState<Set<number>>(new Set());
  const [videoDirty, setVideoDirty] = useState(false);
  const [savingShots, setSavingShots] = useState(false);

  // ─── Shot AI Reference Image ──────────────────────────────────────────────
  const [shotAiOpen, setShotAiOpen] = useState(false);
  const [shotAiIdx, setShotAiIdx] = useState<number>(0);
  const [shotAiTurns, setShotAiTurns] = useState<Array<{ id: number; role: 'user' | 'assistant'; text?: string; image?: string; loading?: boolean; error?: string }>>([]);
  const [shotAiInput, setShotAiInput] = useState('');
  const [shotAiBusy, setShotAiBusy] = useState(false);
  const [shotAiLastImage, setShotAiLastImage] = useState<string | null>(null);
  const shotAiIdRef = useRef(0);
  const shotAiBottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { shotAiBottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [shotAiTurns]);

  function openShotAi(idx: number) {
    setShotAiIdx(idx);
    setShotAiOpen(true);
    setShotAiTurns([]);
    setShotAiInput('');
    setShotAiLastImage(null);
    setShotAiBusy(false);
  }

  async function shotAiSend(text: string) {
    const trimmed = text.trim();
    if (!trimmed || shotAiBusy) return;
    const userId = ++shotAiIdRef.current;
    const assistantId = ++shotAiIdRef.current;
    setShotAiTurns(prev => [...prev, { id: userId, role: 'user', text: trimmed }, { id: assistantId, role: 'assistant', loading: true }]);
    setShotAiInput('');
    setShotAiBusy(true);
    try {
      const { getAccessToken } = await import('@/lib/auth');
      const token = getAccessToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      // Build prompt with shot context
      const shot = shots[shotAiIdx];
      const shotContext = shot ? `[分镜${shot.shot_number}：${shot.title}｜${shot.description || ''}｜提示词：${shot.prompt || ''}｜情绪：${shot.mood || ''}｜镜头：${shot.shot_size || '中景'}]` : '';
      const fullPrompt = shotAiLastImage ? trimmed : `${shotContext}\n\n${trimmed}`;

      const body: Record<string, unknown> = { prompt: fullPrompt };
      if (shotAiLastImage) {
        const m = shotAiLastImage.match(/^data:([^;]+);base64,(.*)$/);
        if (m) body.priorImage = { mimeType: m[1], data: m[2] };
      }
      // Include character images as reference
      if (!shotAiLastImage) {
        const subjectImgs = videoSubjects.filter(s => s.image_url).map(s => s.image_url!);
        if (subjectImgs.length > 0) {
          const refImgs: Array<{ mimeType: string; data: string }> = [];
          for (const imgUrl of subjectImgs.slice(0, 5)) {
            try {
              const resp = await fetch(imgUrl);
              const blob = await resp.blob();
              const reader = new FileReader();
              const dataUrl: string = await new Promise((resolve, reject) => { reader.onload = () => resolve(reader.result as string); reader.onerror = reject; reader.readAsDataURL(blob); });
              const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
              if (match) refImgs.push({ mimeType: match[1], data: match[2] });
            } catch {}
          }
          if (refImgs.length > 0) body.referenceImages = refImgs;
        }
      }

      const res = await fetch('/api/voiceover/ai-image', { method: 'POST', headers, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || '生成失败');
      const image = json.data.image;
      setShotAiLastImage(image);
      setShotAiTurns(prev => prev.map(t => t.id === assistantId ? { ...t, loading: false, image } : t));
    } catch (e) {
      const msg = e instanceof Error ? e.message : '生成失败，请重试';
      setShotAiTurns(prev => prev.map(t => t.id === assistantId ? { ...t, loading: false, error: msg } : t));
    } finally {
      setShotAiBusy(false);
    }
  }

  async function shotAiUseImage(imageUrl: string) {
    // Upload base64 image to get a URL, then save as shot's image_url
    try {
      const blob = await fetch(imageUrl).then(r => r.blob());
      const file = new File([blob], `shot-ref-${Date.now()}.png`, { type: 'image/png' });
      const form = new FormData();
      form.append('file', file);
      const uploadRes = await fetch('/api/upload', { method: 'POST', body: form });
      const uploadJson = await uploadRes.json();
      if (!uploadRes.ok) throw new Error('上传失败');
      const url = uploadJson.data.url;
      const u = [...shots];
      u[shotAiIdx] = { ...u[shotAiIdx], imageUrl: url };
      setShots(u);
      if (u[shotAiIdx].id) api.put(`/shots/${u[shotAiIdx].id}`, { image_url: url }).catch(() => {});
      setShotAiOpen(false);
    } catch {
      alert('保存参考图失败，请重试');
    }
  }

  // 换头像只给认证资源——真人头像走 /assets/real 同一套逻辑（LivenessFace，只能经活体验证入库），
  // 虚拟头像走 /assets/virtual 同一套逻辑（AIGC）。刷新按钮和首次加载共用这一个函数。
  async function refreshAvatars() {
    setAvatarLoading(true);
    try {
      const [real, virtual] = await Promise.all([loadVerifiedAvatars('LivenessFace'), loadVerifiedAvatars('AIGC')]);
      setRealAvatars(real);
      setVirtualAvatars(virtual);
    } finally {
      setAvatarLoading(false);
    }
  }

  // ─── Load video data from API ─────────────────────────────────────────────
  useEffect(() => {
    refreshAvatars();

    if (projectId) {
      api.get<any>(`/projects/${projectId}`).then(p => { if (p?.name) setProjectName(p.name); }).catch(() => {});
      api.get<ProjectSubject[]>(`/projects/${projectId}/subjects`).then(subs => {
        setProjectSubjects(subs || []);
        if (!videoId) setVideoSubjects([]);
      }).catch(() => {});
    }

    if (videoId) {
      api.get<any>(`/videos/${videoId}`).then(data => {
        if (data) {
          setVideoName(data.name || '');
          setScript(data.script || '');
          setSubtitleInput(data.subtitle_input || '');
          setStyle(data.style || STYLES[0].value);
          setRatio(data.ratio || '9:16');
          setVoice(data.voice || 'zh-CN-XiaoqiuNeural');
          setAudioUrl(data.audio_url || null);
          setMergedVideoUrl(data.merged_video_url || null);
          if (data.params) {
            if (data.params.model) setModel(data.params.model);
            if (data.params.resolution) setResolution(data.params.resolution);
            // 音频**只认 true，false 不采信**：这个页面只做叙事短片，人声就是 Seedance
            // 按 prompt 里的对白生成的，关掉等于交付哑画面。库里的 false 基本都是
            // 解说纪录片时代（旁白走 Azure、视频自带音频用不上）留下的残留，
            // 照读回来就是每次重开都默认关。本轮里仍然可以手动关，只是不会跨刷新保留。
            if (data.params.generateAudio) setGenerateAudio(true);
            if (data.params.watermark !== undefined) setWatermark(data.params.watermark);
            if (data.params.serviceTier) setServiceTier(data.params.serviceTier);
            if (data.params.webSearch !== undefined) setWebSearch(data.params.webSearch);
            if (data.params.returnLastFrame !== undefined) setReturnLastFrame(data.params.returnLastFrame);
            if (data.params.draft !== undefined) setDraft(data.params.draft);
            if (data.params.subtitleStyle) setSubtitleStyle(data.params.subtitleStyle);
            if (data.params.banner) setBanner(data.params.banner);
            if (data.params.bannerStyle) setBannerStyle(data.params.bannerStyle);
            if (Array.isArray(data.params.scriptAnalysis) && data.params.scriptAnalysis.length > 0) {
              setScriptAnalysis(data.params.scriptAnalysis);
            }
            if (data.params.dialogueScript) setDialogueScript(data.params.dialogueScript);
            // 「专业分镜生成」浮窗里填的创作目标/受众/基调/核心信息/镜头数/总时长/叙事结构
            if (data.params.sbSettings) setSbSettings(prev => ({ ...prev, ...data.params.sbSettings }));
          }
          if (data.seed != null) { batchSeedRef.current = data.seed; setSeed(data.seed); }
          // Load shots from DB
          if (data.shots && data.shots.length > 0) {
            const loadedShots: VoiceoverShot[] = data.shots.map((s: any) => ({
              id: s.id,
              shot_number: s.shot_number,
              title: s.title || '',
              subtitle: s.subtitle || '',
              description: s.description || '',
              prompt: s.prompt || '',
              duration: Number(s.duration) || 8,
              ratio: s.ratio || '',
              // 老数据里存的是模型原样给的英文（camera_movement）或 null（shot_type），
              // 读出来也归一化一次，不用迁库
              shot_size: normalizeShotSize(s.shot_type || ''),
              roll_type: s.roll_type || undefined,
              voice_style: s.voice_style || undefined,
              camera_movement: normalizeCameraMove(s.camera_movement || ''),
              mood: s.mood || '',
              imageUrl: s.image_url || '',
              subjects: Array.isArray(s.subjects) ? s.subjects.map((sub: any) => typeof sub === 'string' ? sub : sub.label) : [],
              shot_subjects: Array.isArray(s.subjects) ? s.subjects.filter((sub: any) => typeof sub === 'object') : [],
              reference_images: Array.isArray(s.reference_images) ? s.reference_images : [],
              camera: {
                position: { x: Number(s.camera_position_x) || 0, y: Number(s.camera_position_y) || 5, z: Number(s.camera_position_z) || 10 },
                target: { x: Number(s.camera_target_x) || 0, y: Number(s.camera_target_y) || 0, z: Number(s.camera_target_z) || 0 },
                fov: Number(s.camera_fov) || 60,
                movementType: s.camera_movement_type || 'static',
                movementPath: s.camera_movement_path || undefined,
              },
              task_id: s.task_id || null,
              task_status: s.task_status || 'idle',
              video_url: s.video_url || null,
              local_url: s.local_url || null,
              video_duration: s.video_duration ? Number(s.video_duration) : null,
              task_error: s.task_error || null,
            }));
            setShots(loadedShots);
            setInitResult({ autoShotCount: loadedShots.length, shotCount: loadedShots.length, shots: loadedShots, totalVideoDuration: loadedShots.reduce((a, s) => a + s.duration, 0) });
            // Rebuild tasks from shot data
            const restoredTasks: Record<number, ShotTask> = {};
            loadedShots.forEach((s, i) => {
              if (s.task_id || s.task_status !== 'idle') {
                // startedAt 用 shots.updated_at 近似 —— 还在跑的任务，最后一次写库就是提交那一次。
                // 取不到就当此刻开始算，宁可晚一点放出「重新生成」，也不要一刷新就怂恿重开。
                const rawUpdated = data.shots[i]?.updated_at;
                const startedAt = rawUpdated ? Date.parse(rawUpdated) : Date.now();
                restoredTasks[i] = { shotIndex: i, taskId: s.task_id || null, status: s.task_status || 'idle', videoUrl: s.video_url || null, localUrl: s.local_url || null, duration: s.video_duration || null, error: s.task_error || null, submitting: false, startedAt: Number.isFinite(startedAt) ? startedAt : Date.now() };
              }
            });
            setTasks(restoredTasks);
          }
          // Load video subjects from DB
          if (data.video_subjects && data.video_subjects.length > 0) {
            setVideoSubjects(data.video_subjects.map((s: any) => ({ id: s.id, project_id: s.project_id, label: s.label, description: s.description, image_url: s.image_url, asset_id: s.asset_id })));
          }
          // Load media
          if (data.media_items && data.media_items.length > 0) {
            setMediaItems(data.media_items.map((m: any) => ({ uid: m.id, mediaType: m.media_type, url: m.url, name: m.name, description: m.description, previewUrl: m.url })));
          }
        }
        setDataLoaded(true);
      }).catch(() => { setDataLoaded(true); });
    } else {
      setDataLoaded(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resume polling for running tasks
  useEffect(() => {
    if (!dataLoaded) return;
    setTasks(current => {
      for (const [idxStr, t] of Object.entries(current)) {
        const idx = Number(idxStr);
        if (t.taskId && !TERMINAL.has(t.status) && !pollRefs.current[idx]) {
          pollTaskById(idx, t.taskId);
          pollRefs.current[idx] = setInterval(() => pollTaskById(idx, t.taskId!), 10_000);
        }
      }
      return current;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataLoaded]);

  // Resume merge polling
  useEffect(() => {
    if (!dataLoaded) return;
    if (mergeId && !mergedVideoUrl && !mergePollingRef.current) {
      pollMergeStatus(mergeId);
    }
    return () => {
      if (mergePollingRef.current) { clearInterval(mergePollingRef.current); mergePollingRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataLoaded]);

  // Mark video dirty when video-level fields change
  useEffect(() => {
    if (!dataLoaded || !videoId) return;
    setVideoDirty(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script, subtitleInput, style, ratio, voice, model, resolution, generateAudio, watermark, seed, serviceTier, returnLastFrame, draft, webSearch, subtitleStyle, banner, bannerStyle, videoSubjects, mediaItems, dialogueScript, sbSettings]);

  function markShotDirty(idx: number) {
    setDirtyShotIdxs(prev => new Set(prev).add(idx));
  }

  // 在最后一镜后面加一个空分镜。落库走 POST /videos/:id/shots —— 那条接口本来就是
  // 按现有 MAX(shot_number) 往后接着排号的，正好就是「加在最后」。
  // 建完把它选中：加一镜就是为了马上去写它。
  const [addingShot, setAddingShot] = useState(false);
  async function addShot() {
    if (addingShot) return;
    setAddingShot(true);
    try {
      const n = shots.length + 1;
      const draft: VoiceoverShot = {
        shot_number: n, title: `分镜 ${n}`, subtitle: '', description: '', prompt: '',
        duration: 5, ratio, shot_size: '', camera_movement: '', mood: '', roll_type: 'b_roll',
        subjects: [], shot_subjects: [],
      };
      let created: VoiceoverShot = draft;
      if (videoId) {
        const rows = await api.post<any[]>(`/videos/${videoId}/shots`, {
          shots: [{ title: draft.title, description: '', prompt: '', subtitle: '', duration: draft.duration, ratio: draft.ratio, roll_type: draft.roll_type,
                    subjects: videoSubjects.map(vs => ({ label: vs.label, image_url: vs.image_url || '' })) }],
        });
        const row = rows?.[0];
        if (row) created = { ...draft, id: row.id, shot_number: row.shot_number ?? n };
      }
      setShots(prev => [...prev, created]);
      setInitResult(prev => prev ? { ...prev, shotCount: prev.shotCount + 1, totalVideoDuration: prev.totalVideoDuration + created.duration } : prev);
      setActiveShot(shots.length);
      setExpandedShots(prev => ({ ...prev, [shots.length]: true }));
      setShotTabs(prev => ({ ...prev, [shots.length]: 'prompt' }));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '添加分镜失败');
    } finally { setAddingShot(false); }
  }

  // 删掉某一镜。后端 DELETE /shots/:id 自己会把剩下的 shot_number 重排，页面这边麻烦的是
  // **所有按下标存的表都要跟着往前挪一格**（tasks / shotTabs / expandedShots / shotJsonEdits /
  // dirtyShotIdxs），漏一个就是改了这一镜显示到那一镜身上。
  // 轮询定时器尤其要重来一遍：interval 的闭包里锁死了旧下标，删完再跑就会把结果写到别人头上。
  async function deleteShot(idx: number) {
    const shot = shots[idx];
    if (!shot) return;
    const t = tasks[idx];
    const warn = t?.videoUrl ? '，已生成的分镜视频也会一起没掉' : '';
    if (!window.confirm(`删除分镜${shot.shot_number}${warn}？删除后不可恢复。`)) return;
    try {
      if (shot.id) await api.del(`/shots/${shot.id}`);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '删除失败');
      return;
    }
    // 旧的轮询全停掉，下面按新下标重建
    Object.values(pollRefs.current).forEach(clearInterval);
    pollRefs.current = {};

    const shift = <T,>(m: Record<number, T>): Record<number, T> => {
      const out: Record<number, T> = {};
      for (const [k, v] of Object.entries(m)) {
        const i = Number(k);
        if (i === idx) continue;
        out[i > idx ? i - 1 : i] = v;
      }
      return out;
    };

    const nextShots = shots.filter((_, i) => i !== idx).map((sh, i) => ({ ...sh, shot_number: i + 1 }));
    setShots(nextShots);
    setTasks(prev => {
      const next = shift(prev);
      for (const [k, v] of Object.entries(next)) {
        const i = Number(k);
        next[i] = { ...v, shotIndex: i };
        if (v.taskId && !TERMINAL.has(v.status)) {
          pollRefs.current[i] = setInterval(() => pollTaskById(i, v.taskId!), 10_000);
        }
      }
      return next;
    });
    setShotTabs(prev => shift(prev));
    setExpandedShots(prev => shift(prev));
    setShotJsonEdits(prev => shift(prev));
    setDirtyShotIdxs(prev => new Set([...prev].filter(i => i !== idx).map(i => (i > idx ? i - 1 : i))));
    setActiveShot(a => Math.max(0, Math.min(a, nextShots.length - 1)));
    setInitResult(prev => prev
      ? { ...prev, shotCount: nextShots.length, totalVideoDuration: Math.max(0, prev.totalVideoDuration - shot.duration) }
      : prev);
  }

  // videos.params 是**整块覆盖**写的（后端 PUT 直接把这个对象 JSON.stringify 进 JSONB），
  // 少写一个字段就等于把它从库里删掉 —— 所以只有这一处拼 params，别处要写就调它、
  // 需要改的字段用 extra 覆盖。以前「生成分镜脚本」那三处各拼各的、都漏了 scriptAnalysis，
  // 生成一次分镜就把角色卡（形象/性格/头像/音色绑定）从库里抹掉了。
  const buildVideoParams = (extra?: Record<string, unknown>) => ({
    model, resolution, generateAudio, watermark, seed, serviceTier, priority,
    returnLastFrame, draft, webSearch, subtitleStyle, banner, bannerStyle,
    dialogueScript, sbSettings,
    scriptAnalysis: scriptAnalysis.map(s => ({
      label: s.label, type: s.type, appearance: s.appearance, personality: s.personality,
      linkedSubjectId: s.linkedSubjectId, linkedAudioUrl: s.linkedAudioUrl,
    })),
    ...(extra || {}),
  });

  async function saveAll() {
    setSavingShots(true);
    const promises: Promise<any>[] = [];
    // Save video-level fields + subjects + media
    if (videoId) {
      const payload: any = {};
      if (videoDirty) {
        Object.assign(payload, { script, subtitle_input: subtitleInput, style, ratio, voice });
      }
      payload.params = buildVideoParams();
      payload.subject_ids = videoSubjects.map(s => s.id);
      payload.media_items = mediaItems.map(m => ({ media_type: m.mediaType, url: m.url, name: m.name, description: m.description }));
      promises.push(api.put(`/videos/${videoId}`, payload).catch(() => {}));
    }
    // Save dirty shots
    for (const idx of dirtyShotIdxs) {
      const shot = shots[idx];
      if (!shot?.id) continue;
      promises.push(
        api.put(`/shots/${shot.id}`, {
          title: shot.title || null,
          description: shot.description || null,
          prompt: shot.prompt || null,
          subtitle: shot.subtitle || null,
          duration: shot.duration,
          shot_type: shot.shot_size || null,
          roll_type: shot.roll_type || null,
          voice_style: shot.voice_style || null,
          mood: shot.mood || null,
          camera_movement: shot.camera_movement || null,
          subjects: videoSubjects.map(vs => ({ label: vs.label, image_url: vs.image_url || '' })),
          reference_images: shot.reference_images || [],
        }).catch(() => {})
      );
    }
    await Promise.all(promises);
    setDirtyShotIdxs(new Set());
    setVideoDirty(false);
    setSavingShots(false);
  }

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      setTasks(prev => {
        Object.entries(prev).forEach(([i, t]) => {
          if (t.taskId && !TERMINAL.has(t.status)) pollTaskById(Number(i), t.taskId);
        });
        return prev;
      });
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    Object.values(pollRefs.current).forEach(clearInterval);
  }, []);

  useEffect(() => {
    if (!Object.values(tasks).some(t => t.taskId && !TERMINAL.has(t.status))) return;
    const id = setInterval(() => setTaskNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [tasks]);

  // Auto-update shot prompts when subject definitions change
  useEffect(() => {
    if (shots.length === 0 || !prevSubjectDefsRef.current) {
      prevSubjectDefsRef.current = subjectDefs;
      return;
    }
    const prev = prevSubjectDefsRef.current;
    if (prev === subjectDefs) return;

    // Parse old and new definitions to detect label renames
    const parseLabels = (text: string) => {
      const labels: { line: string; label: string }[] = [];
      for (const line of text.split('\n')) {
        const m = line.match(/定义为[<＜]?([^>＞\n]+)[>＞]?$/);
        if (m) labels.push({ line: line.trim(), label: m[1].trim() });
      }
      return labels;
    };
    const oldLabels = parseLabels(prev);
    const newLabels = parseLabels(subjectDefs);

    // Build rename map (same position = rename)
    const renameMap: Record<string, string> = {};
    for (let i = 0; i < Math.min(oldLabels.length, newLabels.length); i++) {
      if (oldLabels[i].label !== newLabels[i].label) {
        renameMap[oldLabels[i].label] = newLabels[i].label;
      }
    }

    if (Object.keys(renameMap).length > 0) {
      setShots(prev => prev.map(shot => {
        let prompt = shot.prompt;
        for (const [oldLabel, newLabel] of Object.entries(renameMap)) {
          prompt = prompt.replaceAll(oldLabel, newLabel);
        }
        return prompt !== shot.prompt ? { ...shot, prompt } : shot;
      }));
    }

    prevSubjectDefsRef.current = subjectDefs;
  }, [subjectDefs, shots.length]);

  const pollTaskById = useCallback(async (idx: number, taskId: string) => {
    try {
      const d = await api.get<{ status: string; videoUrl: string | null; localUrl?: string | null; duration?: number | null; error: string | null }>(`/video/task/${taskId}`);
      setTasks(prev => ({ ...prev, [idx]: { ...prev[idx], status: d.status, videoUrl: d.videoUrl, localUrl: d.localUrl || null, duration: d.duration || null, error: d.error } }));
      if (TERMINAL.has(d.status)) {
        clearInterval(pollRefs.current[idx]); delete pollRefs.current[idx];
        // Save terminal status to shot in DB
        setShots(prev => {
          const shot = prev[idx];
          if (shot?.id) {
            const updates: Record<string, any> = { task_status: d.status };
            if (d.videoUrl) updates.video_url = d.videoUrl;
            if (d.localUrl) updates.local_url = d.localUrl;
            if (d.duration) updates.video_duration = d.duration;
            if (d.error) updates.task_error = d.error;
            api.put(`/shots/${shot.id}`, updates).catch(() => {});
          }
          return prev;
        });
      }
    } catch (e) {
      // 查询失败不改状态（任务本身可能好好的），但要**显示出来** —— 以前只 console.error，
      // 后端一报错（例如重启后丢了 provider）页面就只剩一个转圈的「队列中」，
      // 看不出是查询挂了还是真在排队。下一次查成功会把这条错误清掉（d.error 为 null）
      console.error('[poll]', e);
      const msg = e instanceof Error ? e.message : '查询失败';
      setTasks(prev => prev[idx] ? { ...prev, [idx]: { ...prev[idx], error: `查询任务状态失败：${msg}` } } : prev);
    }
  }, []);

  async function addFiles(files: File[]) {
    const MAX_SIZE = 50 * 1024 * 1024;
    const rejected: string[] = [];
    const batchCount = { image: 0, video: 0, audio: 0 };
    for (const f of files) {
      const mediaType = f.type.startsWith('image/') ? 'image' as const
                      : f.type.startsWith('video/') ? 'video' as const
                      : f.type.startsWith('audio/') ? 'audio' as const
                      : null;
      if (!mediaType) continue;
      if (f.size > MAX_SIZE) { rejected.push(`${f.name}（超过 50MB）`); continue; }
      if (mediaType === 'video') {
        try {
          const { duration, width, height } = await getVideoInfo(f);
          if (duration > 15) { rejected.push(`${f.name}（时长 ${Math.round(duration)}s，超过 15s）`); continue; }
          if (width * height < 409600) { rejected.push(`${f.name}（分辨率不足）`); continue; }
        } catch { rejected.push(`${f.name}（无法读取视频信息）`); continue; }
      }
      const currentCount = mediaItems.filter(m => m.mediaType === mediaType).length + batchCount[mediaType];
      if (currentCount >= mediaLimit(mediaType)) continue;
      batchCount[mediaType]++;
      const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const item: MediaItem = { uid, mediaType, mimeType: f.type, name: f.name, uploading: true, uploadProgress: 0, ...(mediaType === 'image' ? { previewUrl: URL.createObjectURL(f) } : {}) };
      setMediaItems(prev => [...prev, item]);
      uploadWithProgress(f, (pct) => {
        setMediaItems(prev => prev.map(m => m.uid === uid ? { ...m, uploadProgress: pct } : m));
      }).then(url => {
        setMediaItems(prev => prev.map(m => m.uid === uid ? { ...m, url, uploading: false, uploadProgress: 100 } : m));
      }).catch(err => {
        const msg = err instanceof Error ? err.message : '未知错误';
        setUploadError(`${f.name} 上传失败：${msg}`);
        setMediaItems(prev => { const found = prev.find(m => m.uid === uid); if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl); return prev.filter(m => m.uid !== uid); });
      });
    }
    if (rejected.length) setUploadError(`以下文件已跳过：${rejected.join('、')}`);
  }

  function removeMediaItem(idx: number) {
    const removed = mediaItems[idx];
    setMediaItems(prev => { const item = prev[idx]; if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); return prev.filter((_, i) => i !== idx); });
    // 素材没了，绑它的角色也得松手 —— 留着的话 voiceBindings 会指向一个不存在的编号
    if (removed?.mediaType === 'audio' && removed.url) {
      setScriptAnalysis(prev => prev.some(a => a.linkedAudioUrl === removed.url)
        ? prev.map(a => a.linkedAudioUrl === removed.url ? { ...a, linkedAudioUrl: undefined } : a)
        : prev);
    }
  }

  // 角色卡上解绑音色。预设音色是「选音色」时替它入列的，没别的角色再用就一并撤出参考素材 ——
  // 留着会白占一个 @音频N 编号，还会被当成参考素材发给 Seedance。
  // 自己上传的音频不动：那是用户主动传的，可能另有用处（环境音之类）。
  function unbindVoice(idx: number) {
    const url = scriptAnalysis[idx]?.linkedAudioUrl;
    const next = scriptAnalysis.map((a, i) => i === idx ? { ...a, linkedAudioUrl: undefined } : a);
    setScriptAnalysis(next);
    setVideoDirty(true);   // 解绑的是自己传的音频时 mediaItems 不变，不标脏就没有「保存草稿」按钮
    releasePresetAudio(url, next);
  }

  function handleReset() {
    setScript(''); setStyle(STYLES[0].value); setRatio('9:16');
    setInitResult(null); setShots([]); setTasks({}); setMergedVideoUrl(null);
    setInitError(''); setMergeError('');
    setMediaItems([]); setUploadError('');
    setSubtitleInput(''); setSubjectDefs('');
    setAudioUrl(null);
    setAudioDuration(0);
    setSeed(null);
    setAvatarExpanded(false);
    setResetKey(k => k + 1);
    Object.values(pollRefs.current).forEach(clearInterval);
    pollRefs.current = {};
    batchSeedRef.current = null;
  }


  // 轮询「剧本分析」的流式任务：每 1s 拿一次累计文本直接怼进 dialogueScript ——
  // 复用的是显示/编辑对白剧本的同一个状态、同一个框，不用另开一个「预览」框。
  // 不做 storyboard 那套 localStorage 断线重连：这个操作短，用户就在当前页面等着，
  // 断了大不了重新点一次。
  function pollAnalyzeScriptJob(jobId: string) {
    if (scriptJobPollRef.current) clearInterval(scriptJobPollRef.current);
    let settled = false;
    return new Promise<void>(resolve => {
      const tick = async () => {
        if (settled) return;
        try {
          const d = await api.get<{
            status: string; stage?: string; script?: string;
            subjects?: Array<{ label: string; type: string; appearance: string; personality: string }>;
            error?: string;
          }>(`/voiceover/analyze-script-status/${jobId}`);
          if (settled) return;
          if (d.script !== undefined) setDialogueScript(d.script);
          if (d.status === 'processing') return;
          settled = true;
          if (scriptJobPollRef.current) { clearInterval(scriptJobPollRef.current); scriptJobPollRef.current = null; }
          if (d.status === 'done') {
            setScriptAnalysis((d.subjects || []).map(s => ({ ...s, linkedSubjectId: undefined })));
          } else {
            setScriptAnalysisError(d.error || (d.status === 'expired' ? '任务已过期' : '分析失败'));
          }
          resolve();
        } catch (e) {
          // 轮询本身失败（断网之类）不放弃——任务在后端照跑，下一次 tick 再试
          console.warn('analyze-script poll failed:', e);
        }
      };
      tick();
      scriptJobPollRef.current = setInterval(tick, 1000);
    });
  }

  async function handleAnalyzeScript() {
    const text = script.trim() || subtitleInput.trim();
    if (!text) return;
    setAnalyzingScript(true);
    setScriptAnalysisError('');
    setDialogueScript('');   // 清空重新流式填，不然旧剧本会先跟新的叠一下再跳变
    try {
      const oldLinkedIds = scriptAnalysis.filter(s => s.linkedSubjectId).map(s => s.linkedSubjectId!);
      if (oldLinkedIds.length > 0) {
        setVideoSubjects(prev => prev.filter(vs => !oldLinkedIds.includes(vs.id)));
      }
      // 后端现在先流式写一遍完整对白剧本、再从剧本里提取角色（比直接分析概念描述提取得准），
      // 顺带把「专业分镜生成」浮窗里已经填的创作目标/受众/基调/核心信息/总时长带过去，
      // 和「生成分镜脚本」第一步用的是同一套上下文
      const { jobId } = await api.post<{ jobId: string }>('/voiceover/analyze-script-async', {
        script: text,
        creative_goal:   sbSettings.creativeGoal,
        target_audience: sbSettings.audience,
        overall_tone:    sbSettings.tone,
        key_messages:    sbSettings.keyMessages,
        duration_total:  sbSettings.durationTotal,
      });
      await pollAnalyzeScriptJob(jobId);
    } catch (err) {
      setScriptAnalysisError(err instanceof Error ? err.message : '分析失败');
      // 剧本写完了，只是角色提取（后一步、更便宜的那次调用）挂了——剧本不该跟着白写一遍
      if (err instanceof ApiError && err.data && typeof (err.data as any).script === 'string') {
        setDialogueScript((err.data as any).script);
      }
    } finally { setAnalyzingScript(false); }
  }

  // 「重新分析角色」：拿页面上**已经有的那份对白剧本**重新提一遍角色，不重写剧本。
  // 「剧本分析」是「写剧本 + 提角色」两件事一起做（Claude + DeepSeek），剧本手改过之后
  // 再点它就会被整份覆盖掉；只想按现在这份剧本把角色重新提一遍时用这个，走 DeepSeek
  // 那一步，几秒钟，剧本一个字都不动。
  // 同名角色的头像/音色绑定原样保留 —— 重提一次就把绑好的脸和嗓子全丢了，比不提还糟。
  async function handleExtractCharacters() {
    const text = dialogueScript.trim();
    if (!text || extractingRoles) return;
    if (scriptAnalysis.length > 0 && !window.confirm('将按当前的对白剧本重新提取角色，现有角色卡会被替换（同名角色的头像和音色保留）。确定继续？')) return;
    setExtractingRoles(true);
    setScriptAnalysisError('');
    try {
      const d = await api.post<{ subjects?: AnalysisItem[] }>('/voiceover/extract-characters', { script: text });
      const keep = new Map(scriptAnalysis.map(a => [a.label, a]));
      const next = (d.subjects || []).map(sub => {
        const old = keep.get(sub.label);
        return { ...sub, linkedSubjectId: old?.linkedSubjectId, linkedAudioUrl: old?.linkedAudioUrl };
      });
      setScriptAnalysis(next);
      // 角色没了的（这次没提到），它绑的主体也要从 video_subjects 里撤下来，
      // 否则 @图片N 的编号里还占着一个位置
      setVideoSubjects(next.filter(a => a.linkedSubjectId)
        .map(a => projectSubjects.find(ps => ps.id === a.linkedSubjectId))
        .filter(Boolean) as ProjectSubject[]);
    } catch (err) {
      setScriptAnalysisError(err instanceof Error ? err.message : '角色提取失败');
    } finally { setExtractingRoles(false); }
  }

  // 轮询「AI改写」的流式任务，和 pollAnalyzeScriptJob 同一套路，只是结果写进
  // rewritePreview（浮窗里的预览框）而不是直接改 dialogueScript ——改写有可能跑偏，
  // 改完之前不能覆盖正文，用户看完预览才点「采用」。
  function pollRewriteScriptJob(jobId: string) {
    if (rewriteJobPollRef.current) clearInterval(rewriteJobPollRef.current);
    let settled = false;
    return new Promise<void>(resolve => {
      const tick = async () => {
        if (settled) return;
        try {
          const d = await api.get<{ status: string; script?: string; error?: string }>(`/voiceover/rewrite-script-status/${jobId}`);
          if (settled) return;
          if (d.script !== undefined) setRewritePreview(d.script);
          if (d.status === 'processing') return;
          settled = true;
          if (rewriteJobPollRef.current) { clearInterval(rewriteJobPollRef.current); rewriteJobPollRef.current = null; }
          if (d.status !== 'done') {
            setRewriteError(d.error || (d.status === 'expired' ? '任务已过期' : '改写失败'));
          }
          resolve();
        } catch (e) {
          // 轮询本身失败（断网之类）不放弃——任务在后端照跑，下一次 tick 再试
          console.warn('rewrite-script poll failed:', e);
        }
      };
      tick();
      rewriteJobPollRef.current = setInterval(tick, 1000);
    });
  }

  async function handleRewriteScript() {
    const instruction = rewriteInstruction.trim();
    if (!instruction || !dialogueScript.trim()) return;
    setRewritingScript(true);
    setRewriteError('');
    setRewritePreview('');
    try {
      const { jobId } = await api.post<{ jobId: string }>('/voiceover/rewrite-script-async', {
        script: dialogueScript,
        instruction,
      });
      await pollRewriteScriptJob(jobId);
    } catch (err) {
      setRewriteError(err instanceof Error ? err.message : '改写失败');
    } finally { setRewritingScript(false); }
  }

  function applyRewrittenScript() {
    setDialogueScript(rewritePreview);
    setRewriteOpen(false);
    setRewriteInstruction('');
    setRewritePreview('');
    setRewriteError('');
  }

  function closeRewriteModal() {
    if (rewritingScript) return;   // 改写中不许关——关了任务还在后台跑，预览却没地方接
    setRewriteOpen(false);
    setRewriteError('');
  }

  // 角色卡的字段改动统一走这里 —— setScriptAnalysis 之外还要 setVideoDirty，
  // 不然顶部那个「保存」按钮不出来，改完刷新就没了（scriptAnalysis 落在 videos.params 里）
  function patchAnalysis(idx: number, patch: Partial<AnalysisItem>) {
    setScriptAnalysis(prev => prev.map((a, i) => i === idx ? { ...a, ...patch } : a));
    setVideoDirty(true);
  }

  function linkAnalysisSubject(analysisIdx: number, subjectId: string, subjectsOverride?: ProjectSubject[]) {
    // Update scriptAnalysis link
    const newAnalysis = scriptAnalysis.map((s, i) => i === analysisIdx ? { ...s, linkedSubjectId: subjectId } : s);
    setScriptAnalysis(newAnalysis);
    // Rebuild videoSubjects in scriptAnalysis order (allow duplicates)
    const subjectsPool = subjectsOverride || projectSubjects;
    const orderedSubs = newAnalysis
      .filter(a => a.linkedSubjectId)
      .map(a => subjectsPool.find(ps => ps.id === a.linkedSubjectId))
      .filter(Boolean) as ProjectSubject[];
    setVideoSubjects(orderedSubs);
  }

  // 项目是**懒建**的（handleInit 生成分镜那一刻才 POST /projects），但换头像可能发生在那之前：
  // 新开页面 → 剧本分析 → 直接给角色换头像。所以这里要能自己把项目建出来 ——
  // 原来 `if (!projectId) return` 让这条最常见的路径点下去一点反应都没有（不报错、不关浮窗）。
  // 并发点两张头像只建一个项目：把在建的 promise 记在 ref 上，后来者等同一个。
  const projectCreateRef = useRef<Promise<string> | null>(null);
  async function ensureProject(): Promise<string> {
    if (projectId) return projectId;
    if (projectCreateRef.current) return projectCreateRef.current;
    const autoName = (script.trim() || subtitleInput.trim()).slice(0, 30) || '未命名视频';
    projectCreateRef.current = (async () => {
      const proj = await api.post<{ id: string }>('/projects', { name: autoName });
      setProjectId(proj.id);
      setProjectName(autoName);
      window.history.replaceState(null, '', `/voiceover-v3?projectId=${proj.id}${videoId ? `&videoId=${videoId}` : ''}`);
      return proj.id;
    })();
    try {
      return await projectCreateRef.current;
    } catch (err) {
      projectCreateRef.current = null;      // 失败了下次还能再试
      throw err;
    }
  }

  // 认证资源里的头像不是项目自带主体——选中时先落成一个 project_subjects 再走既有的绑定流程。
  // **同一个 Asset ID 在一个项目里只建一行**：这个函数原来每点一次「换头像」就 POST 一条新主体，
  // 换来换去项目角色列表就堆成十几个同名同图的重复项（还都占着 @图片N 的候选位）。
  async function assignAssetAvatar(analysisIdx: number, asset: RemoteAsset) {
    try {
      const pid = await ensureProject();
      const exist = projectSubjects.find(s => s.asset_id === asset.Id);
      if (exist) {
        linkAnalysisSubject(analysisIdx, exist.id, projectSubjects);
        return;
      }
      const thumb = asset.PreviewUrl || asset._thumbnail_url || asset.URL || '';
      const newSub = await api.post<ProjectSubject>(`/projects/${pid}/subjects`, {
        // 角色名优先用这张角色卡的名字（「陈雅」），实在没有才退回素材名 ——
        // 素材名往往是 `微信图片_2026….jpg` 这种文件名，拿它当角色名没有意义
        label: (scriptAnalysis[analysisIdx]?.label || '').trim() || displayLabel(asset.Name) || `${avatarPickerTab === 'real' ? '真人' : '虚拟'}头像`,
        image_url: thumb,
        asset_id: asset.Id,
      });
      setProjectSubjects(prev => [...prev, newSub]);
      linkAnalysisSubject(analysisIdx, newSub.id, [...projectSubjects, newSub]);
    } catch (err) {
      alert(`添加头像失败：${err instanceof Error ? err.message : '请重试'}`);
    } finally {
      setAvatarPickerIdx(null);
      setAvatarSearch('');
    }
  }

  async function handleAnalyzeSubjects() {
    const images = mediaItems.filter(m => m.mediaType === 'image' && !m.uploading && (m.previewUrl || m.url));
    if (images.length === 0) return;
    setAnalyzingSubjects(true); setSubjectError('');
    try {
      const media = images.map(m => ({ url: m.url, mediaType: m.mediaType, previewUrl: m.previewUrl || m.url }));
      const result = await api.post<{ definitions: string[]; summary: string; usageHint: string }>('/voiceover/analyze-subjects', { media });
      const text = result.definitions.join('\n');
      setSubjectDefs(text);
      prevSubjectDefsRef.current = text;
    } catch (err) {
      setSubjectError(err instanceof Error ? err.message : '主体分析失败');
    } finally { setAnalyzingSubjects(false); }
  }

  // 生成分镜是一次几十秒的付费长任务；重新生成还会先 DELETE 掉这条视频的全部分镜
  // 再插新的（见 finishStoryboard），已经生成好的分镜视频跟着一起没了 —— 都先问一句
  function handleInitClick() {
    if (initResult) {
      const done = shots.filter(s => s.video_url || s.local_url).length;
      const msg = '重新生成会用新的分镜脚本覆盖现在这 ' + shots.length + ' 个分镜'
        + (done > 0 ? '，其中 ' + done + ' 个已生成的分镜视频也会一并清掉' : '')
        + '，且无法撤销。确定继续？';
      if (!confirm(msg)) return;
    } else if (!confirm('开始生成分镜脚本？这一步要跑几十秒。')) {
      return;
    }
    handleInit();
  }

  async function handleInit() {
    if (!script.trim() && !subtitleInput.trim()) return;
    setInitError(''); setIniting(true); setInitElapsed(0);
    setInitResult(null); setShots([]); setTasks({}); setMergedVideoUrl(null); setAudioUrl(null);
    setDirtyShotIdxs(new Set());
    batchSeedRef.current = null;
    Object.values(pollRefs.current).forEach(clearInterval);
    pollRefs.current = {};

    try {
      // 没人工绑音色的角色，这里按性别年龄从预设库挑一条钉死 —— 同一个角色全片同一把嗓子，
      // 靠的是「一条固定的参考音频」，不是让模型每镜自己写英文音色描述。
      // 上限内挑不完就只配前几个（音频最多 MEDIA_CAPS.audio 条），其余退回音色描述。
      let nextAnalysis = scriptAnalysis;
      let nextMedia = mediaItems;
      if (voicePresets.length > 0 && scriptAnalysis.some(a => !a.linkedAudioUrl)) {
        const taken = new Set(scriptAnalysis.map(a => a.linkedAudioUrl).filter(Boolean) as string[]);
        let audioSlots = mediaLimit('audio') - nextMedia.filter(m => m.mediaType === 'audio').length;
        const added: MediaItem[] = [];
        nextAnalysis = scriptAnalysis.map((a, i) => {
          if (a.linkedAudioUrl || audioSlots <= 0) return a;
          const v = pickPresetVoice(a, voicePresets, taken, i);
          if (!v) return a;
          taken.add(v.url); audioSlots--;
          added.push({
            uid: `preset-${Date.now()}-${i}`,
            mediaType: 'audio',
            url: v.url,
            name: v.name,
            description: `预设音色：${v.name}`,
          });
          return { ...a, linkedAudioUrl: v.url };
        });
        if (added.length > 0) {
          nextMedia = [...mediaItems, ...added];
          setMediaItems(nextMedia);
          setScriptAnalysis(nextAnalysis);
        }
      }

      const readyMedia = nextMedia.filter(m => m.url && !m.uploading);
      const subjectImagesCount = videoSubjects.filter(s => s.image_url).length;
      const imageCount = readyMedia.filter(m => m.mediaType === 'image').length + subjectImagesCount;
      const videoCount = readyMedia.filter(m => m.mediaType === 'video').length;
      const audioCount = readyMedia.filter(m => m.mediaType === 'audio').length;
      // 与「专业分镜生成」共用同一份角色/素材编号（见 subjectContext）——
      // 用刚算好的那份，state 这会儿还没落地
      const ctx = buildSubjectContext(videoSubjects, nextMedia, nextAnalysis);
      const finalSubjectDefs = ctx.characterDefs;
      const imageDescriptions = ctx.imageDescriptions || undefined;
      const readyAudioList = readyMedia.filter(m => m.mediaType === 'audio');
      const finalVoiceBindings = nextAnalysis
        .map(a => {
          const n = a.linkedAudioUrl ? readyAudioList.findIndex(m => m.url === a.linkedAudioUrl) : -1;
          return n >= 0 ? `角色「${a.label}」使用@音频${n + 1}` : '';
        })
        .filter(Boolean)
        .join('\n');

      const jobId = await startStoryboardJob({
        concept: conceptText.trim(),
        creative_goal:       sbSettings.creativeGoal,
        target_audience:     sbSettings.audience,
        overall_tone:        sbSettings.tone,
        key_messages:        sbSettings.keyMessages,
        shot_count:          sbSettings.shotCount,
        duration_total:      sbSettings.durationTotal,
        narrative_structure: sbSettings.narrative,
        video_type:          'story',
        ratio,                              // 画幅决定装载竖屏还是横屏那套手艺
        style,                              // 视觉风格，不发过去模型会跟着参考图漂
        subject_definitions: finalSubjectDefs,
        image_descriptions:  imageDescriptions || '',
        voice_bindings:      finalVoiceBindings || undefined,   // 人工绑的 + 刚自动配的
        // 「剧本分析」已经写过对白剧本就直接带上——后端跳过第一步，不用重写一遍
        script:              dialogueScript.trim() || undefined,
      });
      await pollStoryboardJob(jobId);
    } catch (err) {
      setInitError(err instanceof Error ? err.message : '生成失败，请重试');
      setIniting(false);
    }
  }

  // ── 分镜生成任务 ──────────────────────────────────────────────────────
  // 一次分镜要 30-80 秒。同步请求的话，切走页面 / 手机锁屏 / Next 代理超时都会让它白跑。
  // 改成后端任务：提交拿 jobId，本地记一笔，轮询取结果 —— 回到页面能接着取。
  const SB_JOB_KEY = 'voiceover-v3:sb-job';
  const sbPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dialogueScriptBoxRef = useRef<HTMLTextAreaElement>(null);
  const scriptJobPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rewriteJobPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rewritePreviewBoxRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (rewritingScript && rewritePreviewBoxRef.current) {
      rewritePreviewBoxRef.current.scrollTop = rewritePreviewBoxRef.current.scrollHeight;
    }
  }, [rewritePreview, rewritingScript]);
  useEffect(() => {
    if (analyzingScript && dialogueScriptBoxRef.current) {
      dialogueScriptBoxRef.current.scrollTop = dialogueScriptBoxRef.current.scrollHeight;
    }
  }, [dialogueScript, analyzingScript]);

  async function startStoryboardJob(payload: Record<string, unknown>) {
    const { jobId } = await api.post<{ jobId: string }>('/prompt/storyboard-async', payload);
    try {
      localStorage.setItem(SB_JOB_KEY, JSON.stringify({ jobId, videoId: videoId || null, at: Date.now() }));
    } catch {}
    return jobId;
  }

  function clearStoryboardJob() {
    try { localStorage.removeItem(SB_JOB_KEY); } catch {}
    if (sbPollRef.current) { clearInterval(sbPollRef.current); sbPollRef.current = null; }
  }

  // 轮询到结束为止。resumed=true 表示是回到页面接着取的，文案不一样。
  //
  // 取结果的接口不删任务（刷新页面要能重新拿到），所以同一个 jobId 可能被连续两次 tick
  // 都问到 status:'done' —— setInterval 不等上一次 tick 的 await 完成就会按时再开一次，
  // 如果上一次的 /storyboard-status 响应慢（分镜生成现在两步走，接近结束时后端负载也高），
  // 下一次 tick 会在它还没跑完 finishStoryboard 时就已经发出请求、也拿到 done。两次都会走
  // finishStoryboard，各自删一遍旧分镜、建一遍新分镜——页面拿着第一批的 shot id 提交生成，
  // 一提交就 404（分镜早被第二批换掉了）。用 settled 挡住第二次，谁先问到非 processing 谁赢。
  function pollStoryboardJob(jobId: string, resumed = false) {
    setIniting(true);
    if (resumed) setInitError('');
    if (!resumed) { setSbStage(''); setSbScript(''); }
    if (sbPollRef.current) clearInterval(sbPollRef.current);
    let settled = false;
    return new Promise<void>(resolve => {
      const tick = async () => {
        if (settled) return;
        try {
          const d = await api.get<{ status: string; result?: Storyboard; error?: string; elapsed?: number; stage?: string; script?: string }>(
            `/prompt/storyboard-status/${jobId}`);
          if (settled) return;   // 另一次没赶上的 tick 已经处理过这个任务了
          if (d.status === 'processing') {
            setInitElapsed(d.elapsed ?? 0);
            if (d.stage === 'script' || d.stage === 'shots') setSbStage(d.stage);
            if (d.script !== undefined) setSbScript(d.script);
            return;
          }
          settled = true;
          if (sbPollRef.current) { clearInterval(sbPollRef.current); sbPollRef.current = null; }
          clearStoryboardJob();
          if (d.status === 'done' && d.result) {
            if (d.result.script) setSbScript(d.result.script);
            try { await finishStoryboard(d.result); }
            catch (e) { setInitError(e instanceof Error ? e.message : '分镜处理失败'); }
          } else {
            setInitError(d.error || (d.status === 'expired' ? '任务已过期' : '分镜生成失败'));
          }
          setIniting(false); resolve();
        } catch (e) {
          // 轮询本身失败（断网之类）不终止任务 —— 任务在后端照跑，下一次 tick 再试
          console.warn('storyboard poll failed:', e);
        }
      };
      tick();
      sbPollRef.current = setInterval(tick, 3000);
    });
  }

  // 回到页面：本地还记着一个任务就接着轮询（videoId 要对得上，别把 A 视频的结果写进 B）
  useEffect(() => {
    if (!dataLoaded) return;
    let raw: string | null = null;
    try { raw = localStorage.getItem(SB_JOB_KEY); } catch {}
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as { jobId: string; videoId: string | null };
      if ((saved.videoId || null) !== (videoId || null)) return;
      if (saved.jobId) pollStoryboardJob(saved.jobId, true);
    } catch { clearStoryboardJob(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataLoaded]);

  useEffect(() => () => { if (sbPollRef.current) clearInterval(sbPollRef.current); }, []);
  useEffect(() => () => { if (scriptJobPollRef.current) clearInterval(scriptJobPollRef.current); }, []);
  useEffect(() => () => { if (rewriteJobPollRef.current) clearInterval(rewriteJobPollRef.current); }, []);

  // 拿到分镜结果之后的全部后处理：转成 shots、落库。
  // 抽出来是因为异步任务的结果可能是**回到页面时**才取到的，那时 handleInit 早就退出了。
  async function finishStoryboard(sbResult: Storyboard) {
    const drafts = toShotDrafts(sbResult, 'story');
    if (drafts.length === 0) throw new Error('模型没有返回任何分镜');
    // 没提前做「剧本分析」时，后端这一步自己写了剧本——同步回来，和分析按钮写的一视同仁，
    // 都要能在页面看到、都要存进 params
    const finalDialogueScript = sbResult.script?.trim() || dialogueScript;
    if (sbResult.script?.trim()) setDialogueScript(sbResult.script);

    const result: InitResult = {
      autoShotCount: drafts.length,
      shotCount:     drafts.length,
      shots: drafts.map((d, i) => {
        // @图片N 是 1-based，对应 subjectContext 里带图角色的顺序；
        // 超出角色数量的编号指向参考素材，不是角色，跳过。
        const labels = d.imageRefs
          .map(n => subjectContext.subjectsWithImage[n - 1])
          .filter(Boolean)
          .map(sub => scriptAnalysis.find(a => a.linkedSubjectId === sub.id)?.label || sub.label);
        return {
          shot_number: i + 1,
          title:       d.title || `分镜 ${i + 1}`,
          subtitle:    d.subtitle,
          description: d.description,
          prompt:      d.prompt,
          duration:    d.duration,
          ratio,
          shot_size:       normalizeShotSize(d.shot_type),
          camera_movement: normalizeCameraMove(d.camera_movement),
          mood:            d.lighting,
          roll_type:       d.rollType,
          voice_style:     d.voiceStyle || undefined,
          subjects:        labels,
          shot_subjects:   labels.map((label, k) => ({ label, color: ['#3b82f6','#ef4444','#10b981','#f59e0b'][k % 4] })),
        };
      }),
      totalVideoDuration: drafts.reduce((a, d) => a + d.duration, 0),
    };
    setInitResult(result);
    setShots(result.shots);
    if (!subtitleInput.trim() && result.shots.length > 0) {
      setSubtitleInput(result.shots.map(s => s.subtitle).join(''));
    }
    batchSeedRef.current = seed ?? Math.floor(Math.random() * 2147483647);

    // 叙事短片的人声是 Seedance 按 prompt 里的对白生成的，分镜时长照模型给的走，不需要 TTS。
    const ttsAudioUrl: string | null = null;

    // ─── Save to project/video/shots DB ─────────────────────────────
    let vid = videoId;
    const autoName = (script.trim() || subtitleInput.trim()).slice(0, 30) || '未命名视频';

    // Create project if needed
    if (!projectId) {
      const proj = await api.post<{ id: string }>('/projects', { name: autoName });
      setProjectId(proj.id);
      // Create video
      const video = await api.post<{ id: string }>(`/projects/${proj.id}/videos`, { name: autoName, script: script.trim(), subtitle_input: subtitleInput.trim(), style, ratio, voice, seed: batchSeedRef.current, params: buildVideoParams({ seed: batchSeedRef.current, dialogueScript: finalDialogueScript }) });
      vid = video.id;
      setVideoId(vid);
      setVideoName(autoName);
      window.history.replaceState(null, '', `/voiceover-v3?projectId=${proj.id}&videoId=${vid}`);
    } else if (!vid) {
      // Create video in existing project
      const video = await api.post<{ id: string }>(`/projects/${projectId}/videos`, { name: autoName, script: script.trim(), subtitle_input: subtitleInput.trim(), style, ratio, voice, seed: batchSeedRef.current, params: buildVideoParams({ seed: batchSeedRef.current, dialogueScript: finalDialogueScript }) });
      vid = video.id;
      setVideoId(vid);
      setVideoName(autoName);
      window.history.replaceState(null, '', `/voiceover-v3?projectId=${projectId}&videoId=${vid}`);
    } else {
      // Update existing video
      await api.put(`/videos/${vid}`, { script: script.trim(), subtitle_input: subtitleInput.trim(), style, ratio, voice, seed: batchSeedRef.current, audio_url: ttsAudioUrl, params: buildVideoParams({ seed: batchSeedRef.current, dialogueScript: finalDialogueScript }) });
    }

    // Save shots to DB — delete existing first, then insert new
    if (vid) {
      await api.del(`/videos/${vid}/shots`).catch(() => {});
      const allSubjects = videoSubjects.map(vs => ({ label: vs.label, image_url: vs.image_url || '' }));
      const createdShots = await api.post<any[]>(`/videos/${vid}/shots`, { shots: result.shots.map(s => ({ title: s.title, description: s.description, prompt: s.prompt, subtitle: s.subtitle, duration: s.duration, ratio: s.ratio || ratio, mood: s.mood, camera_movement: s.camera_movement, shot_type: s.shot_size, roll_type: s.roll_type, voice_style: s.voice_style, subjects: allSubjects })) });
      if (createdShots) {
        const withIds = result.shots.map((s, i) => ({ ...s, id: createdShots[i]?.id }));
        setShots(withIds);
      }
      // Save audio_url to video
      if (ttsAudioUrl) {
        await api.put(`/videos/${vid}`, { audio_url: ttsAudioUrl }).catch(() => {});
      }
    }
  }

  // 「查看提交 JSON」的默认内容——和 submitShot 里拼 content 的逻辑保持一致，
  // 没被手改过时框里显示的就是这个；改过之后 shotJsonEdits[idx] 接管，提交也发它
  function buildShotSubmitJson(idx: number) {
    const shot = shots[idx];
    if (!shot) return null;
    // Seedance 的 content 里最多容许一个 type:"text" 块（多了国内站会提交即失败）——
    // prompt 和图片说明必须合并进同一块，和 createVideoTask() 的真实拼法保持一致
    // 素材排布和编号都取自公共的 contentMedia（提交时发的是同一份）
    const cm = subjectContext.contentMedia;
    const dLines: string[] = [];
    cm.filter(x => x.mediaType === 'image').forEach(x => {
      const no = mediaNoOf(cm, x);
      if (x.from === 'subject') {
        const sub = videoSubjects.find(s => s.id === x.subjectId);
        const a = scriptAnalysis.find(y => y.linkedSubjectId === x.subjectId);
        const d = a ? `${a.appearance}；${a.personality}` : (sub?.description || '');
        dLines.push(`图片${no}：角色「${a?.label || sub?.label || ''}」— ${d || '见图片'}`);
      } else {
        dLines.push(`图片${no}：参考素材「${x.name || '素材'}」— ${x.description || ''}`);
      }
    });
    const textParts = [shot.prompt, dLines.length > 0 ? dLines.join('\n') : ''].filter(Boolean);
    const content: any[] = [{ type: 'text', text: textParts.join('\n\n') }];
    cm.forEach(x => content.push(
      x.mediaType === 'image' ? { type: 'image_url', image_url: { url: x.url }, role: 'reference_image' }
      : x.mediaType === 'video' ? { type: 'video_url', video_url: { url: x.url }, role: 'reference_video' }
      : { type: 'audio_url', audio_url: { url: x.url }, role: 'reference_audio' }));
    return {
      model,
      content,
      resolution, ratio,
      duration: shot.duration || 8,
      seed: batchSeedRef.current,
      generate_audio: generateAudio,
      watermark,
      return_last_frame: returnLastFrame || undefined,
      draft: draft || undefined,
      service_tier: serviceTier !== 'default' ? serviceTier : undefined,
      priority: priority > 0 ? priority : undefined,
      tools: webSearch ? [{ type: 'web_search' }] : undefined,
    };
  }

  // 重新提交同一镜时必须先把上一轮的轮询停掉 —— 否则旧 interval 还在查旧任务，
  // 回来的状态会盖掉刚提交的新任务（旧任务不会被取消，只是不再等它）
  async function submitShot(idx: number) {
    const shot = shots[idx];
    if (!shot) return;
    if (pollRefs.current[idx]) { clearInterval(pollRefs.current[idx]); delete pollRefs.current[idx]; }
    setTasks(prev => ({ ...prev, [idx]: { shotIndex: idx, taskId: null, status: 'pending', videoUrl: null, localUrl: null, duration: null, error: null, submitting: true, startedAt: Date.now() } }));
    try {
      // All shots share the same seed for visual consistency
      if (batchSeedRef.current === null) {
        batchSeedRef.current = seed ?? Math.floor(Math.random() * 2147483647);
      }
      const sharedSeed = batchSeedRef.current;

      const editedJson = shotJsonEdits[idx];
      let res: { taskId: string; status: string; prompt?: string };
      if (editedJson !== undefined) {
        // 「查看提交 JSON」被手改过——原样发这份，不再从 prompt/orderedMedia 重新拼，
        // 也就不会再走后端的锚定锁/字幕对台词（用户看到的框就是最终会发的）
        let parsed: any;
        try { parsed = JSON.parse(editedJson); } catch { throw new Error('提交 JSON 格式错误，请检查后再试'); }
        res = await api.post<{ taskId: string; status: string; prompt?: string }>('/video/generate', {
          content: parsed.content,
          tools: parsed.tools,
          model: parsed.model ?? model,
          resolution: parsed.resolution ?? resolution,
          ratio: parsed.ratio ?? ratio,
          duration: parsed.duration ?? (shot.duration || 8),
          seed: parsed.seed ?? sharedSeed,
          generateAudio: parsed.generate_audio ?? generateAudio,
          watermark: parsed.watermark ?? watermark,
          webSearch: Array.isArray(parsed.tools) && parsed.tools.length > 0,
          returnLastFrame: parsed.return_last_frame ?? returnLastFrame,
          draft: parsed.draft ?? draft,
          serviceTier: parsed.service_tier ?? (serviceTier !== 'default' ? serviceTier : undefined),
          priority: parsed.priority ?? (priority > 0 ? priority : undefined),
          region: region !== 'overseas' ? region : undefined,
        });
      } else {
      // content 里的素材排布 —— 角色头像在前（asset:// 或图片 URL），然后是参考素材，
      // 编号（@图片N/@视频N/@音频N）就是这个数组里同类型的序号，见 buildContentMedia()
      const cm = subjectContext.contentMedia;
      const orderedMedia: Array<{ url: string; mediaType: 'image' | 'video' | 'audio' }> =
        cm.map(x => ({ url: x.url, mediaType: x.mediaType }));
      // Append per-shot reference images
      if (shot.reference_images?.length) {
        for (const img of shot.reference_images) {
          orderedMedia.push({ url: img.url, mediaType: 'image' as const });
        }
      }
      // 素材说明的编号同样从 cm 里查，和上面这份 orderedMedia 是同一个排布
      const imageDescriptions = subjectContext.imageDescriptions || undefined;

      res = await api.post<{ taskId: string; status: string; prompt?: string }>('/video/generate', {
        prompt: shot.prompt, orderedMedia, imageDescriptions,
        // 角色原文：后端提交前把这一镜的定义句统一换成它（原文锁上线前生成的分镜、
        // 手动改过的 prompt 都只经过这条路，不在这里锁就还是一镜一个样）
        subject_definitions: subjectContext.characterDefs || undefined,
        // 字幕是准的那一份：后端据它把 prompt 末尾的台词块对齐（改过字幕的分镜才会动）
        subtitle: shot.subtitle || undefined,
        roll_type: shot.roll_type || undefined,
        model, resolution, ratio, duration: shot.duration || 8,
        generateAudio, watermark, webSearch,
        seed: sharedSeed,
        returnLastFrame, draft,
        serviceTier: serviceTier !== 'default' ? serviceTier : undefined,
        priority: priority > 0 ? priority : undefined,
        region: region !== 'overseas' ? region : undefined,
      });
      }
      const { taskId, status } = res;
      setTasks(prev => ({ ...prev, [idx]: { shotIndex: idx, taskId, status, videoUrl: null, localUrl: null, duration: null, error: null, submitting: false, startedAt: prev[idx]?.startedAt || Date.now() } }));
      // 定义句被原文锁改写过就回写这一镜 —— 否则页面上显示的还是旧文本，
      // 看起来像没生效，重开也还是旧的
      const locked = res.prompt && res.prompt !== shot.prompt ? res.prompt : null;
      if (locked) setShots(prev => prev.map((sh, i) => i === idx ? { ...sh, prompt: locked } : sh));
      // Persist task_id to shot in DB
      if (shot.id) {
        api.put(`/shots/${shot.id}`, { task_id: taskId, task_status: status, ...(locked ? { prompt: locked } : {}) }).catch(() => {});
      }
      const interval = setInterval(() => pollTaskById(idx, taskId), 10_000);
      pollRefs.current[idx] = interval;
      setTimeout(() => pollTaskById(idx, taskId), 5_000);
    } catch (err) {
      setTasks(prev => ({ ...prev, [idx]: { ...prev[idx], status: 'failed', error: err instanceof Error ? err.message : '提交失败', submitting: false } }));
    }
  }

  // 重新生成要确认：又是一次花钱的提交，而且 Seedance 没有取消接口，发出去就收不回来
  function submitShotConfirmed(idx: number, mode: 'redo' | 'stuck') {
    const n = shots[idx]?.shot_number ?? idx + 1;
    const msg = mode === 'stuck'
      ? `分镜${n} 还在排队/生成中。重新生成会另开一个任务，旧任务不会被取消，只是不再等它。确定继续？`
      : `分镜${n} 已经有生成好的视频，重新生成会用新的覆盖它。确定继续？`;
    if (!window.confirm(msg)) return;
    submitShot(idx);
  }

  async function submitAllShots() {
    // 要提交哪几镜先算出来：已经成功的、正在排队/生成的都跳过
    const pending = shots
      .map((_, i) => i)
      .filter(i => {
        const t = tasks[i];
        return !(t?.status === 'succeeded' || t?.status === 'running' || t?.status === 'queued');
      });
    if (pending.length === 0) return;
    // 一次批量提交是花钱的操作，点错了没法撤（Seedance 没有取消接口），所以先确认
    const list = pending.map(i => shots[i].shot_number ?? i + 1).join('、');
    if (!window.confirm(`将提交 ${pending.length} 个分镜生成视频（分镜 ${list}），已生成和排队中的会跳过。确定继续？`)) return;
    for (const i of pending) {
      await submitShot(i); await new Promise(r => setTimeout(r, 800));
    }
  }

  function pollMergeStatus(mid: string) {
    if (mergePollingRef.current) clearInterval(mergePollingRef.current);
    setMerging(true);
    const check = async () => {
      try {
        const res = await api.get<{ status: string; url?: string; error?: string }>(`/voiceover/merge-status/${mid}`);
        if (res.status === 'done' && res.url) {
          setMergedVideoUrl(res.url);
          setMerging(false); setMergeId(null);
          if (mergePollingRef.current) { clearInterval(mergePollingRef.current); mergePollingRef.current = null; }
          if (videoId) api.put(`/videos/${videoId}`, { merged_video_url: res.url }).catch(() => {});
        } else if (res.status === 'failed') {
          setMergeError(res.error || '合并失败');
          setMerging(false); setMergeId(null);
          if (mergePollingRef.current) { clearInterval(mergePollingRef.current); mergePollingRef.current = null; }
        }
      } catch (err) {
        setMergeError(err instanceof Error ? err.message : '合并失败');
        setMerging(false); setMergeId(null);
        if (mergePollingRef.current) { clearInterval(mergePollingRef.current); mergePollingRef.current = null; }
      }
    };
    check();
    mergePollingRef.current = setInterval(check, 3000);
  }

  async function handleMerge() {
    const succeededShots = shots.map((shot, i) => ({ shot, task: tasks[i] })).filter(({ task }) => task?.status === 'succeeded' && (task.localUrl || task.videoUrl));
    if (succeededShots.length < 1) return;
    // targetDuration 是按语音排好的秒数，duration 是实际生成出来的 —— 后端按前者把画面贴齐
    const videoList = succeededShots.map(({ shot, task }) => ({ url: (task!.localUrl || task!.videoUrl) as string, subtitle: shot.subtitle || '', duration: task!.duration || shot.duration || 5, targetDuration: shot.duration || undefined }));
    // 烧进画面的字幕必须和念出来的字一模一样。TTS 现在是**逐镜按 shot.subtitle 合成**的
    // （分支条件见 /voiceover/tts），所以字幕也以各镜台词为准 —— 输入框里的原文可能已经
    // 被模型改写成 narration_script，拿它排字幕会和人声对不上。
    const anyShotSub = shots.some(s => (s.subtitle || '').trim());
    const fullSubtitle = anyShotSub ? shots.map(s => s.subtitle || '').join('') : subtitleInput.trim();
    setMerging(true); setMergeError(''); setMergedVideoUrl(null);
    try {
      // 不传 audioUrl —— 后端保留各分镜视频自带的对白音轨，只烧字幕。
      const res = await api.post<{ mergeId: string }>('/voiceover/merge-async', { videos: videoList, audioUrl: undefined, voice, subtitle: fullSubtitle, subtitleStyle, banner, bannerStyle, wordBoundaries });
      setMergeId(res.mergeId);
      pollMergeStatus(res.mergeId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '合并失败';
      setMergeError(msg.length > 120 ? msg.slice(0, 120) + '…' : msg);
      setMerging(false);
    }
  }

  async function handleImageMerge() {
    if (shots.length === 0 || !audioUrl) { setMergeError('请先生成语音（TTS）'); return; }
    const shotList = shots.map(s => ({ imageUrl: s.imageUrl || undefined, subtitle: s.subtitle || '', duration: s.duration || 5 }));
    setMerging(true); setMergeError(''); setMergedVideoUrl(null);
    try {
      const res = await api.post<{ url: string }>('/voiceover/merge-images', { shots: shotList, audioUrl, voice, ratio, subtitleStyle, banner, bannerStyle, wordBoundaries });
      setMergedVideoUrl(res.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '合并失败';
      setMergeError(msg.length > 120 ? msg.slice(0, 120) + '…' : msg);
    } finally { setMerging(false); }
  }

  const anyUploading    = mediaItems.some(m => m.uploading);
  const mediaDescMissing = mediaItems.some(m => !m.uploading && m.url && !m.description?.trim());
  // 还没做过「剧本分析」时，下面三个页签（对白剧本/角色/参考素材）和「生成分镜脚本」
  // 全都藏起来 —— 那会儿它们只有空状态，页面上只留「视频描述 → 剧本分析」一条路
  const scriptReady = Boolean(analyzingScript || dialogueScript.trim() || scriptAnalysis.length > 0);
  // 「剧本分析」按钮抽出来复用：视频描述展开时它和输入框同一行（手机上等高并排），
  // 折叠时退回自己单独一行
  const analyzeBtn = (
    <button type="button" onClick={handleAnalyzeScript}
      disabled={analyzingScript || (!script.trim() && !subtitleInput.trim())}
      className={styles.conceptAnalyzeBtn}>
      {/* 手机上折成「剧本 / 分析」两行（桌面 br 是 display:none，仍是一行） */}
      {analyzingScript ? '分析中…' : <>剧本<br className={styles.brMobile} />分析</>}
    </button>
  );
  const succeededCount  = Object.values(tasks).filter(t => t.status === 'succeeded').length;
  const allDone         = shots.length > 0 && shots.every((_, i) => { const t = tasks[i]; return t && TERMINAL.has(t.status); });
  const canMerge        = succeededCount >= 1;
  const estText         = subtitleInput.trim() || script;
  const estDuration     = estimateScriptDuration(estText);
  const estShotCount    = recommendShotCount(estDuration);

  const paramsProps = {
    model, onModelChange: (v: string | number) => setModel(v as string),
    resolution, onResolutionChange: (v: string | number) => setResolution(v as string),
    ratio, onRatioChange: (v: string) => setRatio(v),
    style, onStyleChange: (v: string) => setStyle(v),
    generateAudio, onToggleAudio: () => setGenerateAudio(v => !v),
    watermark, onToggleWatermark: () => setWatermark(v => !v),
    seed, onSeedChange: (v: number | null) => setSeed(v),
    serviceTier, onServiceTierChange: (v: string) => setServiceTier(v),
    priority, onPriorityChange: (v: number) => setPriority(v),
    returnLastFrame, onToggleReturnLastFrame: () => setReturnLastFrame(v => !v),
    draft, onToggleDraft: () => setDraft(v => !v),
    webSearch, onToggleWebSearch: () => setWebSearch(v => !v),
    region, onRegionChange: (v: 'overseas' | 'cn') => setRegion(v),
    showJsonPreview, onToggleJsonPreview: () => setShowJsonPreview(v => !v),
    subtitleMode, onSubtitleModeChange: (v: 'on' | 'off') => setSubtitleMode(v),
    voice, onVoiceChange: (v: string) => setVoice(v),
    banner, onBannerChange: (v: string) => setBanner(v),
    bannerStyle, onBannerStyleChange: (v: BannerStyle) => setBannerStyle(v),
    subtitleStyle, onSubtitleStyleChange: (v: SubtitleStyle) => setSubtitleStyle(v),
    duration: shots[0]?.duration || 8,
    mediaItems,
    videoSubjects,
    scriptAnalysis,
  };

  return (
    <div className={styles.page} onClick={() => { setShowProjectPicker(false); setShowVideoPicker(false); }}>
      <div className={styles.body}>
        <div className={styles.breadcrumbBar}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, fontSize: 13 }} onClick={e => e.stopPropagation()}>
            {projectId && (
              <>
                <div style={{ position: 'relative' }}>
                  <button type="button" onClick={() => {
                    if (projectId) window.location.href = `/projects/${projectId}`;
                  }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 4, color: '#000', fontWeight: 500, fontSize: 13, whiteSpace: 'nowrap' }}>
                    {projectName || '项目'}
                  </button>
                </div>
                <span style={{ color: '#94a3b8', flexShrink: 0 }}>&gt;</span>
              </>
            )}
            <div style={{ position: 'relative' }}>
              <button type="button" onClick={() => {
                setShowProjectPicker(false);
                if (!showVideoPicker && projectId) { api.get<any[]>(`/projects/${projectId}/videos`).then(list => setVideoList(list || [])).catch(() => {}); }
                setShowVideoPicker(v => !v);
              }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 4, fontWeight: 600, color: '#1e293b', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}>
                {videoName || '新视频'} ▾
              </button>
              {showVideoPicker && (
                <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,.1)', minWidth: 180, maxHeight: 240, overflow: 'auto', zIndex: 100 }}>
                  {videoList.map(v => (
                    <div key={v.id} onClick={() => {
                      setShowVideoPicker(false);
                      window.location.href = `/voiceover-v3?projectId=${projectId}&videoId=${v.id}`;
                    }} style={{ padding: '8px 12px', fontSize: 13, cursor: 'pointer', background: v.id === videoId ? '#eff6ff' : '#fff', borderBottom: '1px solid #f3f4f6' }}>
                      {v.name}
                    </div>
                  ))}
                  {videoList.length === 0 && <div style={{ padding: '8px 12px', fontSize: 12, color: '#9ca3af' }}>暂无视频</div>}
                </div>
              )}
            </div>
          </div>
          {(videoDirty || dirtyShotIdxs.size > 0) && (
            <button type="button" onClick={saveAll} disabled={savingShots}
              style={{ flexShrink: 0, fontSize: 12, padding: '4px 12px', border: 'none', borderRadius: 6, background: '#2563eb', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
              {savingShots ? '保存中…' : '保存草稿'}
            </button>
          )}
          <button type="button" onClick={() => setShowMobileParams(v => !v)}
            className={styles.paramsBtnBlue}>
            {showMobileParams ? '收起参数' : '参数设置'}
          </button>
        </div>
        {showMobileParams && (
          <div style={{ padding: '12px 12px 16px', borderBottom: '1px solid #e5e7eb' }}>
            <ParamsPanel {...paramsProps} />
          </div>
        )}

        <div className={styles.wrap}>
          <div className={styles.layout}>
            <div className={styles.content}>

              {/* ── Step 1 ── */}
              <div style={{ marginBottom: 16 }}>
                <p className={styles.cardTitle} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: scriptCollapsed ? 0 : 10 }}>
                  <span onClick={() => setScriptCollapsed(v => !v)} style={{ fontSize: 10, cursor: 'pointer', transition: 'transform 0.2s', transform: scriptCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                  {/* 和「N个分镜 · 视频N秒」同一个红色粗框，两个大段落一眼分得开 */}
                  <span onClick={() => setScriptCollapsed(v => !v)}
                    style={{ fontSize: 18, fontWeight: 700, color: '#111827', border: '3px solid #dc2626', borderRadius: 8, padding: '4px 12px', display: 'inline-block', cursor: 'pointer', background: '#fef2f2' }}>剧本编写</span>
                  <button type="button" onClick={() => setShowExamples(v => !v)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 2, background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', color: '#0d9488', fontSize: 13, fontWeight: 500 }}>
                    示例
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 12, height: 12, color: '#9ca3af', transform: showExamples ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>
                      <path d="m6 9 6 6 6-6"/>
                    </svg>
                  </button>
                  <button type="button" onClick={() => setShowAiInput(v => !v)}
                    style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #6b7280', borderRadius: 5, background: '#fff', cursor: 'pointer', color: '#374151' }}>
                    AI辅助填写
                  </button>
                  <button type="button" onClick={() => setSbOpen(v => !v)}
                    style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #2563eb', borderRadius: 5, background: sbOpen ? '#eff6ff' : '#fff', cursor: 'pointer', color: '#2563eb', fontWeight: 500, whiteSpace: 'nowrap' }}>
                    🎬 分镜设置
                  </button>
                  <span style={{ flex: 1 }} />
                </p>

                  {!scriptCollapsed && (<>
                  {showAiInput && (
                    <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center' }}>
                      <input type="text" value={aiTopic} onChange={e => setAiTopic(e.target.value)}
                        placeholder="输入想要生成视频的简要说明、关键词"
                        style={{ flex: 1, fontSize: 12, padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, outline: 'none' }} />
                      <button type="button" disabled={aiScriptLoading} onClick={async () => {
                        setAiScriptLoading(true);
                        try {
                          const res = await api.post<{ script: string }>('/voiceover/generate-script', { topic: aiTopic.trim() });
                          if (res.script) { setScript(res.script); setInitResult(null); setShots([]); setMergedVideoUrl(null); setShowAiInput(false); }
                        } catch (e: any) { console.warn('AI生成失败:', e); }
                        finally { setAiScriptLoading(false); }
                      }}
                        style={{ fontSize: 12, padding: '5px 12px', border: '1px solid #2563eb', borderRadius: 6, background: '#eff6ff', cursor: aiScriptLoading ? 'not-allowed' : 'pointer', color: '#2563eb', whiteSpace: 'nowrap' }}>
                        {aiScriptLoading ? '生成中…' : '生成'}
                      </button>
                    </div>
                  )}
                  {showExamples && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                      {EXAMPLE_SCRIPTS.map((ex, i) => (
                        <button key={i} type="button"
                          onClick={() => { setScript(ex.text); setInitResult(null); setShots([]); setMergedVideoUrl(null); setShowExamples(false); }}
                          className={`${styles.chip} ${styles.chipPill} ${script === ex.text ? styles.chipPillActive : ''}`}>
                          {ex.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* 唯一的 textarea：视频描述。手机上「剧本分析」和它并排、等高 */}
                  <div className={styles.conceptRow}>
                    <div className={styles.conceptBox} style={{ position: 'relative' }}>
                      {conceptText.trim() && (
                        <button type="button" onClick={() => setConceptText('')}
                          style={{ position: 'absolute', top: 6, right: 8, zIndex: 1, background: 'none', border: 'none', fontSize: 12, color: '#9ca3af', cursor: 'pointer' }}>
                          清空
                        </button>
                      )}
                      <textarea rows={4} value={conceptText}
                        onChange={e => setConceptText(e.target.value)}
                        placeholder="输入剧本…"
                        className={styles.textarea} style={{ fontFamily: 'inherit', fontSize: 16, lineHeight: 1.8, border: '2px solid #000', height: '100%' }} />
                    </div>
                    {analyzeBtn}
                  </div>

                  {/* 弹窗经 portal 挂到 body，这里只是受控挂载点；概念取自唯一那个 textarea。 */}
                  <StoryboardGenerator
                    videoType="story"
                    open={sbOpen}
                    onOpenChange={setSbOpen}
                    hideTrigger
                    onSettingsChange={setSbSettings}
                  />

                  {scriptAnalysisError && <div style={{ fontSize: 12, color: '#dc2626', margin: '6px 0' }}>{scriptAnalysisError}</div>}

                  {/* 对白剧本 / 角色 / 参考素材 三块合成页签 */}
                  {scriptReady && (() => {
                    const mediaCount = mediaItems.filter(m => !m.uploading && m.url).length;
                    const tabs = [
                      ['script', '对白剧本'],
                      ['roles',  `角色${scriptAnalysis.length ? ` ${scriptAnalysis.length}` : ''}`],
                      ['media',  `参考素材${mediaCount ? ` ${mediaCount}` : ''}`],
                    ] as const;
                    return (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0 10px' }}>
                        <div className={styles.stepTabs} style={{ margin: 0 }}>
                          {tabs.map(([k, label]) => (
                            <button key={k} type="button" onClick={() => { setStepTab(k); setTabsCollapsed(false); }}
                              className={`${styles.stepTab} ${stepTab === k ? styles.stepTabOn : ''}`}>
                              {label}
                              {k === 'script' && analyzingScript && <span className={styles.shotTabOk}>写作中</span>}
                            </button>
                          ))}
                        </div>
                        {/* 折叠标记：紧挨着页签，三角 + 两个字，不做成带框按钮 */}
                        <span role="button" title={tabsCollapsed ? '展开' : '折叠'}
                          onClick={() => setTabsCollapsed(v => !v)}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11.5, color: '#94a3b8', cursor: 'pointer', padding: '0 2px', userSelect: 'none', whiteSpace: 'nowrap' }}>
                          <span style={{ fontSize: 9, display: 'inline-block', transition: 'transform .2s', transform: tabsCollapsed ? 'rotate(-90deg)' : 'none' }}>▼</span>
                          {tabsCollapsed ? '展开' : '折叠'}
                        </span>
                        {/* AI改写和页签同一行、靠右；只在「对白剧本」页签下出现 */}
                        <span style={{ flex: 1 }} />
                        {/* 「说明」跟着「参考素材」页签走，和页签同一行、靠右 */}
                        {stepTab === 'media' && (
                          <span style={{ position: 'relative', display: 'inline-block' }}>
                            <button type="button" onClick={() => setShowMediaTip(v => !v)}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                              <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 400, textDecoration: 'underline' }}>上传素材说明</span>
                            </button>
                            {showMediaTip && (
                              <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, background: '#1e293b', color: '#f1f5f9', fontSize: 12, lineHeight: 1.6, padding: '10px 12px', borderRadius: 8, width: 260, zIndex: 100, boxShadow: '0 4px 16px rgba(0,0,0,0.2)', whiteSpace: 'normal' }}>
                                图片最多 8 张 · 视频最多 4 条 · 音频最多 4 条。上传素材后，AI 会根据素材内容和风格生成匹配的视频画面。
                                <span onClick={() => setShowMediaTip(false)} style={{ display: 'block', textAlign: 'right', marginTop: 6, cursor: 'pointer', color: '#94a3b8', fontSize: 11 }}>关闭</span>
                              </div>
                            )}
                          </span>
                        )}
                        {stepTab === 'script' && dialogueScript && !analyzingScript && (
                          <button type="button" onClick={() => { setRewriteOpen(true); setRewritePreview(''); setRewriteError(''); }}
                            style={{ fontSize: 11, padding: '4px 10px', border: '1px solid #7c3aed', borderRadius: 5, background: '#fff', cursor: 'pointer', color: '#7c3aed', fontWeight: 500, whiteSpace: 'nowrap' }}>
                            剧本改写
                          </button>
                        )}
                      </div>
                    );
                  })()}

                  {/* 对白剧本 —— 剧本分析写好的（或补做「生成分镜脚本」时后端自己写的）。
                      生成中实时流式刷新（只读，编辑和轮询覆盖会打架）；写完才能改，
                      改完点「生成分镜脚本」会带着这份改过的原文去开拍，不会被重写 */}
                  {scriptReady && !tabsCollapsed && stepTab === 'script' && (
                    <div style={{ marginBottom: 14 }}>
                      {dialogueScript ? (
                        <textarea
                          ref={dialogueScriptBoxRef}
                          className={styles.textarea}
                          value={dialogueScript}
                          onChange={e => setDialogueScript(e.target.value)}
                          readOnly={analyzingScript}
                          rows={Math.min(10, Math.max(5, dialogueScript.split('\n').length))}
                          style={{ fontSize: 16, fontFamily: 'inherit', lineHeight: 1.9, background: analyzingScript ? '#faf5ff' : '#f9fafb', borderColor: '#000' }}
                          placeholder="对白剧本将显示在这里，可手动编辑…"
                        />
                      ) : (
                        <p style={{ margin: 0, fontSize: 12, color: '#9ca3af' }}>
                          {analyzingScript ? '正在写对白剧本…' : '还没有对白剧本，点上面的「剧本分析」写一份（也可以直接点「生成分镜脚本」，后端会自己先写）。'}
                        </p>
                      )}
                    </div>
                  )}

                  {/* 剧本分析结果 */}
                  {/* 有对白剧本就给一个「重新分析角色」——只按现在这份剧本重提角色，不重写剧本
                      （「剧本分析」会连剧本一起重写，手改过的内容就没了） */}
                  {scriptReady && !tabsCollapsed && stepTab === 'roles' && dialogueScript.trim() && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '0 0 10px' }}>
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>按当前对白剧本重新提取角色，不改剧本</span>
                      <button type="button" onClick={handleExtractCharacters} disabled={extractingRoles || analyzingScript}
                        style={{ fontSize: 11, padding: '4px 10px', border: '1px solid #7c3aed', borderRadius: 4, background: extractingRoles ? '#f5f3ff' : '#fff', color: '#7c3aed', cursor: extractingRoles || analyzingScript ? 'default' : 'pointer', fontWeight: 600 }}>
                        {extractingRoles ? '提取中…' : '重新分析角色'}
                      </button>
                    </div>
                  )}
                  {scriptReady && !tabsCollapsed && stepTab === 'roles' && scriptAnalysis.length === 0 && (
                    <p style={{ margin: '0 0 14px', fontSize: 12, color: '#9ca3af' }}>
                      {dialogueScript.trim()
                        ? '还没有角色，点上面的「重新分析角色」从这份对白剧本里提取。'
                        : '还没有角色，点上面的「剧本分析」从剧本里提取。'}
                    </p>
                  )}
                  {scriptReady && !tabsCollapsed && stepTab === 'roles' && scriptAnalysis.length > 0 && (() => {
                    // Build image number per analysis index (not per subject id, since duplicates allowed)
                    let imgCounter = 0;
                    const analysisImgNum: number[] = scriptAnalysis.map(a => {
                      if (a.linkedSubjectId) {
                        const sub = projectSubjects.find(ps => ps.id === a.linkedSubjectId);
                        if (sub?.image_url) return ++imgCounter;
                      }
                      return 0;
                    });
                    return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
                      {scriptAnalysis.map((item, idx) => (
                          <div key={idx} style={{ padding: 10, border: '1px solid #000', borderRadius: 6, background: '#fff', position: 'relative' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <span style={{ fontSize: 14, fontWeight: 600 }}>{item.label}</span>
                                <span style={{ fontSize: 11, color: '#9ca3af' }}>{item.type}</span>
                              </div>
                              {item.linkedSubjectId && (() => {
                                const linked = projectSubjects.find(ps => ps.id === item.linkedSubjectId);
                                const imgNum = analysisImgNum[idx];
                                return linked ? (
                                  <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 6, fontSize: 11, color: '#16a34a', background: '#f0fdf4', padding: '2px 6px', borderRadius: 4 }}>
                                    {/* 「图片N」压在缩略图正下方 —— 这个编号指的就是这张图，
                                        贴着图看才对得上（挂右边一列容易和角色名混作一团） */}
                                    {linked.image_url && (
                                      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                                        <img src={linked.image_url} alt="" style={{ width: 36, height: 36, borderRadius: 4, objectFit: 'cover' }} />
                                        {imgNum > 0 && <span style={{ fontSize: 10, color: '#9ca3af', lineHeight: 1.2 }}>图片{imgNum}</span>}
                                      </span>
                                    )}
                                    {/* 有头像就只留缩略图 + 图片N —— 主体名多半是资源名，占地方又不说明问题，
                                        要核对的是「这张脸是第几张图」。没绑图的才退回显示名字，不然标签是空的 */}
                                    {!linked.image_url && displayLabel(linked.label) && (
                                      <span>{displayLabel(linked.label)}</span>
                                    )}
                                    <button type="button" onClick={() => { const newA = scriptAnalysis.map((s, i) => i === idx ? { ...s, linkedSubjectId: undefined } : s); setScriptAnalysis(newA); setVideoSubjects(newA.filter(a => a.linkedSubjectId).map(a => projectSubjects.find(ps => ps.id === a.linkedSubjectId)).filter(Boolean) as ProjectSubject[]); }}
                                      style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}>×</button>
                                  </span>
                                ) : null;
                              })()}
                              {item.linkedAudioUrl && (() => {
                                const an = audioItems.findIndex(m => m.url === item.linkedAudioUrl);
                                if (an < 0) return null;                       // 音频被删掉了，标签也不显示
                                const media = audioItems[an];
                                const avatar = presetThumbByUrl.get(item.linkedAudioUrl);
                                return (
                                  <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 6, fontSize: 11, color: '#0e7490', background: '#ecfeff', padding: '2px 6px', borderRadius: 4 }}>
                                    {/* 「音频N」压在音色头像正下方，和上面「图片N」同一个排法。
                                        试听没有单独的 ▶ 按钮 —— 点头像/编号本身就是试听 */}
                                    <span role="button" title="点击试听"
                                      onClick={() => { previewAudioRef.current?.pause(); const a = new Audio(media.url!); previewAudioRef.current = a; a.play().catch(() => {}); }}
                                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, cursor: 'pointer' }}>
                                      {avatar
                                        ? <img src={avatar} alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }} />
                                        : <span style={{ width: 28, height: 28, borderRadius: '50%', background: '#cffafe', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>🎵</span>}
                                      <span style={{ lineHeight: 1.2 }}>音频{an + 1}</span>
                                    </span>
                                    <button type="button" onClick={() => unbindVoice(idx)}
                                      style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}>×</button>
                                  </span>
                                );
                              })()}
                              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                                {/* 音色绑定：从已上传的参考音频里挑一条，@音频N 的编号 = 上传顺序。
                                    绑了之后后端逐镜贴同一句「使用@音频N…的音色说话」，
                                    不再让模型自己猜哪条音频是谁的声音 */}
                                {(audioItems.length > 0 || voicePresets.length > 0) && (
                                  <span style={{ position: 'relative' }}>
                                    <button type="button" onClick={() => setScriptAnalysis(prev => prev.map((s, i) => i === idx ? { ...s, _voicePickerOpen: !s._voicePickerOpen } : { ...s, _voicePickerOpen: false }))}
                                      style={{ fontSize: 11, padding: '3px 8px', border: '1px solid #0891b2', borderRadius: 4, background: item.linkedAudioUrl ? '#ecfeff' : '#fff', color: '#0891b2', cursor: 'pointer' }}>
                                      音色
                                    </button>
                                    {item._voicePickerOpen && (
                                      <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, padding: 8, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', zIndex: 50, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', minWidth: 180 }}>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                          {audioItems.map((m, ai) => (
                                            <div key={m.uid} onClick={() => patchAnalysis(idx, { linkedAudioUrl: m.url, _voicePickerOpen: false })}
                                              style={{ padding: '5px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 12, background: item.linkedAudioUrl === m.url ? '#ecfeff' : '#f9fafb', border: item.linkedAudioUrl === m.url ? '1px solid #0891b2' : '1px solid transparent' }}>
                                              音频{ai + 1}：{m.name || '参考音频'}
                                            </div>
                                          ))}
                                        </div>
                                        {/* 方舟预设音色：选中先入列参考素材（拿到 @音频N 编号）再绑给这个角色 */}
                                        {voicePresets.length > 0 && (
                                          <div style={{ marginTop: 8, borderTop: '1px solid #f1f5f9', paddingTop: 8 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                              <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>预设音色 {voicePresets.length}</span>
                                              <input value={voiceQuery} onChange={e => setVoiceQuery(e.target.value)} placeholder="搜索 / 青年 女 …"
                                                style={{ flex: 1, fontSize: 11, padding: '3px 6px', border: '1px solid #e5e7eb', borderRadius: 4 }} />
                                            </div>
                                            <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
                                              {voicePresets
                                                .filter(v => !voiceQuery.trim() || voiceQuery.trim().split(/\s+/).every(q => v.name.includes(q)))
                                                .map(v => (
                                                  <div key={v.url} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 4, fontSize: 12, background: item.linkedAudioUrl === v.url ? '#ecfeff' : '#f9fafb', border: item.linkedAudioUrl === v.url ? '1px solid #0891b2' : '1px solid transparent' }}>
                                                    {v.avatar && <img src={v.avatar} alt="" style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover' }} />}
                                                    <span onClick={() => pickVoicePreset(idx, v)} style={{ flex: 1, cursor: 'pointer' }}>{v.name}</span>
                                                    <span style={{ fontSize: 10, color: '#9ca3af' }}>{v.duration}</span>
                                                    <button type="button" onClick={() => { previewAudioRef.current?.pause(); const a = new Audio(v.url); previewAudioRef.current = a; a.play().catch(() => {}); }}
                                                      style={{ fontSize: 10, padding: '1px 5px', border: '1px solid #cbd5e1', borderRadius: 3, background: '#fff', color: '#475569', cursor: 'pointer' }}>试听</button>
                                                  </div>
                                                ))}
                                            </div>
                                          </div>
                                        )}
                                        {item.linkedAudioUrl && (
                                          <button type="button" onClick={() => { unbindVoice(idx); setScriptAnalysis(prev => prev.map((s, i) => i === idx ? { ...s, _voicePickerOpen: false } : s)); }}
                                            style={{ marginTop: 6, fontSize: 11, color: '#ea580c', background: 'none', border: 'none', cursor: 'pointer' }}>清除音色</button>
                                        )}
                                        <button type="button" onClick={() => setScriptAnalysis(prev => prev.map((s, i) => i === idx ? { ...s, _voicePickerOpen: false } : s))}
                                          style={{ marginTop: 6, marginLeft: 8, fontSize: 11, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer' }}>关闭</button>
                                      </div>
                                    )}
                                  </span>
                                )}
                                <button type="button" onClick={() => { setAvatarPickerIdx(idx); setAvatarPickerTab('real'); setAvatarSearch(''); }}
                                  style={{ fontSize: 11, padding: '3px 8px', border: '1px solid #7c3aed', borderRadius: 4, background: '#fff', color: '#7c3aed', cursor: 'pointer' }}>
                                  头像
                                </button>
                                <button type="button" onClick={() => {
                                  const droppedAudio = scriptAnalysis[idx]?.linkedAudioUrl;
                                  const newA = scriptAnalysis.filter((_, i) => i !== idx);
                                  setScriptAnalysis(newA);
                                  setVideoSubjects(newA.filter(a => a.linkedSubjectId).map(a => projectSubjects.find(ps => ps.id === a.linkedSubjectId)).filter(Boolean) as ProjectSubject[]);
                                  releasePresetAudio(droppedAudio, newA);       // 角色没了，它的预设音色也别留着占编号
                                }}
                                  style={{ background: 'none', border: '1px solid #ea580c', borderRadius: 4, color: '#ea580c', cursor: 'pointer', fontSize: 11, padding: '3px 8px' }}>删除</button>
                              </span>
                            </div>
                            {/* 形象/性格都可改。**形象这段会被逐镜一字不改地贴进每个分镜的
                                prompt_en**（角色定义原文锁），落点就是提示词页签里的「角色定义」那一段，
                                所以改这里等于改全片的长相；性格只用于这张卡的展示，不进提示词 */}
                            <label style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 4 }}>
                              <b>形象</b>
                              <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 4 }}>= 每一镜提示词里的「角色定义」，原样写入</span>
                              <textarea value={item.appearance || ''} rows={3}
                                onChange={e => patchAnalysis(idx, { appearance: e.target.value })}
                                className={styles.textarea} style={{ fontSize: 15, lineHeight: 1.8, marginTop: 2 }} />
                            </label>
                            <label style={{ display: 'block', fontSize: 12, color: '#374151', margin: 0 }}>
                              <b>性格</b>
                              <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 4 }}>只用于这张卡，不进提示词</span>
                              <textarea value={item.personality || ''} rows={2}
                                onChange={e => patchAnalysis(idx, { personality: e.target.value })}
                                className={styles.textarea} style={{ fontSize: 15, lineHeight: 1.8, marginTop: 2 }} />
                            </label>
                          </div>
                        ))}
                      </div>
                  );
                  })()}

                  {/* 参考素材 */}
                  {scriptReady && !tabsCollapsed && stepTab === 'media' && (<>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                      {/* 方舟预设素材：80 音色 / 35 段动作·运镜视频 / 71 张服饰环境画风角色图 */}
                      <button type="button" onClick={() => setLibOpen(true)}
                        style={{ fontSize: 13, padding: '4px 10px', border: '1px solid #0891b2', borderRadius: 5, background: '#fff', cursor: 'pointer', color: '#0891b2' }}>
                        素材库
                      </button>
                      <button type="button" onClick={() => mediaInputRef.current?.click()}
                        style={{ fontSize: 13, padding: '4px 10px', border: '1px solid #6b7280', borderRadius: 5, background: '#fff', cursor: 'pointer', color: '#374151' }}>
                        上传素材(图像|音频|视频)
                      </button>
                      <input ref={mediaInputRef} type="file" accept="image/*,video/*,audio/*" multiple style={{ display: 'none' }}
                        onChange={e => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
                    </div>
                    <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 8, background: '#f9fafb' }}>
                      <MediaPanel items={mediaItemsForPanel} onAddFiles={addFiles} onRemove={removeMediaItem} onDescChange={(idx, desc) => setMediaItems(prev => prev.map((m, i) => i === idx ? { ...m, description: desc } : m))} uploadError={uploadError} imageOffset={videoSubjects.filter(s => s.image_url).length} />
                    </div>
                  </>)}

                  {/* 主体定义 */}
                  <div style={{ marginBottom: 14, display: 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <button type="button" onClick={handleAnalyzeSubjects}
                        disabled={analyzingSubjects || mediaItems.filter(m => m.mediaType === 'image' && !m.uploading).length === 0}
                        style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: '1.5px solid #0d9488', background: '#f0fdfa', color: '#0d9488', cursor: 'pointer', fontWeight: 500 }}>
                        {analyzingSubjects ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <span className={styles.spinner} style={{ width: 10, height: 10 }} /> 分析中…
                          </span>
                        ) : '主体定义'}
                      </button>
                      <span style={{ fontSize: 11, color: '#9ca3af', display: 'none' }}>AI 分析素材中的主体，用于后续分镜引用</span>
                    </div>
                    {subjectError && <div className={styles.errInline} style={{ marginBottom: 8 }}>{subjectError}</div>}
                    {subjectDefs && (
                      <textarea
                        className={styles.textarea}
                        value={subjectDefs}
                        onChange={e => setSubjectDefs(e.target.value)}
                        rows={Math.min(8, subjectDefs.split('\n').length + 1)}
                        style={{ fontSize: 12, fontFamily: 'inherit', background: '#f0fdfa', borderColor: '#99f6e4' }}
                        placeholder="主体定义将显示在这里，可手动编辑..."
                      />
                    )}
                  </div>


                  {initError && <div className={styles.errorBox}>{initError}</div>}

                  {scriptReady && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, marginTop: 18 }}>
                  <button type="button" onClick={handleInitClick} disabled={initing || (!script.trim() && !subtitleInput.trim()) || anyUploading || mediaDescMissing}
                    className={styles.btnDanger} style={{ padding: '7px 24px', width: 'auto' }}>
                    {initing ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <span className={styles.spinner} style={{ borderColor: '#fdba74', borderTopColor: '#fff' }} />
                        分镜进行中{initElapsed > 0 ? ` ${initElapsed}s` : ''}...
                      </span>
                    ) : anyUploading ? '素材上传中，请等待…' : mediaDescMissing ? '请填写素材说明' : initResult ? '重新生成分镜脚本' : '生成分镜脚本'}
                  </button>
                  {initing && (
                    <p style={{ margin: 0, fontSize: 11, color: '#6b7280' }}>
                      {sbStage === 'shots' ? '对白剧本已写好，正在拆分镜头、配运镜…' : sbStage === 'script' ? '正在写对白剧本…' : '任务在服务器上跑'}
                      　可以离开这个页面，回来会自动接着取结果
                    </p>
                  )}
                  </div>
                  )}
                  </>)}
              </div>

              {/* ── Step 2 ── */}
              {initResult && shots.length > 0 && (() => {
                const activeIdx = Math.min(activeShot, shots.length - 1);
                return (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 0', flexWrap: 'wrap' }}>
                    {/* 点这一行折叠整个分镜列表（合并那块不跟着收） */}
                    <span onClick={() => setShotsCollapsed(v => !v)}
                      style={{ fontSize: 10, cursor: 'pointer', color: '#6b7280', transition: 'transform 0.2s', transform: shotsCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', display: 'inline-block' }}>▼</span>
                    {/* 红色粗框（原来是红色粗下划线）—— 这一行是分镜总览，要一眼看到 */}
                    <span onClick={() => setShotsCollapsed(v => !v)}
                      style={{ fontSize: 18, fontWeight: 700, color: '#111827', border: '3px solid #dc2626', borderRadius: 8, padding: '4px 12px', display: 'inline-block', cursor: 'pointer', background: '#fef2f2' }}>
                      {shots.length}个分镜
                    </span>
                    {/* 时长和已生成连成一句，中间只有一个逗号，不留间距 */}
                    <span style={{ fontSize: 13, color: '#16a34a' }}>
                      视频总时长{Math.round(shots.reduce((a, s) => a + s.duration, 0))}秒{audioDuration > 0 ? ` · 音频${Math.round(audioDuration)}秒` : ''}
                      {succeededCount > 0 && <>,已生成{succeededCount}/{shots.length}个</>}
                    </span>
                    {ttsLoading && <span style={{ fontSize: 12, color: '#2563eb' }}>语音生成中…</span>}
                    {/* 横排标签 ⇄ 竖排列表。竖排下才有「全部展开/折叠」——横排一次只显示一镜，
                        展开与否没有意义 */}
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      {shotView === 'list' && (
                        <button type="button" onClick={() => {
                          const next = !allShotsExpanded;
                          setAllShotsExpanded(next);
                          const map: Record<number, boolean> = {};
                          shots.forEach((_, i) => { map[i] = next; });
                          setExpandedShots(map);
                        }}
                          style={{ fontSize: 11, padding: '3px 10px', border: '1px solid #f59e0b', borderRadius: 4, background: '#f59e0b', cursor: 'pointer', color: '#fff', fontWeight: 600 }}>
                          {allShotsExpanded ? '全部折叠' : '全部展开'}
                        </button>
                      )}
                      <button type="button"
                        onClick={() => {
                          const next = shotView === 'tabs' ? 'list' : 'tabs';
                          setShotView(next);
                          try { localStorage.setItem(SHOT_VIEW_KEY, next); } catch {}
                        }}
                        title={shotView === 'tabs' ? '切换成竖排列表' : '切换成横排标签'}
                        style={{ fontSize: 11, padding: '3px 10px', border: '1px solid #6b7280', borderRadius: 4, background: '#fff', color: '#374151', cursor: 'pointer' }}>
                        {shotView === 'tabs' ? '竖排' : '横排'}
                      </button>
                    </span>
                  </div>

                  {/* 分镜标签条：横着排一排，点哪个下面就显示哪一镜。
                      小圆点是这一镜的生成状态（绿=已生成 / 红=失败 / 黄=排队生成中 / 灰=还没提交），
                      不用逐个点开就知道哪几镜还没好。一行放不下就换行，不横向滚动 ——
                      分镜多的时候滚动条会把后面几镜藏起来，换行至少一眼全看得见 */}
                  {!shotsCollapsed && shotView === 'tabs' && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '0 0 10px' }}>
                      {/* 标签上只有编号 —— 上一行「N个分镜」已经说明这是什么，
                          再写一遍「分镜」只是占地方 */}
                      {shots.map((s, i) => {
                        const st = tasks[i]?.status;
                        const dot = st === 'succeeded' ? '#16a34a'
                          : st === 'failed' ? '#dc2626'
                          : st && !TERMINAL.has(st) ? '#f59e0b' : '#d1d5db';
                        const on = i === activeIdx;
                        return (
                          <button key={i} type="button" onClick={() => setActiveShot(i)}
                            style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
                              fontSize: 12, fontWeight: on ? 700 : 500, padding: '5px 10px', borderRadius: 4, cursor: 'pointer',
                              border: on ? '2px solid #2563eb' : '1px solid #e5e7eb',
                              background: on ? '#eff6ff' : '#fff', color: on ? '#1d4ed8' : '#374151' }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, flexShrink: 0 }} />
                            {s.shot_number}
                          </button>
                        );
                      })}
                      {/* 最后一镜后面的「+」：在末尾补一个空分镜，加完直接选中它 */}
                      <button type="button" onClick={addShot} disabled={addingShot} title="在最后加一个分镜"
                        style={{ flexShrink: 0, fontSize: 13, fontWeight: 700, lineHeight: 1, padding: '5px 10px', borderRadius: 4,
                          border: '1px dashed #9ca3af', background: '#fff', color: '#6b7280',
                          cursor: addingShot ? 'default' : 'pointer' }}>
                        {addingShot ? '…' : '+'}
                      </button>
                    </div>
                  )}

                  <div style={{ padding: '0 0 16px' }}>
                    {!shotsCollapsed && (<>
                    {shots.map((shot, idx) => {
                      // 横排：只渲染标签条选中的那一镜，且永远是展开态
                      // 竖排：全部铺开，每张卡各自展开/折叠（点卡头收起）
                      const tabsView = shotView === 'tabs';
                      if (tabsView && idx !== activeIdx) return null;
                      const task = tasks[idx];
                      const isExpanded = tabsView || (expandedShots[idx] ?? false);
                      const shotTab: ShotTabKey = shotTabs[idx] ?? 'subtitle';
                      return (
                        <Fragment key={idx}>
                          {!isExpanded ? (
                            /* ── 竖排下的收起行：分镜N + 标题 + 一句话描述 + 状态 ── */
                            <div className={styles.shotCard} style={{ padding: '8px 12px', marginTop: idx === 0 ? 12 : undefined, cursor: 'pointer' }}
                              onClick={() => setExpandedShots(prev => ({ ...prev, [idx]: true }))}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                {shot.imageUrl && <img src={shot.imageUrl} alt="" style={{ width: 28, height: 28, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }} />}
                                <span className={styles.shotNum} style={{ flexShrink: 0 }}>分镜{shot.shot_number}</span>
                                <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
                                  {shot.title}
                                </span>
                                {shot.duration ? (
                                  <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 600, color: '#0f766e', background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: 999, padding: '1px 7px', whiteSpace: 'nowrap' }}>
                                    {shot.duration}s
                                  </span>
                                ) : null}
                                <span style={{ flex: 1 }} />
                                {task && task.status && <StatusBadge status={task.status} />}
                                {task?.videoUrl && <span style={{ fontSize: 11, color: '#16a34a' }}>▶</span>}
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                                  style={{ width: 14, height: 14, color: '#9ca3af', flexShrink: 0 }}>
                                  <path d="m6 9 6 6 6-6"/>
                                </svg>
                                {shot.description && <p className={styles.shotDescRow}>{shot.description}</p>}
                              </div>
                            </div>
                          ) : (
                          <div className={styles.shotCard} style={{ marginTop: 12 }}>
                            {/* 竖排下点卡头收起这一镜；横排下一次只显示一镜，收起没有意义 */}
                            <div className={styles.shotHead}
                              style={tabsView ? undefined : { cursor: 'pointer' }}
                              onClick={tabsView ? undefined : () => setExpandedShots(prev => ({ ...prev, [idx]: false }))}>
                              <div className={styles.shotInfo}>
                                <span className={styles.shotNum}>分镜{shot.shot_number}</span>
                                {/* 时长紧跟在「分镜N」后面：放在标题之后会被长标题挤到看不见 */}
                                {shot.duration ? (
                                  <span style={{ flexShrink: 0, alignSelf: 'center', fontSize: 12, fontWeight: 700, color: '#0f766e', background: '#f0fdfa', border: '1px solid #5eead4', borderRadius: 999, padding: '2px 9px', whiteSpace: 'nowrap' }}>
                                    {shot.duration}s
                                  </span>
                                ) : null}
                                <div className={styles.shotMeta}>
                                  <p className={styles.shotTitle}>{shot.title}</p>
                                </div>
                              </div>
                              {/* 状态 + 生成按钮：和「分镜N」同一行、靠右（.shotHead 是 space-between），
                                  页签切到哪一页都在。整行是收起卡片的点击区，所以这一小块要吃掉自己的点击事件 */}
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}
                                onClick={e => e.stopPropagation()}>
                                {task && task.status && <StatusBadge status={task.status} />}
                                <button type="button"
                                  onClick={() => task?.status === 'succeeded' ? submitShotConfirmed(idx, 'redo') : submitShot(idx)}
                                  disabled={task?.submitting || (task?.taskId != null && !TERMINAL.has(task?.status || ''))}
                                  className={styles.btnShotGen}>
                                  {task?.submitting ? '提交中…' : (task?.taskId && !TERMINAL.has(task.status)) ? '生成中' : task?.status === 'succeeded' ? '重新生成' : `生成视频${idx + 1}`}
                                </button>
                              </span>
                              {/* 横排下卡头右上角是删除这一镜；竖排下那个位置是收起箭头
                                  （竖排整行就是折叠的点击区，塞个删除按钮容易点错） */}
                              {tabsView ? (
                                <button type="button" title={`删除分镜${shot.shot_number}`}
                                  onClick={e => { e.stopPropagation(); deleteShot(idx); }}
                                  style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 3, border: 'none', background: 'none', color: '#9ca3af', cursor: 'pointer' }}>
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                                    style={{ width: 15, height: 15 }}>
                                    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>
                                  </svg>
                                </button>
                              ) : (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                                  style={{ width: 14, height: 14, color: '#9ca3af', flexShrink: 0, transform: 'rotate(180deg)' }}>
                                  <path d="m6 9 6 6 6-6"/>
                                </svg>
                              )}
                              {/* 一句话描述独占一行：.shotHead 是 flex-wrap，给它 100% 宽就换到下一行，
                                  不再和标题挤在按钮左边那点宽度里（仍在收起卡片的点击区内） */}
                              {shot.description && <p className={styles.shotDescRow}>{shot.description}</p>}
                            </div>

                            {/* 卡内页签。生成按钮和任务状态不在这儿 —— 它们钉在上面的「分镜N」标题行，
                                不管切到哪一页都能提交、都看得到这一镜跑到哪了 */}
                            <div className={styles.shotTabs}>
                              {SHOT_TABS.map(([k, label]) => (
                                <button key={k} type="button"
                                  onClick={() => setShotTabs(prev => ({ ...prev, [idx]: k }))}
                                  className={`${styles.shotTab} ${shotTab === k ? styles.shotTabOn : ''}`}>
                                  {label}
                                  {/* 手改过 JSON 的分镜按编辑后的发送，页签上标一下，免得忘了还挂着改动 */}
                                  {k === 'json' && shotJsonEdits[idx] !== undefined && <span className={styles.shotTabDot}>已改</span>}
                                </button>
                              ))}
                            </div>

                            {shotTab === 'params' && (<>
                            {/* 这一镜的属性一眼过（只读）；改还是改下面那排控件。
                                A-roll/B-roll 和情绪标签没有对应的控件，只在这里看得到 */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                              <ShotChips shot={shot} />
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: '4px 8px', margin: '8px 0', alignItems: 'end' }}>
                              <div>
                                <span className={styles.paramLabel}>景别</span>
                                <select value={shot.shot_size || ''} onChange={e => { const u = [...shots]; u[idx] = { ...u[idx], shot_size: e.target.value }; setShots(u); markShotDirty(idx); }}
                                  className={styles.paramCtl}>
                                  <option value="">--</option>
                                  {SHOT_SIZES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                                  {/* 归一化没认出来的值也得能显示，否则 select 是空白，看着像丢了数据 */}
                                  {shot.shot_size && !SHOT_SIZES.some(o => o.value === shot.shot_size) &&
                                    <option value={shot.shot_size}>{shot.shot_size}</option>}
                                </select>
                              </div>
                              <div>
                                <span className={styles.paramLabel}>光影氛围</span>
                                <input type="text" value={shot.mood || ''} onChange={e => { const u = [...shots]; u[idx] = { ...u[idx], mood: e.target.value }; setShots(u); markShotDirty(idx); }}
                                  className={styles.paramCtl} placeholder="氛围" />
                              </div>
                              <div>
                                <span className={styles.paramLabel}>运镜</span>
                                <select value={shot.camera_movement || ''} onChange={e => { const u = [...shots]; u[idx] = { ...u[idx], camera_movement: e.target.value }; setShots(u); markShotDirty(idx); }}
                                  className={styles.paramCtl}>
                                  <option value="">--</option>
                                  {CAMERA_MOVEMENTS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                                  {shot.camera_movement && !CAMERA_MOVEMENTS.some(o => o.value === shot.camera_movement) &&
                                    <option value={shot.camera_movement}>{shot.camera_movement}</option>}
                                </select>
                              </div>
                              <div>
                                <span className={styles.paramLabel}>时长</span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                                  <input type="number" min={4} max={15} step={1} value={shot.duration}
                                    onChange={e => { const u = [...shots]; u[idx] = { ...u[idx], duration: Math.max(4, Math.min(15, Number(e.target.value) || 5)) }; setShots(u); markShotDirty(idx); }}
                                    className={styles.paramCtl} />
                                  <span style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>s</span>
                                </div>
                              </div>
                              <div>
                                <span className={styles.paramLabel}>主体</span>
                                <input type="text" value={(shot.subjects || []).join(', ')}
                                  onChange={e => { const u = [...shots]; u[idx] = { ...u[idx], subjects: e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean) }; setShots(u); markShotDirty(idx); }}
                                  className={styles.paramCtl} placeholder="逗号分隔" />
                              </div>
                              <div>
                                <span className={styles.paramLabel}>3D机位</span>
                                <button type="button" onClick={() => setCameraEditorIdx(idx)}
                                  className={styles.paramCtl}
                                  style={{ borderColor: '#2563eb', background: shot.camera ? '#eff6ff' : '#fff', color: '#2563eb' }}>
                                  {shot.camera ? '编辑' : '设置'}
                                </button>
                              </div>
                            </div>

                            </>)}

                            {/* 参考图页签：分镜参考图（AI 生成的那一张）+ 分镜附加素材。
                                两者都是「喂给这一镜的图」，放一起才好比对；参数页签只管文字参数 */}
                            {shotTab === 'refs' && (
                            <div style={{ margin: '8px 0' }}>
                              <span className={styles.fieldLabel}>分镜参考图</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 12px' }}>
                                {shot.imageUrl ? (
                                  <div style={{ position: 'relative' }}>
                                    <img src={shot.imageUrl} alt="" style={{ width: 80, height: 80, borderRadius: 6, objectFit: 'cover', border: '1px solid #e5e7eb' }} />
                                    <button onClick={() => { const u = [...shots]; u[idx] = { ...u[idx], imageUrl: '' }; setShots(u); if (u[idx].id) api.put(`/shots/${u[idx].id}`, { image_url: '' }).catch(() => {}); }}
                                      style={{ position: 'absolute', top: -4, right: -4, width: 16, height: 16, borderRadius: '50%', background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none', fontSize: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                                  </div>
                                ) : null}
                                <button onClick={() => openShotAi(idx)}
                                  style={{ padding: '4px 10px', fontSize: 11, border: '1px solid #2563eb', borderRadius: 5, background: '#eff6ff', color: '#2563eb', cursor: 'pointer' }}>
                                  {shot.imageUrl ? '重新生成' : '分镜参考图'}
                                </button>
                              </div>

                              <span className={styles.fieldLabel}>分镜附加素材</span>
                              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, margin: '4px 0 0' }}>
                                <button type="button" onClick={() => setShotMediaIdx(idx)}
                                  className={styles.paramCtl}
                                  style={{ width: 'auto', marginTop: 0, flexShrink: 0, borderColor: '#9ca3af', background: (shot.reference_images?.length) ? '#f0fdf4' : '#fff' }}>
                                  {shot.reference_images?.length ? `${shot.reference_images.length}张` : '添加'}
                                </button>
                                {(shot.reference_images || []).map((r, ri) => (
                                  <img key={ri} src={r.url} alt="" title={r.name || ''}
                                    onClick={() => setShotMediaIdx(idx)}
                                    style={{ width: 40, height: 40, borderRadius: 5, objectFit: 'cover', border: '1px solid #e5e7eb', cursor: 'pointer' }} />
                                ))}
                              </div>
                            </div>
                            )}

                            {/* 提示词按来源拆成四段显示（见 splitShotPrompt）——只是显示上的拆分，
                                提交时仍旧 join 回同一条 prompt 塞进 JSON 的 text 里。
                                拆开是为了让「后端逐镜统一贴的角色定义句」和「真正属于这一镜的画面描述」
                                各归各位：定义句全片一字不差，混在一起看不出哪段该改。 */}
                            {shotTab === 'prompt' && (() => {
                              const parts = splitShotPrompt(shot.prompt);
                              const anchorOptions = subjectAnchorOptions(subjectContext.characterDefs);
                              const setPart = (key: keyof typeof parts, value: string) => {
                                const u = [...shots];
                                u[idx] = { ...u[idx], prompt: joinShotPrompt({ ...parts, [key]: value }) };
                                setShots(u); markShotDirty(idx);
                              };
                              const hint = { fontSize: 10, color: '#9ca3af', margin: '0 0 2px', lineHeight: 1.5 } as const;
                              const sections: Array<{ key: keyof typeof parts; label: string; tip: string; ph: string }> = [
                                { key: 'head',   label: '开场声明', tip: '格式与风格声明，质量杠杆最大的一句', ph: '例：One continuous shot, no cuts, photorealistic, 35mm film grain.' },
                                { key: 'defs',   label: '角色定义', tip: '', ph: '这一镜没有绑定角色' },
                                { key: 'body',   label: '画面描述', tip: '场景/动作/时间轴节拍 —— 真正属于这一镜的部分，改这里最有效', ph: '' },
                                { key: 'speech', label: '台词', tip: '对白/画外音块，提交时会按「字幕」页签的内容重建', ph: '这一镜没有台词' },
                              ];
                              return (
                                <div style={{ marginBottom: 8 }}>
                                  <span className={styles.fieldLabel}>分镜{idx + 1}提示词（分段可编辑，提交时合并为一条）</span>
                                  {sections.map(sec => (
                                    <div key={sec.key} style={{ marginTop: 8 }}>
                                      <span className={styles.fieldLabel} style={{ margin: 0 }}>{sec.label}</span>
                                      {/* 「选取角色」：从角色区那几个角色里挑这一镜出场的，按固定句式插进来。
                                          选中的角色 = 定义段里出现过的 <主体N>，点一下加、再点一下去掉，
                                          句子由 subjectAnchorOptions 拼（和后端原文锁逐字同一个句式） */}
                                      {sec.key === 'defs' && anchorOptions.length > 0 && (() => {
                                        const picked = new Set(
                                          [...parts.defs.matchAll(/[<【]\s*主体\s*(\d+)\s*[>】]/g)].map(m => Number(m[1]))
                                        );
                                        const rebuild = (nums: Set<number>) =>
                                          setPart('defs', anchorOptions.filter(o => nums.has(o.num)).map(o => o.anchor).join('；'));
                                        return (
                                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', margin: '4px 0 2px' }}>
                                            <span style={{ fontSize: 10, color: '#9ca3af' }}>选取角色</span>
                                            {anchorOptions.map(o => {
                                              const on = picked.has(o.num);
                                              return (
                                                <button key={o.num} type="button"
                                                  title={on ? `从这一镜的角色定义里去掉「${o.name}」` : `把「${o.name}」的定义句插进这一镜`}
                                                  onClick={() => {
                                                    const next = new Set(picked);
                                                    if (on) next.delete(o.num); else next.add(o.num);
                                                    rebuild(next);
                                                  }}
                                                  style={{ fontSize: 10, padding: '1px 7px', borderRadius: 4, cursor: 'pointer',
                                                    border: on ? '1px solid #16a34a' : '1px solid #d1d5db',
                                                    background: on ? '#f0fdf4' : '#fff', color: on ? '#15803d' : '#6b7280' }}>
                                                  {on ? '✓ ' : ''}{o.name || `图片${o.num}`}
                                                </button>
                                              );
                                            })}
                                          </div>
                                        );
                                      })()}
                                      {sec.tip ? <p style={hint}>{sec.tip}</p> : null}
                                      <AutoTextarea placeholder={sec.ph}
                                        value={parts[sec.key]}
                                        onChange={e => setPart(sec.key, e.target.value)}
                                        className={styles.textarea} />
                                    </div>
                                  ))}
                                </div>
                              );
                            })()}

                            {shotTab === 'subtitle' && (
                            <div style={{ marginBottom: 8 }}>
                              <span className={styles.fieldLabel}>分镜{idx + 1}字幕</span>
                              {/* 行数随内容走：一句话的字幕不该占四行，长的也不用在小框里滚 */}
                              <textarea rows={Math.min(8, Math.max(2, shot.subtitle ? shot.subtitle.split('\n').length + Math.floor(shot.subtitle.length / 28) : 2))}
                                value={shot.subtitle}
                                onChange={e => { const u = [...shots]; u[idx] = { ...u[idx], subtitle: e.target.value }; setShots(u); markShotDirty(idx); }}
                                className={styles.textarea} />
                            </div>
                            )}

                            {task?.error && <p className={styles.errInline} style={{ marginTop: 6 }}>{task.error}</p>}

                            {shotTab === 'json' && (
                              <div style={{ marginBottom: 8 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                                  <span className={styles.fieldLabel} style={{ margin: 0 }}>JSON（可编辑，改完点右上「生成视频」按编辑后的发送）</span>
                                  {shotJsonEdits[idx] !== undefined && (
                                    <button type="button" onClick={() => setShotJsonEdits(prev => { const n = { ...prev }; delete n[idx]; return n; })}
                                      style={{ fontSize: 10, padding: '1px 6px', border: '1px solid #9ca3af', borderRadius: 3, background: '#fff', color: '#6b7280', cursor: 'pointer' }}>
                                      恢复自动生成
                                    </button>
                                  )}
                                </div>
                                {(() => {
                                  const defaultText = JSON.stringify(buildShotSubmitJson(idx), null, 2);
                                  const text = shotJsonEdits[idx] ?? defaultText;
                                  let parseError = '';
                                  if (shotJsonEdits[idx] !== undefined) {
                                    try { JSON.parse(shotJsonEdits[idx]); } catch { parseError = 'JSON 格式错误，无法提交'; }
                                  }
                                  return (<>
                                    <textarea rows={16} spellCheck={false} value={text}
                                      onChange={e => setShotJsonEdits(prev => ({ ...prev, [idx]: e.target.value }))}
                                      style={{ width: '100%', boxSizing: 'border-box', margin: 0, padding: 8, background: '#1e293b', color: '#e2e8f0', borderRadius: 6, fontSize: 11, lineHeight: 1.5, fontFamily: 'monospace', border: parseError ? '1px solid #dc2626' : '1px solid transparent', resize: 'vertical' }} />
                                    {parseError && <p style={{ color: '#dc2626', fontSize: 11, margin: '4px 0 0' }}>{parseError}</p>}
                                  </>);
                                })()}
                              </div>
                            )}

                            {task?.taskId && !TERMINAL.has(task.status) && (() => {
                              // 排队/生成排太久（3 分钟）就放出「重新生成」：另开一个任务，
                              // 不再等旧的（旧任务无法取消，只是从此不再轮询它）
                              const waited = taskNow - (task.startedAt || taskNow);
                              const stuck  = waited >= STUCK_AFTER_MS;
                              return (
                              <div className={styles.pollingRow} style={{ flexWrap: 'wrap' }}>
                                <span className={styles.pollingText}>
                                  <span className={`${styles.spinner} ${styles.spinnerBlue}`} />
                                  {task.status === 'queued' ? '队列中' : '生成中'}，已等待 {fmtElapsed(waited)}，每 10 秒自动查询
                                </span>
                                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                                  <button type="button" onClick={() => pollTaskById(idx, task.taskId!)} className={styles.refreshBtn}>立即刷新</button>
                                  {stuck && (
                                    <button type="button" onClick={() => submitShotConfirmed(idx, 'stuck')} className={styles.refreshBtn}
                                      title="等太久了？另开一个新任务重新生成。旧任务不会被取消，只是不再等它"
                                      style={{ borderColor: '#f59e0b', color: '#b45309', background: '#fffbeb' }}>
                                      重新生成
                                    </button>
                                  )}
                                </span>
                                {stuck && (
                                  <span style={{ fontSize: 11, color: '#b45309', width: '100%' }}>
                                    等太久了？点「重新生成」另开一个任务 —— 旧任务不会被取消，只是不再等它。
                                  </span>
                                )}
                              </div>);
                            })()}
                            {shotTab === 'preview' && (
                              <div style={{ marginBottom: 8 }}>
                                {task?.videoUrl
                                  ? <VideoThumb src={task.videoUrl} ratio={shot.ratio || ratio} subtitle={shot.subtitle} />
                                  : <p style={{ fontSize: 12, color: '#9ca3af', margin: '4px 0' }}>
                                      这一镜还没有生成好的视频，点右上「{task?.taskId && !TERMINAL.has(task.status) ? '生成中…' : `生成视频${idx + 1}`}」。
                                    </p>}
                              </div>
                            )}
                          </div>
                          )}
                        </Fragment>
                      );
                    })}

                    {/* 竖排下没有标签条，加号就摆在最后一张卡后面 */}
                    {shotView === 'list' && (
                      <button type="button" onClick={addShot} disabled={addingShot}
                        style={{ display: 'block', width: '100%', marginTop: 12, padding: '8px 0', fontSize: 12, fontWeight: 600,
                          border: '1px dashed #9ca3af', borderRadius: 6, background: '#fff', color: '#6b7280',
                          cursor: addingShot ? 'default' : 'pointer' }}>
                        {addingShot ? '添加中…' : '+ 添加分镜'}
                      </button>
                    )}

                    <div className={styles.shotListActions} style={{ marginTop: 12, marginBottom: 12, justifyContent: 'center' }}>
                      <button type="button" onClick={submitAllShots}
                        disabled={succeededCount === shots.length}
                        className={styles.btnSmDanger} style={{ width: 'auto', padding: '8px 24px' }}>
                        {succeededCount === shots.length ? '全部完成' : '一键生成所有分镜视频'}
                      </button>
                    </div>
                    </>)}

                    {/* ── Step 3: Merge ── */}
                    {canMerge && (
                      <div className={styles.mergeBox}>
                        {succeededCount >= 1 && (
                          <>
                            <p className={styles.mergeTitle}>{succeededCount} / {shots.length} 个分镜视频已生成{allDone ? ' — 全部完成！' : ''}</p>
                            <p className={styles.mergeSub}>合并后自动烧录字幕，保留分镜视频自带的对白音轨</p>
                          </>
                        )}
                        <div className={styles.mergeFooter} style={{ marginTop: 14, justifyContent: 'center' }}>
                          <div style={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
                            {/* 已经有成片时，这个按钮挪到下面「新窗口打开」右边去了 */}
                            {succeededCount >= 1 && !mergedVideoUrl && (
                              <button type="button" onClick={handleMerge} disabled={merging || !canMerge}
                                className={styles.btnSmGreen} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '7px 32px', fontSize: 15, fontWeight: 600, borderRadius: 10 }}>
                                {merging ? <><span className={styles.spinner} style={{ borderColor: '#bbf7d0', borderTopColor: '#16a34a' }} />合并中…</> : `${mergedVideoUrl ? '重新生成' : '分镜合并'}(分镜视频+字幕+对白原声)`}
                              </button>
                            )}
                          </div>
                        </div>
                        {mergeError && <p className={styles.errInline} style={{ marginTop: 8 }}>{mergeError}</p>}
                        {mergedVideoUrl && (
                          <div className={styles.mergedResult}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                <a href={mergedVideoUrl} download className={`${styles.btnOutline} ${styles.btnOutlineGreen}`} style={{ textDecoration: 'none', padding: '4px 10px', fontSize: 12 }}>下载</a>
                                <a href={mergedVideoUrl} target="_blank" rel="noopener noreferrer"
                                  className={`${styles.btnOutline} ${styles.btnOutlineGreen}`} style={{ textDecoration: 'none', padding: '4px 10px', fontSize: 12 }}>新窗口打开</a>
                                {/* 重新合并会覆盖现在这条成片，先确认 */}
                                <button type="button" disabled={merging || !canMerge}
                                  onClick={() => { if (window.confirm('已经有一条合成好的最终视频，重新生成会用新的覆盖它。确定继续？')) handleMerge(); }}
                                  className={styles.btnSmGreen} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 12px', fontSize: 12, borderRadius: 6 }}>
                                  {merging ? <><span className={styles.spinner} style={{ borderColor: '#bbf7d0', borderTopColor: '#16a34a' }} />合并中…</> : '重新生成(分镜视频+字幕+对白)'}
                                </button>
                              </div>
                            </div>
                            <video src={mergedVideoUrl} muted autoPlay loop className={styles.mergedVideo}
                              style={{ maxWidth: 320, maxHeight: 200, borderRadius: 8, cursor: 'pointer', display: 'block', margin: 0 }}
                              onClick={() => window.open(mergedVideoUrl, '_blank')} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                );
              })()}
            </div>

          </div>
        </div>
      </div>

      {/* ── 3D Camera Editor Modal ── */}
      {cameraEditorIdx !== null && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.5)' }}>
          <div style={{ background: '#fff', borderRadius: 12, width: '95%', maxWidth: 800, maxHeight: '90vh', overflow: 'auto', padding: 16 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>分镜{shots[cameraEditorIdx]?.shot_number} — 3D机位编辑</h3>
              <button type="button" onClick={() => setCameraEditorIdx(null)} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>
            <div style={{ height: 450 }}>
              <CameraEditor
                value={shots[cameraEditorIdx]?.camera || { position: { x: 0, y: 5, z: 10 }, target: { x: 0, y: 0, z: 0 }, fov: 60, movementType: 'static' }}
                onChange={(cam) => {
                  const idx = cameraEditorIdx;
                  const u = [...shots]; u[idx] = { ...u[idx], camera: cam }; setShots(u);
                  if (u[idx].id) {
                    api.put(`/shots/${u[idx].id}`, {
                      camera_position_x: cam.position.x, camera_position_y: cam.position.y, camera_position_z: cam.position.z,
                      camera_target_x: cam.target.x, camera_target_y: cam.target.y, camera_target_z: cam.target.z,
                      camera_fov: cam.fov, camera_movement_type: cam.movementType,
                      camera_movement_path: cam.movementPath || null,
                    }).catch(() => {});
                  }
                }}
                ratio={ratio}
                subjects={shots[cameraEditorIdx]?.shot_subjects || (shots[cameraEditorIdx]?.subjects || []).map((s, i) => ({ label: s, color: ['#3b82f6','#ef4444','#10b981','#f59e0b'][i % 4] }))}
                onSubjectsChange={(subs) => {
                  const idx = cameraEditorIdx;
                  const u = [...shots]; u[idx] = { ...u[idx], shot_subjects: subs, subjects: subs.map(s => s.label) }; setShots(u);
                  if (u[idx].id) {
                    api.put(`/shots/${u[idx].id}`, { subjects: subs }).catch(() => {});
                  }
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Per-shot reference media modal ── */}
      {shotMediaIdx !== null && (() => {
        const shot = shots[shotMediaIdx];
        const refs = shot?.reference_images || [];
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.5)' }}>
            <div style={{ background: '#fff', borderRadius: 12, width: '90%', maxWidth: 500, maxHeight: '70vh', overflow: 'auto', padding: 20 }} onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>分镜{shot?.shot_number} — 参考素材</h3>
                <button type="button" onClick={() => setShotMediaIdx(null)} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
              </div>
              {refs.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                  {refs.map((img, i) => (
                    <div key={i} style={{ position: 'relative', width: 72, height: 72 }}>
                      <img src={img.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 6, border: '1px solid #e5e7eb' }} />
                      <button type="button" onClick={() => {
                        const newRefs = refs.filter((_, ri) => ri !== i);
                        const u = [...shots]; u[shotMediaIdx] = { ...u[shotMediaIdx], reference_images: newRefs }; setShots(u);
                        if (u[shotMediaIdx].id) api.put(`/shots/${u[shotMediaIdx].id}`, { reference_images: newRefs }).catch(() => {});
                      }} style={{ position: 'absolute', top: -4, right: -4, width: 18, height: 18, borderRadius: '50%', background: '#ef4444', color: '#fff', border: 'none', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, border: '2px dashed #93c5fd', borderRadius: 8, padding: 12, cursor: 'pointer', color: '#3b82f6', fontSize: 13 }}>
                + 上传图片
                <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={async (e) => {
                  const files = Array.from(e.target.files || []);
                  e.target.value = '';
                  for (const f of files) {
                    try {
                      const url = await uploadWithProgress(f, () => {});
                      const newRefs = [...(shots[shotMediaIdx]?.reference_images || []), { url, name: f.name }];
                      const u = [...shots]; u[shotMediaIdx] = { ...u[shotMediaIdx], reference_images: newRefs }; setShots(u);
                      if (u[shotMediaIdx].id) api.put(`/shots/${u[shotMediaIdx].id}`, { reference_images: newRefs }).catch(() => {});
                    } catch {}
                  }
                }} />
              </label>
              <p style={{ margin: '8px 0 0', fontSize: 11, color: '#9ca3af' }}>分镜独有素材，提交生成时会附加在该分镜 prompt 中</p>
            </div>
          </div>
        );
      })()}

      {/* ─── Shot AI Reference Image Modal ─── */}
      {shotAiOpen && (
        <div className={styles.shotAiOverlay} onClick={() => setShotAiOpen(false)}>
          <div className={styles.shotAiModal} onClick={e => e.stopPropagation()}>
            <div className={styles.shotAiHeader}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>生成分镜参考图</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <select value={shotAiIdx} onChange={e => { setShotAiIdx(Number(e.target.value)); setShotAiTurns([]); setShotAiLastImage(null); }}
                  style={{ fontSize: 12, border: '1px solid #d1d5db', borderRadius: 4, padding: '2px 6px', color: '#374151' }}>
                  {shots.map((s, i) => <option key={i} value={i}>分镜{s.shot_number}</option>)}
                </select>
                {shotAiTurns.length > 0 && (
                  <button onClick={() => { setShotAiTurns([]); setShotAiLastImage(null); }} style={{ fontSize: 12, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer' }}>清空</button>
                )}
                <button onClick={() => setShotAiOpen(false)} style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: '#f3f4f6', fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
              </div>
            </div>
            {/* Existing shot reference images gallery */}
            {shots.some(s => s.imageUrl) && (
              <div style={{ padding: '8px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', gap: 6, overflowX: 'auto', flexShrink: 0 }}>
                {shots.map((s, i) => s.imageUrl ? (
                  <div key={i} style={{ position: 'relative', flexShrink: 0, cursor: 'pointer', border: shotAiLastImage === s.imageUrl ? '2px solid #2563eb' : '2px solid transparent', borderRadius: 6 }}
                    onClick={async () => {
                      // Fetch image as base64 and set as priorImage for editing
                      try {
                        const resp = await fetch(s.imageUrl!);
                        const blob = await resp.blob();
                        const reader = new FileReader();
                        const dataUrl: string = await new Promise((resolve, reject) => { reader.onload = () => resolve(reader.result as string); reader.onerror = reject; reader.readAsDataURL(blob); });
                        setShotAiLastImage(dataUrl);
                        const userId = ++shotAiIdRef.current;
                        setShotAiTurns(prev => [...prev, { id: userId, role: 'user', text: `基于分镜${s.shot_number}的参考图修改` }]);
                      } catch {}
                    }}>
                    <img src={s.imageUrl} alt="" style={{ width: 48, height: 48, borderRadius: 4, objectFit: 'cover' }} />
                    <span style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 9, textAlign: 'center', borderRadius: '0 0 4px 4px', padding: '1px 0' }}>
                      镜{s.shot_number}
                    </span>
                  </div>
                ) : null)}
              </div>
            )}
            <div className={styles.shotAiBody}>
              {shotAiTurns.length === 0 ? (
                <div className={styles.shotAiEmpty}>
                  <div style={{ marginBottom: 8 }}>根据分镜脚本生成参考图</div>
                  <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.6 }}>
                    当前：分镜{shots[shotAiIdx]?.shot_number} - {shots[shotAiIdx]?.title}<br/>
                    {shots[shotAiIdx]?.description && <span>{shots[shotAiIdx].description}</span>}
                  </div>
                </div>
              ) : (
                shotAiTurns.map(t => (
                  <div key={t.id} style={{ display: 'flex', justifyContent: t.role === 'user' ? 'flex-end' : 'flex-start' }}>
                    {t.loading ? (
                      <div style={{ maxWidth: '85%', background: '#f3f4f6', borderRadius: '14px 14px 14px 4px', padding: '8px 12px', fontSize: 13, color: '#6b7280' }}>正在生成图片…</div>
                    ) : t.error ? (
                      <div style={{ maxWidth: '85%', background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: '14px 14px 14px 4px', padding: '8px 12px', fontSize: 13 }}>{t.error}</div>
                    ) : t.image ? (
                      <div style={{ maxWidth: '85%', display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <img src={t.image} style={{ width: '100%', maxWidth: 280, borderRadius: 8, border: '1px solid #e5e7eb' }} />
                        <button onClick={() => shotAiUseImage(t.image!)} style={{ alignSelf: 'flex-start', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
                          使用为分镜{shots[shotAiIdx]?.shot_number}参考图
                        </button>
                      </div>
                    ) : (
                      <div style={{ maxWidth: '80%', background: '#2563eb', color: '#fff', borderRadius: '14px 14px 4px 14px', padding: '8px 12px', fontSize: 13, lineHeight: 1.5 }}>{t.text}</div>
                    )}
                  </div>
                ))
              )}
              <div ref={shotAiBottomRef} />
            </div>
            {/* Input row */}
            <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, padding: '12px 16px', borderTop: '1px solid #e5e7eb' }}>
              <textarea
                rows={1}
                style={{ flex: 1, resize: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 10px', fontSize: 13, lineHeight: 1.4, outline: 'none', minHeight: 36 }}
                value={shotAiInput}
                onChange={e => setShotAiInput(e.target.value)}
                onFocus={e => { e.target.style.borderColor = '#2563eb'; }}
                onBlur={e => { e.target.style.borderColor = '#d1d5db'; }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); shotAiSend(shotAiInput); } }}
                disabled={shotAiBusy}
                placeholder={shotAiLastImage ? '继续修改参考图…' : `描述分镜${shots[shotAiIdx]?.shot_number}的画面…`}
              />
              <button onClick={() => shotAiSend(shotAiInput)} disabled={shotAiBusy || !shotAiInput.trim()}
                style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '0 14px', fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap', minHeight: 36, opacity: (shotAiBusy || !shotAiInput.trim()) ? 0.5 : 1 }}>
                发送
              </button>
            </div>
            {/* Auto-generate button */}
            {shotAiTurns.length === 0 && (
              <div style={{ padding: '0 16px 12px' }}>
                <button onClick={() => {
                  const shot = shots[shotAiIdx];
                  const subjectInfo = videoSubjects.length > 0 ? `\n角色：${videoSubjects.map(s => `${s.label}${s.description ? '(' + s.description + ')' : ''}`).join('、')}` : '';
                  const prompt = `根据以下分镜脚本生成一张参考图：\n标题：${shot.title}\n描述：${shot.description}\n视频提示词：${shot.prompt || ''}\n情绪：${shot.mood || '无'}\n镜头：${shot.shot_size || '中景'}${subjectInfo}\n\n请生成符合以上分镜描述的画面，人物形象参考附图`;
                  shotAiSend(prompt);
                }}
                  style={{ width: '100%', padding: '8px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 6, fontSize: 13, color: '#166534', cursor: 'pointer', fontWeight: 500 }}>
                  一键根据脚本生成
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* AI改写对白剧本浮窗：上半是当前剧本（改写中切成流式预览），下半是改写要求输入框。
          流式预览没被采用之前不覆盖正文，避免改写跑偏还是把原稿搭进去。 */}
      {rewriteOpen && typeof document !== 'undefined' && createPortal(
        <div onClick={closeRewriteModal} className={styles.rwOverlay}>
          <div onClick={e => e.stopPropagation()} className={styles.rwSheet}>
            <div className={styles.rwHead}>
              <span className={styles.rwIcon}>✎</span>
              <div style={{ minWidth: 0 }}>
                <div className={styles.rwTitle}>AI 改写对白剧本</div>
                <div className={styles.rwSub}>说清要改什么，结果先预览，采用后才写回正文</div>
              </div>
              <button type="button" onClick={closeRewriteModal} disabled={rewritingScript}
                className={styles.rwClose} title="关闭">×</button>
            </div>

            <div className={styles.rwBody}>
              <div>
                <p className={styles.rwLabel}>
                  {rewritingScript ? '正在按要求改写…' : (rewritePreview ? '改写结果' : '当前对白剧本')}
                  {rewritePreview && !rewritingScript && <span className={styles.rwLabelTag}>未采用</span>}
                </p>
                <textarea
                  ref={rewritePreviewBoxRef}
                  readOnly
                  value={rewritingScript || rewritePreview ? rewritePreview : dialogueScript}
                  rows={12}
                  className={styles.rwDoc}
                />
              </div>

              <div>
                <p className={styles.rwLabel}>改写要求</p>
                <textarea
                  value={rewriteInstruction}
                  onChange={e => setRewriteInstruction(e.target.value)}
                  disabled={rewritingScript}
                  rows={3}
                  placeholder="例如：把结尾改成开放式结局 / 给男主角加一句反驳的台词 / 把语气改得更轻松一点…"
                  className={styles.rwInput}
                />
                <div className={styles.rwChips}>
                  {REWRITE_PRESETS.map(t => (
                    <button key={t} type="button" className={styles.rwChip} disabled={rewritingScript}
                      onClick={() => setRewriteInstruction(prev => prev.trim() ? prev.trim() + '；' + t : t)}>
                      {t}
                    </button>
                  ))}
                </div>
                {rewriteError && (
                  <p className={styles.rwErr}><span aria-hidden="true">⚠</span><span>{rewriteError}</span></p>
                )}
              </div>
            </div>

            <div className={styles.rwFoot}>
              {(rewritingScript || rewritePreview) && (
                <span className={styles.rwHint}>
                  {rewritingScript ? '生成中，别关窗' : '满意就点「采用」，不满意可改要求再来一次'}
                </span>
              )}
              {rewritePreview && !rewritingScript && (
                <button type="button" onClick={applyRewrittenScript}
                  className={`${styles.rwBtn} ${styles.rwBtnApply}`}>
                  采用改写结果
                </button>
              )}
              <button type="button" onClick={handleRewriteScript}
                disabled={rewritingScript || !rewriteInstruction.trim()}
                className={`${styles.rwBtn} ${styles.rwBtnPrimary}`}>
                {rewritingScript && <span className={styles.spinner} style={{ width: 12, height: 12, borderColor: 'rgba(255,255,255,.45)', borderTopColor: '#fff' }} />}
                {rewritingScript ? '改写中…' : (rewritePreview ? '重新改写' : '开始改写')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 素材库浮窗：方舟体验中心的预设素材，点一下就进「参考素材」拿到 @视频N / @音频N / @图片N 编号。
          经 createPortal 挂到 body —— 页面有 sticky 头部和 overflow 容器，挂在原处会被裁掉。 */}
      {libOpen && typeof document !== 'undefined' && createPortal(
        <div onClick={() => setLibOpen(false)} className={styles.libOverlay}>
          <div onClick={e => e.stopPropagation()} className={styles.libSheet}>
            <div className={styles.libHeader}>
              <strong style={{ fontSize: 14 }} className={styles.libTitle}>素材库</strong>
              <button type="button" onClick={() => setLibOpen(false)}
                style={{ background: 'none', border: 'none', fontSize: 20, color: '#9ca3af', cursor: 'pointer', lineHeight: 1, padding: '0 4px' }}>×</button>
              <span className={styles.libTabs}>
                {([['video', `视频 ${videoPresets.length}`], ['audio', `音频 ${voicePresets.length}`], ['image', `图片 ${imagePresets.length}`]] as const).map(([k, label]) => (
                  <button key={k} type="button" onClick={() => { setLibTab(k); setLibQuery(''); }}
                    style={{ fontSize: 12, padding: '4px 12px', borderRadius: 999, cursor: 'pointer', whiteSpace: 'nowrap', border: libTab === k ? '1px solid #0891b2' : '1px solid #e5e7eb', background: libTab === k ? '#ecfeff' : '#fff', color: libTab === k ? '#0891b2' : '#6b7280' }}>
                    {label}
                  </button>
                ))}
              </span>
              <input value={libQuery} onChange={e => setLibQuery(e.target.value)} placeholder="搜索（如 运镜 / 青年 女 / 旗袍）"
                className={styles.libSearch} />
            </div>

            <div className={styles.libBody}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                <input
                  value={libUrlInput}
                  onChange={e => setLibUrlInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addUrlMedia(libTab, libUrlInput); }}
                  placeholder={`粘贴${MEDIA_ZH[libTab]}直链（http/https），回车或点添加`}
                  style={{ flex: 1, fontSize: 12, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 4 }}
                />
                <button type="button" onClick={() => addUrlMedia(libTab, libUrlInput)} disabled={!libUrlInput.trim()}
                  style={{ fontSize: 12, padding: '0 12px', border: '1px solid #0891b2', borderRadius: 4, background: '#fff', color: libUrlInput.trim() ? '#0891b2' : '#a5f3fc', cursor: libUrlInput.trim() ? 'pointer' : 'default', flexShrink: 0 }}>
                  添加
                </button>
              </div>
              {(() => {
                const match = (name: string, category: string) => {
                  const q = libQuery.trim();
                  if (!q) return true;
                  return q.split(/\s+/).every(w => name.includes(w) || category.includes(w));
                };
                // 存量素材可能存着 %XX 转义版的同一条地址，比对前归一
                const picked = (url: string) => mediaItems.some(m => prettyUrl(m.url || '') === url);

                if (libTab === 'audio') {
                  const list = voicePresets.filter(v => match(v.name, v.category));
                  return (
                    <div className={styles.libGridAudio}>
                      {list.map(v => (
                        <div key={v.url} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 7px', borderRadius: 6, fontSize: 12, background: picked(v.url) ? '#ecfeff' : '#f9fafb', border: picked(v.url) ? '1px solid #0891b2' : '1px solid transparent' }}>
                          {v.avatar && <img src={v.avatar} alt="" style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover' }} />}
                          <span onClick={() => addPresetMedia('audio', v)} style={{ flex: 1, cursor: 'pointer', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
                          <span style={{ fontSize: 10, color: '#9ca3af' }}>{v.duration}</span>
                          <button type="button" onClick={() => { previewAudioRef.current?.pause(); const a = new Audio(v.url); previewAudioRef.current = a; a.play().catch(() => {}); }}
                            style={{ fontSize: 11, padding: '4px 10px', border: '1px solid #cbd5e1', borderRadius: 4, background: '#fff', color: '#475569', cursor: 'pointer', flexShrink: 0 }}>试听</button>
                        </div>
                      ))}
                      {list.length === 0 && <p style={{ fontSize: 12, color: '#9ca3af' }}>没有匹配的音色</p>}
                    </div>
                  );
                }

                const list = (libTab === 'video' ? videoPresets : imagePresets).filter(v => match(v.name, v.category));
                return (
                  <div className={styles.libGrid}>
                    {list.map(v => (
                      <div key={v.url} onClick={() => addPresetMedia(libTab, v)}
                        style={{ cursor: 'pointer', borderRadius: 6, overflow: 'hidden', border: picked(v.url) ? '2px solid #0891b2' : '1px solid #e5e7eb', background: '#f9fafb' }}>
                        <img src={v.thumb} alt={v.name} loading="lazy"
                          style={{ width: '100%', aspectRatio: '3 / 4', objectFit: 'cover', display: 'block', background: '#e5e7eb' }} />
                        <div style={{ padding: '4px 6px' }}>
                          <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</div>
                          <div style={{ fontSize: 10, color: '#9ca3af' }}>{v.category}{picked(v.url) ? ' · 已加入' : ''}</div>
                        </div>
                      </div>
                    ))}
                    {list.length === 0 && <p style={{ fontSize: 12, color: '#9ca3af' }}>没有匹配的素材</p>}
                  </div>
                );
              })()}
            </div>

            <div className={styles.libFoot}>
              点一下即加入「参考素材」，编号按加入顺序排（@视频N / @音频N / @图片N）。
              上限：图 {mediaLimit('image')}（角色头像已占 {subjectImageCount} 个）/ 视频 {mediaLimit('video')} / 音频 {mediaLimit('audio')}。
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 换头像浮窗：真人头像（认证，只能经活体验证入库）/ 虚拟头像 两个 tab，同样经 createPortal 挂到 body */}
      {avatarPickerIdx !== null && typeof document !== 'undefined' && createPortal(
        <div onClick={() => setAvatarPickerIdx(null)} className={styles.libOverlay}>
          <div onClick={e => e.stopPropagation()} className={styles.libSheet}>
            <div className={styles.libHeader}>
              <strong style={{ fontSize: 14 }} className={styles.libTitle}>换头像</strong>
              <button type="button" onClick={refreshAvatars} disabled={avatarLoading}
                style={{ fontSize: 11, padding: '3px 8px', border: '1px solid #e5e7eb', borderRadius: 4, background: '#fff', color: avatarLoading ? '#c4b5fd' : '#7c3aed', cursor: avatarLoading ? 'default' : 'pointer' }}>
                {avatarLoading ? '刷新中…' : '刷新'}
              </button>
              <button type="button" onClick={() => setAvatarPickerIdx(null)}
                style={{ background: 'none', border: 'none', fontSize: 20, color: '#9ca3af', cursor: 'pointer', lineHeight: 1, padding: '0 4px' }}>×</button>
              <span className={styles.libTabs}>
                {([['real', `真人头像 ${realAvatars.length}`], ['virtual', `虚拟头像 ${virtualAvatars.length}`]] as const).map(([k, label]) => (
                  <button key={k} type="button" onClick={() => { setAvatarPickerTab(k); setAvatarSearch(''); }}
                    style={{ fontSize: 12, padding: '4px 12px', borderRadius: 999, cursor: 'pointer', whiteSpace: 'nowrap', border: avatarPickerTab === k ? '1px solid #7c3aed' : '1px solid #e5e7eb', background: avatarPickerTab === k ? '#f5f3ff' : '#fff', color: avatarPickerTab === k ? '#7c3aed' : '#6b7280' }}>
                    {label}
                  </button>
                ))}
              </span>
              <input value={avatarSearch} onChange={e => setAvatarSearch(e.target.value)} placeholder="搜索头像名称…"
                className={styles.libSearch} />
            </div>

            <div className={styles.libBody}>
              {(() => {
                const list = avatarPickerTab === 'real' ? realAvatars : virtualAvatars;
                const q = avatarSearch.trim();
                const filtered = q ? list.filter(a => (a.Name || '').includes(q)) : list;
                if (filtered.length === 0) {
                  return (
                    <p style={{ fontSize: 12, color: '#9ca3af' }}>
                      暂无{avatarPickerTab === 'real' ? '真人' : '虚拟'}头像，先到{' '}
                      <a href={avatarPickerTab === 'real' ? '/assets/real' : '/assets/virtual'} style={{ color: '#7c3aed' }}>资源管理</a> 添加
                    </p>
                  );
                }
                return (
                  <div className={styles.libGrid}>
                    {filtered.map(asset => {
                      const thumb = asset.PreviewUrl || asset._thumbnail_url || asset.URL;
                      return (
                        <div key={asset.Id} onClick={() => assignAssetAvatar(avatarPickerIdx as number, asset)}
                          style={{ cursor: 'pointer', borderRadius: 6, overflow: 'hidden', border: '1px solid #e5e7eb', background: '#f9fafb' }}>
                          {thumb
                            ? <img src={thumb} alt={asset.Name || ''} loading="lazy" style={{ width: '100%', aspectRatio: '3 / 4', objectFit: 'cover', display: 'block', background: '#e5e7eb' }} />
                            : <div style={{ width: '100%', aspectRatio: '3 / 4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>👤</div>}
                          <div style={{ padding: '4px 6px', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asset.Name || asset.Id.slice(0, 8)}</div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            <div className={styles.libFoot}>
              只显示已认证的真人头像（经活体验证入库）和虚拟头像，点一下即为该角色换头像。
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
