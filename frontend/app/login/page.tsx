'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { setTokens } from '@/lib/auth'
import styles from './page.module.css'

const FEATURES = ['智能分镜脚本生成', '多音色配音', '批量视频合成']

export default function LoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  function switchMode(next: 'login' | 'register') {
    setMode(next)
    setError('')
  }

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
        router.push('/projects')
      } else {
        setError('返回数据异常')
      }
    } catch (err: any) {
      setError(err.message || '网络错误')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>

        <div className={styles.brand}>
          <div className={styles.brandRow}>
            <span className={styles.logo}>
              {/* 和 TopNav 同一个盾牌标 */}
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                   stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
              </svg>
            </span>
            <h1 className={styles.brandTitle}>星科AI</h1>
          </div>
          <p className={styles.brandDesc}>剧本 · 分镜 · AI 短视频一站式创作</p>
        </div>

        <div className={styles.card}>
          <div className={styles.tabs}>
            <button type="button"
              className={`${styles.tab} ${mode === 'login' ? styles.tabActive : ''}`}
              onClick={() => switchMode('login')}>
              登录
            </button>
            <button type="button"
              className={`${styles.tab} ${mode === 'register' ? styles.tabActive : ''}`}
              onClick={() => switchMode('register')}>
              注册
            </button>
          </div>

          <form onSubmit={handleSubmit} className={styles.form}>
            <div className={styles.field}>
              <label className={styles.label}>
                {mode === 'login' ? '用户名或邮箱' : '用户名'}
              </label>
              <div className={styles.inputWrap}>
                <svg className={styles.inputIcon} viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
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
            </div>

            <div className={styles.field}>
              <label className={styles.label}>密码</label>
              <div className={styles.inputWrap}>
                <svg className={styles.inputIcon} viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <input
                  type={showPwd ? 'text' : 'password'}
                  placeholder="请输入密码"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className={`${styles.input} ${styles.inputPwd}`}
                  required
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
                {/* 手机上输错密码看不见很难受，给个明文开关 */}
                <button type="button" className={styles.eye} tabIndex={-1}
                  onClick={() => setShowPwd(v => !v)}
                  title={showPwd ? '隐藏密码' : '显示密码'}>
                  {showPwd ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {error && (
              <div className={styles.error}>
                <span aria-hidden="true">⚠</span>
                <span>{error}</span>
              </div>
            )}

            <button type="submit" className={styles.btnPrimary} disabled={loading}>
              {loading && <span className={styles.spinner} />}
              {loading
                ? (mode === 'login' ? '登录中…' : '注册中…')
                : (mode === 'login' ? '登录' : '注册')}
            </button>
          </form>

          <p className={styles.switchHint}>
            {mode === 'login' ? '还没有账号？' : '已经有账号了？'}
            <button type="button" className={styles.switchLink}
              onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? '立即注册' : '去登录'}
            </button>
          </p>
        </div>

        <ul className={styles.features}>
          {FEATURES.map(f => <li key={f}>{f}</li>)}
        </ul>

      </div>
    </div>
  )
}
