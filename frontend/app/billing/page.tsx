'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';

interface LineItem {
  task_id: string;
  created_at: number;
  resolution: string;
  duration_seconds: number;
  status: string;
  subtotal: number;
  frames: number;
}

interface BillingSummary {
  total_rmb: number;
  total_frames: number;
  task_count: number;
  by_resolution: Record<string, { count: number; duration_sec: number; frames: number; subtotal: number }>;
  line_items: LineItem[];
}

interface UserInfo {
  username: string;
  name: string;
  quota: number;
  used: number;
}

export default function BillingPage() {
  const [data, setData] = useState<BillingSummary | null>(null);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showRecharge, setShowRecharge] = useState(false);

  async function loadBilling() {
    setLoading(true);
    setError('');
    try {
      const res = await api.get<BillingSummary>('/manage/billing/summary');
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function loadUser() {
    try {
      const res = await api.get<UserInfo>('/auth/me');
      setUser(res);
    } catch {}
  }

  useEffect(() => { loadBilling(); loadUser(); }, []);

  function formatTime(ts: number) {
    return new Date(ts * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  return (
    <div style={{ padding: '16px 12px', maxWidth: 1000, margin: '0 auto', fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>账单概览</h2>
        <button onClick={loadBilling} disabled={loading}
          style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
          刷新
        </button>
        <button onClick={() => setShowRecharge(true)}
          style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #16a34a', background: '#f0fdf4', fontSize: 13, fontWeight: 600, color: '#16a34a', cursor: 'pointer' }}>
          充值
        </button>
      </div>

      {/* 充值弹窗 */}
      {showRecharge && (
        <div onClick={() => setShowRecharge(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 12, padding: '24px 28px', width: 340, boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700, textAlign: 'center' }}>扫码充值</h3>
            <div style={{ display: 'flex', gap: 16, justifyContent: 'center' }}>
              <div style={{ textAlign: 'center' }}>
                <img src="/wechat-qr.png" alt="微信支付" style={{ width: 120, height: 120, borderRadius: 8, border: '1px solid #e5e7eb', objectFit: 'cover' }} />
                <div style={{ fontSize: 13, color: '#16a34a', fontWeight: 600, marginTop: 6 }}>微信支付</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <img src="/alipay-qr.png" alt="支付宝" style={{ width: 120, height: 120, borderRadius: 8, border: '1px solid #e5e7eb', objectFit: 'cover' }} />
                <div style={{ fontSize: 13, color: '#2563eb', fontWeight: 600, marginTop: 6 }}>支付宝</div>
              </div>
            </div>
            <p style={{ margin: '16px 0 0', fontSize: 12, color: '#6b7280', textAlign: 'center' }}>支付后请联系管理员确认到账</p>
            <button onClick={() => setShowRecharge(false)}
              style={{ marginTop: 16, width: '100%', padding: '9px 0', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 }}>
              关闭
            </button>
          </div>
        </div>
      )}

      {/* 用户信息 + 额度 */}
      {user && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          <div style={{ flex: 1, minWidth: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, color: '#6b7280' }}>用户</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#111827' }}>{user.name || user.username}</div>
          </div>
          <div style={{ flex: 1, minWidth: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, color: '#6b7280' }}>剩余次数</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: user.quota - user.used > 0 ? '#16a34a' : '#dc2626' }}>{user.quota - user.used} <span style={{ fontSize: 12, fontWeight: 400, color: '#9ca3af' }}>/ {user.quota}</span></div>
          </div>
          <div style={{ flex: 1, minWidth: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, color: '#6b7280' }}>已使用</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#2563eb' }}>{user.used}</div>
          </div>
        </div>
      )}

      {error && <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '10px 14px', fontSize: 13, color: '#dc2626', marginBottom: 16 }}>{error}</div>}

      {loading && !data && <p style={{ color: '#9ca3af', fontSize: 13 }}>加载中...</p>}

      {data && (
        <>
          {/* Summary - 一行三个 */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 90, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px' }}>
              <div style={{ fontSize: 11, color: '#6b7280' }}>总费用</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#dc2626' }}>{data.total_rmb.toFixed(2)}</div>
            </div>
            <div style={{ flex: 1, minWidth: 90, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px' }}>
              <div style={{ fontSize: 11, color: '#6b7280' }}>任务数</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#2563eb' }}>{data.task_count}</div>
            </div>
            <div style={{ flex: 1, minWidth: 90, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px' }}>
              <div style={{ fontSize: 11, color: '#6b7280' }}>总帧数</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#7c3aed' }}>{data.total_frames.toLocaleString()}</div>
            </div>
          </div>

          {/* By Resolution - 一行 */}
          {Object.keys(data.by_resolution).length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              {Object.entries(data.by_resolution).map(([res, info]) => (
                <div key={res} style={{ padding: '8px 12px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12 }}>
                  <span style={{ fontWeight: 600 }}>{res}</span>
                  <span style={{ color: '#6b7280', marginLeft: 8 }}>{info.count}次 {info.duration_sec}s {info.frames}帧 ¥{info.subtotal.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Line Items - 卡片式 */}
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#374151' }}>明细</h3>
          <div>
            {data.line_items.map(item => (
              <div key={item.task_id} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 10px', padding: '8px 0', borderBottom: '1px solid #f3f4f6', fontSize: 12 }}>
                <code style={{ fontSize: 11, color: '#374151' }}>{item.task_id.slice(0, 10)}</code>
                <span style={{ color: '#6b7280' }}>{formatTime(item.created_at)}</span>
                <span>{item.resolution}</span>
                <span>{item.duration_seconds}s</span>
                <span>{item.frames}帧</span>
                <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 8, background: item.status === 'succeeded' ? '#dcfce7' : '#fee2e2', color: item.status === 'succeeded' ? '#166534' : '#dc2626' }}>
                  {item.status === 'succeeded' ? '成功' : item.status}
                </span>
                <span style={{ fontWeight: 600, marginLeft: 'auto' }}>¥{item.subtotal.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
