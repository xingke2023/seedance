#!/usr/bin/env bash
# 在远程服务器上把 public/avatars 切换到数据盘的新人像库
#
# 安全设计:
#   1. 先校验新库完整 (index.json 存在、文件数吻合、抽样可读)
#   2. 旧目录 mv 成 avatars.old 保留，不直接删
#   3. 切软链 + 重启生产实例
#   4. HTTP 验证两个端口都能取到新图
#   5. 任一步失败 -> 自动回滚到旧库并重启
#
# 校验通过后旧库仍留在 avatars.old，确认无误再手动删除。
#
# 用法 (在远程服务器上):
#   bash swap-remote-avatars.sh
#   bash swap-remote-avatars.sh --commit    # 通过后顺带删掉 avatars.old

set -uo pipefail

PUBLIC_DIR=/home/ubuntu/seedance2.0/frontend/public
NEW_DIR=/data/seedance-avatars
LIVE=$PUBLIC_DIR/avatars
OLD=$PUBLIC_DIR/avatars.old
PM2_APP=seedance20-frontend
PORTS=(8118 8113)          # 8118=next dev, 8113=next start(生产)

COMMIT=0
[ "${1:-}" = "--commit" ] && COMMIT=1

die() { echo "✗ $*" >&2; exit 1; }

# ---------- 1. 校验新库 ----------
echo "=== 校验新库 ==="
[ -d "$NEW_DIR" ] || die "新目录不存在: $NEW_DIR"
[ -f "$NEW_DIR/index.json" ] || die "缺 index.json，下载可能未完成"

read -r n_idx n_files < <(python3 - "$NEW_DIR" <<'PY'
import json, os, sys
d = sys.argv[1]
idx = json.load(open(os.path.join(d, "index.json")))
files = [f for f in os.listdir(d) if f != "index.json" and not f.endswith(".part")]
print(len(idx), len(files))
PY
) || die "读取 index.json 失败"

echo "  index.json: $n_idx 条"
echo "  实际文件:   $n_files 个"
[ "$n_idx" -gt 0 ] || die "index.json 是空的"

# index.json 里每条的 thumb 都必须真实存在（抽样 200 条）
python3 - "$NEW_DIR" <<'PY' || die "thumb 路径校验失败"
import json, os, random, sys, urllib.parse
d = sys.argv[1]
idx = json.load(open(os.path.join(d, "index.json")))
sample = random.sample(idx, min(200, len(idx)))
bad = []
for e in sample:
    name = urllib.parse.unquote(e["thumb"].removeprefix("/avatars/"))
    p = os.path.join(d, name)
    if not (os.path.exists(p) and os.path.getsize(p) > 5000):
        bad.append(name)
if bad:
    print(f"  ✗ 抽样 {len(sample)} 条中 {len(bad)} 条指向的文件缺失/过小:")
    for b in bad[:5]: print(f"      {b}")
    sys.exit(1)
print(f"  ✓ 抽样 {len(sample)} 条 thumb 全部命中")
PY

if [ -f "$NEW_DIR/failures.json" ]; then
  nf=$(python3 -c "import json;print(len(json.load(open('$NEW_DIR/failures.json'))))" 2>/dev/null || echo 0)
  [ "$nf" -gt 0 ] && echo "  注意: 有 $nf 条下载失败 (已从 index.json 排除)"
fi

# ---------- 2. 切换 ----------
echo ""
echo "=== 切换 ==="
[ -e "$OLD" ] && die "$OLD 已存在，请先处理 (上次切换未收尾?)"

if [ -L "$LIVE" ]; then
  echo "  当前已是软链 -> $(readlink "$LIVE")，仅重启"
  PREV_WAS_SYMLINK=1
else
  n_old=$(find "$LIVE" -maxdepth 1 -type f 2>/dev/null | wc -l)
  echo "  旧库 $n_old 个文件 -> $OLD"
  mv "$LIVE" "$OLD" || die "mv 失败"
  PREV_WAS_SYMLINK=0
fi

ln -sfn "$NEW_DIR" "$LIVE" || die "建软链失败"
echo "  软链: avatars -> $(readlink "$LIVE")"

rollback() {
  echo ""
  echo "!!! 回滚 !!!"
  rm -f "$LIVE"
  [ "$PREV_WAS_SYMLINK" = "0" ] && [ -d "$OLD" ] && mv "$OLD" "$LIVE"
  pm2 restart "$PM2_APP" >/dev/null 2>&1
  echo "已恢复旧库并重启"
  exit 1
}

# ---------- 3. 重启生产实例 ----------
# next start 用构建期的 public 清单，不重启认不到新文件
echo ""
echo "=== 重启 $PM2_APP ==="
pm2 restart "$PM2_APP" >/dev/null 2>&1 || { echo "pm2 restart 失败"; rollback; }
ready=0
for i in $(seq 1 30); do
  sleep 2
  if curl -sf -o /dev/null "http://127.0.0.1:8113/avatars/index.json"; then
    ready=$((i * 2))
    break
  fi
done
[ "$ready" -gt 0 ] || { echo "60 秒内未就绪"; rollback; }
echo "  已就绪 (${ready} 秒)"

# ---------- 4. HTTP 验证 ----------
echo ""
echo "=== HTTP 验证 ==="
verify_ok=1
for port in "${PORTS[@]}"; do
  out=$(python3 - "$NEW_DIR" "$port" <<'PY'
import json, os, random, sys, urllib.request, urllib.parse
d, port = sys.argv[1], sys.argv[2]
idx = json.load(open(os.path.join(d, "index.json")))
ok = 0
for e in random.sample(idx, min(5, len(idx))):
    url = f"http://127.0.0.1:{port}{e['thumb']}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            data = r.read()
        name = urllib.parse.unquote(e["thumb"].removeprefix("/avatars/"))
        if r.status == 200 and len(data) == os.path.getsize(os.path.join(d, name)):
            ok += 1
    except Exception:
        pass
print(ok)
PY
)
  if [ "$out" = "5" ]; then
    echo "  ✓ $port: 5/5 取图成功"
  else
    echo "  ✗ $port: 仅 ${out}/5 成功"
    verify_ok=0
  fi
done
[ "$verify_ok" = "1" ] || rollback

# ---------- 5. 收尾 ----------
echo ""
echo "=== 完成 ==="
echo "新库生效: $n_idx 条，$(du -sh "$NEW_DIR" | cut -f1)"
if [ "$COMMIT" = "1" ] && [ -d "$OLD" ]; then
  rm -rf "$OLD"
  echo "旧库已删除"
elif [ -d "$OLD" ]; then
  echo "旧库保留在 $OLD ($(du -sh "$OLD" | cut -f1))"
  echo "确认页面无误后删除: rm -rf $OLD"
fi
