'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import styles from './StoryboardGenerator.module.css';

// ─── Shapes returned by POST /prompt/storyboard ───────────────────────────────

interface GeneratedShot {
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
  narration_script?: string; // 旁白解说模式专有
  stage?: string;            // 起承转合模式专有
  image_refs?: number[];     // 后端从 prompt_en 的 <图片N> 解析出来
}
interface Storyboard {
  title?: string;
  total_duration?: string;
  narrative_summary?: string;
  shots: GeneratedShot[];
}

/** The shot payload POST /videos/:id/shots accepts. */
export interface ShotDraft {
  title: string;
  description: string;
  prompt: string;
  subtitle: string;
  duration: number;
  shot_type: string;
  lighting: string;
  camera_movement: string;
  /** 1-based 素材编号，对应 prompt 里的 <图片N>；宿主据此把角色挂到分镜上。 */
  imageRefs: number[];
}

// Two orthogonal axes, matching the backend contract:
//   video_type          叙事短片 story | 解说纪录片 narration — narration wins outright
//   narrative_structure 自由 free    | 起承转合 qczh        — only meaningful for 叙事短片
export type VideoType = 'story' | 'narration';
export type Narrative = 'free' | 'qczh';

const VIDEO_TYPES: { value: VideoType; label: string }[] = [
  { value: 'story',     label: '叙事短片（画面驱动叙事）' },
  { value: 'narration', label: '解说纪录片（旁白+字幕+B-roll）' },
];

// Option values are the English phrases the original app fed straight into the
// prompt (创作目标：brand storytelling, …) — keep them English, the model uses them.
const CREATIVE_GOALS: { value: string; label: string }[] = [
  { value: '',                                                    label: '-- 选择目标 --' },
  { value: 'brand storytelling, emotional connection',            label: '品牌故事/情感共鸣' },
  { value: 'product showcase, highlight features',                label: '产品展示/功能演示' },
  { value: 'documentary narrative, authentic',                    label: '纪录片叙事/真实记录' },
  { value: 'advertisement, hook viewer, drive conversion',        label: '广告/钩子+转化' },
  { value: 'artistic expression, visual poetry',                  label: '艺术表达/视觉诗意' },
  { value: 'social media short, fast paced',                      label: '社交媒体短视频/快节奏' },
];

