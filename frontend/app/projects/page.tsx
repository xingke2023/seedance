'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
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
    if (!confirm('确定删除该项目？所有视频将一并删除。')) return;
    try {
      await api.del(`/projects/${id}`);
      setProjects(prev => prev.filter(p => p.id !== id));
    } catch {
      // ignore
    }
  }

  function formatDate(d: string) {
    return new Date(d).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>项目库</h1>
        <button className={styles.createBtn} disabled onClick={() => setShowCreate(true)}>
          + 新建项目
        </button>
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

      {loading ? (
        <div className={styles.empty}>加载中...</div>
      ) : projects.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>📁</div>
          <div>还没有项目</div>
          <div className={styles.emptyHint}>点击「新建项目」开始创作</div>
        </div>
      ) : (
        <div className={styles.grid}>
          {projects.map(project => (
            <div key={project.id} className={styles.card} onClick={() => router.push(`/projects/${project.id}`)}>
              <div className={styles.cardBody}>
                <svg className={styles.cardIcon} width="18" height="18" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" stroke="currentColor">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                <div>
                  <div className={styles.cardName}>{project.name}</div>
                  <div className={styles.cardMeta}>
                    <span>{project.video_count} 个视频</span>
                    <span>{formatDate(project.updated_at)}</span>
                  </div>
                </div>
              </div>
              <button className={styles.cardDelete} onClick={e => handleDelete(e, project.id)} title="删除">
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className={styles.guide}>
        <h3 className={styles.guideTitle}>使用指南</h3>
        <div className={styles.guideSteps}>
          <div className={styles.guideStep}>
            <span className={styles.guideNum}>1</span>
            <div>
              <strong>新建项目</strong>
              <p>点击「新建项目」创建一个视频项目，用于管理相关的视频素材和分镜</p>
            </div>
          </div>
          <div className={styles.guideStep}>
            <span className={styles.guideNum}>2</span>
            <div>
              <strong>编写剧本</strong>
              <p>进入项目后，输入视频剧本内容，或使用 AI 辅助生成</p>
            </div>
          </div>
          <div className={styles.guideStep}>
            <span className={styles.guideNum}>3</span>
            <div>
              <strong>生成分镜</strong>
              <p>一键将剧本拆分为多个分镜，自动生成镜头描述和提示词</p>
            </div>
          </div>
          <div className={styles.guideStep}>
            <span className={styles.guideNum}>4</span>
            <div>
              <strong>生成视频</strong>
              <p>逐个或批量提交分镜生成 AI 视频，支持合并和配音</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
