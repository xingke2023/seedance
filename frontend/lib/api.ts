import { getAccessToken, refreshAccessToken, clearTokens } from './auth'

const API_BASE = '/api'

async function request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = getAccessToken()
  if (token) headers['Authorization'] = `Bearer ${token}`

  const opts: RequestInit = { method, headers }
  if (method !== 'GET') opts.body = JSON.stringify(body ?? {})

  const res = await fetch(`${API_BASE}${path}`, opts)

  if (res.status === 401 && retry) {
    const refreshed = await refreshAccessToken()
    if (refreshed) {
      return request<T>(method, path, body, false)
    }
    clearTokens()
    if (typeof window !== 'undefined') {
      window.location.href = '/login'
    }
    throw new Error('登录已过期')
  }

  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(res.ok ? '响应格式异常' : `请求失败：${text.slice(0, 100) || `HTTP ${res.status}`}`)
  }
  if (!res.ok || json.success === false) {
    throw new Error(json.error || json.message || `HTTP ${res.status}`)
  }
  return json.data !== undefined ? json.data : json
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}
