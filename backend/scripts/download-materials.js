'use strict'

// 把方舟体验中心的预设视频/音频转存到本机 uploads/materials/ 下，
// 之后 GET /library/materials 交出来的就是自己域名的 /uploads/... 地址，
// 不再把 volces.com 的外链直接甩给 Seedance。
//
//   node backend/scripts/download-materials.js                # 只下缺的（可重复跑）
//   node backend/scripts/download-materials.js --force        # 全部重下
//   node backend/scripts/download-materials.js --kind audios  # 只下某一类
//
// 落地路径 = uploads/materials/<清单里 materials/ 之后的那截>，中文原样保留：
//   uploads/materials/视频/动作/华尔兹.mp4
//   uploads/materials/音频/音色/青年-女-亲切女声.mp3
// 失败的逐条打印出来，退出码非 0。

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const fs   = require('fs')
const path = require('path')
const { UPLOAD_ROOT } = require('../src/lib/uploads')
const { load, materialRelPath } = require('../src/lib/materials')

const args  = process.argv.slice(2)
const FORCE = args.includes('--force')
const kindArg = (args[args.indexOf('--kind') + 1] || '').trim()
const KINDS = kindArg && args.includes('--kind') ? [kindArg] : ['videos', 'audios']

const MATERIALS_ROOT = path.join(UPLOAD_ROOT, 'materials')

async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(180000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) throw new Error('空文件')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  fs.writeFileSync(tmp, buf)          // 先写 .part 再改名，中断不会留下半个文件冒充成品
  fs.renameSync(tmp, dest)
  return buf.length
}

;(async () => {
  const lib = load({ local: false })   // 要的是原始外链，不是转存后的地址
  const failed = []
  let got = 0, skipped = 0, bytes = 0

  for (const kind of KINDS) {
    const items = lib[kind] || []
    if (!items.length) { console.log(`[${kind}] 清单里没有条目，跳过`); continue }
    console.log(`\n[${kind}] ${items.length} 条`)

    for (const [i, it] of items.entries()) {
      const rel = materialRelPath(it.url)
      if (!rel) { failed.push({ kind, name: it.name, url: it.url, err: '地址里找不到 materials/ 这一段' }); continue }
      const dest = path.join(MATERIALS_ROOT, rel)
      if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 0) { skipped++; continue }
      try {
        const n = await download(it.url, dest)
        got++; bytes += n
        console.log(`  ${i + 1}/${items.length} ✓ ${rel} (${(n / 1048576).toFixed(1)}MB)`)
      } catch (e) {
        failed.push({ kind, name: it.name, url: it.url, err: e.message })
        console.log(`  ${i + 1}/${items.length} ✗ ${rel} — ${e.message}`)
      }
    }
  }

  console.log(`\n新下载 ${got} 个（${(bytes / 1048576).toFixed(1)}MB），已有跳过 ${skipped} 个，失败 ${failed.length} 个`)
  if (failed.length) {
    console.log('\n下载失败的素材：')
    failed.forEach(f => console.log(`  [${f.kind}] ${f.name} — ${f.err}\n      ${f.url}`))
  }
  console.log('\n转存完成后记得 pm2 restart seedance20-backend（素材清单在进程里缓存了一份）')
  process.exit(failed.length ? 1 : 0)
})()
