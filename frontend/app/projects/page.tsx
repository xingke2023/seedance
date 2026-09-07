'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { haptic, hapticStrong } from '@/lib/haptics';
import styles from './page.module.css';

interface Project {
  id: string;
  name: string;
  description: string | null;
  cover_url: string | null;
  video_count: number;
  created_at: string;
  updated_at: string;
}

// 后端 `/projects/default` 按这个名字查/建默认项目，删了下次进 voiceover-v3 又会
// 自动建一个空的回来，却把里面的视频全带走 —— 所以它不给删（后端 DELETE 也拦一道）
const DEFAULT_PROJECT_NAME = '默认视频项目';

const GUIDE_STEPS = [
  { title: '新建项目', desc: '点击「新建项目」创建一个视频项目，用于管理相关的视频素材和分镜' },
  { title: '编写剧本', desc: '进入项目后，输入视频剧本内容，或使用 AI 辅助生成' },
  { title: '生成分镜', desc: '一键将剧本拆分为多个分镜，自动生成镜头描述和提示词' },
  { title: '生成视频', desc: '逐个或批量提交分镜生成 AI 视频，支持合并和配音' },
];

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const loadProjects = useCallback(async () => {
    try {
      const data = await api.get<Project[]>('/projects');
      setProjects(data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  async function handleCreate() {
    if (!newName.trim()) return;
    haptic();
    setCreating(true);
    try {
      const data = await api.post<Project>('/projects', { name: newName.trim() });
      if (data?.id) {
        router.push(`/projects/${data.id}`);
      }
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    hapticStrong();
    if (!confirm('确定删除该项目？所有视频将一并删除。')) return;
    try {
      await api.del(`/projects/${id}`);
      setProjects(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      // 后端会拒掉默认项目的删除，静默失败会让人以为点了没反应
      alert(err instanceof Error ? err.message : '删除失败');
    }
  }

  function formatDate(d: string) {
    return new Date(d).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  const videoTotal = projects.reduce((sum, p) => sum + (p.video_count || 0), 0);

  return (
    <div className={styles.shell}>
      <div className={styles.container}>
        <div className={styles.hero}>
          <div className={styles.heroTop}>
            <div>
              <h1 className={styles.title}>项目库</h1>
              <div className={styles.subtitle}>剧本 · 分镜 · AI 短视频一站式创作</div>
            </div>
            <button className={styles.createBtn} disabled onClick={() => { haptic(); setShowCreate(true); }}>
              + 新建
            </button>
          </div>
          <div className={styles.heroStats}>
            <div className={styles.stat}>
              <div className={styles.statNum}>{loading ? '—' : projects.length}</div>
              <div className={styles.statLabel}>项目</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statNum}>{loading ? '—' : videoTotal}</div>
              <div className={styles.statLabel}>视频</div>
            </div>
          </div>
        </div>

        {showCreate && (
          <div className={styles.createForm}>
            <input
              className={styles.createInput}
              placeholder="项目名称"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              autoFocus
            />
            <button className={styles.createConfirm} onClick={handleCreate} disabled={creating}>
              {creating ? '创建中...' : '创建'}
            </button>
            <button className={styles.createCancel} onClick={() => { setShowCreate(false); setNewName(''); }}>
              取消
            </button>
          </div>
        )}

        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>我的项目</h2>
          {!loading && projects.length > 0 && (
            <span className={styles.sectionCount}>{projects.length} 个</span>
          )}
        </div>

        {loading ? (
          <div className={styles.grid}>
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
          </div>
        ) : projects.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>📁</div>
            <div>还没有项目</div>
            <div className={styles.emptyHint}>点击「新建项目」开始创作</div>
          </div>
        ) : (
          <div className={styles.grid}>
            {projects.map(project => (
              <div key={project.id} className={styles.card} onClick={() => { haptic(); router.push(`/projects/${project.id}`); }}>
                <div className={styles.thumb}>
                  {project.cover_url ? (
                    <img src={project.cover_url} alt="" />
                  ) : (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="6 3 20 12 6 21 6 3" />
                    </svg>
                  )}
                </div>
                <div className={styles.cardBody}>
                  <div className={styles.cardName}>{project.name}</div>
                  <div className={styles.cardMeta}>
                    <span className={styles.badge}>{project.video_count} 个视频</span>
                    <span className={styles.cardDate}>{formatDate(project.updated_at)}</span>
                  </div>
                </div>
                {/* 默认项目不给删（后端 DELETE 也拦一道），这里不放删除键 */}
                {project.name !== DEFAULT_PROJECT_NAME && (
                  <button className={styles.cardDelete} onClick={e => handleDelete(e, project.id)} title="删除">
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className={styles.guide}>
          <h3 className={styles.guideTitle}>使用指南</h3>
          <div className={styles.guideSteps}>
            {GUIDE_STEPS.map((step, i) => (
              <div key={step.title} className={styles.guideStep}>
                <span className={styles.guideNum}>{i + 1}</span>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <button className={styles.fab} disabled onClick={() => { haptic(); setShowCreate(true); }} title="新建项目">
        +
      </button>
    </div>
  );
}
