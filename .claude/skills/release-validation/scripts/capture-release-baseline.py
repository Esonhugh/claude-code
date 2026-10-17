#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys
from datetime import datetime, timezone


sys.dont_write_bytecode = True


WORKFLOW_RUNS_ROOT = '.claude/workflow-runs'
BUN_BUILD_TEMPORARY_PATTERN = re.compile(
    r'^\.[0-9a-f]{16}-[0-9a-f]{8}\.bun-build$'
)
PYTHON_BYTECODE_PATTERN = re.compile(r'^.+\.py[cod]$')
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


def git_paths_manifest(repo, *args, excluded_roots=(), strict=False):
    manifest = {}
    paths = command(repo, 'ls-files', *args, '-z').split('\0')
    for relative in sorted(path for path in paths if path):
        relative = relative.rstrip('/')
        if (
            (not strict and (
                BUN_BUILD_TEMPORARY_PATTERN.fullmatch(relative)
                or '/__pycache__/' in f'/{relative}'
                or PYTHON_BYTECODE_PATTERN.fullmatch(relative)
            ))
            or any(
                relative == root or relative.startswith(f'{root}/')
                for root in excluded_roots
            )
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


def default_release_base_ref(repo):
    release_base_ref = command(
        repo, 'describe', '--tags', '--abbrev=0', 'HEAD^', check=False
    ).strip()
    if not release_base_ref:
        raise RuntimeError(
            'could not determine the previous release tag from HEAD^; '
            'pass --release-base-ref <commit-ish>'
        )
    return release_base_ref


def retained_paths(repo, run_root, binary):
    repo = repo.resolve()
    # macOS /tmp is a system alias; no other symlink is a retained path.
    for path in (run_root, binary):
        if any(parent.is_symlink() and not (
            sys.platform == 'darwin' and parent == Path('/tmp')
            and parent.resolve() == Path('/private/tmp')
        ) for parent in (path.absolute(), *path.absolute().parents)):
            raise ValueError('retained paths must not contain symlinks')
    root = run_root.resolve()
    binary = binary.resolve()
    if binary.is_relative_to(repo):
        relative = binary.relative_to(repo)
        if not relative.parts or relative.parts[0] == '.git':
            raise ValueError('binary must be strictly inside repository, outside .git')
    else:
        if not binary.is_relative_to(Path('/tmp').resolve()) or not binary.is_file():
            raise ValueError('external binary must be an existing file strictly inside system /tmp')
        homes = {Path.home().resolve(), *(Path(user.pw_dir).resolve()
                  for user in pwd.getpwall() if user.pw_dir not in ('', '/', '/var/empty'))}
        if any(binary == home or binary.is_relative_to(home) for home in homes):
            raise ValueError('external binary must not be in a user HOME')
    if root.is_relative_to(repo):
        relative = root.relative_to(repo)
        if not relative.parts or relative.parts[0] == '.git':
            raise ValueError('run root must be strictly inside repository, outside .git')
    elif root == Path('/tmp').resolve() or not root.is_relative_to(Path('/tmp').resolve()):
        raise ValueError('external run root must be strictly inside system /tmp')
    if not root.is_relative_to(repo):
        homes = {Path.home().resolve(), *(Path(user.pw_dir).resolve()
                  for user in pwd.getpwall() if user.pw_dir not in ('', '/', '/var/empty'))}
        if any(root == home or root.is_relative_to(home) for home in homes):
            raise ValueError('external run root must not be in a user HOME')
    if binary == repo / 'built-claude' or binary.is_relative_to(root):
        raise ValueError('--binary must be a separate build artifact, not the protected root binary or run output')
    return root, binary


def binary_identity(path):
    exists = path.is_file()
    return {
        'path': str(path), 'exists': exists,
        'size': path.stat().st_size if exists else None,
        'mtime_ns': path.stat().st_mtime_ns if exists else None,
        'sha256': sha256(path) if exists else None,
    }


def retained_environment(root):
    return {
        'HOME': str(root / 'home'),
        'CLAUDE_CONFIG_DIR': str(root / 'config'),
        'XDG_CACHE_HOME': str(root / 'home/.cache'),
        'XDG_CONFIG_HOME': str(root / 'home/.config'),
        'XDG_DATA_HOME': str(root / 'home/.local/share'),
        'TMPDIR': str(root / 'tmp'), 'TMP': str(root / 'tmp'),
        'TEMP': str(root / 'tmp'), 'CLAUDE_CODE_TMPDIR': str(root / 'tmp'),
        'PYTHONDONTWRITEBYTECODE': '1',
        'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1',
    }


def retained_repository_state(repo, root, binary):
    excluded = (str(root.relative_to(repo)),) if root.is_relative_to(repo) else ()
    pathspec = ['.', *(f':(top,literal,exclude){path}' for path in excluded)]
    content_excluded = tuple(filter(None, os.environ.get('CC_VALIDATION_STATE_CONTENT_EXCLUDE', '').split(',')))
    if any(Path(path).is_absolute() or '..' in Path(path).parts for path in content_excluded):
        raise ValueError('content exclusions must be repository-relative paths')
    content_pathspec = [*pathspec, *(f':(top,literal,exclude){path}' for path in content_excluded)]
    untracked = git_paths_manifest(
        repo, '--others', '--exclude-standard', excluded_roots=(*excluded, *content_excluded), strict=True,
    )
    ignored = git_paths_manifest(
        repo, '--others', '--ignored', '--exclude-standard',
        excluded_roots=(*excluded, *content_excluded), strict=True,
    )
    return {
        'head': command(repo, 'rev-parse', 'HEAD').strip(),
        'branch': command(repo, 'branch', '--show-current').strip(),
        'status_porcelain': command(repo, 'status', '--short', '--', *pathspec),
        'content_excluded_paths': list(content_excluded),
        'unstaged_diff_sha256': text_sha256(command(repo, 'diff', '--binary', '--', *content_pathspec)),
        'staged_diff_sha256': text_sha256(command(repo, 'diff', '--cached', '--binary', '--', *content_pathspec)),
        'untracked_files_manifest': untracked,
        'untracked_files_sha256': tree_sha256(untracked),
        'ignored_files_excluded_roots': list(excluded),
        'ignored_files_manifest': ignored,
        'ignored_files_sha256': tree_sha256(ignored),
        'binary': binary_identity(binary),
        'protected_root_binary': binary_identity(repo / 'built-claude'),
    }


def capture_retained_baseline(args):
    repo = args.repo.resolve()
    root, binary = retained_paths(repo, args.run_root, args.binary)
    if root.exists():
        raise ValueError('--run-root must be new; baseline creates it exclusively')
    if not root.parent.is_dir():
        raise ValueError('--run-root parent must already exist')
    output = args.output.parent.resolve() / args.output.name
    if output != root / 'baseline.json':
        raise ValueError('retained --output must be <run-root>/baseline.json')
    if not binary.is_file():
        raise ValueError('--binary must be an existing build artifact')
    release_ref = args.release_base_ref or default_release_base_ref(repo)
    release_commit = command(repo, 'rev-parse', '--verify', f'{release_ref}^{{commit}}').strip()
    state = retained_repository_state(repo, root, binary)
    baseline = {
        **state, 'repo': str(repo), 'run_root': str(root), 'retain_artifacts': True,
        'captured_at': datetime.now(timezone.utc).isoformat(),
        'release_base_ref': release_ref, 'release_base_commit': release_commit,
        'status_porcelain_raw': command(repo, 'status', '--short'),
        'makefile_version': read_makefile_version(repo),
        'package_version': json.loads((repo / 'package.json').read_text()).get('version'),
        'environment': retained_environment(root),
    }
    root.mkdir(mode=0o700)
    with output.open('x') as stream:
        stream.write(json.dumps(baseline, indent=2) + '\n')
    print(output)
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument(
        '--release-base-ref',
        help='previous release tag or commit-ish; defaults to the nearest tag from HEAD^',
    )
    parser.add_argument('--binary', type=Path)
    parser.add_argument('--run-root', type=Path)
    parser.add_argument('--retain-artifacts', action='store_true')
    args = parser.parse_args()
    if args.retain_artifacts or args.run_root or args.binary:
        if not (args.retain_artifacts and args.run_root and args.binary):
            parser.error('retained mode requires --binary, --run-root and --retain-artifacts')
        try:
            return capture_retained_baseline(args)
        except (ValueError, RuntimeError, OSError) as error:
            parser.error(str(error))
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
    untracked_files_manifest = untracked_manifest(repo)
    ignored_files_manifest = ignored_manifest(repo)
    unstaged_diff = command(repo, 'diff', '--binary')
    staged_diff = command(repo, 'diff', '--cached', '--binary')
    release_base_ref = args.release_base_ref or default_release_base_ref(repo)
    release_base_commit = command(
        repo, 'rev-parse', '--verify', f'{release_base_ref}^{{commit}}'
    ).strip()
    baseline = {
        'captured_at': datetime.now(timezone.utc).isoformat(),
        'repo': str(repo),
        'head': command(repo, 'rev-parse', 'HEAD').strip(),
        'head_short': command(repo, 'rev-parse', '--short', 'HEAD').strip(),
        'branch': command(repo, 'branch', '--show-current').strip(),
        'upstream': upstream or None,
        'release_base_ref': release_base_ref,
        'release_base_commit': release_base_commit,
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
        'makefile_version': read_makefile_version(repo),
        'package_version': package.get('version'),
        'binary': {
            'path': str(binary),
            'exists': binary.is_file(),
            'size': binary.stat().st_size if binary.is_file() else None,
            'sha256': sha256(binary) if binary.is_file() else None,
        },
    }
    output.write_text(json.dumps(baseline, indent=2) + '\n')
    print(output)
    print(json.dumps(baseline, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
