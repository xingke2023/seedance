'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';

interface Task {
  id: string;
  model: string;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  content: { video_url: string | null; last_frame_url: string | null };
  resolution: string;
  ratio: string;
  duration: number;
  usage: { completion_tokens: number; total_tokens: number } | null;
}

const STATUS_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  queued:    { label: '排队中', color: '#92400e', bg: '#fef3c7' },
  running:   { label: '运行中', color: '#1d4ed8', bg: '#dbeafe' },
  succeeded: { label: '成功',   color: '#166534', bg: '#dcfce7' },
  failed:    { label: '失败',   color: '#dc2626', bg: '#fee2e2' },
  cancelled: { label: '已取消', color: '#6b7280', bg: '#f3f4f6' },
  expired:   { label: '已过期', color: '#6b7280', bg: '#f3f4f6' },
};

const STATUS_OPTIONS = ['', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'];

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).then(() => {
    // brief visual feedback handled by caller
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [detail, setDetail] = useState<Task | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const pageSize = 15;

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      let url = `/manage/tasks?page=${page}&page_size=${pageSize}`;
      if (statusFilter) url += `&status=${statusFilter}`;
      const res = await api.get<{ items: Task[]; total: number }>(url);
      setTasks(res.items || []);
      setTotal(res.total || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  useEffect(() => {
    if (!autoRefresh) return;
    const iv = setInterval(loadTasks, 10000);
    return () => clearInterval(iv);
  }, [autoRefresh, loadTasks]);

  const totalPages = Math.ceil(total / pageSize);

  function formatTime(ts: number) {
    return new Date(ts * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function handleCopyId(id: string) {
    copyToClipboard(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  return (
    <div style={{ padding: '16px 12px', maxWidth: 1200, margin: '0 auto', fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif' }}>
      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          style={{ padding: '7px 12px', borderRadius: 6, border: '1px solid #d4d4d8', fontSize: 13 }}>
          <option value="">全部状态</option>
          {STATUS_OPTIONS.filter(Boolean).map(s => (
            <option key={s} value={s}>{STATUS_LABELS[s]?.label || s}</option>
          ))}
        </select>

        <button onClick={loadTasks} disabled={loading}
          style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
          刷新
        </button>

        <label style={{ fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
          <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
          自动刷新
        </label>

        <span style={{ fontSize: 12, color: '#9ca3af' }}>共 {total} 条</span>
      </div>

      {error && <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '10px 14px', fontSize: 13, color: '#dc2626', marginBottom: 16 }}>{error}</div>}

      {/* Mobile Card List */}
      <div className="task-cards">
        {tasks.map(task => {
          const st = STATUS_LABELS[task.status] || { label: task.status, color: '#6b7280', bg: '#f3f4f6' };
          return (
            <div key={task.id} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 10, background: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <button onClick={() => handleCopyId(task.id)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <code style={{ fontSize: 11, color: '#374151', wordBreak: 'break-all' }}>{task.id}</code>
                  <span style={{ fontSize: 10, color: copiedId === task.id ? '#16a34a' : '#9ca3af', whiteSpace: 'nowrap' }}>
                    {copiedId === task.id ? '已复制' : '复制'}
                  </span>
                </button>
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: st.bg, color: st.color, fontWeight: 500 }}>
                  {st.label}
                </span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 12, color: '#6b7280' }}>
                <span>{task.model.replace('doubao-seedance-', 'SD ')}</span>
                <span>{task.resolution} / {task.ratio}</span>
                <span>{task.duration}s</span>
                {task.usage && <span>{task.usage.total_tokens.toLocaleString()} tokens</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
                <span style={{ fontSize: 11, color: '#9ca3af' }}>{formatTime(task.created_at)}</span>
                <button onClick={() => setDetail(task)}
                  style={{ fontSize: 12, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer' }}>
                  详情
                </button>
              </div>
            </div>
          );
        })}
        {!loading && tasks.length === 0 && (
          <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40, fontSize: 13 }}>暂无任务</div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} style={pgBtn}>上一页</button>
          <span style={{ fontSize: 13, color: '#6b7280', lineHeight: '32px' }}>{page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} style={pgBtn}>下一页</button>
        </div>
      )}

      {/* Detail Modal */}
      {detail && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => setDetail(null)}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 20, maxWidth: 600, width: '100%', maxHeight: '80vh', overflow: 'auto' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>任务详情</h3>
              <button onClick={() => setDetail(null)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#6b7280' }}>x</button>
            </div>
            <div style={{ fontSize: 13, lineHeight: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <b>ID:</b>
                <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{detail.id}</code>
                <button onClick={() => handleCopyId(detail.id)}
                  style={{ fontSize: 11, color: copiedId === detail.id ? '#16a34a' : '#2563eb', background: 'none', border: 'none', cursor: 'pointer' }}>
                  {copiedId === detail.id ? '已复制' : '复制'}
                </button>
              </div>
              <div><b>模型:</b> {detail.model}</div>
              <div><b>状态:</b> {STATUS_LABELS[detail.status]?.label || detail.status}</div>
              <div><b>分辨率:</b> {detail.resolution} / {detail.ratio}</div>
              <div><b>时长:</b> {detail.duration}s</div>
              <div><b>Tokens:</b> {detail.usage?.total_tokens?.toLocaleString() || '-'}</div>
              <div><b>创建:</b> {formatTime(detail.created_at)}</div>
              <div><b>更新:</b> {formatTime(detail.updated_at)}</div>
              {detail.error && <div><b>错误:</b> <span style={{ color: '#dc2626' }}>{detail.error}</span></div>}
              {detail.content?.video_url && (
                <div style={{ marginTop: 12 }}>
                  <b>视频:</b>
                  <video src={detail.content.video_url} controls style={{ width: '100%', borderRadius: 8, marginTop: 8 }} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const pgBtn: React.CSSProperties = { padding: '6px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer' };
