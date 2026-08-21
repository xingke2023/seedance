'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import styles from './StoryboardGenerator.module.css';

// ─── Shapes returned by POST /prompt/storyboard ───────────────────────────────

export interface GeneratedShot {
  shot_number: number;
  duration: string;          // "5s"
  shot_type: string;
  camera_move: string;
  composition: string;
  lighting: string;
  color_tone: string;
  description_zh: string;
  prompt_en: string;
  first_frame?: string;
  last_frame?: string;
  narration_script?: string; // 解说纪录片专有
  subtitle?: string;         // 叙事短片的台词，后端第二步补上
  voice_style?: string;      // 解说纪录片逐镜情绪，驱动 Azure express-as
  stage?: string;            // 起承转合专有
  image_refs?: number[];     // 后端从 prompt_en 的 @图片N 解析出来
  roll_type?: 'a_roll' | 'b_roll';
}
export interface Storyboard {
  title?: string;
  total_duration?: string;
  narrative_summary?: string;
  shots: GeneratedShot[];
}

/** Shot fields a host writes onto its own shot record. */
export interface ShotDraft {
  title: string;
  description: string;
  prompt: string;
  subtitle: string;
  duration: number;
  shot_type: string;
  lighting: string;
  camera_movement: string;
  /** 1-based 素材编号，对应 prompt 里的 @图片N；宿主据此把角色挂到分镜上。 */
  imageRefs: number[];
  /** a_roll = 画面里有人正对镜头说话；其余都是 b_roll。 */
  rollType: 'a_roll' | 'b_roll';
  /** 解说纪录片逐镜情绪，转成 Azure 的 express-as；叙事短片为空。 */
  voiceStyle: string;
}

// Two orthogonal axes, matching the backend contract:
//   video_type          叙事短片 story | 解说纪录片 narration — narration wins outright
//   narrative_structure 自由 free    | 起承转合 qczh        — only meaningful for 叙事短片
export type VideoType = 'story' | 'narration';
export type Narrative = 'free' | 'qczh';

/** Everything the panel collects. The host owns generation and passes these on. */
export interface StoryboardSettings {
  videoType: VideoType;
  narrative: Narrative;
  creativeGoal: string;
  audience: string;
  tone: string;
  keyMessages: string;
  shotCount: number;
  durationTotal: string;
}

export const DEFAULT_STORYBOARD_SETTINGS: StoryboardSettings = {
  videoType: 'story', narrative: 'free', creativeGoal: '', audience: '',
  tone: '', keyMessages: '', shotCount: 5, durationTotal: '30s',
};

const VIDEO_TYPES: { value: VideoType; label: string }[] = [
  { value: 'story',     label: '叙事短片（画面驱动叙事）' },
  { value: 'narration', label: '解说纪录片（旁白+字幕+B-roll）' },
];

// Option values are the English phrases the original app fed straight into the
// prompt (创作目标：brand storytelling, …) — keep them English, the model uses them.
const CREATIVE_GOALS: { value: string; label: string }[] = [
  { value: '',                                             label: '-- 选择目标 --' },
  { value: 'brand storytelling, emotional connection',     label: '品牌故事/情感共鸣' },
  { value: 'product showcase, highlight features',         label: '产品展示/功能演示' },
  { value: 'documentary narrative, authentic',             label: '纪录片叙事/真实记录' },
  { value: 'advertisement, hook viewer, drive conversion', label: '广告/钩子+转化' },
  { value: 'artistic expression, visual poetry',           label: '艺术表达/视觉诗意' },
  { value: 'social media short, fast paced',               label: '社交媒体短视频/快节奏' },
];

const TONES: { value: string; label: string }[] = [
  { value: '',                        label: '-- 选择基调 --' },
  { value: 'cinematic and emotional', label: '电影感·情感' },
  { value: 'energetic and dynamic',   label: '活力·动感' },
  { value: 'calm and contemplative',  label: '宁静·沉思' },
  { value: 'epic and grand',          label: '史诗·宏大' },
  { value: 'warm and nostalgic',      label: '温暖·怀旧' },
  { value: 'dark and mysterious',     label: '暗黑·神秘' },
  { value: 'bright and commercial',   label: '明亮·商业感' },
];

const DURATIONS: { value: string; label: string }[] = [
  { value: '15s', label: '15秒（3-4个镜头）' },
  { value: '30s', label: '30秒（5-6个镜头）' },
  { value: '60s', label: '60秒（8-10个镜头）' },
  { value: '90s', label: '90秒（12个镜头）' },
];

const SHOT_COUNTS: { value: number; label: string }[] = [
  { value: 3, label: '3个镜头' },
  { value: 4, label: '4个镜头（起承转合推荐）' },
  { value: 5, label: '5个镜头' },
  { value: 6, label: '6个镜头' },
  { value: 8, label: '8个镜头' },
];

