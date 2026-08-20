'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
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
}

interface InsuranceCase {
  id: number; title: string; tags: string[];
  description: string; insurance_needs: string | null;
}

// Two orthogonal axes, matching the backend contract:
//   video_type          叙事短片 story | 解说纪录片 narration — narration wins outright
//   narrative_structure 自由 free    | 起承转合 qczh        — only meaningful for 叙事短片
export type VideoType = 'story' | 'narration';
export type Narrative = 'free' | 'qczh';

const VIDEO_TYPES: { value: VideoType; label: string; desc: string }[] = [
  { value: 'story',     label: '叙事短片',   desc: '画面叙事，每镜产出英文提示词与首末帧' },
  { value: 'narration', label: '解说纪录片', desc: '全程旁白配音 + B-roll 画面，每镜产出可直接配音的文案' },
];

const NARRATIVES: { value: Narrative; label: string; desc: string }[] = [
  { value: 'free', label: '自由分镜', desc: '开头钩子 → 中段发展 → 结尾收束' },
  { value: 'qczh', label: '起承转合', desc: '古典四段结构，「转」是记忆点，「合」呼应「起」' },
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
  }));
}

interface Props {
  /** Seeds 视频概念描述 when the host does NOT control it. */
  initialConcept?: string;
  /**
   * Controlled 视频概念描述. Pass this when the host page already shows a
   * 视频概念描述 box (voiceover-v3 does) — the panel then drops its own field and
   * reads/writes the page's, so the concept is never entered twice.
   * `onConceptChange` is what 从港险案例库取材 writes back through.
   */
  concept?: string;
  onConceptChange?: (v: string) => void;
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
  concept: controlledConcept, onConceptChange,
  open: controlledOpen, onOpenChange, hideTrigger = false, onGenerated,
}: Props) {
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
  const setConcept = (v: string) => {
    if (!conceptControlled) setOwnConcept(v);
    onConceptChange?.(v);
  };
  const [goal, setGoal]             = useState('');
  const [audience, setAudience]     = useState('');
  const [tone, setTone]             = useState('');
  const [keyMessages, setKeyMsg]    = useState('');
  const [shotCount, setShotCount]   = useState(5);
  const [durationTotal, setDurTotal] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [preview, setPreview] = useState<{ sb: Storyboard; drafts: ShotDraft[] } | null>(null);

  // 港险案例取材
  const [casesOpen, setCasesOpen] = useState(false);
  const [caseQuery, setCaseQuery] = useState('');
  const [cases, setCases]         = useState<InsuranceCase[] | null>(null);
  const [casesLoading, setCasesLoading] = useState(false);

  const searchCases = useCallback(async (q: string) => {
    setCasesLoading(true);
    try {
      const res = await api.get<{ Items: InsuranceCase[] }>(
        `/library/cases?page_size=15${q ? `&q=${encodeURIComponent(q)}` : ''}`
      );
      setCases(res.Items || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '案例检索失败');
    } finally {
      setCasesLoading(false);
    }
  }, []);

  function openCases() {
    const next = !casesOpen;
    setCasesOpen(next);
    if (next && !cases) searchCases('');
  }

  async function pickCase(c: InsuranceCase) {
    try {
      const full = await api.get<InsuranceCase & { content?: string; budget_suggestion?: string }>(`/library/cases/${c.id}`);
      setConcept(full.description || c.description || c.title);
      if (!keyMessages && full.insurance_needs) setKeyMsg(full.insurance_needs);
      if (!audience && full.tags?.length) setAudience(full.tags.join('、'));
      setVideoType('narration'); // 案例讲解天然适配解说纪录片
      setCasesOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '案例读取失败');
    }
  }

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

  return (
    <div className={styles.wrap}>
      {!hideTrigger && (
        <button type="button" className={styles.trigger} onClick={togglePanel}>
          🎬 专业分镜生成
        </button>
      )}

      {open && (
        <div className={styles.panel}>
          {!controlled && (
          <div className={styles.axis}>
            <span className={styles.axisLabel}>视频类型</span>
            <div className={styles.structRow}>
              {VIDEO_TYPES.map(v => (
                <label key={v.value} className={`${styles.struct} ${videoType === v.value ? styles.structActive : ''}`}>
                  <input type="radio" name="sbVideoType" value={v.value}
                    checked={videoType === v.value}
                    onChange={() => setVideoType(v.value)} />
                  <span className={styles.structLabel}>{v.label}</span>
                  <span className={styles.structDesc}>{v.desc}</span>
                </label>
              ))}
            </div>
          </div>
          )}

          {videoType === 'story' && (
            <div className={styles.axis}>
              <span className={styles.axisLabel}>叙事结构</span>
              <div className={styles.structRow}>
                {NARRATIVES.map(n => (
                  <label key={n.value} className={`${styles.struct} ${narrative === n.value ? styles.structActive : ''}`}>
                    <input type="radio" name="sbNarrative" value={n.value}
                      checked={narrative === n.value}
                      onChange={() => setNarrative(n.value)} />
                    <span className={styles.structLabel}>{n.label}</span>
                    <span className={styles.structDesc}>{n.desc}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {conceptControlled ? (
            // The page's own 视频概念描述 box is the single source — don't ask twice.
            <div className={styles.conceptRef}>
              <span className={styles.conceptRefLabel}>
                概念取自上方「视频概念描述」
                {!concept.trim() && <span className={styles.conceptRefWarn}>（尚未填写）</span>}
              </span>
              <button type="button" className={styles.linkBtn} onClick={openCases}>
                {casesOpen ? '收起案例库' : '从港险案例库取材'}
              </button>
            </div>
          ) : (
            <div className={styles.field}>
              <div className={styles.fieldHead}>
                <label>视频概念描述 <span className={styles.req}>*</span></label>
                <button type="button" className={styles.linkBtn} onClick={openCases}>
                  {casesOpen ? '收起案例库' : '从港险案例库取材'}
                </button>
              </div>
              <textarea rows={3} value={concept} onChange={e => setConcept(e.target.value)}
                placeholder="这条视频要讲什么？例如：一位年轻插画师在雨天的咖啡馆里完成一幅画" />
            </div>
          )}

          {casesOpen && (
            <div className={styles.cases}>
              <div className={styles.caseSearch}>
                <input value={caseQuery} onChange={e => setCaseQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') searchCases(caseQuery); }}
                  placeholder="搜索案例标题或描述，回车检索" />
                <button type="button" onClick={() => searchCases(caseQuery)}>搜索</button>
              </div>
              {casesLoading && <div className={styles.status}>检索中…</div>}
              <div className={styles.caseList}>
                {(cases || []).map(c => (
                  <button key={c.id} type="button" className={styles.caseItem} onClick={() => pickCase(c)}>
                    <span className={styles.caseTitle}>{c.title}</span>
                    {c.tags?.length > 0 && (
                      <span className={styles.caseTags}>{c.tags.slice(0, 3).join(' · ')}</span>
                    )}
                  </button>
                ))}
                {!casesLoading && cases && cases.length === 0 && (
                  <div className={styles.status}>没有匹配的案例</div>
                )}
              </div>
            </div>
          )}

          <div className={styles.grid2}>
            <div className={styles.field}><label>创作目标</label>
              <input value={goal} onChange={e => setGoal(e.target.value)} placeholder="想让观众获得什么" /></div>
            <div className={styles.field}><label>目标受众</label>
              <input value={audience} onChange={e => setAudience(e.target.value)} placeholder="给谁看" /></div>
            <div className={styles.field}><label>整体基调</label>
              <input value={tone} onChange={e => setTone(e.target.value)} placeholder="温暖 / 悬念 / 专业…" /></div>
            <div className={styles.field}><label>核心信息</label>
              <input value={keyMessages} onChange={e => setKeyMsg(e.target.value)} placeholder="必须传达的要点" /></div>
            <div className={styles.field}><label>镜头数</label>
              <input type="number" min={1} max={20} value={shotCount}
                onChange={e => setShotCount(Math.min(20, Math.max(1, parseInt(e.target.value, 10) || 1)))} />
              {videoType === 'story' && narrative === 'qczh' && shotCount < 4 && (
                <span className={styles.note}>起承转合至少 4 个镜头，后端会自动补足</span>
              )}
            </div>
            <div className={styles.field}><label>总时长</label>
              <input value={durationTotal} onChange={e => setDurTotal(e.target.value)} placeholder="如 30s（可留空）" /></div>
          </div>

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

          {preview && (
            <div className={styles.preview}>
              {preview.sb.title && <div className={styles.pvTitle}>{preview.sb.title}
                {preview.sb.total_duration && <span className={styles.pvDur}>{preview.sb.total_duration}</span>}</div>}
              {preview.sb.narrative_summary && <div className={styles.pvSummary}>{preview.sb.narrative_summary}</div>}
              <ol className={styles.pvList}>
                {preview.drafts.map((d, i) => (
                  <li key={i} className={styles.pvShot}>
                    <div className={styles.pvHead}>
                      <span className={styles.pvNum}>{i + 1}</span>
                      {d.shot_type && <span className={styles.pvTag}>{d.shot_type}</span>}
                      {d.camera_movement && <span className={styles.pvTag}>{d.camera_movement}</span>}
                      <span className={styles.pvTag}>{d.duration}s</span>
                    </div>
                    <div className={styles.pvDesc}>{d.description}</div>
                    {d.subtitle && <div className={styles.pvNarration}>🎙 {d.subtitle}</div>}
                    <div className={styles.pvPrompt}>{d.prompt}</div>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
