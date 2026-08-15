import TopNav from '@/components/TopNav'
import AuthGuard from '@/components/AuthGuard'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Seedance 视频生成</title>
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