/** "5s" / "8-10s" / "约5秒" → a number the shots table can store. */
export function parseDuration(d: string | undefined, fallback = 5): number {
  const m = String(d ?? '').match(/(\d+(?:\.\d+)?)/);
  const n = m ? parseFloat(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Map a /prompt/storyboard result onto shot fields. */
export function toShotDrafts(sb: Storyboard, videoType: VideoType): ShotDraft[] {
  return (sb.shots || []).map((s, i) => ({
    // 解说纪录片 的成品旁白在 narration_script；叙事短片的台词由后端第二步写进
    // subtitle（STORYBOARD / QCZH 本身不产台词字段）。
    title: s.stage || `分镜 ${s.shot_number ?? i + 1}`,
    description: s.description_zh || '',
    prompt: s.prompt_en || '',
    subtitle: videoType === 'narration' ? (s.narration_script || '') : (s.subtitle || ''),
    duration: parseDuration(s.duration),
    shot_type: s.shot_type || '',
    lighting: s.lighting || '',
    camera_movement: s.camera_move || '',
    imageRefs: Array.isArray(s.image_refs) ? s.image_refs : [],
    rollType: s.roll_type === 'a_roll' ? 'a_roll' : 'b_roll',
    voiceStyle: s.voice_style || '',
  }));
}

interface Props {
  /**
   * Controls 视频类型 from the parent. Pass this when the host page already has
   * its own 叙事短片/解说纪录片 selector (voiceover-v3 does) so the two can't
   * disagree — the panel then hides its own row.
   */
  videoType?: VideoType;
  /**
   * Controlled open state. Use with `hideTrigger` when the host renders the
   * button somewhere the panel can't follow — e.g. inside a <p> header row,
   * where nesting the panel's <div> would be invalid HTML.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  /** Fires on every change. The host stores these and generates on its own button. */
  onSettingsChange: (s: StoryboardSettings) => void;
}

/**
 * Settings panel for 专业分镜生成. It does not generate anything — the host page
 * owns the one 生成分镜脚本 button, so there is a single place a storyboard is
 * kicked off and these values simply ride along with it.
 */
export default function StoryboardGenerator({
  videoType: controlledType, open: controlledOpen, onOpenChange,
  hideTrigger = false, onSettingsChange,
}: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (v: boolean) => { if (controlledOpen === undefined) setOwnOpen(v); onOpenChange?.(v); };

  const [ownType, setOwnType] = useState<VideoType>('story');
  const controlled = controlledType !== undefined;
  const videoType = controlled ? controlledType : ownType;

  const [narrative, setNarrative]    = useState<Narrative>('free');
  const [goal, setGoal]              = useState('');
  const [audience, setAudience]      = useState('');
  const [tone, setTone]              = useState('');
  const [keyMessages, setKeyMsg]     = useState('');
  const [shotCount, setShotCount]    = useState(5);
  const [durationTotal, setDurTotal] = useState('30s');

  // Push settings up on every change, first paint included, so the host never
  // generates against stale defaults.
  useEffect(() => {
    onSettingsChange({
      videoType, narrative, creativeGoal: goal, audience, tone,
      keyMessages, shotCount, durationTotal,
    });
    // onSettingsChange is a host callback; re-running on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoType, narrative, goal, audience, tone, keyMessages, shotCount, durationTotal]);

  // Esc closes. No body scroll lock — it floats over the page rather than
  // blocking it, so the page underneath stays scrollable.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const dialog = (
    <div className={styles.backdrop}
      onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className={styles.dialog} role="dialog" aria-label="专业分镜生成">
        <div className={styles.dialogHead}>
          <span className={styles.dialogTitle}>🎬 专业分镜生成</span>
          <button type="button" className={styles.close} onClick={() => setOpen(false)} aria-label="关闭">×</button>
        </div>

        <div className={styles.dialogBody}>
          <div className={styles.fieldGrid}>
            {!controlled && (
              <div className={styles.field}><label>视频类型</label>
                <select value={videoType} onChange={e => setOwnType(e.target.value as VideoType)}>
                  {VIDEO_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            )}
            {videoType === 'story' && (
              <div className={styles.field}><label>叙事结构</label>
                <select value={narrative} onChange={e => setNarrative(e.target.value as Narrative)}>
                  <option value="free">自由结构（AI 自由创作）</option>
                  <option value="qczh">起承转合（经典四段式叙事）</option>
                </select>
              </div>
            )}
            <div className={styles.field}><label>创作目标</label>
              <select value={goal} onChange={e => setGoal(e.target.value)}>
                {CREATIVE_GOALS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className={styles.field}><label>整体基调</label>
              <select value={tone} onChange={e => setTone(e.target.value)}>
                {TONES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className={styles.field}><label>总时长</label>
              <select value={durationTotal} onChange={e => setDurTotal(e.target.value)}>
                {DURATIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className={styles.field}><label>镜头数量</label>
              <select value={shotCount} onChange={e => setShotCount(parseInt(e.target.value, 10))}>
                {SHOT_COUNTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {videoType === 'story' && narrative === 'qczh' && shotCount < 4 && (
                <span className={styles.note}>起承转合至少 4 镜，后端会补足</span>
              )}
            </div>
            <div className={`${styles.field} ${styles.fieldWide}`}><label>目标受众</label>
              <input value={audience} onChange={e => setAudience(e.target.value)}
                placeholder="例：25-35岁都市女性，热爱生活方式内容" /></div>
            <div className={`${styles.field} ${styles.fieldWide}`}><label>核心信息/卖点</label>
              <input value={keyMessages} onChange={e => setKeyMsg(e.target.value)}
                placeholder="例：品质感、自然材质、匠心工艺" /></div>
          </div>
        </div>

        <div className={styles.dialogFoot}>
          <span className={styles.footHint}>设置好后，点页面上的「生成分镜脚本」</span>
          <button type="button" className={styles.primary} onClick={() => setOpen(false)}>完成</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className={styles.wrap}>
      {!hideTrigger && (
        <button type="button" className={styles.trigger} onClick={() => setOpen(!open)}>
          🎬 专业分镜生成
        </button>
      )}
      {/* Portalled so page-level sticky headers / overflow containers can't clip it. */}
      {/* Floating, not modal: no dim layer, page stays scrollable behind it. */}
      {mounted && open && createPortal(dialog, document.body)}
    </div>
  );
}
