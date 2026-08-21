'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Shot, Video, ShotSubject, MODELS, RATIOS, AZURE_VOICES, MOVEMENT_TYPES, SHOT_TYPES, LIGHTING_TYPES, CameraState, ProjectSubject } from '@/components/video-editor/types';
import CameraEditor from '@/components/video-editor/CameraEditor';
import styles from './page.module.css';
import StoryboardGenerator, {
  toShotDrafts, DEFAULT_STORYBOARD_SETTINGS,
  type Storyboard, type StoryboardSettings, type ShotDraft,
} from '@/components/library/StoryboardGenerator';
import LibraryPanel from '@/components/library/LibraryPanel';

interface VideoListItem {
  id: string;
  name: string;
  status: string;
  shot_count: number;
  ratio: string;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  idle:      { label: '待生成', color: '#6b7280' },
  pending:   { label: '等待中', color: '#92400e' },
  queued:    { label: '队列中', color: '#92400e' },
  running:   { label: '生成中', color: '#1d4ed8' },
  succeeded: { label: '已完成', color: '#166534' },
  failed:    { label: '失败', color: '#dc2626' },
};

export default function VideoEditorPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const videoId = params.videoId as string;

  const [videoList, setVideoList] = useState<VideoListItem[]>([]);
  const [video, setVideo] = useState<Video | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [loading, setLoading] = useState(true);
  const [script, setScript] = useState('');
  const [subtitleInput, setSubtitleInput] = useState('');
  const [style, setStyle] = useState('');
  const [ratio, setRatio] = useState('9:16');
  const [voice, setVoice] = useState('zh-CN-YunfengNeural');
  const [model, setModel] = useState('doubao-seedance-2-0');
  const [region, setRegion] = useState<'overseas' | 'cn'>('cn');
  const [initing, setIniting] = useState(false);
  const [sbSettings, setSbSettings] = useState<StoryboardSettings>(DEFAULT_STORYBOARD_SETTINGS);
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const [expandedShot, setExpandedShot] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState<string | null>(null);
  const [projectSubjects, setProjectSubjects] = useState<ProjectSubject[]>([]);
  const [videoSubjects, setVideoSubjects] = useState<ProjectSubject[]>([]);
  const [showSubjectPicker, setShowSubjectPicker] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadVideo = useCallback(async () => {
    try {
      const [data, projSubs, vidSubs, vList] = await Promise.all([
        api.get<Video>(`/videos/${videoId}`),
        api.get<ProjectSubject[]>(`/projects/${projectId}/subjects`),
        api.get<ProjectSubject[]>(`/videos/${videoId}/subjects`),
        api.get<VideoListItem[]>(`/projects/${projectId}/videos`),
      ]);
      setVideo(data);
      setShots(data.shots || []);
      setScript(data.script || '');
      setSubtitleInput(data.subtitle_input || '');
      setStyle(data.style || '');
      setRatio(data.ratio || '9:16');
      setVoice(data.voice || 'zh-CN-YunfengNeural');
      setModel(data.params?.model || 'doubao-seedance-2-0');
      setProjectSubjects(projSubs || []);
      setVideoSubjects(vidSubs || []);
      setVideoList(vList || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [videoId, projectId]);

  useEffect(() => { loadVideo(); }, [loadVideo]);

  function scheduleSave(fields: Record<string, any>) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try { await api.put(`/videos/${videoId}`, fields); } catch {}
    }, 2000);
  }

  function handleScriptChange(val: string) {
    setScript(val);
    scheduleSave({ script: val });
  }

  function handleSubtitleChange(val: string) {
    setSubtitleInput(val);
    scheduleSave({ subtitle_input: val });
  }

  async function handleGenerateStoryboard() {
    if (!script.trim()) return;
    setIniting(true);
    try {
      // 与 voiceover-v3 同一个引擎，参数来自「专业分镜生成」浮窗
      const sb = await api.post<{ result: Storyboard }>('/prompt/storyboard', {
        concept: script.trim(),
        creative_goal:       sbSettings.creativeGoal,
        target_audience:     sbSettings.audience,
        overall_tone:        sbSettings.tone,
        key_messages:        sbSettings.keyMessages,
        shot_count:          sbSettings.shotCount,
        duration_total:      sbSettings.durationTotal,
        narrative_structure: sbSettings.narrative,
        video_type:          sbSettings.videoType,
        subject_definitions: subjectContext.characterDefs,
        image_descriptions:  subjectContext.imageDescriptions,
      });
      const drafts = toShotDrafts(sb.result, sbSettings.videoType);
      if (drafts.length > 0) await handleImportStoryboard(drafts);
    } catch (e) {
      console.warn('分镜生成失败:', e);
    }
    setIniting(false);
  }

  // 与 voiceover-v3 同一套 @图片N 编号规则：带图主体按顺序 1..N
  const subjectContext = useMemo(() => {
    const withImage = videoSubjects.filter(sub => sub.image_url);
    return {
      characterDefs: withImage
        .map((sub, i) => `角色「${sub.label}」绑定@图片${i + 1}，外貌描述：${sub.description || '见图片'}`)
        .join('\n'),
      imageDescriptions: withImage
        .map((sub, i) => `图片${i + 1}：角色「${sub.label}」— ${sub.description || '见图片'}`)
        .join('\n'),
      subjectsWithImage: withImage,
    };
  }, [videoSubjects]);

  async function handleImportStoryboard(drafts: ShotDraft[]) {
    const withSubjects = drafts.map(d => ({
      ...d,
      roll_type: d.rollType,
      // @图片N 反查回主体，超出主体数量的编号指向参考素材，跳过
      subjects: d.imageRefs
        .map(n => subjectContext.subjectsWithImage[n - 1])
        .filter(Boolean)
        .map(sub => ({ label: sub.label, imageUrl: sub.image_url || undefined })),
    }));
    const created = await api.post<Shot[]>(`/videos/${videoId}/shots`, { shots: withSubjects });
    if (created) setShots(prev => [...prev, ...created]);

  }

  async function handleShotUpdate(shotId: string, fields: Partial<Shot>) {
    try {
      const updated = await api.put<Shot>(`/shots/${shotId}`, fields);
      if (updated) {
        setShots(prev => prev.map(s => s.id === shotId ? { ...s, ...updated } : s));
      }
    } catch {}
  }

  async function handleDeleteShot(shotId: string) {
    if (!confirm('确定删除该分镜？')) return;
    try {
      await api.del(`/shots/${shotId}`);
      setShots(prev => prev.filter(s => s.id !== shotId));
    } catch {}
  }

  async function handleGenerateVideo(shot: Shot) {
    setGenerating(prev => new Set(prev).add(shot.id));
    try {
      const res = await api.post<{ taskId: string }>('/video/generate', {
        prompt: shot.prompt,
        ratio: shot.ratio || ratio,
        duration: shot.duration,
        model,
        resolution: '1080p',
        region: region !== 'overseas' ? region : undefined,
      });
      if (res?.taskId) {
        await handleShotUpdate(shot.id, { task_id: res.taskId, task_status: 'pending' });
        pollShotTask(shot.id, res.taskId);
      }
    } catch {}
    setGenerating(prev => { const s = new Set(prev); s.delete(shot.id); return s; });
  }

  async function handleAddVideoSubject(subjectId: string) {
    try {
      const data = await api.post<ProjectSubject[]>(`/videos/${videoId}/subjects`, { subject_ids: [subjectId] });
      if (data) setVideoSubjects(data);
    } catch {}
  }

  async function handleRemoveVideoSubject(subjectId: string) {
    try {
      await api.del(`/videos/${videoId}/subjects/${subjectId}`);
      setVideoSubjects(prev => prev.filter(s => s.id !== subjectId));
    } catch {}
  }

  function pollShotTask(shotId: string, taskId: string) {
    const iv = setInterval(async () => {
      try {
        const res = await api.get<{ status: string; video_url?: string; duration?: number; error?: string }>(`/video/task/${taskId}`);
        if (res) {
          const updates: Partial<Shot> = { task_status: res.status };
          if (res.video_url) updates.video_url = res.video_url;
          if (res.duration) updates.video_duration = res.duration;
          if (res.error) updates.task_error = res.error;
          await handleShotUpdate(shotId, updates);
          if (['succeeded', 'failed', 'expired', 'cancelled'].includes(res.status)) {
            clearInterval(iv);
          }
        }
      } catch { clearInterval(iv); }
    }, 10000);
  }

  function toggleShotSubject(shot: Shot, subject: ProjectSubject) {
    const current = shot.subjects || [];
    const exists = current.find(s => s.label === subject.label);
    if (exists) {
      handleShotUpdate(shot.id, { subjects: current.filter(s => s.label !== subject.label) });
    } else {
      handleShotUpdate(shot.id, { subjects: [...current, { label: subject.label, imageUrl: subject.image_url || undefined }] });
    }
  }

  if (loading) return <div className={styles.loading}>加载中...</div>;
  if (!video) return <div className={styles.loading}>视频不存在</div>;

  return (
    <div className={styles.layout}>
      {/* Left Panel: Video List */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <Link href={`/projects/${projectId}`} className={styles.backLink}>← 项目</Link>
        </div>
        <div className={styles.videoList}>
          {videoList.map(v => (
            <div
              key={v.id}
              className={`${styles.videoItem} ${v.id === videoId ? styles.videoItemActive : ''}`}
              onClick={() => v.id !== videoId && router.push(`/projects/${projectId}/videos/${v.id}`)}
            >
              <div className={styles.videoItemName}>{v.name}</div>
              <div className={styles.videoItemMeta}>{v.shot_count} 分镜 · {v.ratio}</div>
            </div>
          ))}
        </div>
      </aside>

      {/* Right Panel: Video Details */}
      <main className={styles.main}>
        <h1 className={styles.videoTitle}>{video.name}</h1>

        {/* Script & Params Row */}
        <div className={styles.topRow}>
          <div className={styles.scriptBlock}>
            <label className={styles.fieldLabel}>脚本</label>
            <textarea
              className={styles.scriptInput}
              value={script}
              onChange={e => handleScriptChange(e.target.value)}
              placeholder="输入视频脚本..."
              rows={4}
            />
            <div className={styles.scriptMeta}>
              <span>{script.replace(/\s/g, '').length} 字</span>
              <span>≈ {Math.round(script.replace(/\s/g, '').length / 3.5)}s</span>
            </div>
          </div>
          <div className={styles.paramsBlock}>
            <label className={styles.fieldLabel}>参数</label>
            <div className={styles.paramsGrid}>
              <label className={styles.paramItem}>
                模型
                <select className={styles.select} value={model} onChange={e => { setModel(e.target.value); scheduleSave({ params: { ...video.params, model: e.target.value } }); }}>
                  {MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </label>
              <label className={styles.paramItem}>
                比例
                <select className={styles.select} value={ratio} onChange={e => { setRatio(e.target.value); scheduleSave({ ratio: e.target.value }); }}>
                  {RATIOS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </label>
              <label className={styles.paramItem}>
                配音
                <select className={styles.select} value={voice} onChange={e => { setVoice(e.target.value); scheduleSave({ voice: e.target.value }); }}>
                  {AZURE_VOICES.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                </select>
              </label>
              <label className={styles.paramItem}>
                节点
                <select className={styles.select} value={region} onChange={e => setRegion(e.target.value as 'overseas' | 'cn')}>
                  <option value="overseas">海外</option>
                  <option value="cn">国内</option>
                </select>
              </label>
            </div>
            <div className={styles.subtitleRow}>
              <label className={styles.fieldLabel}>字幕</label>
              <textarea
                className={styles.subtitleInput}
                value={subtitleInput}
                onChange={e => handleSubtitleChange(e.target.value)}
                placeholder="字幕文本（可选）"
                rows={2}
              />
            </div>
          </div>
        </div>

        {/* Subjects */}
        <div className={styles.subjectsBar}>
          <span className={styles.fieldLabel}>主体 ({videoSubjects.length})</span>
          <div className={styles.subjectTags}>
            {videoSubjects.map(sub => (
              <span key={sub.id} className={styles.subjectTag}>
                {sub.image_url && <img src={sub.image_url} alt="" className={styles.subjectThumb} />}
                {sub.label}
                <button className={styles.subjectRemove} onClick={() => handleRemoveVideoSubject(sub.id)}>×</button>
              </span>
            ))}
          </div>
          <button className={styles.addBtn} onClick={() => setShowSubjectPicker(!showSubjectPicker)}>
            {showSubjectPicker ? '收起' : '+ 添加'}
          </button>
        </div>

        {showSubjectPicker && (
          <div className={styles.subjectPicker}>
            {projectSubjects.filter(ps => !videoSubjects.find(vs => vs.id === ps.id)).map(ps => (
              <button key={ps.id} className={styles.pickerItem} onClick={() => handleAddVideoSubject(ps.id)}>
                {ps.image_url && <img src={ps.image_url} alt="" className={styles.subjectThumb} />}
                {ps.label}
              </button>
            ))}
            {projectSubjects.filter(ps => !videoSubjects.find(vs => vs.id === ps.id)).length === 0 && (
              <span className={styles.pickerEmpty}>所有主体已添加</span>
            )}
          </div>
        )}

        {/* Storyboard Section */}
        <div className={styles.storyboardHeader}>
          <span className={styles.fieldLabel}>分镜 ({shots.length})</span>
          <button className={styles.primaryBtn} onClick={handleGenerateStoryboard} disabled={initing || !script.trim()}>
            {initing ? '生成中...' : shots.length ? '重新生成分镜脚本' : '生成分镜脚本'}
          </button>
        </div>

        <StoryboardGenerator onSettingsChange={setSbSettings} />

        {shots.length === 0 ? (
          <div className={styles.emptyShots}>输入脚本后，点击「生成分镜脚本」自动规划</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.shotTable}>
              <thead>
                <tr>
                  <th className={styles.thNum}>#</th>
                  <th className={styles.thDesc}>画面描述</th>
                  <th className={styles.thSubtitle}>旁白</th>
                  <th className={styles.thShotType}>景别</th>
                  <th className={styles.thLighting}>光影氛围</th>
                  <th className={styles.thCamera}>运镜</th>
                  <th className={styles.thDur}>时长</th>
                  <th className={styles.thSubjects}>主体</th>
                  <th className={styles.th3D}>3D机位</th>
                  <th className={styles.thStatus}>状态</th>
                  <th className={styles.thActions}>操作</th>
                </tr>
              </thead>
              <tbody>
                {shots.map((shot, idx) => {
                  const status = STATUS_LABELS[shot.task_status] || STATUS_LABELS.idle;
                  return (
                    <tr key={shot.id} className={styles.shotRow} onClick={() => setExpandedShot(shot.id)}>
                      <td className={styles.cellNum}>{idx + 1}</td>
                      <td className={styles.cellDesc}>
                        <span className={styles.cellText}>{shot.description || '-'}</span>
                      </td>
                      <td className={styles.cellSubtitle}>
                        <span className={styles.cellText}>{shot.subtitle || '-'}</span>
                      </td>
                      <td className={styles.cellShotType}>
                        {SHOT_TYPES.find(t => t.value === shot.shot_type)?.label || '-'}
                      </td>
                      <td className={styles.cellLighting}>
                        {LIGHTING_TYPES.find(t => t.value === shot.lighting)?.label || '-'}
                      </td>
                      <td className={styles.cellCamera}>
                        {MOVEMENT_TYPES.find(m => m.value === shot.camera_movement_type)?.label || '静止'}
                      </td>
                      <td className={styles.cellDur}>{shot.duration}s</td>
                      <td className={styles.cellSubjects}>
                        {(shot.subjects || []).map(s => s.label).join(', ') || '-'}
                      </td>
                      <td className={styles.cell3D} onClick={e => e.stopPropagation()}>
                        <button className={styles.cameraBtn} onClick={() => setCameraOpen(shot.id)}>
                          查看
                        </button>
                      </td>
                      <td className={styles.cellStatus}>
                        <span style={{ color: status.color }}>{status.label}</span>
                      </td>
                      <td className={styles.cellActions} onClick={e => e.stopPropagation()}>
                        <button className={styles.genBtn} onClick={() => handleGenerateVideo(shot)} disabled={generating.has(shot.id) || shot.task_status === 'running'}>
                          {generating.has(shot.id) ? '...' : shot.task_status === 'running' ? '...' : '生成'}
                        </button>
                        <button className={styles.delBtn} onClick={() => handleDeleteShot(shot.id)}>删</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Shot Detail Modal */}
        {expandedShot && (
          <ShotModal
            shot={shots.find(s => s.id === expandedShot)!}
            index={shots.findIndex(s => s.id === expandedShot)}
            videoSubjects={videoSubjects}
            ratio={ratio}
            isGenerating={generating.has(expandedShot)}
            onClose={() => { setExpandedShot(null); }}
            onUpdate={fields => handleShotUpdate(expandedShot, fields)}
            onDelete={() => { handleDeleteShot(expandedShot); setExpandedShot(null); }}
            onGenerate={() => { const shot = shots.find(s => s.id === expandedShot); if (shot) handleGenerateVideo(shot); }}
            onToggleSubject={sub => { const shot = shots.find(s => s.id === expandedShot); if (shot) toggleShotSubject(shot, sub); }}
          />
        )}

        {/* Standalone 3D Camera Modal */}
        {cameraOpen && (() => {
          const camShot = shots.find(s => s.id === cameraOpen);
          if (!camShot) return null;
          return (
            <div className={styles.modalOverlay} onClick={() => setCameraOpen(null)}>
              <div className={styles.cameraModal} onClick={e => e.stopPropagation()}>
                <div className={styles.modalHeader}>
                  <h3 className={styles.modalTitle}>3D机位 — 分镜 #{shots.indexOf(camShot) + 1}</h3>
                  <button className={styles.modalClose} onClick={() => setCameraOpen(null)}>×</button>
                </div>
                <div className={styles.cameraModalBody}>
                  <CameraEditor
                    value={{
                      position: { x: camShot.camera_position_x, y: camShot.camera_position_y, z: camShot.camera_position_z },
                      target: { x: camShot.camera_target_x, y: camShot.camera_target_y, z: camShot.camera_target_z },
                      fov: camShot.camera_fov,
                      movementType: camShot.camera_movement_type || 'static',
                    }}
                    onChange={(state: CameraState) => handleShotUpdate(cameraOpen, {
                      camera_position_x: state.position.x,
                      camera_position_y: state.position.y,
                      camera_position_z: state.position.z,
                      camera_target_x: state.target.x,
                      camera_target_y: state.target.y,
                      camera_target_z: state.target.z,
                      camera_fov: state.fov,
                      camera_movement_type: state.movementType,
                    })}
                    ratio={camShot.ratio || undefined}
                    subjects={camShot.subjects || []}
                    onSubjectsChange={(subjects: ShotSubject[]) => handleShotUpdate(cameraOpen, { subjects })}
                  />
                </div>
              </div>
            </div>
          );
        })()}
      </main>
    </div>
  );
}

// ─── ShotModal ──────────────────────────────────────────────────────────────

interface ShotModalProps {
  shot: Shot;
  index: number;
  videoSubjects: ProjectSubject[];
  ratio: string;
  isGenerating: boolean;
  onClose: () => void;
  onUpdate: (fields: Partial<Shot>) => void;
  onDelete: () => void;
  onGenerate: () => void;
  onToggleSubject: (sub: ProjectSubject) => void;
}

function ShotModal({ shot, index, videoSubjects, ratio, isGenerating, onClose, onUpdate, onDelete, onGenerate, onToggleSubject }: ShotModalProps) {
  const [description, setDescription] = useState(shot.description || '');
  const [prompt, setPrompt] = useState(shot.prompt || '');
  const [subtitle, setSubtitle] = useState(shot.subtitle || '');
  const [dirty, setDirty] = useState(false);

  const shotSubjectLabels = (shot.subjects || []).map(s => s.label);
  const status = STATUS_LABELS[shot.task_status] || STATUS_LABELS.idle;

  useEffect(() => {
    setDescription(shot.description || '');
    setPrompt(shot.prompt || '');
    setSubtitle(shot.subtitle || '');
    setDirty(false);
  }, [shot.id, shot.description, shot.prompt, shot.subtitle]);

  function handleTextChange(field: 'description' | 'prompt' | 'subtitle', val: string) {
    if (field === 'description') setDescription(val);
    else if (field === 'prompt') setPrompt(val);
    else setSubtitle(val);
    setDirty(true);
  }

  function handleSaveText() {
    onUpdate({ description, prompt, subtitle });
    setDirty(false);
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>分镜 #{index + 1}</h3>
          <span className={styles.modalStatus} style={{ color: status.color }}>{status.label}</span>
          <button className={styles.modalClose} onClick={onClose}>×</button>
        </div>

        <div className={styles.modalBody}>
          {/* Text fields with save button */}
          <div className={styles.modalField}>
            <label>画面描述</label>
            <textarea
              className={styles.modalTextarea}
              value={description}
              onChange={e => handleTextChange('description', e.target.value)}
              rows={2}
              placeholder="描述该分镜的画面内容..."
            />
          </div>
          <div className={styles.modalField}>
            <label>生成提示词</label>
            <textarea
              className={styles.modalTextarea}
              value={prompt}
              onChange={e => handleTextChange('prompt', e.target.value)}
              rows={3}
              placeholder="视频生成的英文/中文提示词..."
            />
            <LibraryPanel onInsert={snippet => {
              const sep = prompt.trim() && !/[,.;]\s*$/.test(prompt.trim()) ? ', ' : prompt.trim() ? ' ' : '';
              handleTextChange('prompt', prompt.trim() + sep + snippet);
            }} />
          </div>
          <div className={styles.modalField}>
            <label>旁白/对白</label>
            <textarea
              className={styles.modalTextarea}
              value={subtitle}
              onChange={e => handleTextChange('subtitle', e.target.value)}
              rows={2}
              placeholder="该分镜的旁白或对白文本..."
            />
          </div>

          {dirty && (
            <div className={styles.saveBar}>
              <button className={styles.saveBtn} onClick={handleSaveText}>保存文本</button>
              <span className={styles.saveHint}>文本已修改，点击保存</span>
            </div>
          )}

          {/* Auto-save fields */}
          <div className={styles.modalRow}>
            <label className={styles.modalSmall}>
              时长(s)
              <input
                type="number"
                className={styles.modalInputSmall}
                value={shot.duration}
                min={4} max={15}
                onChange={e => onUpdate({ duration: Number(e.target.value) })}
              />
            </label>
            <label className={styles.modalSmall}>
              景别
              <select
                className={styles.modalSelect}
                value={shot.shot_type || ''}
                onChange={e => onUpdate({ shot_type: e.target.value || null })}
              >
                <option value="">--</option>
                {SHOT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label className={styles.modalSmall}>
              光影氛围
              <select
                className={styles.modalSelect}
                value={shot.lighting || ''}
                onChange={e => onUpdate({ lighting: e.target.value || null })}
              >
                <option value="">--</option>
                {LIGHTING_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label className={styles.modalSmall}>
              运镜
              <select
                className={styles.modalSelect}
                value={shot.camera_movement_type || 'static'}
                onChange={e => onUpdate({ camera_movement_type: e.target.value })}
              >
                {MOVEMENT_TYPES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
          </div>

          {/* Subjects */}
          <div className={styles.modalField}>
            <label>出场主体</label>
            <div className={styles.shotSubjectList}>
              {videoSubjects.map(sub => {
                const active = shotSubjectLabels.includes(sub.label);
                return (
                  <button
                    key={sub.id}
                    className={`${styles.shotSubjectTag} ${active ? styles.shotSubjectActive : ''}`}
                    onClick={() => onToggleSubject(sub)}
                  >
                    {active && <span style={{ marginRight: 3 }}>✓</span>}{sub.label}
                  </button>
                );
              })}
              {videoSubjects.length === 0 && <span className={styles.pickerEmpty}>请先在视频主体中添加</span>}
            </div>
          </div>

          {/* Shot Media (upload images/video/audio) */}
          <ShotMedia
            images={shot.reference_images || []}
            onUpdate={(imgs) => onUpdate({ reference_images: imgs })}
          />

          {/* Video result */}
          {shot.video_url && (
            <div className={styles.modalField}>
              <label>生成结果</label>
              <video src={shot.video_url} controls className={styles.shotVideo} />
            </div>
          )}
        </div>

        <div className={styles.modalFooter}>
          <button className={styles.primaryBtn} onClick={onGenerate} disabled={isGenerating || shot.task_status === 'running'}>
            {isGenerating ? '提交中...' : shot.task_status === 'running' ? '生成中...' : '生成视频'}
          </button>
          <button className={styles.delBtn} onClick={onDelete}>删除分镜</button>
        </div>
      </div>
    </div>
  );
}

// ─── ShotMedia ──────────────────────────────────────────────────────────────

interface ReferenceImage {
  url: string;
  name?: string;
  role?: string;
}

function ShotMedia({ images, onUpdate }: { images: ReferenceImage[]; onUpdate: (imgs: ReferenceImage[]) => void }) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    const { getAccessToken } = await import('@/lib/auth');
    const token = getAccessToken();
    const newItems: ReferenceImage[] = [...images];

    for (const file of Array.from(files)) {
      try {
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const form = new FormData();
        form.append('file', file);
        const res = await fetch('/api/upload', { method: 'POST', body: form, headers });
        const json = await res.json();
        if (json.success) {
          const role = file.type.startsWith('video/') ? 'reference_video'
                     : file.type.startsWith('audio/') ? 'reference_audio'
                     : 'reference_image';
          newItems.push({ url: json.data.url, name: file.name, role });
        }
      } catch {}
    }

    onUpdate(newItems);
    setUploading(false);
  }

  function handleRemove(idx: number) {
    onUpdate(images.filter((_, i) => i !== idx));
  }

  const imageItems = images.filter(m => !m.role || m.role === 'reference_image');
  const videoItems = images.filter(m => m.role === 'reference_video');
  const audioItems = images.filter(m => m.role === 'reference_audio');

  return (
    <div className={styles.modalField}>
      <div className={styles.modalFieldHeader}>
        <label>参考素材 ({images.length})</label>
        <button className={styles.cameraBtn} onClick={() => inputRef.current?.click()} disabled={uploading}>
          {uploading ? '上传中...' : '+ 上传'}
        </button>
        <input ref={inputRef} type="file" accept="image/*,video/*,audio/*" multiple style={{ display: 'none' }}
          onChange={e => { handleFiles(e.target.files); e.target.value = ''; }} />
      </div>
      {images.length > 0 && (
        <div className={styles.mediaList}>
          {imageItems.map((img, i) => {
            const globalIdx = images.indexOf(img);
            return (
              <div key={globalIdx} className={styles.mediaItem}>
                <img src={img.url} alt="" className={styles.refThumb} />
                <span className={styles.mediaName}>{img.name || '图片'}</span>
                <button className={styles.mediaRemoveBtn} onClick={() => handleRemove(globalIdx)}>×</button>
              </div>
            );
          })}
          {videoItems.map((item) => {
            const globalIdx = images.indexOf(item);
            return (
              <div key={globalIdx} className={styles.mediaItem}>
                <span className={styles.mediaIcon}>🎬</span>
                <span className={styles.mediaName}>{item.name || '视频'}</span>
                <button className={styles.mediaRemoveBtn} onClick={() => handleRemove(globalIdx)}>×</button>
              </div>
            );
          })}
          {audioItems.map((item) => {
            const globalIdx = images.indexOf(item);
            return (
              <div key={globalIdx} className={styles.mediaItem}>
                <span className={styles.mediaIcon}>🎵</span>
                <span className={styles.mediaName}>{item.name || '音频'}</span>
                <button className={styles.mediaRemoveBtn} onClick={() => handleRemove(globalIdx)}>×</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
