'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { getAccessToken, isTokenExpired, refreshAccessToken, clearTokens } from '@/lib/auth'

const PUBLIC_PATHS = ['/login', '/oauth/callback']

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (PUBLIC_PATHS.some(p => pathname?.startsWith(p))) {
      setReady(true)
      return
    }

    const token = getAccessToken()
    if (!token) {
      router.replace('/login')
      return
    }

    if (isTokenExpired()) {
      refreshAccessToken().then(ok => {
        if (ok) {
          setReady(true)
        } else {
          clearTokens()
          router.replace('/login')
        }
      })
    } else {
      setReady(true)
    }
  }, [pathname, router])

  if (PUBLIC_PATHS.some(p => pathname?.startsWith(p))) {
    return <>{children}</>
  }

  if (!ready) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#6b7280', fontSize: 14 }}>验证中...</p>
      </div>
    )
  }

  return <>{children}</>
}
