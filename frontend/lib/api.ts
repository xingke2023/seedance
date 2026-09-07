import { getAccessToken, refreshAccessToken, clearTokens } from './auth'

const API_BASE = '/api'

// 有些接口失败时仍想带回部分结果（例如剧本分析：剧本写完了但角色提取失败，
// 剧本不该跟着白写）——挂在 Error 上，不改 .message，调用方按需读 err.data。
export class ApiError extends Error {
  data?: unknown;
  constructor(message: string, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.data = data;
  }
}

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
    throw new ApiError(json.error || json.message || `HTTP ${res.status}`, json)
  }
  return json.data !== undefined ? json.data : json
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}
