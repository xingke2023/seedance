import TopNav from '@/components/TopNav'
import AuthGuard from '@/components/AuthGuard'

/* ── 主题色彩 ──────────────────────────────────────────────────────────────
   三套配色都写成 CSS 变量，靠 <html data-theme> 切换；**默认是靛蓝**（bare :root 挂在
   cool 上；warm / violet 用属性选择器，特异性更高，和书写顺序无关）。
   顶栏、首页、项目页只引用变量，不再写死颜色 —— 再加一套主题只用在这里补一段。
   变量放在 layout（而不是 TopNav 的 styled-jsx）里：登录页没有 TopNav，
   放那儿的话那一页就拿不到变量。                                            */
const THEME_VARS = `
:root[data-theme="warm"] {
  /* 暖阳 —— 落日色系：紫 → 玫瑰 → 橙 → 金，四个色相一路过渡。
     「暖」是这组搭配的温度，不是某一个橙。大色块（顶栏/Hero/FAB/底纹）都跨色相走，
     只有正文里的小面积强调色收敛到一个橙，免得处处抢眼 */
  --th-nav-grad: linear-gradient(135deg, #7e22ce 0%, #be123c 48%, #ea580c 100%);
  --th-nav-shadow: rgba(126,34,206,.30);
  --th-menu-shadow: rgba(190,18,60,.18);
  --th-hero-grad: linear-gradient(135deg, #9333ea 0%, #e11d48 45%, #f97316 100%);
  --th-hero-shadow: rgba(225,29,72,.26);
  --th-shell-bg:
    radial-gradient(900px 380px at 12% -8%, #ffedd5 0%, rgba(255,237,213,0) 62%),
    radial-gradient(760px 340px at 92% 4%, #f3e8ff 0%, rgba(243,232,255,0) 60%),
    #f7ece1;
  --th-border: #ecdcc7;
  --th-border-hover: #dcbf9e;
  --th-accent: #ea580c;
  --th-accent-deep: #9a3412;
  --th-accent-bg: #fff7ed;
  --th-focus: #fb923c;
  --th-btn-grad: linear-gradient(135deg, #e11d48, #f97316);
  --th-btn-shadow: rgba(225,29,72,.30);
  --th-fab-grad: linear-gradient(135deg, #9333ea, #f97316);
  --th-fab-shadow: rgba(225,29,72,.40);
  --th-soft-grad: linear-gradient(135deg, #ffedd5, #f3e8ff);
  --th-skel-grad: linear-gradient(100deg, #ffedd5 30%, #fed7aa 50%, #ffedd5 70%);
  /* 列表卡的 5 色循环 —— 一整套配色，不是同一个橙的五个深浅：
     赤陶 / 琥珀 / 玫瑰 / 青（冷色对冲）/ 紫 */
  --th-c1: linear-gradient(135deg, #fb923c, #ea580c); --th-c1s: rgba(234,88,12,.34); --th-b1: #fff7ed; --th-f1: #c2410c;
  --th-c2: linear-gradient(135deg, #fcd34d, #f59e0b); --th-c2s: rgba(245,158,11,.32); --th-b2: #fffbeb; --th-f2: #b45309;
  --th-c3: linear-gradient(135deg, #fda4af, #e11d48); --th-c3s: rgba(225,29,72,.28);  --th-b3: #fff1f2; --th-f3: #be123c;
  --th-c4: linear-gradient(135deg, #5eead4, #0d9488); --th-c4s: rgba(13,148,136,.28); --th-b4: #f0fdfa; --th-f4: #0f766e;
  --th-c5: linear-gradient(135deg, #c084fc, #9333ea); --th-c5s: rgba(147,51,234,.28); --th-b5: #faf5ff; --th-f5: #7e22ce;
}
:root[data-theme="violet"] {
  /* 紫霞 —— 极光色系：靛紫 → 品红 → 粉，再用青做冷色对冲 */
  --th-nav-grad: linear-gradient(135deg, #4c1d95 0%, #7c3aed 50%, #d946ef 100%);
  --th-nav-shadow: rgba(76,29,149,.32);
  --th-menu-shadow: rgba(124,58,237,.18);
  --th-hero-grad: linear-gradient(135deg, #6d28d9 0%, #a855f7 45%, #ec4899 100%);
  --th-hero-shadow: rgba(168,85,247,.26);
  --th-shell-bg:
    radial-gradient(900px 380px at 12% -8%, #ede9fe 0%, rgba(237,233,254,0) 62%),
    radial-gradient(760px 340px at 92% 4%, #fce7f3 0%, rgba(252,231,243,0) 60%),
    #f3eefb;
  --th-border: #e2d9f0;
  --th-border-hover: #c9b8e4;
  --th-accent: #7c3aed;
  --th-accent-deep: #5b21b6;
  --th-accent-bg: #f5f3ff;
  --th-focus: #a78bfa;
  --th-btn-grad: linear-gradient(135deg, #7c3aed, #c026d3);
  --th-btn-shadow: rgba(124,58,237,.30);
  --th-fab-grad: linear-gradient(135deg, #6d28d9, #ec4899);
  --th-fab-shadow: rgba(168,85,247,.40);
  --th-soft-grad: linear-gradient(135deg, #ede9fe, #fce7f3);
  --th-skel-grad: linear-gradient(100deg, #ede9fe 30%, #ddd6fe 50%, #ede9fe 70%);
  /* 紫 / 品红 / 粉 / 青（冷色对冲）/ 靛 */
  --th-c1: linear-gradient(135deg, #a78bfa, #7c3aed); --th-c1s: rgba(124,58,237,.32); --th-b1: #f5f3ff; --th-f1: #6d28d9;
  --th-c2: linear-gradient(135deg, #e879f9, #c026d3); --th-c2s: rgba(192,38,211,.30); --th-b2: #fdf4ff; --th-f2: #a21caf;
  --th-c3: linear-gradient(135deg, #f472b6, #db2777); --th-c3s: rgba(219,39,119,.28); --th-b3: #fdf2f8; --th-f3: #be185d;
  --th-c4: linear-gradient(135deg, #22d3ee, #0891b2); --th-c4s: rgba(8,145,178,.28); --th-b4: #ecfeff; --th-f4: #0e7490;
  --th-c5: linear-gradient(135deg, #818cf8, #4f46e5); --th-c5s: rgba(79,70,229,.30); --th-b5: #eef2ff; --th-f5: #4338ca;
}
:root, :root[data-theme="cool"] {
  /* 靛蓝 —— 深海色系：紫 → 靛 → 蓝 → 青，同样是四个色相的搭配 */
  --th-nav-grad: linear-gradient(135deg, #6d28d9 0%, #2563eb 52%, #06b6d4 100%);
  --th-nav-shadow: rgba(109,40,217,.30);
  --th-menu-shadow: rgba(67,56,202,.18);
  --th-hero-grad: linear-gradient(135deg, #7c3aed 0%, #2563eb 45%, #22d3ee 100%);
  --th-hero-shadow: rgba(59,130,246,.26);
  --th-shell-bg:
    radial-gradient(900px 380px at 12% -8%, #dbeafe 0%, rgba(219,234,254,0) 62%),
    radial-gradient(760px 340px at 92% 4%, #cffafe 0%, rgba(207,250,254,0) 60%),
    #eaf0fa;
  --th-border: #d7e2f2;
  --th-border-hover: #bcd0ea;
  --th-accent: #2563eb;
  --th-accent-deep: #4338ca;
  --th-accent-bg: #eff6ff;
  --th-focus: #3b82f6;
  --th-btn-grad: linear-gradient(135deg, #2563eb, #06b6d4);
  --th-btn-shadow: rgba(37,99,235,.30);
  --th-fab-grad: linear-gradient(135deg, #7c3aed, #22d3ee);
  --th-fab-shadow: rgba(37,99,235,.42);
  --th-soft-grad: linear-gradient(135deg, #dbeafe, #cffafe);
  --th-skel-grad: linear-gradient(100deg, #dbeafe 30%, #bfdbfe 50%, #dbeafe 70%);
  /* 蓝 / 青 / 靛 / 翡翠 / 紫 */
  --th-c1: linear-gradient(135deg, #60a5fa, #2563eb); --th-c1s: rgba(37,99,235,.34); --th-b1: #eff6ff; --th-f1: #1d4ed8;
  --th-c2: linear-gradient(135deg, #22d3ee, #0891b2); --th-c2s: rgba(8,145,178,.30); --th-b2: #ecfeff; --th-f2: #0e7490;
  --th-c3: linear-gradient(135deg, #818cf8, #4f46e5); --th-c3s: rgba(79,70,229,.32); --th-b3: #eef2ff; --th-f3: #4338ca;
  --th-c4: linear-gradient(135deg, #34d399, #059669); --th-c4s: rgba(5,150,105,.28); --th-b4: #ecfdf5; --th-f4: #047857;
  --th-c5: linear-gradient(135deg, #a78bfa, #7c3aed); --th-c5s: rgba(124,58,237,.28); --th-b5: #f5f3ff; --th-f5: #6d28d9;
}
nav::-webkit-scrollbar { display: none; }
`

/* 首屏前就把主题贴上，否则会先闪一下默认色再切过去 */
const THEME_BOOT = `try{var t=localStorage.getItem('theme');if(t==='cool'||t==='warm'||t==='violet'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-theme="cool">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>短视频制作系统</title>
        <style dangerouslySetInnerHTML={{ __html: THEME_VARS }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body style={{ margin: 0 }}>
        <AuthGuard>
          <TopNav />
          {children}
        </AuthGuard>
      </body>
    </html>
  )
}
