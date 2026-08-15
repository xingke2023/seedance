'use client'

import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { setTokens } from '@/lib/auth'

function CallbackHandler() {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const accessToken = searchParams.get('accessToken') || searchParams.get('access_token')
    const refreshToken = searchParams.get('refreshToken') || searchParams.get('refresh_token')

    if (accessToken && refreshToken) {
      setTokens(accessToken, refreshToken)
      router.replace('/voiceover-v3')
    } else {
      router.replace('/login')
    }
  }, [searchParams, router])

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: '#6b7280', fontSize: 14 }}>登录中...</p>
    </div>
  )
}

export default function OAuthCallbackPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><p style={{ color: '#6b7280', fontSize: 14 }}>加载中...</p></div>}>
      <CallbackHandler />
    </Suspense>
  )
}
