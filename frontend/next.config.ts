/** @type {import('next').NextConfig} */
const nextConfig = {
  // dev 与生产同在一个仓库目录里跑，必须各用各的构建目录，
  // 否则 next dev 会清掉 next start 正在读的 .next（NEXT_DIST_DIR=.next-dev）
  distDir: process.env.NEXT_DIST_DIR || '.next',
  experimental: {
    // rewrite 代理默认 30s 超时（router-utils/proxy-request.js），超时直接给
    // 浏览器返回纯文本 Internal Server Error。分镜生成要 35-60s，必须调大。
    // 生产走 nginx 的 location /api/ 直连 8112，不经过这里
    proxyTimeout: 600_000,
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `http://localhost:${process.env.BACKEND_PORT || 8112}/:path*`,
      },
    ]
  },
}

export default nextConfig
