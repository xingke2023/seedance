#!/usr/bin/env python3
"""过滤远程人像库的 index.json（前端选择器读的就是这个文件）

图片文件一张不动，只改索引 —— 所以不需要重新构建前端。
全量索引备份为 index-all.json，随时可以还原：
    cp index-all.json index.json

用法（在远程服务器上）:
    # 只要 2026-08 批次的半身像
    python3 filter-avatar-index.py --prefix asset-202608 --kind halfbody

    # 还原全量
    python3 filter-avatar-index.py --restore

    # 看看有哪些批次、各多少
    python3 filter-avatar-index.py --stats
"""
import argparse
import json
import os
import shutil
import sys
from collections import Counter

DEFAULT_DIR = '/data/seedance-avatars'
FULLBODY_SUFFIX = ' 全身'


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def kind_of(entry):
    return 'fullbody' if entry['label'].endswith(FULLBODY_SUFFIX) else 'halfbody'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default=DEFAULT_DIR)
    ap.add_argument('--prefix', help='只保留 assetId 以此开头的，如 asset-202608')
    ap.add_argument('--kind', choices=['halfbody', 'fullbody'], help='只保留半身或全身')
    ap.add_argument('--restore', action='store_true', help='从 index-all.json 还原全量')
    ap.add_argument('--stats', action='store_true', help='只看统计，不改文件')
    args = ap.parse_args()

    index_path = os.path.join(args.dir, 'index.json')
    all_path = os.path.join(args.dir, 'index-all.json')

    if not os.path.exists(index_path):
        sys.exit(f'找不到 {index_path}')

    # 首次运行时把当前的全量索引备份下来
    if not os.path.exists(all_path):
        shutil.copy2(index_path, all_path)
        print(f'已备份全量索引 -> {all_path}')

    if args.restore:
        shutil.copy2(all_path, index_path)
        print(f'已还原全量: {len(load(index_path))} 条')
        return

    full = load(all_path)

    if args.stats:
        print(f'全量索引: {len(full)} 条\n')
        by_prefix = Counter(e['assetId'][:12] for e in full)
        print(f'{"批次前缀":<16}{"总数":>7}{"半身":>7}{"全身":>7}')
        for pre in sorted(by_prefix):
            sub = [e for e in full if e['assetId'].startswith(pre)]
            half = sum(1 for e in sub if kind_of(e) == 'halfbody')
            print(f'{pre:<16}{len(sub):>7}{half:>7}{len(sub)-half:>7}')
        return

    if not args.prefix and not args.kind:
        sys.exit('至少要指定 --prefix 或 --kind（或用 --restore / --stats）')

    kept = full
    if args.prefix:
        kept = [e for e in kept if e['assetId'].startswith(args.prefix)]
    if args.kind:
        kept = [e for e in kept if kind_of(e) == args.kind]

    if not kept:
        sys.exit('过滤后是空的，拒绝写入')

    # 校验保留的条目对应的图片文件确实还在
    import urllib.parse
    missing = []
    for e in kept:
        name = urllib.parse.unquote(e['thumb'].removeprefix('/avatars/'))
        p = os.path.join(args.dir, name)
        if not (os.path.exists(p) and os.path.getsize(p) > 5000):
            missing.append(name)
    if missing:
        print(f'警告: {len(missing)} 条指向的文件缺失，已剔除')
        names = set(missing)
        kept = [e for e in kept
                if urllib.parse.unquote(e['thumb'].removeprefix('/avatars/')) not in names]

    with open(index_path, 'w', encoding='utf-8') as f:
        json.dump(kept, f, ensure_ascii=False)

    filters = []
    if args.prefix: filters.append(f'前缀={args.prefix}')
    if args.kind: filters.append(f'类型={args.kind}')
    print(f'index.json: {len(full)} -> {len(kept)} 条  ({", ".join(filters)})')
    print(f'全量仍在 {all_path}，还原: python3 {os.path.basename(__file__)} --restore')


if __name__ == '__main__':
    main()
