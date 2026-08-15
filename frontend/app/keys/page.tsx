'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';

interface ResourceKey {
  id: string;
  label: string;
  access_key: string;
  secret_key_masked?: string;
  source?: string;
  created_at: number | null;
}

export default function KeysPage() {
  const [keys, setKeys] = useState<ResourceKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newAK, setNewAK] = useState('');
  const [newSK, setNewSK] = useState('');
  const [creating, setCreating] = useState(false);

  async function loadKeys() {
    setLoading(true);
    setError('');
    try {
      const res = await api.get<ResourceKey[]>('/manage/keys');
      setKeys(Array.isArray(res) ? res : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadKeys(); }, []);

  async function createKey() {
    if (!newLabel.trim()) return;
    setCreating(true);
    setError('');
    try {
      await api.post('/manage/keys', { label: newLabel.trim(), access_key: newAK.trim(), secret_key: newSK.trim() });
      setNewLabel('');
      setNewAK('');
      setNewSK('');
      setShowCreate(false);
      await loadKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setCreating(false);
    }
  }

  async function deleteKey(keyId: string) {
    if (!confirm('确定删除该密钥？')) return;
    try {
      await fetch(`/api/manage/keys/${keyId}`, { method: 'DELETE' });
      await loadKeys();
    } catch {}
  }

  function formatTime(ts: number | null) {
    if (!ts) return '-';
    return new Date(ts * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  return (
    <div style={{ padding: '16px 12px', maxWidth: 900, margin: '0 auto', fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif' }}>
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 8, lineHeight: 1.7 }}>
        资源密钥用于第三方开发者通过 HMAC-SHA256 签名方式调用资源库 API。
      </p>
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 20, lineHeight: 1.7 }}>
        密钥仅能访问资源库（真人资源/虚拟人像），不能创建任务或查询账单。同一账号下所有密钥共享资源空间。
      </p>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button onClick={() => setShowCreate(!showCreate)}
          style={{ padding: '8px 16px', borderRadius: 6, background: '#2563eb', color: '#fff', border: 'none', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
          + 创建密钥
        </button>
        <button onClick={loadKeys} disabled={loading}
          style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
          ↻ 刷新
        </button>
      </div>

      {/* Create Form */}
      {showCreate && (
        <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginBottom: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input type="text" placeholder="密钥标签" value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              style={inputStyle} />
            <input type="text" placeholder="Access Key (AK)" value={newAK}
              onChange={e => setNewAK(e.target.value)}
              style={inputStyle} />
            <input type="password" placeholder="Secret Key (SK)" value={newSK}
              onChange={e => setNewSK(e.target.value)}
              style={inputStyle} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={createKey} disabled={creating || !newLabel.trim()}
                style={{ padding: '8px 16px', borderRadius: 6, background: '#2563eb', color: '#fff', border: 'none', fontSize: 13, cursor: 'pointer', opacity: creating || !newLabel.trim() ? 0.5 : 1 }}>
                {creating ? '创建中…' : '确认创建'}
              </button>
              <button onClick={() => setShowCreate(false)}
                style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '10px 14px', fontSize: 13, color: '#dc2626', marginBottom: 16 }}>{error}</div>}

      {/* Keys List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {keys.map(key => (
          <div key={key.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{key.label}</span>
                {key.source === 'env' && (
                  <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 8, background: '#fef3c7', color: '#92400e' }}>环境变量</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4, fontFamily: 'monospace' }}>
                AK: {key.access_key}
              </div>
              {key.secret_key_masked && (
                <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2, fontFamily: 'monospace' }}>
                  SK: {key.secret_key_masked}
                </div>
              )}
              {key.created_at && (
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>创建: {formatTime(key.created_at)}</div>
              )}
            </div>
            {key.source !== 'env' && (
              <button onClick={() => deleteKey(key.id)}
                style={{ padding: '4px 10px', borderRadius: 4, background: '#fff', border: '1px solid #e5e7eb', color: '#dc2626', fontSize: 12, cursor: 'pointer' }}>
                删除
              </button>
            )}
          </div>
        ))}
        {!loading && keys.length === 0 && (
          <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: 40 }}>暂无密钥</p>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = { padding: '8px 12px', border: '1px solid #d4d4d8', borderRadius: 6, fontSize: 14, width: '100%', maxWidth: 400 };
