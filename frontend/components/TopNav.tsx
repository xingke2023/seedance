'use client';

import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState, useRef } from 'react';
import { getUserFromToken, clearTokens, getAccessToken } from '@/lib/auth';

const NAV_ITEMS = [
  { href: '/projects',  label: '首页' },
  { href: '/insurance', label: '港险资料' },
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
    <nav className="topNav" style={{
      position: 'sticky',
      top: 0,
      zIndex: 100,
      background: '#1e293b',
      borderBottom: '1px solid #334155',
      display: 'flex',
      alignItems: 'center',
      height: 44,
      overflow: 'visible',
    }}>
      <Link href="/" className="brandLogo" style={{
        display: 'flex',
        alignItems: 'center',
        color: '#fff',
        textDecoration: 'none',
        flexShrink: 0,
      }}>
        <span className="brandIcon" style={{
          background: 'linear-gradient(135deg, #3b82f6, #4f46e5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          boxShadow: '0 1px 2px rgba(0,0,0,.25)',
        }}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
               fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
               aria-hidden="true">
            <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          </svg>
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
          <span className="brandName" style={{ fontWeight: 900, letterSpacing: -0.2, color: '#fff' }}>
            MACRODATA
          </span>
          <span className="brandSub" style={{
            fontSize: 8,
            fontWeight: 700,
            color: '#94a3b8',
            letterSpacing: 1,
            textTransform: 'uppercase',
            marginTop: 2,
            whiteSpace: 'nowrap',
          }}>
            International (HK) Limited
          </span>
        </span>
      </Link>
      <div className="navLinks" style={{
        display: 'flex',
        alignItems: 'center',
        overflow: 'visible',
        flexShrink: 1,
        minWidth: 0,
      }}>
      {NAV_ITEMS.map(item => {
        const active = pathname === item.href || pathname?.startsWith(item.href + '/');
        return (
          <Link key={item.href} href={item.href} className="navLink" style={{
            color: active ? '#fff' : '#94a3b8',
            textDecoration: 'none',
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
        <button onClick={() => setAssetOpen(v => !v)} className="navLink" style={{
          color: pathname?.startsWith('/assets') ? '#fff' : '#94a3b8',
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

      <style jsx global>{`
        .topNav { padding: 0 12px; gap: 4px; }
        .topNav .brandLogo { gap: 7px; margin-right: 12px; }
        .topNav .brandIcon { width: 26px; height: 26px; border-radius: 7px; }
        .topNav .brandIcon svg { width: 16px; height: 16px; }
        .topNav .brandName { font-size: 14px; }
        .topNav .navLinks { gap: 4px; }
        .topNav .navLink { font-size: 13px; padding: 6px 10px; }

        @media (max-width: 768px) {
          .topNav { padding: 0 10px; }
          .topNav .brandSub { display: none; }
          .topNav .brandLogo { gap: 5px; margin-right: 8px; }
          .topNav .brandIcon { width: 22px; height: 22px; border-radius: 6px; }
          .topNav .brandIcon svg { width: 14px; height: 14px; }
          .topNav .brandName { font-size: 13px; }
          .topNav .navLinks { gap: 3px; }
          .topNav .navLink { font-size: 12.5px; padding: 5px 8px; }
        }

        @media (max-width: 380px) {
          .topNav { padding: 0 6px; gap: 2px; }
          .topNav .brandLogo { gap: 4px; margin-right: 5px; }
          .topNav .brandIcon { width: 20px; height: 20px; }
          .topNav .brandIcon svg { width: 13px; height: 13px; }
          .topNav .brandName { font-size: 12px; }
          .topNav .navLinks { gap: 2px; }
          .topNav .navLink { font-size: 11.5px; padding: 4px 5px; }
        }
      `}</style>
    </nav>
  );
}
