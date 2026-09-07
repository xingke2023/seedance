'use client';

import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState, useRef } from 'react';
import { getUserFromToken, clearTokens, getAccessToken } from '@/lib/auth';

const NAV_ITEMS = [
  { href: '/projects',  label: '首页' },
  { href: '/insurance', label: '剧本库' },
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
  const [user, setUser] = useState<{ name?: string; username?: string; avatar?: string; quota?: number; used?: number; quota_enforced?: boolean } | null>(null);
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
      background: 'linear-gradient(135deg, #1d4ed8 0%, #2563eb 52%, #3b82f6 100%)',
      boxShadow: '0 2px 10px rgba(29,78,216,.30)',
      display: 'flex',
      alignItems: 'center',
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
          background: 'rgba(255,255,255,.20)',
          border: '1px solid rgba(255,255,255,.30)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
               fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
               aria-hidden="true">
            <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          </svg>
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
          <span className="brandName" style={{ fontWeight: 900, letterSpacing: 0, color: '#fff' }}>
            星科AI
          </span>
          <span className="brandSub" style={{
            fontSize: 9.5,
            fontWeight: 700,
            color: 'rgba(255,255,255,.70)',
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
          <Link key={item.href} href={item.href}
            className={'navLink' + (active ? ' navLinkActive' : '')}
            style={{ textDecoration: 'none', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {item.label}
          </Link>
        );
      })}
      <div ref={assetRef} style={{ position: 'relative' }}>
        <button onClick={() => setAssetOpen(v => !v)}
          className={'navLink' + (pathname?.startsWith('/assets') ? ' navLinkActive' : '') + (assetOpen ? ' navLinkOpen' : '')}
          style={{ border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
          认证资源
          <span className="navCaret" aria-hidden="true">▾</span>
        </button>
        {assetOpen && (
          <div style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 6,
            background: '#fff',
            border: 'none',
            borderRadius: 14,
            boxShadow: '0 10px 28px rgba(29,78,216,.18), 0 2px 8px rgba(15,23,42,.10)',
            minWidth: 130,
            overflow: 'hidden',
            zIndex: 200,
          }}>
            {ASSET_ITEMS.map(item => {
              const active = pathname === item.href;
              return (
                <Link key={item.href} href={item.href} onClick={() => setAssetOpen(false)} style={{
                  display: 'block',
                  padding: '12px 16px',
                  fontSize: 15,
                  color: active ? '#1d4ed8' : '#334155',
                  textDecoration: 'none',
                  fontWeight: active ? 600 : 500,
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
          width: 30,
          height: 30,
          borderRadius: '50%',
          background: 'rgba(255,255,255,.22)',
          border: '2px solid ' + (menuOpen ? '#fff' : 'rgba(255,255,255,.55)'),
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
            <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>
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
            border: 'none',
            borderRadius: 14,
            boxShadow: '0 10px 28px rgba(29,78,216,.18), 0 2px 8px rgba(15,23,42,.10)',
            minWidth: 160,
            overflow: 'hidden',
            zIndex: 200,
            whiteSpace: 'nowrap',
          }}>
            {user && (
              <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6' }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: '#111827' }}>{user.name || user.username}</div>
                {/* quota_enforced 关着就是不限制（后端 lib/quota.js）——
                    /me 还没回来时先不显示，免得闪一下「剩余 0 次」 */}
                {user.quota_enforced === false ? (
                  <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
                    次数不限（已用 {user.used || 0} 次）
                  </div>
                ) : user.quota !== undefined && user.quota_enforced !== undefined && (
                  <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
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
                  padding: '12px 16px',
                  fontSize: 15,
                  color: active ? '#1d4ed8' : '#334155',
                  textDecoration: 'none',
                  fontWeight: active ? 600 : 500,
                  background: active ? '#eff6ff' : 'transparent',
                }}>
                  {item.label}
                </Link>
              );
            })}
            <div style={{ borderTop: '1px solid #f3f4f6' }}>
              <button onClick={handleLogout} style={{
                width: '100%',
                padding: '12px 16px',
                fontSize: 15,
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
        /* 栏高是全站共用的锚点：voiceover-v3 的 sticky 面包屑贴在它下面，
           几个页面的 calc(100vh - 栏高) 也按它算 —— 所以写成变量，别再各处硬编码 44px */
        :root { --topnav-h: 52px; }
        .topNav { height: var(--topnav-h); padding: 0 12px; gap: 4px; }
        .topNav .brandLogo { gap: 7px; margin-right: 12px; }
        .topNav .brandIcon { width: 28px; height: 28px; border-radius: 9px; }
        .topNav .brandIcon svg { width: 17px; height: 17px; }
        .topNav .brandName { font-size: 18px; }
        .topNav .navLinks { gap: 4px; }
        /* 药丸导航：选中态是一层磨砂白，不是贴上去的白色纸片 —— 后者在蓝底上
           对比过硬，切换时像闪一下。这里只加亮底色和字色，位移交给 :active */
        .topNav .navLink {
          font-size: 16px;
          padding: 5px 14px;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          line-height: 1.5;
          border-radius: 999px;
          color: rgba(255,255,255,.78);
          background: transparent;
          font-weight: 500;
          -webkit-tap-highlight-color: transparent;
          transition: background .18s ease, color .18s ease, transform .12s ease;
        }
        .topNav .navLink:hover { color: #fff; background: rgba(255,255,255,.14); }
        .topNav .navLink:active { transform: scale(.96); }
        .topNav .navLinkActive,
        .topNav .navLinkActive:hover {
          color: #fff;
          font-weight: 700;
          background: rgba(255,255,255,.24);
          box-shadow: inset 0 0 0 1px rgba(255,255,255,.30);
        }
        .topNav .navLinkOpen { color: #fff; background: rgba(255,255,255,.18); }
        .topNav .navCaret {
          font-size: .72em;
          opacity: .8;
          transition: transform .18s ease;
        }
        .topNav .navLinkOpen .navCaret { transform: rotate(180deg); }
        .topNav .brandLogo:active { opacity: .8; }

        @media (max-width: 768px) {
          :root { --topnav-h: 48px; }
          .topNav { padding: 0 10px; }
          .topNav .brandSub { display: none; }
          .topNav .brandLogo { gap: 5px; margin-right: 8px; }
          .topNav .brandIcon { width: 22px; height: 22px; border-radius: 6px; }
          .topNav .brandIcon svg { width: 14px; height: 14px; }
          .topNav .brandName { font-size: 16.5px; }
          .topNav .navLinks { gap: 3px; }
          .topNav .navLink { font-size: 14.5px; padding: 5px 10px; }
        }

        @media (max-width: 380px) {
          .topNav { padding: 0 6px; gap: 2px; }
          .topNav .brandLogo { gap: 4px; margin-right: 5px; }
          .topNav .brandIcon { width: 20px; height: 20px; }
          .topNav .brandIcon svg { width: 13px; height: 13px; }
          .topNav .brandName { font-size: 14.5px; }
          .topNav .navLinks { gap: 2px; }
          .topNav .navLink { font-size: 13px; padding: 4px 6px; }
        }
      `}</style>
    </nav>
  );
}
