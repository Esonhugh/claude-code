#!/usr/bin/env python3
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone


def command(repo, *args, check=True):
    result = subprocess.run(
        ['git', '-C', str(repo), *args],
        text=True,
        capture_output=True,
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"git command failed: {args!r}\nstdout={result.stdout}\nstderr={result.stderr}"
        )
    return result.stdout


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def read_makefile_version(repo):
    text = (repo / 'Makefile').read_text()
    match = re.search(r'^VERSION\s*[:?+]?=\s*(\S+)\s*$', text, re.MULTILINE)
    if not match:
        raise RuntimeError('Makefile VERSION not found')
    return match.group(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    repo = args.repo.resolve()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    status = command(repo, 'status', '--short', '--branch')
    upstream = command(
        repo,
        'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}',
        check=False,
    ).strip()
    binary = repo / 'built-claude'
    package = json.loads((repo / 'package.json').read_text())
    baseline = {
        'captured_at': datetime.now(timezone.utc).isoformat(),
        'repo': str(repo),
        'head': command(repo, 'rev-parse', 'HEAD').strip(),
        'head_short': command(repo, 'rev-parse', '--short', 'HEAD').strip(),
        'branch': command(repo, 'branch', '--show-current').strip(),
        'upstream': upstream or None,
        'status_short_branch': status,
        'status_porcelain': command(repo, 'status', '--short'),
        'diff_stat': command(repo, 'diff', '--stat'),
        'cached_diff_stat': command(repo, 'diff', '--cached', '--stat'),
        'makefile_version': read_makefile_version(repo),
        'package_version': package.get('version'),
        'binary': {
            'path': str(binary),
            'exists': binary.is_file(),
            'size': binary.stat().st_size if binary.is_file() else None,
            'mtime_ns': binary.stat().st_mtime_ns if binary.is_file() else None,
            'sha256': sha256(binary) if binary.is_file() else None,
        },
    }
    output.write_text(json.dumps(baseline, indent=2) + '\n')
    print(output)
    print(json.dumps(baseline, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
