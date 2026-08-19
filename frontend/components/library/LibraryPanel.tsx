'use client';

import { useState, useCallback } from 'react';
import { api } from '@/lib/api';
import styles from './LibraryPanel.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ShotPreset {
  id: number; name: string; category: string | null;
  camera_move: string | null; shot_type: string | null; composition: string | null;
  lighting: string | null; color_tone: string | null; style: string | null; quality: string | null;
  fragment_en: string; description_zh: string | null; use_count: number;
}
interface StylePreset {
  id: number; name: string; category: string | null;
  style: string | null; lighting: string | null; color_tone: string | null; quality: string | null;
  fragment_en: string; description_zh: string | null; use_count: number;
}
interface PromptTemplate {
  id: number; name: string; category: string | null;
  description_zh: string | null; prompt_en: string; use_count: number;
}
interface Fragment {
  id: number; name: string; type: string; content_en: string;
  description_zh: string | null; use_count: number;
}
interface Guide {
  structure: { formula: string; example: string };
  cameraMoves: { zh: string; en: string }[];
  shotTypes: { zh: string; en: string }[];
  compositions: { zh: string; en: string }[];
  rules: { kind: 'do' | 'dont'; title: string; detail: string }[];
  qualityPresets: { name: string; words: string }[];
}

type TabId = 'shot' | 'style' | 'template' | 'fragment' | 'guide';

const TABS: { id: TabId; label: string }[] = [
  { id: 'shot',     label: '🎥 镜头预设' },
  { id: 'style',    label: '🎨 风格预设' },
  { id: 'template', label: '📄 提示词模板' },
  { id: 'fragment', label: '🧩 素材片段' },
  { id: 'guide',    label: '📖 指南' },
];

// The `table` segment of POST /library/use/:table/:id — used to rank presets by real usage.
const USE_TABLE: Record<Exclude<TabId, 'guide'>, string> = {
  shot: 'shot-presets', style: 'style-presets', template: 'templates', fragment: 'fragments',
};

const FRAGMENT_TYPES: { value: string; label: string }[] = [
  { value: '',         label: '全部' },
  { value: 'character', label: '角色' },
  { value: 'scene',     label: '场景' },
  { value: 'action',    label: '动作' },
  { value: 'lighting',  label: '光线' },
  { value: 'quality',   label: '质量词' },
];

interface Props {
  /** Called with the English snippet when a card is clicked. */
  onInsert: (text: string) => void;
  /** Render expanded on first paint instead of collapsed behind the toggle. */
  defaultOpen?: boolean;
}

