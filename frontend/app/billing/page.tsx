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

interface Plan {
  key: string;
  name: string;
  amount: number;      // 最小货币单位（港币的「分」）
  currency: string;
  credits: number;
  features: string[];
  configured: boolean; // 后端有没有配上这一档的 Stripe Price ID
}

interface Pack {
  key: string;
  name: string;
  amount: number;
  currency: string;
  credits: number;
  configured: boolean;
}

const METHOD_LABEL: Record<string, string> = {
  card: '银行卡', alipay: '支付宝', wechat_pay: '微信支付', link: 'Link',
};

interface Subscription {
  plan_key: string;
  plan_name: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

interface GrantRecord {
  stripe_event_id: string;
  type: string;
  credits_granted: number;
  amount: number | null;
  currency: string | null;
  created_at: string;
}

interface BillingAccount {
  quota: number;
  used: number;
  subscription: Subscription | null;
  history: GrantRecord[];
}

const STATUS_LABEL: Record<string, { text: string; color: string; bg: string }> = {
  active:             { text: '订阅中',   color: '#166534', bg: '#dcfce7' },
  trialing:           { text: '试用中',   color: '#166534', bg: '#dcfce7' },
  past_due:           { text: '扣款失败', color: '#b45309', bg: '#fef3c7' },
  unpaid:             { text: '未付款',   color: '#b45309', bg: '#fef3c7' },
  canceled:           { text: '已取消',   color: '#6b7280', bg: '#f3f4f6' },
  incomplete:         { text: '待完成',   color: '#6b7280', bg: '#f3f4f6' },
  incomplete_expired: { text: '已失效',   color: '#6b7280', bg: '#f3f4f6' },
};

const CURRENCY_SYMBOL: Record<string, string> = { cny: '¥', hkd: 'HK$', usd: 'US$' };

function money(amount: number, currency: string) {
  const key = (currency || '').toLowerCase();
  const symbol = CURRENCY_SYMBOL[key] || key.toUpperCase() + ' ';
  return symbol + (amount / 100).toFixed(amount % 100 === 0 ? 0 : 2);
}

export default function BillingPage() {
  const [data, setData] = useState<BillingSummary | null>(null);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showRecharge, setShowRecharge] = useState(false);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [oneTimeMethods, setOneTimeMethods] = useState<string[]>([]);
  const [account, setAccount] = useState<BillingAccount | null>(null);
  const [payEnabled, setPayEnabled] = useState(true);
  const [busyPlan, setBusyPlan] = useState('');
  const [payNotice, setPayNotice] = useState('');
  const [showQR, setShowQR] = useState(false);

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

  async function loadPlans() {
    try {
      const res = await api.get<{ currency: string; enabled: boolean; plans: Plan[]; packs: Pack[]; one_time_methods: string[] }>('/billing/plans');
      setPlans(res.plans || []);
      setPacks(res.packs || []);
      setOneTimeMethods(res.one_time_methods || []);
      setPayEnabled(res.enabled);
    } catch {}
  }

  async function loadAccount() {
    try {
      setAccount(await api.get<BillingAccount>('/billing/subscription'));
    } catch {}
  }

  useEffect(() => { loadBilling(); loadUser(); loadPlans(); loadAccount(); }, []);

