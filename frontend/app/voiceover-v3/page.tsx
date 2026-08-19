'use client';

import { Fragment, useRef, useState, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useVirtualizer } from '@tanstack/react-virtual';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';
import { CameraState, ShotSubject, ProjectSubject } from '@/components/video-editor/types';
import styles from './page.module.css';

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

interface AvatarItem { assetId: string; label: string; thumb: string; }

const MEDIA_LIMITS = { image: 8, video: 4, audio: 4 } as const;
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

const SCRIPT_TABS = [
  { value: 'script'   as const, label: '剧本' },
  { value: 'subtitle' as const, label: '解说词' },
];

const MODELS = [
  { value: 'doubao-seedance-2-0',             label: 'Seedance 2.0' },
  { value: 'doubao-seedance-2-0-260128',      label: 'Seedance 2.0 (260128)' },
  { value: 'doubao-seedance-2-5',             label: 'Seedance 2.5' },
];

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
        <video src={src} style={{ aspectRatio: `${w||9}/${h||16}`, height: 100, width: 'auto', display: 'block', borderRadius: 6, border: '1px solid #e5e7eb', objectFit: 'cover' }}
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

  const readyMedia = p.mediaItems.filter(m => m.url && !m.uploading);
  const assetImages = readyMedia.filter(m => m.mediaType === 'image' && m.url?.startsWith('asset://'));
  const uploadedImages = readyMedia.filter(m => m.mediaType === 'image' && !m.url?.startsWith('asset://'));
  const videos = readyMedia.filter(m => m.mediaType === 'video');
  const audios = readyMedia.filter(m => m.mediaType === 'audio');

  const contentItems: unknown[] = [{ type: 'text', text: '(prompt内容)' }];
  // Image descriptions text
  const subjectsWithImg = p.videoSubjects.filter(s => s.image_url);
  const imgDescLines: string[] = [];
  subjectsWithImg.forEach((s, i) => {
    const analysis = p.scriptAnalysis.find(a => a.linkedSubjectId === s.id);
    const name = analysis?.label || s.label;
    imgDescLines.push(`图片${i + 1}：角色「${name}」— ${s.description || '见图片'}`);
  });
  const mImagesForDesc = readyMedia.filter(m => m.mediaType === 'image');
  mImagesForDesc.forEach((m, i) => imgDescLines.push(`图片${subjectsWithImg.length + i + 1}：参考素材「${m.name || '素材'}」— ${(m as any).description || ''}`));
  if (imgDescLines.length > 0) contentItems.push({ type: 'text', text: imgDescLines.join('\n') });
  subjectsWithImg.forEach(s => contentItems.push({ type: 'image_url', image_url: { url: s.asset_id ? `asset://${s.asset_id}` : s.image_url }, role: 'reference_image' }));
  assetImages.forEach(m => contentItems.push({ type: 'image_url', image_url: { url: m.url!.replace('asset://remote:', 'asset://') }, role: 'reference_image' }));
  uploadedImages.forEach(m => contentItems.push({ type: 'image_url', image_url: { url: m.url }, role: 'reference_image' }));
  videos.forEach(m => contentItems.push({ type: 'video_url', video_url: { url: m.url }, role: 'reference_video' }));
  audios.forEach(m => contentItems.push({ type: 'audio_url', audio_url: { url: m.url }, role: 'reference_audio' }));

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

  const [model, setModel]               = useState(MODELS[0].value);
  const [resolution, setResolution]     = useState('720p');
  const [generateAudio, setGenerateAudio] = useState(false);
  const [watermark, setWatermark]         = useState(false);
  const [seed, setSeed]                   = useState<number | null>(null);
  const [serviceTier, setServiceTier]     = useState('default');
  const [priority, setPriority]           = useState(0);
  const [returnLastFrame, setReturnLastFrame] = useState(false);
  const [draft, setDraft]                 = useState(false);
  const [webSearch, setWebSearch]         = useState(false);
  const [region, setRegion]               = useState<'overseas' | 'cn'>('cn');
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
  const [tasks, setTasks]                 = useState<Record<number, ShotTask>>({});
  const pollRefs = useRef<Record<number, ReturnType<typeof setInterval>>>({});
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const batchSeedRef = useRef<number | null>(null);

  const [merging, setMerging]               = useState(false);
  const [mergedVideoUrl, setMergedVideoUrl] = useState<string | null>(null);
  const [mergeError, setMergeError]         = useState('');
  const [mergeId, setMergeId]               = useState<string | null>(null);
  const mergePollingRef = useRef<ReturnType<typeof setInterval> | null>(null);


  const [showMobileParams, setShowMobileParams] = useState(false);
  const [showExamples, setShowExamples] = useState(false);
  const [scriptTab, setScriptTab] = useState<'script' | 'subtitle'>('script');
  const [showSubtitleTip, setShowSubtitleTip] = useState(false);
  const [showMediaTip, setShowMediaTip] = useState(false);

  const [mediaItems, setMediaItems]   = useState<MediaItem[]>([]);
  const [uploadError, setUploadError] = useState('');
  const [avatars, setAvatars]         = useState<AvatarItem[]>([]);
  const [avatarSearch, setAvatarSearch] = useState('');
  const [avatarExpanded, setAvatarExpanded] = useState(false);

  const [subjectDefs, setSubjectDefs]         = useState('');
  const [analyzingSubjects, setAnalyzingSubjects] = useState(false);
  const [subjectError, setSubjectError]       = useState('');
  const prevSubjectDefsRef = useRef('');

  const [resetKey, setResetKey]             = useState(0);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [expandedShots, setExpandedShots]   = useState<Record<number, boolean>>({});
  const [allShotsExpanded, setAllShotsExpanded] = useState(false);
  const [cameraEditorIdx, setCameraEditorIdx] = useState<number | null>(null);
  const [shotMediaIdx, setShotMediaIdx] = useState<number | null>(null);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [showVideoPicker, setShowVideoPicker] = useState(false);
  const [projectList, setProjectList] = useState<Array<{ id: string; name: string }>>([]);
  const [videoList, setVideoList] = useState<Array<{ id: string; name: string }>>([]);
  const [projectSubjects, setProjectSubjects] = useState<ProjectSubject[]>([]);
  const [videoSubjects, setVideoSubjects] = useState<ProjectSubject[]>([]);
  const [showSubjectPicker, setShowSubjectPicker] = useState(false);
  const [scriptAnalysis, setScriptAnalysis] = useState<Array<{ label: string; type: string; appearance: string; personality: string; linkedSubjectId?: string; _pickerOpen?: boolean }>>([]);
  const [analyzingScript, setAnalyzingScript] = useState(false);
  const [scriptAnalysisError, setScriptAnalysisError] = useState('');
  const [analysisCollapsed, setAnalysisCollapsed] = useState(false);
  const [mediaCollapsed, setMediaCollapsed] = useState(false);
  const [scriptCollapsed, setScriptCollapsed] = useState(false);
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

  // ─── Load video data from API ─────────────────────────────────────────────
  useEffect(() => {
    fetch('/avatars/index.json').then(r => r.json()).then((data: AvatarItem[]) => setAvatars(data.reverse())).catch(() => {});

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
            if (data.params.generateAudio !== undefined) setGenerateAudio(data.params.generateAudio);
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
              shot_size: s.shot_type || '',
              camera_movement: s.camera_movement || '',
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
                restoredTasks[i] = { shotIndex: i, taskId: s.task_id || null, status: s.task_status || 'idle', videoUrl: s.video_url || null, localUrl: s.local_url || null, duration: s.video_duration || null, error: s.task_error || null, submitting: false };
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
  }, [script, subtitleInput, style, ratio, voice, model, resolution, generateAudio, watermark, seed, serviceTier, returnLastFrame, draft, webSearch, subtitleStyle, banner, bannerStyle, videoSubjects, mediaItems]);

  function markShotDirty(idx: number) {
    setDirtyShotIdxs(prev => new Set(prev).add(idx));
  }

  async function saveAll() {
    setSavingShots(true);
    const promises: Promise<any>[] = [];
    // Save video-level fields + subjects + media
    if (videoId) {
      const payload: any = {};
      if (videoDirty) {
        Object.assign(payload, { script, subtitle_input: subtitleInput, style, ratio, voice });
      }
      payload.params = { model, resolution, generateAudio, watermark, seed, serviceTier, returnLastFrame, draft, webSearch, subtitleStyle, banner, bannerStyle, scriptAnalysis: scriptAnalysis.map(s => ({ label: s.label, type: s.type, appearance: s.appearance, personality: s.personality, linkedSubjectId: s.linkedSubjectId })) };
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
    } catch (e) { console.error('[poll]', e); }
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
      if (currentCount >= MEDIA_LIMITS[mediaType]) continue;
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
    setMediaItems(prev => { const item = prev[idx]; if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); return prev.filter((_, i) => i !== idx); });
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


  async function handleAnalyzeScript() {
    const text = script.trim() || subtitleInput.trim();
    if (!text) return;
    setAnalyzingScript(true);
    setScriptAnalysisError('');
    try {
      const oldLinkedIds = scriptAnalysis.filter(s => s.linkedSubjectId).map(s => s.linkedSubjectId!);
      if (oldLinkedIds.length > 0) {
        setVideoSubjects(prev => prev.filter(vs => !oldLinkedIds.includes(vs.id)));
      }
      const result = await api.post<{ subjects: Array<{ label: string; type: string; appearance: string; personality: string }> }>('/voiceover/analyze-script', { script: text });
      setScriptAnalysis((result.subjects || []).map(s => ({ ...s, linkedSubjectId: undefined })));
    } catch (err) {
      setScriptAnalysisError(err instanceof Error ? err.message : '分析失败');
    } finally { setAnalyzingScript(false); }
  }

  function linkAnalysisSubject(analysisIdx: number, subjectId: string) {
    // Update scriptAnalysis link
    const newAnalysis = scriptAnalysis.map((s, i) => i === analysisIdx ? { ...s, linkedSubjectId: subjectId } : s);
    setScriptAnalysis(newAnalysis);
    // Rebuild videoSubjects in scriptAnalysis order (allow duplicates)
    const orderedSubs = newAnalysis
      .filter(a => a.linkedSubjectId)
      .map(a => projectSubjects.find(ps => ps.id === a.linkedSubjectId))
      .filter(Boolean) as ProjectSubject[];
    setVideoSubjects(orderedSubs);
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

  async function handleInit() {
    if (!script.trim() && !subtitleInput.trim()) return;
    setInitError(''); setIniting(true);
    setInitResult(null); setShots([]); setTasks({}); setMergedVideoUrl(null); setAudioUrl(null);
    setDirtyShotIdxs(new Set());
    batchSeedRef.current = null;
    Object.values(pollRefs.current).forEach(clearInterval);
    pollRefs.current = {};

    try {
      const readyMedia = mediaItems.filter(m => m.url && !m.uploading);
      const subjectImagesCount = videoSubjects.filter(s => s.image_url).length;
      const imageCount = readyMedia.filter(m => m.mediaType === 'image').length + subjectImagesCount;
      const videoCount = readyMedia.filter(m => m.mediaType === 'video').length;
      const audioCount = readyMedia.filter(m => m.mediaType === 'audio').length;
      // Build character definitions from ALL videoSubjects for storyboard generation
      const withImage = videoSubjects.filter(s => s.image_url);
      const withoutImage = videoSubjects.filter(s => !s.image_url);
      const characterLines: string[] = [];
      withImage.forEach((s, i) => {
        const analysis = scriptAnalysis.find(a => a.linkedSubjectId === s.id);
        const name = analysis?.label || s.label;
        characterLines.push(`角色「${name}」绑定<图片${i + 1}>，外貌描述：${s.description || '见图片'}`);
      });
      withoutImage.forEach(s => {
        const analysis = scriptAnalysis.find(a => a.linkedSubjectId === s.id);
        const name = analysis?.label || s.label;
        characterLines.push(`角色「${name}」，外貌描述：${s.description || '未提供'}`);
      });
      const characterDefs = characterLines.length > 0 ? characterLines.join('\n') : '';
      const finalSubjectDefs = characterDefs || '';

      // Build imageDescriptions: 角色图片描述 + 参考素材图片描述
      const descLines: string[] = [];
      withImage.forEach((s, i) => {
        const analysis = scriptAnalysis.find(a => a.linkedSubjectId === s.id);
        const desc = analysis ? `${analysis.appearance}；${analysis.personality}` : (s.description || '');
        const name = analysis?.label || s.label;
        descLines.push(`图片${i + 1}：角色「${name}」— ${desc || '见图片'}`);
      });
      const mediaImages = readyMedia.filter(m => m.mediaType === 'image');
      mediaImages.forEach((m, i) => {
        descLines.push(`图片${subjectImagesCount + i + 1}：参考素材「${m.name || '素材'}」— ${m.description || ''}`);
      });
      const imageDescriptions = descLines.length > 0 ? descLines.join('\n') : undefined;

      const result = await api.post<InitResult>('/voiceover/init', { script: script.trim(), style, ratio, imageCount, subjectImageCount: subjectImagesCount, videoCount, audioCount, subjectDefinitions: finalSubjectDefs || undefined, imageDescriptions, subtitleMode, subtitleInput: subtitleInput.trim() || undefined });
      setInitResult(result);
      setShots(result.shots);
      if (!subtitleInput.trim() && result.shots.length > 0) {
        setSubtitleInput(result.shots.map(s => s.subtitle).join(''));
      }
      batchSeedRef.current = seed ?? Math.floor(Math.random() * 2147483647);

      // TTS: 生成语音并按实际时长更新各分镜 duration
      const ttsScript = subtitleInput.trim() || result.shots.map(s => s.subtitle).join('');
      let ttsAudioUrl: string | null = null;
      if (ttsScript) {
        setTtsLoading(true);
        try {
          const ttsRes = await api.post<{ audioUrl: string; totalDuration: number; shotDurations: number[]; totalVideoDuration: number; wordBoundaries?: Array<{text: string; offset: number; duration: number}> }>('/voiceover/tts', {
            script: ttsScript, voice, shots: result.shots.map(s => ({ subtitle: s.subtitle })),
          });
          setAudioUrl(ttsRes.audioUrl);
          setAudioDuration(ttsRes.totalDuration);
          if (ttsRes.wordBoundaries) setWordBoundaries(ttsRes.wordBoundaries);
          ttsAudioUrl = ttsRes.audioUrl;
          const updatedShots = result.shots.map((s, i) => ({ ...s, duration: ttsRes.shotDurations[i] ?? s.duration }));
          setShots(updatedShots);
          result.shots = updatedShots;
          result.totalVideoDuration = ttsRes.totalVideoDuration;
        } catch (e) {
          console.warn('TTS failed, using estimated durations:', e);
        } finally { setTtsLoading(false); }
      }

      // ─── Save to project/video/shots DB ─────────────────────────────
      let vid = videoId;
      const autoName = (script.trim() || subtitleInput.trim()).slice(0, 30) || '未命名视频';

      // Create project if needed
      if (!projectId) {
        const proj = await api.post<{ id: string }>('/projects', { name: autoName });
        setProjectId(proj.id);
        // Create video
        const video = await api.post<{ id: string }>(`/projects/${proj.id}/videos`, { name: autoName, script: script.trim(), subtitle_input: subtitleInput.trim(), style, ratio, voice, seed: batchSeedRef.current, params: { model, resolution, generateAudio, watermark, seed: batchSeedRef.current, serviceTier, priority, returnLastFrame, draft, webSearch } });
        vid = video.id;
        setVideoId(vid);
        setVideoName(autoName);
        window.history.replaceState(null, '', `/voiceover-v3?projectId=${proj.id}&videoId=${vid}`);
      } else if (!vid) {
        // Create video in existing project
        const video = await api.post<{ id: string }>(`/projects/${projectId}/videos`, { name: autoName, script: script.trim(), subtitle_input: subtitleInput.trim(), style, ratio, voice, seed: batchSeedRef.current, params: { model, resolution, generateAudio, watermark, seed: batchSeedRef.current, serviceTier, priority, returnLastFrame, draft, webSearch } });
        vid = video.id;
        setVideoId(vid);
        setVideoName(autoName);
        window.history.replaceState(null, '', `/voiceover-v3?projectId=${projectId}&videoId=${vid}`);
      } else {
        // Update existing video
        await api.put(`/videos/${vid}`, { script: script.trim(), subtitle_input: subtitleInput.trim(), style, ratio, voice, seed: batchSeedRef.current, audio_url: ttsAudioUrl, params: { model, resolution, generateAudio, watermark, seed: batchSeedRef.current, serviceTier, priority, returnLastFrame, draft, webSearch } });
      }

      // Save shots to DB — delete existing first, then insert new
      if (vid) {
        await api.del(`/videos/${vid}/shots`).catch(() => {});
        const allSubjects = videoSubjects.map(vs => ({ label: vs.label, image_url: vs.image_url || '' }));
        const createdShots = await api.post<any[]>(`/videos/${vid}/shots`, { shots: result.shots.map(s => ({ title: s.title, description: s.description, prompt: s.prompt, subtitle: s.subtitle, duration: s.duration, ratio: s.ratio || ratio, mood: s.mood, camera_movement: s.camera_movement, subjects: allSubjects })) });
        if (createdShots) {
          const withIds = result.shots.map((s, i) => ({ ...s, id: createdShots[i]?.id }));
          setShots(withIds);
        }
        // Save audio_url to video
        if (ttsAudioUrl) {
          await api.put(`/videos/${vid}`, { audio_url: ttsAudioUrl }).catch(() => {});
        }
      }
    } catch (err) {
      setInitError(err instanceof Error ? err.message : '生成失败，请重试');
    } finally { setIniting(false); }
  }

  async function handleRegenTTS() {
    const ttsScript = subtitleInput.trim();
    if (!ttsScript) return;
    setTtsLoading(true);
    try {
      const ttsRes = await api.post<{ audioUrl: string; totalDuration: number; shotDurations: number[]; totalVideoDuration: number; wordBoundaries?: Array<{text: string; offset: number; duration: number}> }>('/voiceover/tts', {
        script: ttsScript, voice, shots: shots.length > 0 ? shots.map(s => ({ subtitle: s.subtitle })) : [{ subtitle: ttsScript }],
      });
      setAudioUrl(ttsRes.audioUrl);
      setAudioDuration(ttsRes.totalDuration);
      if (ttsRes.wordBoundaries) setWordBoundaries(ttsRes.wordBoundaries);
      if (videoId) {
        try { await api.put(`/videos/${videoId}`, { audio_url: ttsRes.audioUrl, subtitle_input: ttsScript }); } catch {}
      }
    } catch (e) {
      console.warn('TTS regen failed:', e);
    } finally { setTtsLoading(false); }
  }

  async function submitShot(idx: number) {
    const shot = shots[idx];
    if (!shot) return;
    setTasks(prev => ({ ...prev, [idx]: { shotIndex: idx, taskId: null, status: 'pending', videoUrl: null, localUrl: null, duration: null, error: null, submitting: true } }));
    try {
      // All shots share the same seed for visual consistency
      if (batchSeedRef.current === null) {
        batchSeedRef.current = seed ?? Math.floor(Math.random() * 2147483647);
      }
      const sharedSeed = batchSeedRef.current;
      // Subject images first
      const subjectMedia = videoSubjects
        .filter(s => s.image_url)
        .map(s => ({
          url: s.asset_id ? `asset://${s.asset_id}` : s.image_url!,
          mediaType: 'image' as const,
        }));
      // Maintain upload order: send media in the same order as mediaItems
      const orderedMedia = [
        ...subjectMedia,
        ...mediaItems
          .filter(m => m.url && !m.uploading)
          .map(m => ({
            url: m.url!.startsWith('asset://remote:') ? m.url!.replace('asset://remote:', 'asset://') : m.url!,
            mediaType: m.mediaType,
          })),
      ];
      // Append per-shot reference images
      if (shot.reference_images?.length) {
        for (const img of shot.reference_images) {
          orderedMedia.push({ url: img.url, mediaType: 'image' as const });
        }
      }
      // Build imageDescriptions text for content
      const descLines: string[] = [];
      const withImg = videoSubjects.filter(s => s.image_url);
      withImg.forEach((s, i) => {
        const analysis = scriptAnalysis.find(a => a.linkedSubjectId === s.id);
        const desc = analysis ? `${analysis.appearance}；${analysis.personality}` : (s.description || '');
        const name = analysis?.label || s.label;
        descLines.push(`图片${i + 1}：角色「${name}」— ${desc || '见图片'}`);
      });
      const mediaImages = mediaItems.filter(m => m.url && !m.uploading && m.mediaType === 'image');
      mediaImages.forEach((m, i) => {
        descLines.push(`图片${withImg.length + i + 1}：参考素材「${m.name || '素材'}」— ${m.description || ''}`);
      });
      const imageDescriptions = descLines.length > 0 ? descLines.join('\n') : undefined;

      const res = await api.post<{ taskId: string; status: string }>('/video/generate', {
        prompt: shot.prompt, orderedMedia, imageDescriptions,
        model, resolution, ratio, duration: shot.duration || 8,
        generateAudio, watermark, webSearch,
        seed: sharedSeed,
        returnLastFrame, draft,
        serviceTier: serviceTier !== 'default' ? serviceTier : undefined,
        priority: priority > 0 ? priority : undefined,
        region: region !== 'overseas' ? region : undefined,
      });
      const { taskId, status } = res;
      setTasks(prev => ({ ...prev, [idx]: { shotIndex: idx, taskId, status, videoUrl: null, localUrl: null, duration: null, error: null, submitting: false } }));
      // Persist task_id to shot in DB
      if (shot.id) {
        api.put(`/shots/${shot.id}`, { task_id: taskId, task_status: status }).catch(() => {});
      }
      const interval = setInterval(() => pollTaskById(idx, taskId), 10_000);
      pollRefs.current[idx] = interval;
      setTimeout(() => pollTaskById(idx, taskId), 5_000);
    } catch (err) {
      setTasks(prev => ({ ...prev, [idx]: { ...prev[idx], status: 'failed', error: err instanceof Error ? err.message : '提交失败', submitting: false } }));
    }
  }

  async function submitAllShots() {
    for (let i = 0; i < shots.length; i++) {
      const t = tasks[i];
      if (!(t?.status === 'succeeded' || t?.status === 'running' || t?.status === 'queued')) {
        await submitShot(i); await new Promise(r => setTimeout(r, 800));
      }
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
    if (!audioUrl) { setMergeError('请先生成语音（TTS）'); return; }
    const succeededShots = shots.map((shot, i) => ({ shot, task: tasks[i] })).filter(({ task }) => task?.status === 'succeeded' && (task.localUrl || task.videoUrl));
    if (succeededShots.length < 1) return;
    const videoList = succeededShots.map(({ shot, task }) => ({ url: (task!.localUrl || task!.videoUrl) as string, subtitle: shot.subtitle || '', duration: task!.duration || shot.duration || 5 }));
    const fullSubtitle = subtitleInput.trim() || shots.map(s => s.subtitle).join('');
    setMerging(true); setMergeError(''); setMergedVideoUrl(null);
    try {
      const res = await api.post<{ mergeId: string }>('/voiceover/merge-async', { videos: videoList, audioUrl, voice, subtitle: fullSubtitle, subtitleStyle, banner, bannerStyle, wordBoundaries });
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
  const succeededCount  = Object.values(tasks).filter(t => t.status === 'succeeded').length;
  const allDone         = shots.length > 0 && shots.every((_, i) => { const t = tasks[i]; return t && TERMINAL.has(t.status); });
  const canMerge        = !!audioUrl && succeededCount >= 1;
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
              {savingShots ? '保存中…' : '保存'}
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
                  <span onClick={() => setScriptCollapsed(v => !v)} style={{ cursor: 'pointer', color: '#111827' }}>视频概念描述</span>
                  {scriptTab === 'script' && <>
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
                  </>}
                  {scriptTab === 'subtitle' && (
                    <span style={{ position: 'relative', display: 'inline-block' }}>
                      <span onClick={() => setShowSubtitleTip(v => !v)} style={{ fontSize: 11, fontWeight: 400, textDecoration: 'underline', cursor: 'pointer', color: '#6b7280' }}>说明</span>
                      {showSubtitleTip && (
                        <div style={{ position: 'absolute', left: 0, top: '100%', marginTop: 4, background: '#1e293b', color: '#f1f5f9', fontSize: 12, lineHeight: 1.6, padding: '10px 12px', borderRadius: 8, width: 260, zIndex: 100, boxShadow: '0 4px 16px rgba(0,0,0,0.2)', whiteSpace: 'normal' }}>
                          如果字幕输入内容，那么生成视频的字幕严格按照字幕内容来生成，如果字幕内容为空，系统会根据视频需求来自动生成合适的字幕
                          <span onClick={() => setShowSubtitleTip(false)} style={{ display: 'block', textAlign: 'right', marginTop: 6, cursor: 'pointer', color: '#94a3b8', fontSize: 11 }}>关闭</span>
                        </div>
                      )}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                </p>

                  {!scriptCollapsed && (<>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10 }}>
                    {SCRIPT_TABS.map(opt => (
                      <label key={opt.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, cursor: 'pointer', color: scriptTab === opt.value ? '#111827' : '#6b7280' }}>
                        <input type="radio" name="scriptTab" value={opt.value} checked={scriptTab === opt.value}
                          onChange={() => setScriptTab(opt.value)}
                          style={{ accentColor: '#2563eb', cursor: 'pointer', margin: 0 }} />
                        {opt.label}
                      </label>
                    ))}
                  </div>

                  {scriptTab === 'script' && (<>
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

                  <div style={{ position: 'relative', marginBottom: 10 }}>
                    {script.trim() && (
                      <button type="button" onClick={() => { setScript(''); setInitResult(null); setShots([]); setMergedVideoUrl(null); }}
                        style={{ position: 'absolute', top: 6, right: 8, zIndex: 1, background: 'none', border: 'none', fontSize: 12, color: '#9ca3af', cursor: 'pointer' }}>
                        清空
                      </button>
                    )}
                    <textarea rows={4} value={script}
                      onChange={e => { setScript(e.target.value); setInitResult(null); setShots([]); setMergedVideoUrl(null); }}
                      placeholder="输入视频概念描述…"
                      className={styles.textarea} style={{ fontFamily: 'inherit', fontSize: 13, border: '2px solid #000' }} />
                  </div>
                  </>)}

                  {scriptTab === 'subtitle' && (<>
                  <div style={{ position: 'relative', marginBottom: 10 }}>
                    {subtitleInput.trim() && (
                      <button type="button" onClick={() => { setSubtitleInput(''); setInitResult(null); setShots([]); setMergedVideoUrl(null); }}
                        style={{ position: 'absolute', top: 6, right: 8, zIndex: 1, background: 'none', border: 'none', fontSize: 12, color: '#9ca3af', cursor: 'pointer' }}>
                        清空
                      </button>
                    )}
                    <textarea rows={3} value={subtitleInput}
                      onChange={e => { setSubtitleInput(e.target.value); setAudioUrl(null); }}
                      placeholder="输入字幕文本，将按分镜拆分并在视频中显示…"
                      className={styles.textarea} style={{ fontFamily: 'inherit', fontSize: 13, border: '2px solid #000' }} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, marginTop: -4, flexWrap: 'wrap' }}>
                    <select value={voice} onChange={e => setVoice(e.target.value)}
                      style={{ fontSize: 11, padding: '3px 6px', borderRadius: 6, border: '1px solid #111827', background: '#fff', color: '#374151', cursor: 'pointer', width: 110 }}>
                      {AZURE_VOICES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                    </select>
                    <button type="button" onClick={handleRegenTTS} disabled={ttsLoading || !subtitleInput.trim()}
                      style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #111827', borderRadius: 5, background: ttsLoading ? '#f3f4f6' : '#fff', cursor: (ttsLoading || !subtitleInput.trim()) ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', color: '#374151' }}>
                      {ttsLoading ? '生成中…' : audioUrl ? '重新生成' : '生成配音'}
                    </button>
                    {audioUrl && (
                      <audio controls src={audioUrl} style={{ height: 28, flex: 1, minWidth: 120 }} />
                    )}
                  </div>
                  </>)}
                  </>)}

                  {/* 剧本分析按钮 */}
                  <div style={{ marginTop: 10, marginBottom: 6 }}>
                    <button type="button" onClick={handleAnalyzeScript}
                      disabled={analyzingScript || (!script.trim() && !subtitleInput.trim())}
                      style={{ fontSize: 13, padding: '6px 14px', borderRadius: 6, border: '1.5px solid #7c3aed', background: analyzingScript ? '#f5f3ff' : '#fff', color: '#7c3aed', cursor: (analyzingScript || (!script.trim() && !subtitleInput.trim())) ? 'not-allowed' : 'pointer', fontWeight: 500 }}>
                      {analyzingScript ? '分析中…' : '剧本分析（提取角色）'}
                    </button>
                    {scriptAnalysisError && <span style={{ fontSize: 12, color: '#dc2626', marginLeft: 8 }}>{scriptAnalysisError}</span>}
                  </div>

                  {/* 剧本分析结果 */}
                  {scriptAnalysis.length > 0 && (() => {
                    // Build image number per analysis index (not per subject id, since duplicates allowed)
                    let imgCounter = 0;
                    const analysisImgNum: number[] = scriptAnalysis.map(a => {
                      if (a.linkedSubjectId) {
                        const sub = projectSubjects.find(ps => ps.id === a.linkedSubjectId);
                        if (sub?.image_url) return ++imgCounter;
                      }
                      return 0;
                    });
                    return (<>
                    <p onClick={() => setAnalysisCollapsed(v => !v)} className={styles.cardTitle} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 16, marginBottom: analysisCollapsed ? 0 : 8, cursor: 'pointer', userSelect: 'none' }}>
                      <span style={{ fontSize: 10, transition: 'transform 0.2s', transform: analysisCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                      角色（{scriptAnalysis.length}个）
                    </p>
                    {!analysisCollapsed && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {scriptAnalysis.map((item, idx) => (
                          <div key={idx} style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', position: 'relative' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <span style={{ fontSize: 14, fontWeight: 600 }}>{item.label}</span>
                                <span style={{ fontSize: 11, color: '#9ca3af' }}>{item.type}</span>
                              </div>
                              {item.linkedSubjectId && (() => {
                                const linked = projectSubjects.find(ps => ps.id === item.linkedSubjectId);
                                const imgNum = analysisImgNum[idx];
                                return linked ? (
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#16a34a', background: '#f0fdf4', padding: '2px 6px', borderRadius: 4 }}>
                                    {linked.image_url && <img src={linked.image_url} alt="" style={{ width: 36, height: 36, borderRadius: 4, objectFit: 'cover' }} />}
                                    <span style={{ display: 'flex', flexDirection: 'column' }}>
                                      <span>{linked.label}</span>
                                      {imgNum > 0 && <span style={{ fontSize: 10, color: '#9ca3af' }}>图片{imgNum}</span>}
                                    </span>
                                    <button type="button" onClick={() => { const newA = scriptAnalysis.map((s, i) => i === idx ? { ...s, linkedSubjectId: undefined } : s); setScriptAnalysis(newA); setVideoSubjects(newA.filter(a => a.linkedSubjectId).map(a => projectSubjects.find(ps => ps.id === a.linkedSubjectId)).filter(Boolean) as ProjectSubject[]); }}
                                      style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}>×</button>
                                  </span>
                                ) : null;
                              })()}
                              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                                {projectSubjects.length > 0 && (
                                  <span style={{ position: 'relative' }}>
                                    <button type="button" onClick={() => setScriptAnalysis(prev => prev.map((s, i) => i === idx ? { ...s, _pickerOpen: !s._pickerOpen } : { ...s, _pickerOpen: false }))}
                                      style={{ fontSize: 11, padding: '3px 8px', border: '1px solid #7c3aed', borderRadius: 4, background: '#fff', color: '#7c3aed', cursor: 'pointer' }}>
                                      {item.linkedSubjectId ? '换头像' : '选择头像'}
                                    </button>
                                    {item._pickerOpen && (
                                      <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, padding: 8, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', zIndex: 50, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', minWidth: 160 }}>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                          {projectSubjects.map(ps => (
                                            <div key={ps.id} onClick={() => { linkAnalysisSubject(idx, ps.id); setScriptAnalysis(prev => prev.map((s, i) => i === idx ? { ...s, _pickerOpen: false } : s)); }}
                                              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 12, background: item.linkedSubjectId === ps.id ? '#f5f3ff' : '#f9fafb', border: item.linkedSubjectId === ps.id ? '1px solid #7c3aed' : '1px solid transparent' }}>
                                              {ps.image_url && <img src={ps.image_url} alt="" style={{ width: 28, height: 28, borderRadius: 3, objectFit: 'cover' }} />}
                                              <span>{ps.label}</span>
                                            </div>
                                          ))}
                                        </div>
                                        <button type="button" onClick={() => setScriptAnalysis(prev => prev.map((s, i) => i === idx ? { ...s, _pickerOpen: false } : s))}
                                          style={{ marginTop: 6, fontSize: 11, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer' }}>关闭</button>
                                      </div>
                                    )}
                                  </span>
                                )}
                                <button type="button" onClick={() => {
                                  const newA = scriptAnalysis.filter((_, i) => i !== idx);
                                  setScriptAnalysis(newA);
                                  setVideoSubjects(newA.filter(a => a.linkedSubjectId).map(a => projectSubjects.find(ps => ps.id === a.linkedSubjectId)).filter(Boolean) as ProjectSubject[]);
                                }}
                                  style={{ background: 'none', border: '1px solid #dc2626', borderRadius: 4, color: '#dc2626', cursor: 'pointer', fontSize: 11, padding: '3px 8px' }}>删除</button>
                              </span>
                            </div>
                            <p style={{ fontSize: 12, color: '#374151', margin: '0 0 4px', lineHeight: 1.5 }}><b>形象：</b>{item.appearance}</p>
                            <p style={{ fontSize: 12, color: '#374151', margin: 0, lineHeight: 1.5 }}><b>性格：</b>{item.personality}</p>
                          </div>
                        ))}
                      </div>
                      )}
                  </>);
                  })()}

                  {/* 参考素材 */}
                  <p className={styles.cardTitle} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: mediaCollapsed ? 0 : 6, marginTop: 20, cursor: 'pointer', userSelect: 'none' }} onClick={() => setMediaCollapsed(v => !v)}>
                    <span style={{ fontSize: 10, transition: 'transform 0.2s', transform: mediaCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                    参考素材({mediaItems.filter(m => !m.uploading && m.url).length}个)
                    {!mediaCollapsed && (<>
                    <span style={{ position: 'relative', display: 'inline-block' }} onClick={e => e.stopPropagation()}>
                      <button type="button" onClick={() => setShowMediaTip(v => !v)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 400, textDecoration: 'underline' }}>说明</span>
                      </button>
                      {showMediaTip && (
                        <div style={{ position: 'absolute', left: 0, top: '100%', marginTop: 4, background: '#1e293b', color: '#f1f5f9', fontSize: 12, lineHeight: 1.6, padding: '10px 12px', borderRadius: 8, width: 260, zIndex: 100, boxShadow: '0 4px 16px rgba(0,0,0,0.2)', whiteSpace: 'normal' }}>
                          图片最多 8 张 · 视频最多 4 条 · 音频最多 4 条。上传素材后，AI 会根据素材内容和风格生成匹配的视频画面。
                          <span onClick={() => setShowMediaTip(false)} style={{ display: 'block', textAlign: 'right', marginTop: 6, cursor: 'pointer', color: '#94a3b8', fontSize: 11 }}>关闭</span>
                        </div>
                      )}
                    </span>
                    <span onClick={e => e.stopPropagation()}>
                      <button type="button" onClick={() => mediaInputRef.current?.click()}
                        style={{ fontSize: 13, padding: '4px 8px', border: '1px solid #6b7280', borderRadius: 5, background: '#fff', cursor: 'pointer', color: '#374151' }}>
                        上传素材(图像|音频|视频)
                      </button>
                      <input ref={mediaInputRef} type="file" accept="image/*,video/*,audio/*" multiple style={{ display: 'none' }}
                        onChange={e => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
                    </span>
                    </>)}
                  </p>
                  {!mediaCollapsed && (
                  <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 8, background: '#f9fafb' }}>
                    <MediaPanel items={mediaItems} onAddFiles={addFiles} onRemove={removeMediaItem} onDescChange={(idx, desc) => setMediaItems(prev => prev.map((m, i) => i === idx ? { ...m, description: desc } : m))} uploadError={uploadError} imageOffset={videoSubjects.filter(s => s.image_url).length} />
                  </div>
                  )}

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

                  <div style={{ display: 'flex', justifyContent: 'center', marginTop: 18 }}>
                  <button type="button" onClick={handleInit} disabled={initing || (!script.trim() && !subtitleInput.trim()) || anyUploading || mediaDescMissing}
                    className={styles.btnPrimary} style={{ padding: '7px 24px', width: 'auto' }}>
                    {initing ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <span className={styles.spinner} style={{ borderColor: '#5eead4', borderTopColor: '#fff' }} />
                        分镜进行中...
                      </span>
                    ) : anyUploading ? '素材上传中，请等待…' : mediaDescMissing ? '请填写素材说明' : initResult ? '重新生成分镜脚本' : '一键生成分镜'}
                  </button>
                  </div>
              </div>

              {/* ── Step 2 ── */}
              {initResult && shots.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 0', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 18, fontWeight: 700, color: '#111827', textDecoration: 'underline', textDecorationColor: '#dc2626', textDecorationThickness: '3px', textUnderlineOffset: '4px' }}>
                      {shots.length}个分镜 · 视频{Math.round(shots.reduce((a, s) => a + s.duration, 0))}秒{audioDuration > 0 ? ` · 音频${Math.round(audioDuration)}秒` : ''}
                    </span>
                    {succeededCount > 0 && <span style={{ fontSize: 13, color: '#16a34a' }}>{succeededCount}已生成</span>}
                    {ttsLoading && <span style={{ fontSize: 12, color: '#2563eb' }}>语音生成中…</span>}
                    <button type="button" onClick={() => openShotAi(0)}
                      style={{ fontSize: 11, padding: '3px 10px', border: '1px solid #2563eb', borderRadius: 5, background: '#eff6ff', cursor: 'pointer', color: '#2563eb', fontWeight: 500 }}>
                      生成分镜参考图
                    </button>
                    <button type="button" onClick={() => {
                      const next = !allShotsExpanded;
                      setAllShotsExpanded(next);
                      const map: Record<number, boolean> = {};
                      shots.forEach((_, i) => { map[i] = next; });
                      setExpandedShots(map);
                    }}
                      style={{ marginLeft: 'auto', fontSize: 11, padding: '3px 10px', border: '1px solid #d1d5db', borderRadius: 5, background: '#fff', cursor: 'pointer', color: '#374151' }}>
                      {allShotsExpanded ? '全部折叠' : '全部展开'}
                    </button>
                  </div>

                  <div style={{ padding: '0 0 16px' }}>
                    {shots.map((shot, idx) => {
                      const task = tasks[idx];
                      const isExpanded = expandedShots[idx] ?? false;
                      return (
                        <Fragment key={idx}>
                          {!isExpanded ? (
                            /* ── Collapsed: compact list row ── */
                            <div className={styles.shotCard} style={{ padding: '8px 12px', marginTop: idx === 0 ? 12 : undefined, cursor: 'pointer' }}
                              onClick={() => setExpandedShots(prev => ({ ...prev, [idx]: true }))}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                {shot.imageUrl && <img src={shot.imageUrl} alt="" style={{ width: 28, height: 28, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }} />}
                                <span className={styles.shotNum} style={{ flexShrink: 0 }}>分镜{shot.shot_number}</span>
                                <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
                                  {shot.title}
                                </span>
                                {shot.shot_size && <span style={{ fontSize: 10, color: '#6b7280', background: '#f3f4f6', borderRadius: 3, padding: '1px 4px' }}>{shot.shot_size}</span>}
                                {shot.mood && <span style={{ fontSize: 10, color: '#92400e', background: '#fef3c7', borderRadius: 3, padding: '1px 4px' }}>{shot.mood}</span>}
                                {shot.camera_movement && <span style={{ fontSize: 10, color: '#1d4ed8', background: '#dbeafe', borderRadius: 3, padding: '1px 4px' }}>{shot.camera_movement}</span>}
                                <span style={{ fontSize: 10, color: '#6b7280' }}>{shot.duration}s</span>
                                {shot.subjects && shot.subjects.length > 0 && <span style={{ fontSize: 10, color: '#7c3aed', background: '#f5f3ff', borderRadius: 3, padding: '1px 4px' }}>{shot.subjects.join('/')}</span>}
                                {(shot.camera_pan || shot.camera_tilt || (shot.camera_zoom && shot.camera_zoom !== 1)) && <span style={{ fontSize: 10, color: '#059669', background: '#d1fae5', borderRadius: 3, padding: '1px 4px' }}>3D</span>}
                                <span style={{ flex: 1 }} />
                                {task && task.status && <StatusBadge status={task.status} />}
                                {task?.videoUrl && <span style={{ fontSize: 11, color: '#16a34a' }}>▶</span>}
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                                  style={{ width: 14, height: 14, color: '#9ca3af', flexShrink: 0 }}>
                                  <path d="m6 9 6 6 6-6"/>
                                </svg>
                              </div>
                            </div>
                          ) : (
                            /* ── Expanded: full editor ── */
                          <div className={styles.shotCard} style={idx === 0 ? { marginTop: 12 } : undefined}>
                            <div className={styles.shotHead} style={{ cursor: 'pointer' }} onClick={() => setExpandedShots(prev => ({ ...prev, [idx]: false }))}>
                              <div className={styles.shotInfo}>
                                <span className={styles.shotNum}>分镜{shot.shot_number}</span>
                                <div className={styles.shotMeta}>
                                  <p className={styles.shotTitle}>{shot.title}</p>
                                  <p className={styles.shotDesc}>{shot.description}</p>
                                </div>
                              </div>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                                style={{ width: 14, height: 14, color: '#9ca3af', flexShrink: 0, transform: 'rotate(180deg)' }}>
                                <path d="m6 9 6 6 6-6"/>
                              </svg>
                            </div>

                            {/* Shot reference image */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }}>
                              {shot.imageUrl ? (
                                <div style={{ position: 'relative' }}>
                                  <img src={shot.imageUrl} alt="" style={{ width: 80, height: 80, borderRadius: 6, objectFit: 'cover', border: '1px solid #e5e7eb' }} />
                                  <button onClick={() => { const u = [...shots]; u[idx] = { ...u[idx], imageUrl: '' }; setShots(u); if (u[idx].id) api.put(`/shots/${u[idx].id}`, { image_url: '' }).catch(() => {}); }}
                                    style={{ position: 'absolute', top: -4, right: -4, width: 16, height: 16, borderRadius: '50%', background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none', fontSize: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                                </div>
                              ) : null}
                              <button onClick={() => openShotAi(idx)}
                                style={{ padding: '4px 10px', fontSize: 11, border: '1px solid #2563eb', borderRadius: 5, background: '#eff6ff', color: '#2563eb', cursor: 'pointer' }}>
                                {shot.imageUrl ? '重新生成' : 'AI生成参考图'}
                              </button>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: '4px 8px', margin: '8px 0', alignItems: 'end' }}>
                              <div>
                                <span className={styles.paramLabel}>景别</span>
                                <select value={shot.shot_size || ''} onChange={e => { const u = [...shots]; u[idx] = { ...u[idx], shot_size: e.target.value }; setShots(u); markShotDirty(idx); }}
                                  className={styles.select} style={{ width: '100%', marginTop: 2 }}>
                                  <option value="">--</option>
                                  {SHOT_SIZES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                                </select>
                              </div>
                              <div>
                                <span className={styles.paramLabel}>光影氛围</span>
                                <input type="text" value={shot.mood || ''} onChange={e => { const u = [...shots]; u[idx] = { ...u[idx], mood: e.target.value }; setShots(u); markShotDirty(idx); }}
                                  className={styles.input} style={{ width: '100%', padding: '3px 6px', fontSize: 11, marginTop: 2 }} placeholder="氛围" />
                              </div>
                              <div>
                                <span className={styles.paramLabel}>运镜</span>
                                <select value={shot.camera_movement || ''} onChange={e => { const u = [...shots]; u[idx] = { ...u[idx], camera_movement: e.target.value }; setShots(u); markShotDirty(idx); }}
                                  className={styles.select} style={{ width: '100%', marginTop: 2 }}>
                                  <option value="">--</option>
                                  {CAMERA_MOVEMENTS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                                </select>
                              </div>
                              <div>
                                <span className={styles.paramLabel}>时长</span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 2 }}>
                                  <input type="number" min={4} max={15} step={1} value={shot.duration}
                                    onChange={e => { const u = [...shots]; u[idx] = { ...u[idx], duration: Math.max(4, Math.min(15, Number(e.target.value) || 5)) }; setShots(u); markShotDirty(idx); }}
                                    className={styles.input} style={{ width: '100%', padding: '3px 6px', fontSize: 11 }} />
                                  <span style={{ fontSize: 11, color: '#6b7280' }}>s</span>
                                </div>
                              </div>
                              <div>
                                <span className={styles.paramLabel}>主体</span>
                                <input type="text" value={(shot.subjects || []).join(', ')}
                                  onChange={e => { const u = [...shots]; u[idx] = { ...u[idx], subjects: e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean) }; setShots(u); markShotDirty(idx); }}
                                  className={styles.input} style={{ width: '100%', padding: '3px 6px', fontSize: 11, marginTop: 2 }} placeholder="逗号分隔" />
                              </div>
                              <div>
                                <span className={styles.paramLabel}>3D机位</span>
                                <button type="button" onClick={() => setCameraEditorIdx(idx)}
                                  style={{ width: '100%', marginTop: 2, padding: '3px 6px', fontSize: 11, borderRadius: 4, border: '1px solid #2563eb', background: shot.camera ? '#eff6ff' : '#fff', color: '#2563eb', cursor: 'pointer', fontWeight: 500 }}>
                                  {shot.camera ? '编辑' : '设置'}
                                </button>
                              </div>
                              <div>
                                <span className={styles.paramLabel}>素材</span>
                                <button type="button" onClick={() => setShotMediaIdx(idx)}
                                  style={{ width: '100%', marginTop: 2, padding: '3px 6px', fontSize: 11, borderRadius: 4, border: '1px solid #6b7280', background: (shot.reference_images?.length) ? '#f0fdf4' : '#fff', color: '#374151', cursor: 'pointer', fontWeight: 500 }}>
                                  {shot.reference_images?.length ? `${shot.reference_images.length}张` : '添加'}
                                </button>
                              </div>
                            </div>


                            <div style={{ marginBottom: 8 }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                                <span className={styles.fieldLabel} style={{ margin: 0 }}>分镜{idx + 1}场景描述（可编辑）</span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {task && task.status && <StatusBadge status={task.status} />}
                                  <button type="button" onClick={() => submitShot(idx)}
                                    disabled={task?.submitting || (task?.taskId != null && !TERMINAL.has(task?.status || ''))}
                                    className={styles.btnShotGen}>
                                    {task?.submitting ? '提交中…' : (task?.taskId && !TERMINAL.has(task.status)) ? '生成中' : task?.status === 'succeeded' ? '重新生成' : `生成视频${idx + 1}`}
                                  </button>
                                </div>
                              </div>
                              <textarea rows={4} value={shot.prompt}
                                onChange={e => { const u = [...shots]; u[idx] = { ...u[idx], prompt: e.target.value }; setShots(u); markShotDirty(idx); }}
                                className={styles.textarea} />
                            </div>

                            <div style={{ marginBottom: 8 }}>
                              <span className={styles.fieldLabel}>分镜{idx + 1}字幕</span>
                              <textarea rows={2} value={shot.subtitle}
                                onChange={e => { const u = [...shots]; u[idx] = { ...u[idx], subtitle: e.target.value }; setShots(u); markShotDirty(idx); }}
                                className={styles.textarea} />
                            </div>

                            {task?.error && <p className={styles.errInline} style={{ marginTop: 6 }}>{task.error}</p>}

                            <details className={styles.jsonDetails}>
                              <summary className={styles.fieldLabel} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none', marginBottom: 4 }}>查看提交 JSON</summary>
                              <pre style={{ margin: '6px 0 0', padding: 8, background: '#1e293b', color: '#e2e8f0', borderRadius: 6, fontSize: 11, lineHeight: 1.5, overflow: 'auto', maxHeight: 200 }}>
                                {JSON.stringify((() => {
                                  const content: any[] = [{ type: 'text', text: shot.prompt }];
                                  // Image descriptions text
                                  const dLines: string[] = [];
                                  const wImg = videoSubjects.filter(s => s.image_url);
                                  wImg.forEach((s, i) => {
                                    const a = scriptAnalysis.find(x => x.linkedSubjectId === s.id);
                                    const d = a ? `${a.appearance}；${a.personality}` : (s.description || '');
                                    const nm = a?.label || s.label;
                                    dLines.push(`图片${i + 1}：角色「${nm}」— ${d || '见图片'}`);
                                  });
                                  const mImgs = mediaItems.filter(m => m.url && !m.uploading && m.mediaType === 'image');
                                  mImgs.forEach((m, i) => {
                                    dLines.push(`图片${wImg.length + i + 1}：参考素材「${m.name || '素材'}」— ${m.description || ''}`);
                                  });
                                  if (dLines.length > 0) content.push({ type: 'text', text: dLines.join('\n') });
                                  // Subject images first
                                  videoSubjects.filter(s => s.image_url).forEach(s => {
                                    content.push({ type: 'image_url', image_url: { url: s.asset_id ? `asset://${s.asset_id}` : s.image_url }, role: 'reference_image' });
                                  });
                                  // Maintain upload order — iterate mediaItems directly
                                  mediaItems.filter(m => m.url && !m.uploading).forEach(m => {
                                    const url = m.url!.startsWith('asset://remote:') ? m.url!.replace('asset://remote:', 'asset://') : m.url!;
                                    if (m.mediaType === 'image') {
                                      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
                                    } else if (m.mediaType === 'video') {
                                      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
                                    } else if (m.mediaType === 'audio') {
                                      content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
                                    }
                                  });
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
                                })(), null, 2)}
                              </pre>
                            </details>

                            {task?.taskId && !TERMINAL.has(task.status) && (
                              <div className={styles.pollingRow}>
                                <span className={styles.pollingText}>
                                  <span className={`${styles.spinner} ${styles.spinnerBlue}`} />生成中，每 10 秒自动查询
                                </span>
                                <button type="button" onClick={() => pollTaskById(idx, task.taskId!)} className={styles.refreshBtn}>立即刷新</button>
                              </div>
                            )}
                            {task?.videoUrl && (
                              <div style={{ marginBottom: 8 }}>
                                <span className={styles.fieldLabel}>预览</span>
                                <VideoThumb src={task.videoUrl} ratio={shot.ratio || ratio} subtitle={shot.subtitle} />
                              </div>
                            )}
                          </div>
                          )}
                        </Fragment>
                      );
                    })}

                    <div className={styles.shotListActions} style={{ marginTop: 12, marginBottom: 12 }}>
                      <button type="button" onClick={submitAllShots}
                        disabled={succeededCount === shots.length}
                        className={styles.btnSmTeal} style={{ width: '100%' }}>
                        {succeededCount === shots.length ? '全部完成' : '一键生成所有分镜视频'}
                      </button>
                    </div>

                    {/* ── Step 3: Merge ── */}
                    {canMerge && (
                      <div className={styles.mergeBox}>
                        {succeededCount >= 1 && (
                          <>
                            <p className={styles.mergeTitle}>{succeededCount} / {shots.length} 个分镜视频已生成{allDone ? ' — 全部完成！' : ''}</p>
                            <p className={styles.mergeSub}>合并后自动烧录字幕 + 叠加配音</p>
                          </>
                        )}
                        <div className={styles.mergeFooter} style={{ marginTop: 14, justifyContent: 'center' }}>
                          <div style={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
                            {succeededCount >= 1 && (
                              <button type="button" onClick={handleMerge} disabled={merging || !canMerge}
                                className={styles.btnSmGreen} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '7px 32px', fontSize: 15, fontWeight: 600, borderRadius: 10 }}>
                                {merging ? <><span className={styles.spinner} style={{ borderColor: '#bbf7d0', borderTopColor: '#16a34a' }} />合并中…</> : mergedVideoUrl ? '重新生成(分镜视频+字幕+配音)' : '分镜合并(分镜视频+字幕+配音)'}
                              </button>
                            )}
                          </div>
                        </div>
                        {mergeError && <p className={styles.errInline} style={{ marginTop: 8 }}>{mergeError}</p>}
                        {mergedVideoUrl && (
                          <div className={styles.mergedResult}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                              <p className={styles.mergedTitle} style={{ margin: 0 }}>最终视频（点击放大）</p>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <a href={mergedVideoUrl} download className={`${styles.btnOutline} ${styles.btnOutlineGreen}`} style={{ textDecoration: 'none', padding: '4px 10px', fontSize: 12 }}>下载</a>
                                <a href={mergedVideoUrl} target="_blank" rel="noopener noreferrer"
                                  className={`${styles.btnOutline} ${styles.btnOutlineGreen}`} style={{ textDecoration: 'none', padding: '4px 10px', fontSize: 12 }}>新窗口打开</a>
                              </div>
                            </div>
                            <video src={mergedVideoUrl} muted autoPlay loop className={styles.mergedVideo}
                              style={{ maxWidth: 320, maxHeight: 200, borderRadius: 8, cursor: 'pointer', display: 'block', margin: '0 auto' }}
                              onClick={() => window.open(mergedVideoUrl, '_blank')} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
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
    </div>
  );
}