export default function LibraryPanel({ onInsert, defaultOpen = false }: Props) {
  const [open, setOpen]   = useState(defaultOpen);
  const [tab, setTab]     = useState<TabId>('shot');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [shots, setShots]         = useState<ShotPreset[] | null>(null);
  const [stylesL, setStylesL]     = useState<StylePreset[] | null>(null);
  const [templates, setTemplates] = useState<PromptTemplate[] | null>(null);
  const [fragments, setFragments] = useState<Fragment[] | null>(null);
  const [guide, setGuide]         = useState<Guide | null>(null);

  const [fragType, setFragType] = useState('');
  const [inserted, setInserted] = useState<string | null>(null);

  // Each tab fetches once and stays cached; the tables are static reference data.
  const load = useCallback(async (t: TabId) => {
    setError('');
    if ((t === 'shot' && shots) || (t === 'style' && stylesL) || (t === 'template' && templates) ||
        (t === 'fragment' && fragments) || (t === 'guide' && guide)) return;
    setLoading(true);
    try {
      if (t === 'shot')     setShots((await api.get<{ Items: ShotPreset[] }>('/library/shot-presets')).Items || []);
      if (t === 'style')    setStylesL((await api.get<{ Items: StylePreset[] }>('/library/style-presets')).Items || []);
      if (t === 'template') setTemplates((await api.get<{ Items: PromptTemplate[] }>('/library/templates')).Items || []);
      if (t === 'fragment') setFragments((await api.get<{ Items: Fragment[] }>('/library/fragments')).Items || []);
      if (t === 'guide')    setGuide(await api.get<Guide>('/library/guide'));
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [shots, stylesL, templates, fragments, guide]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) load(tab);
  }

  function switchTab(t: TabId) {
    setTab(t);
    load(t);
  }

  function insert(text: string, table?: string, id?: number) {
    if (!text) return;
    onInsert(text);
    setInserted(`${table ?? 'guide'}-${id ?? text.slice(0, 12)}`);
    setTimeout(() => setInserted(null), 1200);
    // Ranking signal only — a failed bump must not break the insert.
    if (table && id != null) api.post(`/library/use/${table}/${id}`, {}).catch(() => {});
  }

  const cardKey = (table: string, id: number) => `${table}-${id}`;

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.toggle} onClick={toggle}>
        <span className={styles.caret} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
        📚 素材库
        <span className={styles.hint}>点击条目插入到提示词</span>
      </button>

      {open && (
        <div className={styles.body}>
          <div className={styles.tabs}>
            {TABS.map(t => (
              <button key={t.id} type="button"
                className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
                onClick={() => switchTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>

          {loading && <div className={styles.status}>加载中…</div>}
          {error && <div className={styles.errorBox}>{error}</div>}

          {!loading && !error && tab === 'shot' && (
            <div className={styles.grid}>
              {(shots || []).map(p => (
                <button key={p.id} type="button"
                  className={`${styles.card} ${inserted === cardKey('shot-presets', p.id) ? styles.cardHit : ''}`}
                  onClick={() => insert(p.fragment_en, 'shot-presets', p.id)}>
                  <div className={styles.cardHead}>
                    <span className={styles.cardName}>{p.name}</span>
                    {p.category && <span className={styles.badge}>{p.category}</span>}
                  </div>
                  {p.description_zh && <div className={styles.cardDesc}>{p.description_zh}</div>}
                  <div className={styles.cardEn}>{p.fragment_en}</div>
                </button>
              ))}
            </div>
          )}

          {!loading && !error && tab === 'style' && (
            <div className={styles.grid}>
              {(stylesL || []).map(p => (
                <button key={p.id} type="button"
                  className={`${styles.card} ${inserted === cardKey('style-presets', p.id) ? styles.cardHit : ''}`}
                  onClick={() => insert(p.fragment_en, 'style-presets', p.id)}>
                  <div className={styles.cardHead}>
                    <span className={styles.cardName}>{p.name}</span>
                    {p.category && <span className={styles.badge}>{p.category}</span>}
                  </div>
                  {p.description_zh && <div className={styles.cardDesc}>{p.description_zh}</div>}
                  <div className={styles.cardEn}>{p.fragment_en}</div>
                </button>
              ))}
            </div>
          )}

          {!loading && !error && tab === 'template' && (
            <div className={styles.grid}>
              {(templates || []).map(p => (
                <button key={p.id} type="button"
                  className={`${styles.card} ${inserted === cardKey('templates', p.id) ? styles.cardHit : ''}`}
                  onClick={() => insert(p.prompt_en, 'templates', p.id)}>
                  <div className={styles.cardHead}>
                    <span className={styles.cardName}>{p.name}</span>
                    {p.category && <span className={styles.badge}>{p.category}</span>}
                  </div>
                  {p.description_zh && <div className={styles.cardDesc}>{p.description_zh}</div>}
                  <div className={styles.cardEn}>{p.prompt_en}</div>
                </button>
              ))}
            </div>
          )}

          {!loading && !error && tab === 'fragment' && (
            <>
              <div className={styles.chips}>
                {FRAGMENT_TYPES.map(t => (
                  <button key={t.value} type="button"
                    className={`${styles.chip} ${fragType === t.value ? styles.chipActive : ''}`}
                    onClick={() => setFragType(t.value)}>
                    {t.label}
                  </button>
                ))}
              </div>
              <div className={styles.grid}>
                {(fragments || []).filter(f => !fragType || f.type === fragType).map(f => (
                  <button key={f.id} type="button"
                    className={`${styles.card} ${inserted === cardKey('fragments', f.id) ? styles.cardHit : ''}`}
                    onClick={() => insert(f.content_en, 'fragments', f.id)}>
                    <div className={styles.cardHead}>
                      <span className={styles.cardName}>{f.name}</span>
                      <span className={styles.badge}>{f.type}</span>
                    </div>
                    <div className={styles.cardEn}>{f.content_en}</div>
                  </button>
                ))}
              </div>
            </>
          )}

          {!loading && !error && tab === 'guide' && guide && (
            <div className={styles.guide}>
              <section>
                <h4>提示词结构</h4>
                <code className={styles.formula}>{guide.structure.formula}</code>
                <button type="button" className={styles.exampleBtn}
                  onClick={() => insert(guide.structure.example)}>
                  插入示例提示词
                </button>
              </section>

              <section>
                <h4>镜头运动</h4>
                <div className={styles.kvGrid}>
                  {guide.cameraMoves.map(m => (
                    <button key={m.zh} type="button" className={styles.kv} onClick={() => insert(m.en)}>
                      <span className={styles.kvZh}>{m.zh}</span>
                      <span className={styles.kvEn}>{m.en}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <h4>景别</h4>
                <div className={styles.kvGrid}>
                  {guide.shotTypes.map(m => (
                    <button key={m.zh} type="button" className={styles.kv} onClick={() => insert(m.en)}>
                      <span className={styles.kvZh}>{m.zh}</span>
                      <span className={styles.kvEn}>{m.en}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <h4>构图法则</h4>
                <div className={styles.kvGrid}>
                  {guide.compositions.map(m => (
                    <button key={m.zh} type="button" className={styles.kv} onClick={() => insert(m.en)}>
                      <span className={styles.kvZh}>{m.zh}</span>
                      <span className={styles.kvEn}>{m.en}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <h4>质量词组合</h4>
                <div className={styles.grid}>
                  {guide.qualityPresets.map(q => (
                    <button key={q.name} type="button" className={styles.card} onClick={() => insert(q.words)}>
                      <div className={styles.cardHead}><span className={styles.cardName}>{q.name}</span></div>
                      <div className={styles.cardEn}>{q.words}</div>
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <h4>核心规则</h4>
                <ul className={styles.rules}>
                  {guide.rules.map(r => (
                    <li key={r.title} className={r.kind === 'do' ? styles.ruleDo : styles.ruleDont}>
                      <strong>{r.kind === 'do' ? '✅' : '❌'} {r.title}</strong>
                      <span>{r.detail}</span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