  // Checkout 付完会跳回 /billing?checkout=success。
  // 额度是 webhook 入账的，可能比这次跳转晚一两秒，所以过几秒再刷一次余额
  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get('checkout');
    if (!status) return;
    if (status === 'success') {
      setPayNotice('支付成功，额度到账可能有几秒延迟');
      const timer = setTimeout(() => { loadUser(); loadAccount(); }, 4000);
      window.history.replaceState({}, '', '/billing');
      return () => clearTimeout(timer);
    }
    setPayNotice('已取消支付');
    window.history.replaceState({}, '', '/billing');
  }, []);

  async function subscribe(planKey: string) {
    setBusyPlan(planKey);
    setError('');
    try {
      const res = await api.post<{ url: string }>('/billing/checkout', { plan: planKey });
      window.location.href = res.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : '发起支付失败');
      setBusyPlan('');
    }
  }

  async function buyPack(packKey: string) {
    setBusyPlan(packKey);
    setError('');
    try {
      const res = await api.post<{ url: string }>('/billing/checkout', { pack: packKey });
      window.location.href = res.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : '发起支付失败');
      setBusyPlan('');
    }
  }

  async function openPortal() {
    setBusyPlan('portal');
    setError('');
    try {
      const res = await api.post<{ url: string }>('/billing/portal', {});
      window.location.href = res.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开管理页失败');
      setBusyPlan('');
    }
  }

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
          {account?.subscription && ['active', 'trialing'].includes(account.subscription.status) ? '更换套餐' : '购买额度'}
        </button>
        {account?.subscription && (
          <button onClick={openPortal} disabled={busyPlan === 'portal'}
            style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
            {busyPlan === 'portal' ? '打开中...' : '管理订阅'}
          </button>
        )}
      </div>

      {payNotice && (
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '10px 14px', fontSize: 13, color: '#1d4ed8', marginBottom: 16 }}>
          {payNotice}
        </div>
      )}

      {/* 订阅套餐弹窗 */}
      {showRecharge && (
        <div onClick={() => setShowRecharge(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, overflowY: 'auto' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 12, padding: '22px 22px 18px', width: '100%', maxWidth: 640, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 700 }}>购买额度</h3>

            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>按月订阅</span>
              <span style={{ fontSize: 12, color: '#6b7280' }}>每个账期自动到账，可随时退订 · 仅支持银行卡</span>
            </div>

            {!payEnabled && (
              <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 6, padding: '10px 14px', fontSize: 13, color: '#92400e', marginBottom: 14 }}>
                在线支付尚未配置，请先使用下方扫码方式或联系管理员
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {plans.map(plan => {
                const current = account?.subscription?.plan_key === plan.key
                  && ['active', 'trialing'].includes(account?.subscription?.status || '');
                return (
                  <div key={plan.key} style={{
                    flex: '1 1 170px', minWidth: 170, border: '1px solid ' + (current ? '#2563eb' : '#e5e7eb'),
                    borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column',
                    background: current ? '#f8faff' : '#fff',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 15, fontWeight: 700 }}>{plan.name}</span>
                      {current && <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 8, background: '#dbeafe', color: '#1d4ed8' }}>当前</span>}
                    </div>
                    <div style={{ margin: '8px 0 2px' }}>
                      <span style={{ fontSize: 24, fontWeight: 700, color: '#111827' }}>{money(plan.amount, plan.currency)}</span>
                      <span style={{ fontSize: 12, color: '#6b7280' }}> / 月</span>
                    </div>
                    <div style={{ fontSize: 12, color: '#16a34a', fontWeight: 600, marginBottom: 10 }}>每月 {plan.credits} 次</div>
                    <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: 12, color: '#6b7280', lineHeight: 1.7, flex: 1 }}>
                      {plan.features.map(f => <li key={f}>{f}</li>)}
                    </ul>
                    <button onClick={() => subscribe(plan.key)}
                      disabled={!payEnabled || !plan.configured || busyPlan !== '' || current}
                      style={{
                        marginTop: 12, width: '100%', padding: '9px 0', borderRadius: 6, border: 'none',
                        background: (!payEnabled || !plan.configured || current) ? '#e5e7eb' : '#2563eb',
                        color: (!payEnabled || !plan.configured || current) ? '#9ca3af' : '#fff',
                        fontSize: 13, fontWeight: 600,
                        cursor: (!payEnabled || !plan.configured || current) ? 'not-allowed' : 'pointer',
                      }}>
                      {current ? '已订阅' : busyPlan === plan.key ? '跳转中...' : !plan.configured ? '未开放' : '立即订阅'}
                    </button>
                  </div>
                );
              })}
            </div>

            {/* 一次性次数包：支付宝/微信在 Stripe 里只能用于一次性付款 */}
            {packs.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>一次性次数包</span>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>
                    买断不续费 · 支持 {oneTimeMethods.map(m => METHOD_LABEL[m] || m).join(' / ')}
                  </span>
                </div>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                  {packs.map((pack, i) => (
                    <div key={pack.key} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                      borderTop: i === 0 ? 'none' : '1px solid #f3f4f6', flexWrap: 'wrap',
                    }}>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{pack.name}</span>
                      <span style={{ fontSize: 12, color: '#9ca3af' }}>
                        {money(Math.round(pack.amount / pack.credits), pack.currency)} / 次
                      </span>
                      <span style={{ marginLeft: 'auto', fontSize: 16, fontWeight: 700 }}>{money(pack.amount, pack.currency)}</span>
                      <button onClick={() => buyPack(pack.key)}
                        disabled={!payEnabled || !pack.configured || busyPlan !== ''}
                        style={{
                          padding: '6px 14px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 600,
                          background: (!payEnabled || !pack.configured) ? '#e5e7eb' : '#16a34a',
                          color: (!payEnabled || !pack.configured) ? '#9ca3af' : '#fff',
                          cursor: (!payEnabled || !pack.configured) ? 'not-allowed' : 'pointer',
                        }}>
                        {busyPlan === pack.key ? '跳转中...' : !pack.configured ? '未开放' : '购买'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 大陆用户仍可走原来的人工扫码充值 */}
            <button onClick={() => setShowQR(v => !v)}
              style={{ marginTop: 16, background: 'none', border: 'none', padding: 0, fontSize: 12, color: '#6b7280', cursor: 'pointer', textDecoration: 'underline' }}>
              {showQR ? '收起' : '其他支付方式（微信 / 支付宝扫码）'}
            </button>
            {showQR && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f3f4f6' }}>
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
                <p style={{ margin: '12px 0 0', fontSize: 12, color: '#6b7280', textAlign: 'center' }}>支付后请联系管理员确认到账</p>
              </div>
            )}

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

      {/* 订阅状态 */}
      {account?.subscription && (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 12px' }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{account.subscription.plan_name}</span>
          <span style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 8,
            background: (STATUS_LABEL[account.subscription.status] || STATUS_LABEL.canceled).bg,
            color: (STATUS_LABEL[account.subscription.status] || STATUS_LABEL.canceled).color,
          }}>
            {(STATUS_LABEL[account.subscription.status] || { text: account.subscription.status }).text}
          </span>
          {account.subscription.current_period_end && (
            <span style={{ fontSize: 12, color: '#6b7280' }}>
              {account.subscription.cancel_at_period_end ? '到期后停止：' : '下次续费：'}
              {new Date(account.subscription.current_period_end).toLocaleDateString('zh-CN')}
            </span>
          )}
          <button onClick={openPortal} disabled={busyPlan === 'portal'}
            style={{ marginLeft: 'auto', padding: '5px 12px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', fontSize: 12, cursor: 'pointer' }}>
            管理订阅
          </button>
        </div>
      )}

      {/* 订阅到账记录 */}
      {account && account.history.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#374151' }}>充值到账</h3>
          {account.history.map(h => (
            <div key={h.stripe_event_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid #f3f4f6', fontSize: 12 }}>
              <span style={{ color: '#6b7280' }}>{new Date(h.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              <span style={{ color: '#16a34a', fontWeight: 600 }}>+{h.credits_granted} 次</span>
              {h.amount != null && <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{money(h.amount, h.currency || 'hkd')}</span>}
            </div>
          ))}
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
