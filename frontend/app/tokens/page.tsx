'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';

interface Token {
  id: string;
  label: string;
  principal_id: string;
  is_active: boolean;
  created_at: number;
  last_used_at: number | null;
}

interface NewTokenResult {
  raw_token: string;
  token_id: string;
  label: string;
}

export default function TokensPage() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<NewTokenResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function loadTokens() {
    setLoading(true);
    setError('');
    try {
      const res = await api.get<Token[]>('/manage/tokens');
      setTokens(Array.isArray(res) ? res : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadTokens(); }, []);

  async function createToken() {
    if (!newLabel.trim()) return;
    setCreating(true);
    setError('');
    try {
      const res = await api.post<NewTokenResult>('/manage/tokens', { label: newLabel.trim() });
      setNewToken(res);
      setNewLabel('');
      await loadTokens();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setCreating(false);
    }
  }

  async function deleteToken(tokenId: string) {
    if (!confirm('确定删除该 Token？删除后使用该 Token 的请求将失败。')) return;
    try {
      await fetch(`/api/manage/tokens/${tokenId}`, { method: 'DELETE' });
      await loadTokens();
    } catch {}
  }

  function copyToken(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function formatTime(ts: number | null) {
    if (!ts) return '-';
    return new Date(ts * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  return (
    <div style={{ padding: '16px 12px', maxWidth: 900, margin: '0 auto', fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif' }}>
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 20, lineHeight: 1.7 }}>
        Token 用于 API 调用时的身份认证，通过 <code style={{ background: '#f3f4f6', padding: '1px 6px', borderRadius: 3 }}>Authorization: Bearer &lt;token&gt;</code> 方式鉴权。<br/>
        每个 Token 仅在创建时显示一次完整值，请妥善保存。
      </p>

      {/* Create Token */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center' }}>
        <input type="text" placeholder="Token 标签（如: production）" value={newLabel}
          onChange={e => setNewLabel(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && createToken()}
          style={{ padding: '8px 12px', border: '1px solid #d4d4d8', borderRadius: 6, fontSize: 14, width: 220 }} />
        <button onClick={createToken} disabled={creating || !newLabel.trim()}
          style={{ padding: '8px 16px', borderRadius: 6, background: '#2563eb', color: '#fff', border: 'none', fontSize: 14, fontWeight: 500, cursor: 'pointer', opacity: creating || !newLabel.trim() ? 0.5 : 1 }}>
          {creating ? '创建中…' : '+ 创建 Token'}
        </button>
        <button onClick={loadTokens} disabled={loading}
          style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
          ↻ 刷新
        </button>
      </div>

      {/* New Token Alert */}
      {newToken && (
        <div style={{ background: '#ecfdf5', border: '1px solid #6ee7b7', borderRadius: 8, padding: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#065f46', marginBottom: 8 }}>Token 创建成功</div>
          <p style={{ fontSize: 12, color: '#047857', marginBottom: 8 }}>请立即复制保存，此 Token 不会再次显示：</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{ flex: 1, fontSize: 12, background: '#fff', padding: '8px 12px', borderRadius: 4, border: '1px solid #d1fae5', wordBreak: 'break-all' }}>
              {newToken.raw_token}
            </code>
            <button onClick={() => copyToken(newToken.raw_token)}
              style={{ padding: '6px 12px', borderRadius: 4, background: '#059669', color: '#fff', border: 'none', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          <button onClick={() => setNewToken(null)} style={{ marginTop: 8, fontSize: 12, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer' }}>关闭</button>
        </div>
      )}

      {error && <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '10px 14px', fontSize: 13, color: '#dc2626', marginBottom: 16 }}>{error}</div>}

      {/* Token List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {tokens.map(token => (
          <div key={token.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{token.label || '(无标签)'}</span>
                <span style={{
                  fontSize: 11, padding: '1px 6px', borderRadius: 8,
                  background: token.is_active ? '#dcfce7' : '#f3f4f6',
                  color: token.is_active ? '#166534' : '#6b7280',
                }}>{token.is_active ? '活跃' : '已禁用'}</span>
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                <code>{token.id}</code> · 创建: {formatTime(token.created_at)} · 最近使用: {formatTime(token.last_used_at)}
              </div>
            </div>
            <button onClick={() => deleteToken(token.id)}
              style={{ padding: '4px 10px', borderRadius: 4, background: '#fff', border: '1px solid #e5e7eb', color: '#dc2626', fontSize: 12, cursor: 'pointer' }}>
              删除
            </button>
          </div>
        ))}
        {!loading && tokens.length === 0 && (
          <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: 40 }}>暂无 Token，点击上方按钮创建</p>
        )}
      </div>
    </div>
  );
}
