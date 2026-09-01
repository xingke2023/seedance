import TopNav from '@/components/TopNav'
import AuthGuard from '@/components/AuthGuard'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>MACRODATA保险短视频制作系统(Seedance2.5高级版本)</title>
        <style dangerouslySetInnerHTML={{ __html: `nav::-webkit-scrollbar { display: none; }` }} />
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
