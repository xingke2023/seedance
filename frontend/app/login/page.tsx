'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { setTokens } from '@/lib/auth'
import styles from './page.module.css'

export default function LoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register'
      const body = mode === 'login'
        ? { identifier, password }
        : { username: identifier, password }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        setError(json.error || (mode === 'login' ? '登录失败' : '注册失败'))
        return
      }
      const data = json.data
      if (data.accessToken) {
        setTokens(data.accessToken, data.refreshToken)
        router.push('/voiceover-v3')
      } else {
        setError('返回数据异常')
      }
    } catch (err: any) {
      setError(err.message || '网络错误')
    } finally {
      setLoading(false)
    }
  }

  function handleWeChatLogin() {
    const redirectUri = `${window.location.origin}/oauth/callback`
    window.location.href = `/api/auth/wechat?redirect_uri=${encodeURIComponent(redirectUri)}`
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        {/* Left: branding */}
        <div className={styles.brand}>
          <div className={styles.brandInner}>
            <h1 className={styles.brandTitle}>Fidelity视频生成平台</h1>
            <ul className={styles.features}>
              <li>智能分镜脚本生成</li>
              <li>多音色配音</li>
              <li>智能的批量视频合成</li>
            </ul>
          </div>
        </div>

        {/* Right: form */}
        <div className={styles.formWrap}>
          <div className={styles.card}>
            <div className={styles.tabs}>
              <button
                className={`${styles.tab} ${mode === 'login' ? styles.tabActive : ''}`}
                onClick={() => { setMode('login'); setError('') }}
              >
                登录
              </button>
              <button
                className={`${styles.tab} ${mode === 'register' ? styles.tabActive : ''}`}
                onClick={() => { setMode('register'); setError('') }}
              >
                注册
              </button>
            </div>

            <form onSubmit={handleSubmit} className={styles.form}>
              <div className={styles.field}>
                <label className={styles.label}>
                  {mode === 'login' ? '用户名或邮箱' : '用户名'}
                </label>
                <input
                  type="text"
                  placeholder={mode === 'login' ? '请输入用户名或邮箱' : '请输入用户名'}
                  value={identifier}
                  onChange={e => setIdentifier(e.target.value)}
                  className={styles.input}
                  required
                  autoComplete="username"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>密码</label>
                <input
                  type="password"
                  placeholder="请输入密码"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className={styles.input}
                  required
                  autoComplete="current-password"
                />
              </div>

              {error && <div className={styles.error}>{error}</div>}

              <button type="submit" className={styles.btnPrimary} disabled={loading}>
                {loading ? (mode === 'login' ? '登录中…' : '注册中…') : (mode === 'login' ? '登录' : '注册')}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
