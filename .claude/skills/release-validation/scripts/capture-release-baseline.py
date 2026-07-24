#!/usr/bin/env python3
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone


WORKFLOW_RUNS_ROOT = '.claude/workflow-runs'
IGNORED_FILES_EXCLUDED_ROOTS = (
    'node_modules',
    WORKFLOW_RUNS_ROOT,
    '.claude-test-evidence',
    'built-claude',
    'dist',
    'official-claude',
)


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


def text_sha256(text):
    return hashlib.sha256(text.encode()).hexdigest()


def tree_manifest(root):
    manifest = {}
    if not root.exists():
        return manifest
    for path in sorted(root.rglob('*')):
        relative = str(path.relative_to(root))
        if path.is_symlink():
            manifest[relative] = {
                'type': 'link',
                'target': str(path.readlink()),
            }
        elif path.is_file():
            manifest[relative] = {'type': 'file', 'sha256': sha256(path)}
        elif path.is_dir():
            manifest[relative] = {'type': 'dir'}
    return manifest


def tree_sha256(manifest):
    return text_sha256(json.dumps(manifest, sort_keys=True))


def git_paths_manifest(repo, *args, excluded_roots=()):
    manifest = {}
    paths = command(repo, 'ls-files', *args, '-z').split('\0')
    for relative in sorted(path for path in paths if path):
        relative = relative.rstrip('/')
        if any(
            relative == root or relative.startswith(f'{root}/')
            for root in excluded_roots
        ):
            continue
        file_path = repo / relative
        if file_path.is_symlink():
            manifest[relative] = {
                'type': 'link',
                'target': str(file_path.readlink()),
            }
        elif file_path.is_file():
            manifest[relative] = {'type': 'file', 'sha256': sha256(file_path)}
        elif file_path.is_dir():
            manifest[relative] = {'type': 'dir'}
            manifest.update({
                f'{relative}/{child}': entry
                for child, entry in tree_manifest(file_path).items()
            })
        else:
            raise RuntimeError(f'git-listed path does not exist: {relative}')
    return manifest


def untracked_manifest(repo):
    return git_paths_manifest(
        repo,
        '--others', '--exclude-standard',
        excluded_roots=(WORKFLOW_RUNS_ROOT,),
    )


def ignored_manifest(repo):
    return git_paths_manifest(
        repo,
        '--others', '--ignored', '--exclude-standard',
        excluded_roots=IGNORED_FILES_EXCLUDED_ROOTS,
    )


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
    try:
        output.relative_to(repo)
    except ValueError:
        pass
    else:
        parser.error('--output must be outside the repository')
    output.parent.mkdir(parents=True, exist_ok=True)
    status = command(repo, 'status', '--short', '--branch')
    upstream = command(
        repo,
        'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}',
        check=False,
    ).strip()
    binary = repo / 'built-claude'
    package = json.loads((repo / 'package.json').read_text())
    workflow_runs = repo / '.claude' / 'workflow-runs'
    workflow_runs_manifest = tree_manifest(workflow_runs)
    untracked_files_manifest = untracked_manifest(repo)
    ignored_files_manifest = ignored_manifest(repo)
    unstaged_diff = command(repo, 'diff', '--binary')
    staged_diff = command(repo, 'diff', '--cached', '--binary')
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
        'unstaged_diff_sha256': text_sha256(unstaged_diff),
        'staged_diff_sha256': text_sha256(staged_diff),
        'untracked_files_manifest': untracked_files_manifest,
        'untracked_files_sha256': tree_sha256(untracked_files_manifest),
        'ignored_files_excluded_roots': list(IGNORED_FILES_EXCLUDED_ROOTS),
        'ignored_files_manifest': ignored_files_manifest,
        'ignored_files_sha256': tree_sha256(ignored_files_manifest),
        'workflow_runs_exists': workflow_runs.is_dir(),
        'workflow_runs_manifest': workflow_runs_manifest,
        'workflow_runs_sha256': tree_sha256(workflow_runs_manifest),
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
