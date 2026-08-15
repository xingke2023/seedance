'use client';

import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState, useRef } from 'react';
import { getUserFromToken, clearTokens, getAccessToken } from '@/lib/auth';

const NAV_ITEMS = [
  { href: '/projects/default', label: '首页' },
];

const ASSET_ITEMS = [
  { href: '/assets/real', label: '真人头像' },
  { href: '/assets/virtual', label: '虚拟头像' },
];

const MENU_ITEMS = [
  { href: '/tasks', label: '任务列表' },
  { href: '/billing', label: '账单' },
];

export default function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<{ name?: string; username?: string; avatar?: string; quota?: number; used?: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [assetOpen, setAssetOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const assetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    const payload = getUserFromToken();
    if (payload) setUser(payload);

    fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(json => {
        if (json.success && json.data) {
          setUser(json.data);
        }
      })
      .catch(() => {});
  }, [pathname]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
      if (assetRef.current && !assetRef.current.contains(e.target as Node)) {
        setAssetOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function handleLogout() {
    clearTokens();
    setMenuOpen(false);
    router.push('/login');
  }

  if (pathname === '/login' || pathname?.startsWith('/oauth/')) {
    return null;
  }

  return (
    <nav style={{
      position: 'sticky',
      top: 0,
      zIndex: 100,
      background: '#1e293b',
      borderBottom: '1px solid #334155',
      padding: '0 12px',
      display: 'flex',
      alignItems: 'center',
      height: 44,
      gap: 4,
      overflow: 'visible',
    }}>
      <Link href="/" style={{
        fontSize: 15,
        fontWeight: 700,
        color: '#fff',
        textDecoration: 'none',
        marginRight: 12,
        letterSpacing: 0.5,
        flexShrink: 0,
      }}>
        Seedance
      </Link>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        overflow: 'visible',
        flexShrink: 1,
        minWidth: 0,
      }}>
      {NAV_ITEMS.map(item => {
        const active = pathname === item.href || pathname?.startsWith(item.href + '/');
        return (
          <Link key={item.href} href={item.href} style={{
            fontSize: 13,
            color: active ? '#fff' : '#94a3b8',
            textDecoration: 'none',
            padding: '6px 10px',
            borderRadius: 4,
            background: active ? '#334155' : 'transparent',
            fontWeight: active ? 500 : 400,
            transition: 'all .15s',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}>
            {item.label}
          </Link>
        );
      })}
      <div ref={assetRef} style={{ position: 'relative' }}>
        <button onClick={() => setAssetOpen(v => !v)} style={{
          fontSize: 13,
          color: pathname?.startsWith('/assets') ? '#fff' : '#94a3b8',
          padding: '6px 10px',
          borderRadius: 4,
          background: pathname?.startsWith('/assets') ? '#334155' : 'transparent',
          fontWeight: pathname?.startsWith('/assets') ? 500 : 400,
          border: 'none',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}>
          认证资源 ▾
        </button>
        {assetOpen && (
          <div style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 6,
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,.12)',
            minWidth: 130,
            overflow: 'hidden',
            zIndex: 200,
          }}>
            {ASSET_ITEMS.map(item => {
              const active = pathname === item.href;
              return (
                <Link key={item.href} href={item.href} onClick={() => setAssetOpen(false)} style={{
                  display: 'block',
                  padding: '10px 14px',
                  fontSize: 13,
                  color: active ? '#2563eb' : '#374151',
                  textDecoration: 'none',
                  background: active ? '#eff6ff' : 'transparent',
                }}>
                  {item.label}
                </Link>
              );
            })}
          </div>
        )}
      </div>
      </div>

      <div ref={menuRef} style={{ marginLeft: 'auto', position: 'relative', flexShrink: 0 }}>
        <button onClick={() => setMenuOpen(v => !v)} style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: menuOpen ? '#475569' : '#475569',
          border: '2px solid ' + (menuOpen ? '#94a3b8' : '#64748b'),
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          overflow: 'hidden',
        }}>
          {user?.avatar ? (
            <img src={user.avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>
              {(user?.name || user?.username || '?').slice(0, 1).toUpperCase()}
            </span>
          )}
        </button>

        {menuOpen && (
          <div style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 6,
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,.12)',
            minWidth: 160,
            overflow: 'hidden',
            zIndex: 200,
            whiteSpace: 'nowrap',
          }}>
            {user && (
              <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{user.name || user.username}</div>
                {user.quota !== undefined && (
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                    剩余 {user.quota - (user.used || 0)} 次 / 共 {user.quota} 次
                  </div>
                )}
              </div>
            )}
            {MENU_ITEMS.map(item => {
              const active = pathname === item.href;
              return (
                <Link key={item.href} href={item.href} onClick={() => setMenuOpen(false)} style={{
                  display: 'block',
                  padding: '10px 14px',
                  fontSize: 13,
                  color: active ? '#2563eb' : '#374151',
                  textDecoration: 'none',
                  background: active ? '#eff6ff' : 'transparent',
                }}>
                  {item.label}
                </Link>
              );
            })}
            <div style={{ borderTop: '1px solid #f3f4f6' }}>
              <button onClick={handleLogout} style={{
                width: '100%',
                padding: '10px 14px',
                fontSize: 13,
                color: '#dc2626',
                background: 'none',
                border: 'none',
                textAlign: 'left',
                cursor: 'pointer',
              }}>
                退出登录
              </button>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