const TONES: { value: string; label: string }[] = [
  { value: '',                          label: '-- 选择基调 --' },
  { value: 'cinematic and emotional',   label: '电影感·情感' },
  { value: 'energetic and dynamic',     label: '活力·动感' },
  { value: 'calm and contemplative',    label: '宁静·沉思' },
  { value: 'epic and grand',            label: '史诗·宏大' },
  { value: 'warm and nostalgic',        label: '温暖·怀旧' },
  { value: 'dark and mysterious',       label: '暗黑·神秘' },
  { value: 'bright and commercial',     label: '明亮·商业感' },
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

const NARRATIVES: { value: Narrative; label: string }[] = [
  { value: 'free', label: '自由结构（AI 自由创作）' },
  { value: 'qczh', label: '起承转合（经典四段式叙事）' },
];

/** "5s" / "8-10s" / "约5秒" → a number the shots table can store. */
function parseDuration(d: string | undefined, fallback = 5): number {
  const m = String(d ?? '').match(/(\d+(?:\.\d+)?)/);
  const n = m ? parseFloat(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toDrafts(sb: Storyboard, videoType: VideoType): ShotDraft[] {
  return (sb.shots || []).map((s, i) => ({
    // 解说纪录片 puts the finished voiceover copy in narration_script; the other
    // structures have no spoken line, so subtitle stays empty for the user to fill.
    title: s.stage || `分镜 ${s.shot_number ?? i + 1}`,
    description: s.description_zh || '',
    prompt: s.prompt_en || '',
    subtitle: videoType === 'narration' ? (s.narration_script || '') : '',
    duration: parseDuration(s.duration),
    shot_type: s.shot_type || '',
    lighting: s.lighting || '',
    camera_movement: s.camera_move || '',
    imageRefs: Array.isArray(s.image_refs) ? s.image_refs : [],
  }));
}

interface Props {
  /** Seeds 视频概念描述 when the host does NOT control it. */
  initialConcept?: string;
  /**
   * 已绑定的角色与参考素材，两段文本原样喂给模型，让它在 prompt_en 里用
   * <图片N> 锚定角色 —— 没有这个，生成的提示词认不出已上传的人像。
   */
  subjectDefinitions?: string;
  imageDescriptions?: string;
  /**
   * Controlled 视频概念描述, read-only. Pass this when the host page already
   * shows a 视频概念描述 box (voiceover-v3 does) — the panel then drops its own
   * field entirely and reads the page's, so the concept is never entered twice.
   */
  concept?: string;
  /**
   * Controls 视频类型 from the parent. Pass this when the host page already has
   * its own 叙事短片/解说纪录片 selector (voiceover-v3 does) so the two can't disagree —
   * the component then hides its own radio.
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
  /** Receives the mapped shots; the parent persists them. */
  onGenerated: (shots: ShotDraft[], meta: { title?: string; summary?: string; videoType: VideoType; narrative: Narrative }) => Promise<void> | void;
}

export default function StoryboardGenerator({
  initialConcept = '', videoType: controlledType,
  concept: controlledConcept, subjectDefinitions, imageDescriptions,
  open: controlledOpen, onOpenChange, hideTrigger = false, onGenerated,
}: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (v: boolean) => { if (controlledOpen === undefined) setOwnOpen(v); onOpenChange?.(v); };
  const [ownType, setOwnType] = useState<VideoType>('story');
  const [narrative, setNarrative] = useState<Narrative>('free');

  const controlled = controlledType !== undefined;
  const videoType = controlled ? controlledType : ownType;
  const setVideoType = (v: VideoType) => { if (!controlled) setOwnType(v); };

  const [ownConcept, setOwnConcept] = useState(initialConcept);
  const conceptControlled = controlledConcept !== undefined;
  const concept = conceptControlled ? controlledConcept : ownConcept;
  const setConcept = (v: string) => { if (!conceptControlled) setOwnConcept(v); };
  const [goal, setGoal]             = useState('');
  const [audience, setAudience]     = useState('');
  const [tone, setTone]             = useState('');
  const [keyMessages, setKeyMsg]    = useState('');
  const [shotCount, setShotCount]   = useState(5);
  const [durationTotal, setDurTotal] = useState('30s');

  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [preview, setPreview] = useState<{ sb: Storyboard; drafts: ShotDraft[] } | null>(null);

  async function generate() {
    if (!concept.trim()) { setError('请输入视频概念描述'); return; }
    setLoading(true); setError(''); setPreview(null);
    try {
      const res = await api.post<{ result: Storyboard; usage: { input: number; output: number } }>(
        '/prompt/storyboard',
        {
          concept: concept.trim(),
          creative_goal: goal.trim(),
          target_audience: audience.trim(),
          overall_tone: tone.trim(),
          key_messages: keyMessages.trim(),
          shot_count: shotCount,
          duration_total: durationTotal.trim(),
          narrative_structure: narrative,
          video_type: videoType,
          subject_definitions: subjectDefinitions || '',
          image_descriptions: imageDescriptions || '',
        }
      );
      const sb = res.result;
      setPreview({ sb, drafts: toDrafts(sb, videoType) });
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败');
    } finally {
      setLoading(false);
    }
  }

  async function applyPreview() {
    if (!preview) return;
    setLoading(true);
    try {
      await onGenerated(preview.drafts, {
        title: preview.sb.title,
        summary: preview.sb.narrative_summary,
        videoType,
        narrative,
      });
      setPreview(null);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败');
    } finally {
      setLoading(false);
    }
  }

  // initialConcept is captured at mount, but the panel mounts with the page — the
  // script is usually still empty then. Re-seed on open, without clobbering an
  // edited concept.
  function togglePanel() { setOpen(!open); }

  // Re-seed whenever the panel becomes visible, however it was opened. Only for
  // the uncontrolled field — a host-controlled concept is already live.
  const seededRef = useRef(false);
  useEffect(() => {
    if (conceptControlled) return;
    if (!open) { seededRef.current = false; return; }
    if (seededRef.current) return;
    seededRef.current = true;
    if (!ownConcept.trim() && initialConcept.trim()) setOwnConcept(initialConcept);
  }, [open, conceptControlled, ownConcept, initialConcept]);

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
            {!conceptControlled && (
              <div className={styles.field}>
                <label>视频概念描述 <span className={styles.req}>*</span></label>
                <textarea rows={3} value={concept} onChange={e => setConcept(e.target.value)}
                  placeholder="这条视频要讲什么？例如：一位年轻插画师在雨天的咖啡馆里完成一幅画" />
              </div>
            )}

            <div className={styles.fieldGrid}>
              {!controlled && (
                <div className={styles.field}><label>视频类型</label>
                  <select value={videoType} onChange={e => setVideoType(e.target.value as VideoType)}>
                    {VIDEO_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              )}
              {videoType === 'story' && (
                <div className={styles.field}><label>叙事结构</label>
                  <select value={narrative} onChange={e => setNarrative(e.target.value as Narrative)}>
                    {NARRATIVES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
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

              {preview && (
                <button type="button" className={styles.apply} onClick={applyPreview} disabled={loading}>
                  导入 {preview.drafts.length} 个分镜
                </button>
              )}
        </div>

        <div className={styles.dialogFoot}>
            {error && <div className={styles.errorBox}>{error}</div>}
            <div className={styles.actions}>
              <button type="button" className={styles.primary} onClick={generate} disabled={loading || !concept.trim()}>
                {loading ? '生成中…' : preview ? '重新生成' : '生成分镜脚本'}
              </button>
              {preview && (
                <button type="button" className={styles.apply} onClick={applyPreview} disabled={loading}>
                  导入 {preview.drafts.length} 个分镜
                </button>
              )}
            </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className={styles.wrap}>
      {!hideTrigger && (
        <button type="button" className={styles.trigger} onClick={togglePanel}>
          🎬 专业分镜生成
        </button>
      )}
      {/* Portalled so page-level sticky headers / overflow containers can't clip it. */}
      {/* Floating, not modal: no dim layer, page stays scrollable behind it. */}
      {mounted && open && createPortal(dialog, document.body)}
    </div>
  );
}
