#!/usr/bin/env python3
"""在远程服务器上按清单下载虚拟人像图片，并生成 index.json

设计成在目标服务器上运行 —— 签名 URL 免鉴权，服务器带宽比本地上传快得多，
省去 2.5GB 的本地→远程传输。

先下载到 --out 指定的新目录，不动现有目录；下载校验通过后再由调用方切换，
避免出现"旧的删了新的没下好"的空窗。

用法（在远程服务器上）:
    python3 remote-download-avatars.py \
        --manifest avatar-manifest.json \
        --out /home/ubuntu/seedance2.0/frontend/public/avatars.new \
        --workers 16
"""
import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

MIN_BYTES = 5000          # 小于这个字节数视为下载失败/占位图
UA = 'Mozilla/5.0'

lock = threading.Lock()
stats = {'ok': 0, 'skip': 0, 'fail': 0, 'bytes': 0}


def download(entry, out_dir, retries=3):
    """下载单张图，返回 (状态, filename, 错误信息)"""
    filename = entry['filename']
    path = os.path.join(out_dir, filename)

    if os.path.exists(path) and os.path.getsize(path) >= MIN_BYTES:
        with lock:
            stats['skip'] += 1
        return 'skip', filename, None

    last_err = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(entry['url'], headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()

            if len(data) < MIN_BYTES:
                last_err = f'内容过小 ({len(data)} 字节)'
                continue

            tmp = path + '.part'
            with open(tmp, 'wb') as f:
                f.write(data)
            os.replace(tmp, path)

            with lock:
                stats['ok'] += 1
                stats['bytes'] += len(data)
            return 'ok', filename, None

        except urllib.error.HTTPError as e:
            last_err = f'HTTP {e.code}'
            if e.code in (403, 404):   # 签名过期或资源不存在，重试无意义
                break
        except Exception as e:
            last_err = str(e)[:80]

        if attempt < retries:
            time.sleep(1.5 * attempt)

    with lock:
        stats['fail'] += 1
    return 'fail', filename, last_err


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--out', required=True, help='输出目录（新目录，不要指向线上目录）')
    ap.add_argument('--workers', type=int, default=16)
    ap.add_argument('--limit', type=int, help='只下载前 N 条（测试用）')
    args = ap.parse_args()

    with open(args.manifest, encoding='utf-8') as f:
        manifest = json.load(f)

    entries = manifest['entries']
    if args.limit:
        entries = entries[:args.limit]

    os.makedirs(args.out, exist_ok=True)
    total = len(entries)
    print(f'清单 {total} 条 -> {args.out}  ({args.workers} 并发)')
    print(f'源数据抓取时间: {manifest.get("sourceFetchedAt")}\n')

    failures = []
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(download, e, args.out): e for e in entries}
        done = 0
        for fut in as_completed(futures):
            status, filename, err = fut.result()
            done += 1
            if status == 'fail':
                failures.append({'filename': filename, 'error': err})

            if done % 250 == 0 or done == total:
                el = time.time() - t0
                rate = done / el if el else 0
                eta = (total - done) / rate / 60 if rate else 0
                gb = stats['bytes'] / 1024 ** 3
                print(f'  [{done}/{total}] {done*100//total}%  '
                      f'成功 {stats["ok"]} 跳过 {stats["skip"]} 失败 {stats["fail"]}  '
                      f'{gb:.2f}GB  {rate:.1f}/s  剩余 {eta:.1f}min')

    # 生成 index.json（沿用远程既有格式）
    index = []
    missing = []
    for e in entries:
        path = os.path.join(args.out, e['filename'])
        if not (os.path.exists(path) and os.path.getsize(path) >= MIN_BYTES):
            missing.append(e['filename'])
            continue
        index.append({
            'assetId': e['assetId'],
            'label': e['label'],
            'thumb': '/avatars/' + urllib.parse.quote(e['filename']),
        })

    index_path = os.path.join(args.out, 'index.json')
    with open(index_path, 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False)

    el = time.time() - t0
    print(f'\n耗时 {el/60:.1f} 分钟')
    print(f'下载 {stats["ok"]} 成功 / {stats["skip"]} 跳过 / {stats["fail"]} 失败')
    print(f'总大小 {stats["bytes"]/1024**3:.2f} GB')
    print(f'index.json: {len(index)} 条 -> {index_path}')

    if failures:
        fp = os.path.join(args.out, 'failures.json')
        with open(fp, 'w', encoding='utf-8') as f:
            json.dump(failures, f, ensure_ascii=False, indent=2)
        print(f'\n失败明细 -> {fp}')
        for x in failures[:5]:
            print(f'  {x["filename"]}: {x["error"]}')
        # 失败率超过 2% 用非零退出码，让调用方不要贸然切换目录
        if len(failures) > total * 0.02:
            print(f'\n失败率 {len(failures)/total*100:.1f}% 偏高，建议排查后重跑（可续传）')
            sys.exit(1)

    if missing:
        print(f'{len(missing)} 条未落盘，已从 index.json 中排除')


if __name__ == '__main__':
    main()
