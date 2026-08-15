const SSO_BASE_URL = 'https://mo.xingke888.com'

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('accessToken')
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('refreshToken')
}

export function setTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem('accessToken', accessToken)
  localStorage.setItem('refreshToken', refreshToken)
}

export function clearTokens() {
  localStorage.removeItem('accessToken')
  localStorage.removeItem('refreshToken')
}

export function getUserFromToken(): { userId: number; username: string; name: string; email: string; avatar: string } | null {
  const token = getAccessToken()
  if (!token) return null
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return payload
  } catch {
    return null
  }
}

export function isTokenExpired(): boolean {
  const token = getAccessToken()
  if (!token) return true
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return Date.now() >= payload.exp * 1000
  } catch {
    return true
  }
}

export async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) return false
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (!res.ok) {
      clearTokens()
      return false
    }
    const json = await res.json()
    const data = json.data || json
    if (data.accessToken) {
      setTokens(data.accessToken, data.refreshToken || refreshToken)
      return true
    }
    clearTokens()
    return false
  } catch {
    return false
  }
}

export function getWeChatLoginUrl(redirectUri: string): string {
  return `/api/auth/wechat?redirect_uri=${encodeURIComponent(redirectUri)}`
}
