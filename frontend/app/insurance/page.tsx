'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CaseRow {
  id: number; title: string; tags: string[];
  customer_age: number | null; family_structure: string | null;
  insurance_needs: string | null; description: string;
  is_featured: boolean;
}
interface CaseDetail extends CaseRow {
  content: string; key_points: unknown; budget_suggestion: string;
}
interface QaRow { id: number; title: string; tags: string[] }
interface QaDetail extends QaRow { content: string }
interface TagCount { tag: string; count: number }

type Tab = 'cases' | 'qa';

const PAGE_SIZE = 20;

export default function InsurancePage() {
  const [tab, setTab] = useState<Tab>('cases');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');   // committed search term
  const [tag, setTag] = useState('');
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<(CaseRow | QaRow)[]>([]);
  const [total, setTotal] = useState(0);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [detail, setDetail] = useState<CaseDetail | QaDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Tag lists are per-tab and static; fetch once each time the tab changes.
  useEffect(() => {
    let cancelled = false;
    api.get<{ Items: TagCount[] }>(`/library/${tab}/tags`)
      .then(r => { if (!cancelled) setTags(r.Items || []); })
      .catch(() => { if (!cancelled) setTags([]); });
    return () => { cancelled = true; };
  }, [tab]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
      if (query) params.set('q', query);
      if (tag) params.set('tag', tag);
      const r = await api.get<{ Items: (CaseRow | QaRow)[]; Total: number }>(`/library/${tab}?${params}`);
      setRows(r.Items || []);
      setTotal(r.Total || 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
      setRows([]); setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [tab, query, tag, page]);

  useEffect(() => { load(); }, [load]);

  function switchTab(t: Tab) {
    if (t === tab) return;
    setTab(t); setQ(''); setQuery(''); setTag(''); setPage(1); setDetail(null);
  }

  function search() { setQuery(q.trim()); setPage(1); }

  function pickTag(t: string) { setTag(t === tag ? '' : t); setPage(1); }

  async function openDetail(id: number) {
    setDetailLoading(true);
    try {
      setDetail(await api.get<CaseDetail | QaDetail>(`/library/${tab}/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      setDetailLoading(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '16px 14px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#111827', margin: 0 }}>港险资料</h1>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>分镜取材用的案例与问答语料</span>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {([['cases', '案例'], ['qa', '问答']] as [Tab, string][]).map(([t, label]) => (
          <button key={t} type="button" onClick={() => switchTab(t)}
            style={{
              fontSize: 13, padding: '5px 14px', borderRadius: 6, cursor: 'pointer',
              border: tab === t ? '1.5px solid #2563eb' : '1px solid #e5e7eb',
              background: tab === t ? '#eff6ff' : '#fff',
              color: tab === t ? '#2563eb' : '#6b7280',
              fontWeight: tab === t ? 600 : 400,
            }}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <input value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') search(); }}
          placeholder={tab === 'cases' ? '搜索案例标题或描述，回车检索' : '搜索问答标题或内容，回车检索'}
          style={{ flex: 1, fontSize: 13, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, outline: 'none' }} />
        <button type="button" onClick={search}
          style={{ fontSize: 13, padding: '6px 16px', border: 'none', borderRadius: 6, background: '#2563eb', color: '#fff', cursor: 'pointer' }}>
          搜索
        </button>
      </div>

      {tags.length > 0 && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
          {tags.slice(0, 24).map(t => (
            <button key={t.tag} type="button" onClick={() => pickTag(t.tag)}
              style={{
                fontSize: 11, padding: '3px 9px', borderRadius: 999, cursor: 'pointer',
                border: tag === t.tag ? '1px solid #2563eb' : '1px solid #e5e7eb',
                background: tag === t.tag ? '#eff6ff' : '#fff',
                color: tag === t.tag ? '#2563eb' : '#6b7280',
              }}>
              {t.tag} <span style={{ color: '#9ca3af' }}>{t.count}</span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <div style={{ fontSize: 12, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '7px 10px', marginBottom: 10 }}>
          {error}
        </div>
      )}

      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
        {loading ? '加载中…' : `共 ${total} 条${tag ? `　标签：${tag}` : ''}${query ? `　关键词：${query}` : ''}`}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map(r => (
          <button key={r.id} type="button" onClick={() => openDetail(r.id)}
            style={{
              display: 'flex', flexDirection: 'column', gap: 3, textAlign: 'left',
              padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8,
              background: '#fff', cursor: 'pointer',
            }}>
            <span style={{ fontSize: 13.5, color: '#111827' }}>
              {'is_featured' in r && r.is_featured && <span style={{ color: '#f59e0b', marginRight: 4 }}>★</span>}
              {r.title}
            </span>
            {'description' in r && r.description && (
              <span style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {r.description}
              </span>
            )}
            {r.tags?.length > 0 && (
              <span style={{ fontSize: 11, color: '#9ca3af' }}>{r.tags.slice(0, 5).join(' · ')}</span>
            )}
          </button>
        ))}
        {!loading && rows.length === 0 && (
          <div style={{ fontSize: 13, color: '#9ca3af', padding: '24px 0', textAlign: 'center' }}>没有匹配的内容</div>
        )}
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 16 }}>
          <button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)}
            style={{ fontSize: 12, padding: '5px 12px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', cursor: page <= 1 ? 'not-allowed' : 'pointer', color: page <= 1 ? '#d1d5db' : '#374151' }}>
            上一页
          </button>
          <span style={{ fontSize: 12, color: '#6b7280' }}>{page} / {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}
            style={{ fontSize: 12, padding: '5px 12px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', cursor: page >= totalPages ? 'not-allowed' : 'pointer', color: page >= totalPages ? '#d1d5db' : '#374151' }}>
            下一页
          </button>
        </div>
      )}

      {/* 详情浮窗 */}
      {(detail || detailLoading) && (
        <div onMouseDown={e => { if (e.target === e.currentTarget) setDetail(null); }}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{
            display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 720, maxHeight: '76vh',
            background: '#fff', border: '1px solid #d1d5db', borderRadius: 12,
            boxShadow: '0 16px 40px rgba(15,23,42,.22)', overflow: 'hidden',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', borderBottom: '1px solid #e5e7eb' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>
                {detailLoading ? '读取中…' : detail?.title}
              </span>
              <button type="button" onClick={() => setDetail(null)} aria-label="关闭"
                style={{ background: 'none', border: 'none', fontSize: 22, lineHeight: 1, color: '#9ca3af', cursor: 'pointer' }}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
              {detail && (
                <>
                  {detail.tags?.length > 0 && (
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>{detail.tags.join(' · ')}</div>
                  )}
                  {'customer_age' in detail && (
                    <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.9, marginBottom: 10 }}>
                      {detail.customer_age ? <div>客户年龄：{detail.customer_age}</div> : null}
                      {detail.family_structure ? <div>家庭结构：{detail.family_structure}</div> : null}
                      {detail.insurance_needs ? <div>保障需求：{detail.insurance_needs}</div> : null}
                      {detail.budget_suggestion ? <div>预算建议：{detail.budget_suggestion}</div> : null}
                    </div>
                  )}
                  {'description' in detail && detail.description && (
                    <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.8, whiteSpace: 'pre-wrap', margin: '0 0 10px' }}>
                      {detail.description}
                    </p>
                  )}
                  <p style={{ fontSize: 13, color: '#111827', lineHeight: 1.9, whiteSpace: 'pre-wrap', margin: 0 }}>
                    {detail.content}
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
