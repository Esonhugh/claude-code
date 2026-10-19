#!/usr/bin/env python3
import ast
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen


sys.dont_write_bytecode = True


SCRIPTS_DIR = Path(__file__).resolve().parent
DRIVER_PATH = SCRIPTS_DIR / 'run-binary-gate.py'
BASELINE_PATH = SCRIPTS_DIR / 'capture-release-baseline.py'
LAUNCHER_PATH = (
    SCRIPTS_DIR.parent.parent
    / 'claude-agent-workflow-validation/scripts/launch-built-claude.sh'
)


def load_driver():
    spec = importlib.util.spec_from_file_location('run_binary_gate', DRIVER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_baseline():
    spec = importlib.util.spec_from_file_location(
        'capture_release_baseline', BASELINE_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_retained_builtin_archive_real_filesystem():
    completed = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / 'test-builtin-evidence-archive.py')],
        cwd=SCRIPTS_DIR, capture_output=True, text=True, timeout=30)
    assert completed.returncode == 0, completed.stdout + completed.stderr


def test_retained_g5_contract():
    driver = load_driver()
    root = '/private/tmp/owned/config/dev-mods/session-id'
    request = {'method': 'POST', 'path': '/v1/responses',
               'authorization': {'matches_dummy': True},
               'response_kind': 'retained-readiness',
               'body': {'input': [{'role': 'user', 'content': [
                   {'type': 'input_text', 'text': 'Session authoring was enabled for this session only. '
                    f'Create plugins as direct child directories of `{root}`'}]}]}}
    consent = {'type': 'dev-mods', 'sessionId': 'session-id', 'folder': root}
    observed = dict(requests=[request], roots=[root], entries=[consent], prompt_ready=True)
    assert driver.retained_g5_semantics('enable', **observed)
    for key, value in [('requests', []), ('roots', []), ('entries', []), ('prompt_ready', False)]:
        assert not driver.retained_g5_semantics('enable', **{**observed, key: value})
    wrong = json.loads(json.dumps(request))
    wrong['body']['input'][0]['role'] = 'assistant'
    assert not driver.retained_g5_semantics('enable', **{**observed, 'requests': [wrong]})
    wrong = json.loads(json.dumps(request))
    wrong['authorization']['matches_dummy'] = False
    assert not driver.retained_g5_semantics('enable', **{**observed, 'requests': [wrong]})
    declined = json.loads(json.dumps(request))
    declined['body']['input'][0]['content'][0]['text'] = 'This invocation did not enable a session authoring root; explain the supported plugin load/reload path instead of claiming hot reload.'
    assert driver.retained_g5_semantics('not-now', [declined], [], [], True)
    assert not driver.retained_g5_semantics('not-now', [declined], [root], [], True)
    assert driver.retained_g5_semantics('cancel', [], [], [], True)
    assert not driver.retained_g5_semantics('cancel', [request], [], [], True)
    policy = driver.retained_target_policy(['terminal-interaction', 'agent-fg-bg'])
    assert policy['overall_verdict'] == 'blocked'
    assert 'terminal-interaction' in policy['blocked_targets']
    assert 'agent-fg-bg' in policy['blocked_targets']
    source = DRIVER_PATH.read_text()
    assert "retained_g5(root, binary, repo, evidence, baseline_module," in source
    assert driver.retained_g5_consent('mod_hot_reload\n …folder truncated\n 1. How does this work?\n 2. Enable for this session\n 3. Not now')
    assert not driver.retained_g5_consent('❯ /plugin-authoring')


def test_retained_g5_stops_at_first_divergence():
    driver = load_driver()
    with tempfile.TemporaryDirectory(prefix='g5-stop-') as directory:
        root = Path(directory)
        evidence = root / 'evidence'
        evidence.mkdir()
        for failed_index in range(3):
            run_root = root / str(failed_index)
            run_root.mkdir()
            calls = []

            def run(_root, _binary, _repo, _evidence, _baseline, scenario):
                calls.append(scenario)
                return {'scenario_id': f'G5-{scenario}',
                        'status': 'failed' if len(calls) == failed_index + 1 else 'passed'}

            with patch.object(driver, 'retained_readiness', side_effect=run):
                result = driver.retained_g5(run_root, None, None, evidence, None)
            assert len(calls) == failed_index + 1, calls
            assert result['first_divergence'] == result['scenarios'][-1]
            assert result['validation_verdict'] == 'blocked'
            assert result['turn_end_plugin_load'] == 'not covered'
            assert result['resume'] == 'not covered'
            assert json.loads((evidence / 'g5-result.json').read_text()) == result


def test_retained_state_content_exclusion():
    import os
    baseline = load_baseline()
    calls = []
    def command(repo, *args, **kwargs):
        calls.append(args)
        return ''
    with patch.dict(os.environ, {'CC_VALIDATION_STATE_CONTENT_EXCLUDE': 'src/hooks/useVirtualScroll.test.tsx'}), \
         patch.object(baseline, 'command', side_effect=command), \
         patch.object(baseline, 'git_paths_manifest', return_value={}), \
         patch.object(baseline, 'binary_identity', return_value={}):
        state = baseline.retained_repository_state(Path('/repo'), Path('/tmp/run'), Path('/tmp/binary'))
    assert state['content_excluded_paths'] == ['src/hooks/useVirtualScroll.test.tsx']
    for args in calls:
        if args[0] == 'diff':
            assert ':(top,literal,exclude)src/hooks/useVirtualScroll.test.tsx' in args
    assert ('status', '--short', '--', '.') in calls


def test_retained_g5_turn_end_load_contract():
    driver = load_driver()
    with tempfile.TemporaryDirectory(prefix='g5-turn-') as directory:
        root = Path(directory)
        evidence = root / 'evidence'
        evidence.mkdir()
        with patch.object(driver, 'retained_readiness', return_value={'status': 'passed'}) as run:
            result = driver.retained_g5(root, None, None, evidence, None, 'turn-end-load')
        assert run.call_count == 1
        assert run.call_args.args[-1] == 'turn-end-load'
        assert result['turn_end_plugin_load'] == 'passed'
        assert result['validation_verdict'] == 'blocked'
        assert result['resume'] == 'not covered'
    active = 'Working… esc to interrupt'
    assert driver.retained_g5_turn_active(active, True, False, False)
    for pane, waiting, released, declarations in [
        ('❯ ', True, False, False), (active, False, False, False),
        (active, True, True, False), (active, True, False, True),
        (active + ' G5_TURN_END_ACTIVE', True, False, False),
    ]:
        assert not driver.retained_g5_turn_active(pane, waiting, released, declarations)
    with tempfile.TemporaryDirectory(prefix='g5-provider-') as directory:
        provider = driver.MockOpenAIServer(Path(directory), 'retained-turn-end-load')
        responses = []
        worker = threading.Thread(target=lambda: responses.append(provider.response_for({})))
        worker.start()
        try:
            assert provider.turn_waiting.wait(2)
            assert not responses
            provider.turn_release.set()
            worker.join(2)
            assert responses[0][0] == 'retained-readiness'
            assert 'RELEASE_RETAINED_RESPONSE' in responses[0][1]
        finally:
            provider.turn_release.set()
            worker.join(2)


def test_retained_g5_held_identity_and_async_persistence():
    driver = load_driver()
    with tempfile.TemporaryDirectory(prefix='g5-identity-') as directory:
        config = Path(directory) / 'config'
        session = 'd60f8a82-2d37-46f7-a7f3-38e83c2b1d1c'
        root = config / 'dev-mods' / session
        root.mkdir(parents=True)
        request = {'sequence': 2, 'method': 'POST', 'path': '/v1/responses',
                   'authorization': {'matches_dummy': True}, 'response_kind': None,
                   'headers': {key: session for key in
                               ('session-id', 'thread-id', 'x-claude-code-session-id')},
                   'body': {'input': [{'role': 'user', 'content': [{'type': 'input_text',
                       'text': 'Session authoring was enabled for this session only. '
                               f'Create plugins as direct child directories of `{root}`; '
                               'valid child plugins load after the current turn and are watched for later changes.'}]}]}}
        identity = driver.retained_g5_held_identity([request], [str(root)], config)
        assert identity == {'sessionId': session, 'folder': str(root), 'request_sequence': 2}
        assert not driver.retained_g5_identity_persisted(identity, [])
        entry = {'type': 'dev-mods', 'sessionId': session, 'folder': str(root)}
        assert driver.retained_g5_identity_persisted(identity, [entry])
        for field in ('sessionId', 'folder', 'type'):
            assert not driver.retained_g5_identity_persisted(identity, [{**entry, field: 'wrong'}])
        for field, value in [('authorization', {'matches_dummy': False}),
                             ('response_kind', 'retained-readiness'), ('path', '/other'),
                             ('headers', {**request['headers'], 'thread-id': 'other'}),
                             ('headers', {}), ('body', {'input': []})]:
            assert driver.retained_g5_held_identity([{**request, field: value}], [str(root)], config) is None
        assert driver.retained_g5_held_identity([request, request], [str(root)], config) is None
        assert driver.retained_g5_held_identity([request], [], config) is None
        assert driver.retained_g5_held_identity([request], [str(root)], config / 'other') is None
        wrong = json.loads(json.dumps(request))
        wrong['body']['input'][0]['role'] = 'assistant'
        assert driver.retained_g5_held_identity([wrong], [str(root)], config) is None
        root.rmdir()
        root.symlink_to(config, target_is_directory=True)
        assert driver.retained_g5_held_identity([request], [str(root)], config) is None


def test_retained_g5_same_session_resume_contract():
    driver = load_driver()
    with tempfile.TemporaryDirectory(prefix='g5-resume-') as directory:
        root = Path(directory)
        evidence = root / 'evidence'
        evidence.mkdir()
        with patch.object(driver, 'retained_readiness', return_value={'status': 'passed'}) as run:
            result = driver.retained_g5(root, None, None, evidence, None, 'same-session-resume')
        assert run.call_count == 1
        assert run.call_args.args[-1] == 'same-session-resume'
        assert result['resume'] == 'passed'
        assert result['turn_end_plugin_load'] == 'not covered'
        assert result['validation_verdict'] == 'blocked'
    identity = {'sessionId': 'original', 'folder': '/owned/dev-mods/original'}
    entry = {'type': 'dev-mods', **identity}
    request = {'method': 'POST', 'path': '/v1/responses',
               'authorization': {'matches_dummy': True}, 'response_kind': 'retained-readiness',
               'headers': {key: 'original' for key in
                           ('session-id', 'thread-id', 'x-claude-code-session-id')}}
    pane = 'G5_SAME_SESSION_ROOT_ACTIVE\nG5_SAME_SESSION_CHILD_ACTIVE\n❯ '
    assert driver.retained_g5_resumed(identity, [entry], [request], pane)
    for field in ('sessionId', 'folder', 'type'):
        assert not driver.retained_g5_resumed(identity, [{**entry, field: 'other'}], [request], pane)
    for key in request['headers']:
        wrong = {**request, 'headers': {**request['headers'], key: 'new-session'}}
        assert not driver.retained_g5_resumed(identity, [entry], [wrong], pane)
    assert not driver.retained_g5_resumed(identity, [entry], [], pane)
    assert not driver.retained_g5_resumed(identity, [entry], [request], '❯ ')
    assert not driver.retained_g5_resumed(identity, [entry], [{**request, 'authorization': {}}], pane)
    retained_launcher = LAUNCHER_PATH.read_text().split('\nfi', 1)[0]
    assert '"$@"' in retained_launcher


def test_retained_g5_fork_session_contract():
    driver = load_driver()
    with tempfile.TemporaryDirectory(prefix='g5-fork-', dir='/private/tmp') as directory:
        root = Path(directory)
        evidence = root / 'evidence'
        evidence.mkdir()
        with patch.object(driver, 'retained_readiness', return_value={'status': 'passed'}) as run:
            result = driver.retained_g5(root, None, None, evidence, None, 'fork-session')
        assert run.call_count == 1
        assert run.call_args.args[-1] == 'fork-session'
        assert result['fork_session'] == 'passed'
        assert result['validation_verdict'] == 'blocked'

        original_session = 'd60f8a82-2d37-46f7-a7f3-38e83c2b1d1c'
        fork_session = '4389974e-2f95-4b9d-b22f-90d37efefca9'
        original = {
            'sessionId': original_session,
            'folder': str(root / 'config/dev-mods' / original_session),
        }
        entry = {'type': 'dev-mods', **original}
        request = {
            'method': 'POST',
            'path': '/v1/responses',
            'authorization': {'matches_dummy': True},
            'response_kind': 'retained-readiness',
            'headers': {key: fork_session for key in
                        ('session-id', 'thread-id', 'x-claude-code-session-id')},
        }
        pane = 'G5_FORK_IDENTITY_PROBE\n❯ '
        roots = [original['folder']]
        assert driver.retained_g5_forked(original, [entry], roots, [request], pane)
        for key in request['headers']:
            wrong = {**request, 'headers': {**request['headers'], key: original_session}}
            assert not driver.retained_g5_forked(original, [entry], roots, [wrong], pane)
        assert not driver.retained_g5_forked(original, [], roots, [request], pane)
        assert not driver.retained_g5_forked(original, [entry], roots + [
            str(root / 'config/dev-mods' / fork_session)
        ], [request], pane)
        assert not driver.retained_g5_forked(original, [entry], roots, [request], '❯ ')
        for marker in (
            'G5_SAME_SESSION_ROOT_ACTIVE', 'G5_SAME_SESSION_CHILD_ACTIVE'
        ):
            assert not driver.retained_g5_forked(
                original, [entry], roots, [request], pane + marker
            )
        assert not driver.retained_g5_forked(
            original, [entry], roots, [{**request, 'authorization': {}}], pane
        )

    with tempfile.TemporaryDirectory(prefix='g5-default-', dir='/private/tmp') as directory:
        root = Path(directory)
        evidence = root / 'evidence'
        evidence.mkdir()
        calls = []
        def run(_root, _binary, _repo, _evidence, _baseline, scenario):
            calls.append(scenario)
            return {'status': 'passed'}
        with patch.object(driver, 'retained_readiness', side_effect=run):
            result = driver.retained_g5(root, None, None, evidence, None)
        assert calls == [
            'not-now', 'enable', 'cancel', 'turn-end-load',
            'same-session-resume', 'fork-session',
        ]
        assert result['resume'] == 'passed'
        assert result['fork_session'] == 'passed'
        assert result['physical_frames'] == 'not covered'
        assert result['validation_verdict'] == 'blocked'

    source = DRIVER_PATH.read_text()
    assert "choices=['turn-end-load', 'same-session-resume', 'fork-session']" in source


def test_retained_g5_fork_cancel_clears_restored_draft_before_exit():
    source = DRIVER_PATH.read_text()
    lines = source.splitlines()
    start = next(index for index, line in enumerate(lines, 1)
                 if "wait_pane('fork-consent-cancel', fork_cancelled)" in line)
    end = next(index for index, line in enumerate(lines, 1)
               if index > start and "normal_exit('resumed-exit')" in line)
    calls = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call) or not start <= node.lineno <= end:
            continue
        if not isinstance(node.func, ast.Name) or node.func.id not in ('send', 'wait_pane', 'normal_exit'):
            continue
        args = [arg.value if isinstance(arg, ast.Constant) else None for arg in node.args]
        calls.append((node.lineno, node.func.id, *args))
    inputs = [call[2:] for call in sorted(calls)]
    assert inputs == [
        ('fork-consent-cancel', None),
        ('C-u', '15'),
        ('fork-cancel-draft-cleared', None),
        ('resumed-exit',),
    ]

    def simulate_composer(initial):
        composer = initial
        for value, *raw_hex in inputs:
            if value == 'C-u' and raw_hex == ['15']:
                composer = ''
            elif value == 'resumed-exit':
                composer += '/exit'
        return composer

    assert '/plugin-authoring' + '/exit' == '/plugin-authoring/exit'
    assert simulate_composer('/plugin-authoring') == '/exit'
    assert simulate_composer('') == '/exit'


def test_retained_g5_marker_fixture_composes_handlers():
    source = DRIVER_PATH.read_text()
    fixture = source.split(
        "(plugin / 'hooks/marker.mjs').write_text(f'''", 1
    )[1].split("''')", 1)[0]
    marker_sources = [
        eval("f'''" + fixture + "'''", {}, {'marker': marker}).replace(
            'export function register', f'function register{index}'
        )
        for index, marker in enumerate(('ROOT', 'CHILD'))
    ]
    probe = f'''{marker_sources[0]}
{marker_sources[1]}
const handlers = [];
const on = (_event, _filter, handler) => handlers.push(handler);
register0(on);
register1(on);
const $ = {{ui: {{resolve: () => ({{
  Box: props => ({{type: "Box", ...props}}),
  Text: props => ({{type: "Text", ...props}}),
}})}}}};
const dispatch = index => index === handlers.length
  ? {{type: "Text", children: "BASE"}}
  : handlers[index]($, {{}}, () => dispatch(index + 1));
const text = JSON.stringify(await dispatch(0));
if (!text.includes("ROOT") || !text.includes("CHILD")) {{
  throw new Error(`composed markers missing: ${{text}}`);
}}
'''
    with tempfile.TemporaryDirectory(
        prefix='g5-marker-fixture-', dir='/private/tmp'
    ) as directory:
        root = Path(directory)
        isolated = {
            name: str(root / name.lower())
            for name in ('HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR')
        }
        for value in isolated.values():
            Path(value).mkdir()
        env = {**os.environ, **isolated}
        result = subprocess.run(
            ['nice', '-n', '10', 'bun', '-e', probe], cwd=root, env=env,
            text=True, capture_output=True,
        )
    assert result.returncode == 0, result.stdout + result.stderr


def test_retained_g5_clear_cancel_contract():
    driver = load_driver()
    restored = (
        '────────────────────────────────────────\n'
        '❯\u00a0/plugin-authoring\n'
        '────────────────────────────────────────\n'
        '  /plugin-authoring       Make a mod: a pane, band, status line, toast, or hook\n'
    )
    get_request = {'method': 'GET', 'path': '/v1/models'}
    root = '/private/tmp/owned/config/dev-mods/previous-session'
    entry = {'type': 'dev-mods', 'sessionId': 'previous-session', 'folder': root}
    before = {'requests': [get_request], 'roots': [], 'entries': []}
    assert driver.retained_g5_terminal_semantics(
        'cancel', restored, '/plugin-authoring', before, dict(before)
    )
    for pane in (
        restored.replace('/plugin-authoring', '/wrong-draft'),
        restored.replace('❯\u00a0/plugin-authoring', '❯ '),
        restored + 'mod_hot_reload\n1. How does this work?\n'
        '2. Enable for this session\n3. Not now\n',
        restored + 'esc to interrupt\n',
    ):
        assert not driver.retained_g5_terminal_semantics(
            'cancel', pane, '/plugin-authoring', before, dict(before)
        )
    post_request = {'method': 'POST', 'path': '/v1/responses'}
    for key, value in (
        ('requests', [get_request, post_request]),
        ('requests', [get_request, post_request, post_request]),
        ('roots', [root]),
        ('entries', [entry]),
    ):
        after = {**before, key: value}
        assert not driver.retained_g5_terminal_semantics(
            'cancel', restored, '/plugin-authoring', before, after
        )
    enabled_request = {
        'method': 'POST',
        'path': '/v1/responses',
        'authorization': {'matches_dummy': True},
        'response_kind': 'retained-readiness',
        'body': {'input': [{'role': 'user', 'content': [{
            'type': 'input_text',
            'text': 'Session authoring was enabled for this session only. '
                    f'Create plugins as direct child directories of `{root}`.',
        }]}]},
    }
    assert driver.retained_g5_terminal_semantics(
        'enable', 'RELEASE_RETAINED_RESPONSE\n❯ ', None, None,
        {'requests': [enabled_request], 'roots': [root], 'entries': [entry]},
    )
    assert not driver.retained_g5_terminal_semantics(
        'enable', 'RELEASE_RETAINED_RESPONSE\n❯ draft', None, None,
        {'requests': [enabled_request], 'roots': [root], 'entries': [entry]},
    )


def test_retained_external_tmp_binary():
    import hashlib
    import os

    baseline = load_baseline()
    parent = Path(tempfile.mkdtemp(prefix='external-binary-', dir=Path('/tmp').resolve())).resolve()
    repo = parent / 'repo'
    repo.mkdir()
    binary = parent / 'build/built-claude'
    binary.parent.mkdir()
    binary.write_bytes(b'qualified fixture')
    binary.chmod(0o700)
    root = parent / 'run'
    assert baseline.retained_paths(repo, root, binary) == (root, binary)
    identity = baseline.binary_identity(binary)
    assert identity['sha256'] == hashlib.sha256(b'qualified fixture').hexdigest()
    assert identity['size'] == 17 and identity['exists']
    link = parent / 'linked-binary'
    link.symlink_to(binary)
    home = parent / 'user-home'
    with patch.object(baseline.pwd, 'getpwall', return_value=[SimpleNamespace(pw_dir=str(home))]):
        for invalid in (link, parent / 'missing', parent / 'build',
                        root / 'binary', repo / 'built-claude',
                        home / 'binary', Path('/usr/bin/true')):
            try:
                baseline.retained_paths(repo, root, invalid)
            except ValueError:
                pass
            else:
                raise AssertionError(f'unsafe binary accepted: {invalid}')
    alias = Path('/tmp') / binary.relative_to(Path('/tmp').resolve())
    assert baseline.retained_paths(repo, root, alias) == (root, binary)
    print(f'external binary evidence: {parent}', flush=True)


def test_retained_external_tmp_root():
    import os
    import stat

    baseline = load_baseline()
    driver = load_driver()
    parent = Path(tempfile.mkdtemp(prefix='retained-path-test-', dir=Path('/tmp').resolve())).resolve()
    print(f'retained evidence: {parent}', flush=True)
    repo = parent / 'repo'
    repo.mkdir()
    env = {**os.environ, 'HOME': str(parent), 'GIT_CONFIG_GLOBAL': '/dev/null',
           'GIT_CONFIG_NOSYSTEM': '1'}
    subprocess.run(['git', 'init', '-q', str(repo)], env=env, check=True)
    (repo / 'Makefile').write_text('VERSION := test\n')
    (repo / 'package.json').write_text('{"version":"0.0.0-dev"}')
    binary = repo / 'build/built-claude'
    binary.parent.mkdir()
    binary.write_text('isolated binary')
    (repo / 'built-claude').write_text('protected binary')
    (repo / '.gitignore').write_text('ignored/\n')
    (repo / 'ignored').mkdir()
    (repo / 'ignored/old-auth.json').write_text('dummy authentication fixture')
    root = parent / 'run'
    alias = Path('/tmp') / root.relative_to(Path('/tmp').resolve())
    assert baseline.retained_paths(repo, alias, binary) == (root, binary)
    args = SimpleNamespace(repo=repo, run_root=alias, binary=binary,
                           output=alias / 'baseline.json', release_base_ref='HEAD')
    original_command = baseline.command
    def command(repo, *args, **kwargs):
        if args[:2] == ('rev-parse', '--verify'):
            return 'fixture-commit\n'
        if args[:2] == ('rev-parse', 'HEAD'):
            return 'fixture-commit\n'
        return original_command(repo, *args, **kwargs)
    with patch.object(baseline, 'command', side_effect=command):
        baseline.capture_retained_baseline(args)
        assert stat.S_IMODE(root.stat().st_mode) == 0o700
        before = baseline.retained_repository_state(repo, root, binary)
        assert before['ignored_files_excluded_roots'] == []
        assert 'ignored/old-auth.json' in before['ignored_files_manifest']
        (root / 'evidence').mkdir()
        (root / 'evidence/result').write_text('retained')
        assert baseline.retained_repository_state(repo, root, binary) == before
        try:
            baseline.capture_retained_baseline(args)
        except ValueError:
            pass
        else:
            raise AssertionError('existing root accepted')
    fake_home = parent / 'other-user-home'
    with patch.object(baseline.pwd, 'getpwall', return_value=[SimpleNamespace(pw_dir=str(fake_home))]):
        for invalid in (fake_home, fake_home / 'run'):
            try:
                baseline.retained_paths(repo, invalid, binary)
            except ValueError:
                pass
            else:
                raise AssertionError(f'user HOME accepted: {invalid}')
    link = parent / 'link'
    link.symlink_to(parent, target_is_directory=True)
    for invalid in (Path('/'), Path('/tmp'), Path.home(), Path.home() / 'unsafe-run',
                    repo, repo / '.git/run', link / 'run2'):
        try:
            baseline.retained_paths(repo, invalid, binary)
        except ValueError:
            pass
        else:
            raise AssertionError(f'unsafe root accepted: {invalid}')
    for invalid in (repo / 'built-claude', root / 'binary', parent / 'binary'):
        try:
            baseline.retained_paths(repo, parent / 'another-run', invalid)
        except ValueError:
            pass
        else:
            raise AssertionError(f'unsafe binary accepted: {invalid}')
    internal = repo / 'new-run'
    with patch.object(baseline, 'command', side_effect=command):
        assert baseline.retained_repository_state(repo, internal, binary)['ignored_files_excluded_roots'] == ['new-run']
    planned = driver.plan_targets(['builtin-mods'], {'terminal-interaction'}, retain_artifacts=True)
    assert set(driver.DEFAULT_TARGETS) | {'builtin-mods', 'terminal-interaction'} <= set(planned)


def test_retained_builtin_cache_no_delete():
    import hashlib
    import os
    import zipfile

    repo = SCRIPTS_DIR.parents[3]
    root = Path(tempfile.mkdtemp(prefix='.retained-cache-test-')).resolve()
    print(f'retained evidence: {root}', flush=True)
    home = root / 'home'
    home.mkdir()
    (root / 'tmp').mkdir()
    fixture = root / 'repo'
    fixture.mkdir()
    env = {**load_baseline().retained_environment(root),
           'BUN_RUNTIME_TRANSPILER_CACHE_PATH': '0',
           'PATH': os.environ.get('PATH', '/usr/bin:/bin')}
    subprocess.run(['git', 'init', '-q', str(fixture)], env=env, check=True)
    driver = load_driver()
    evidence = driver.seed_retained_builtin_cache(repo, root, env)
    target = Path(evidence['path'])
    archive = repo / 'assets/builtin-mods-2.1.277.zip'
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert target.is_relative_to(home)
    assert target.name == evidence['archive_digest'] == digest
    with zipfile.ZipFile(archive) as zipped:
        for entry in zipped.infolist():
            if not entry.is_dir():
                assert (target / entry.filename).read_bytes() == zipped.read(entry)
    assert (target / '.complete').read_text() == f"{digest}\n{evidence['tree_digest']}"

    # Run the product's unchanged algorithms, denying every cache-miss mutation.
    source = (repo / 'src/plugins/builtinMods.ts').read_text()
    product = source[source.index('const OFFICIAL_MODS'):source.index('function portableEntryName')]
    product += source[source.index('async function treeDigest'):source.index('export async function loadBuiltinModDefinitions')]
    product += source[source.index('export async function materializeBuiltinModsArchive'):]
    probe = '''import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
const forbidden = () => { throw new Error('cache miss or mutation attempted'); };
const mkdir = forbidden, writeFile = forbidden, rename = forbidden, rm = forbidden;
const unzipArchive = forbidden;
'''
    probe += product
    probe += '''
const [archive, target, expected] = process.argv.slice(-3);
await validateOfficialBuiltinModsProvenance(target);
const actual = await treeDigest(target);
if (actual !== expected) throw new Error(`treeDigest mismatch: ${actual}`);
const hit = await materializeBuiltinModsArchive(archive, target.slice(0, target.lastIndexOf('/')), {
  validate: validateOfficialBuiltinModsProvenance,
});
if (hit !== target) throw new Error('wrong cache target');
console.log(JSON.stringify({treeDigest: actual, cacheHit: true, provenance: true}));
'''
    # Resolve zod from this repository, not from a global installation.
    probe_path = root / 'product-cache-probe.ts'
    probe = probe.replace("from 'zod'", 'from ' + json.dumps(str(repo / 'node_modules/zod/index.js')))
    probe_path.write_text(probe)
    before = load_baseline().tree_manifest(home)
    result = subprocess.run(['bun', str(probe_path), str(archive), str(target),
                             evidence['tree_digest']], cwd=fixture, env=env,
                            capture_output=True, text=True, timeout=30)
    (root / 'product-probe.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout)['cacheHit'] is True
    assert load_baseline().tree_manifest(home) == before
    assert list(target.parent.iterdir()) == [target]
    (root / 'cache-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(result.stdout, end='')
    # A repeated seed must preserve, not overwrite or clean, existing artifacts.
    try:
        driver.seed_retained_builtin_cache(repo, root, env)
    except FileExistsError:
        pass
    else:
        raise AssertionError('existing cache accepted for writing')
    assert load_baseline().tree_manifest(home) == before


def test_retained_builtin_cache_restart_contract():
    import hashlib
    import zipfile

    driver = load_driver()
    digest = '7529d618a2048f43b92070be542bfa6171d78932cdd24aed73b3392a33c6f161'
    assert driver.OFFICIAL_BUILTIN_MODS_SHA256 == digest
    root = Path('/private/tmp/release-s7')
    target = root / f'home/Library/Caches/claude-cli-nodejs/builtin-mods/{digest}'
    cold = driver.retained_builtin_cache_sandbox_profile(root, 12345, target, cold=True)
    warm = driver.retained_builtin_cache_sandbox_profile(root, 12345, target, cold=False)
    socket_write = f'(allow file-write* (literal {json.dumps(str(root / "t"))}))'
    assert socket_write in cold
    assert socket_write in warm
    assert '[0-9a-f-]' * 36 in cold
    assert r'\-' not in cold
    assert str(target) in cold and 'tmp' in cold
    lock_write = f'(allow file-write* (literal {json.dumps(str(target) + ".lock")}))'
    lock_unlink = f'(allow file-write-unlink (literal {json.dumps(str(target) + ".lock")}))'
    assert lock_write in cold
    assert lock_unlink in cold
    assert lock_write not in warm and lock_unlink not in warm
    assert str(target.parent) in warm
    assert 'allow file-write*' in cold
    assert 'allow file-write*' not in warm.split('(deny file-write* (subpath ' + json.dumps(str(target.parent)) + '))', 1)[1]

    with tempfile.TemporaryDirectory(prefix='s7-cache-contract-', dir='/private/tmp') as directory:
        cache = Path(directory) / digest
        cache.mkdir()
        archive = SCRIPTS_DIR.parents[3] / 'assets/builtin-mods-2.1.277.zip'
        with zipfile.ZipFile(archive) as zipped:
            for entry in zipped.infolist():
                if entry.is_dir():
                    continue
                path = cache / entry.filename
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(zipped.read(entry))
        tree_digest = driver.retained_builtin_tree_digest(cache)
        # Produced independently by src/plugins/builtinMods.ts treeDigest over the
        # pinned archive contents; do not derive this from the checker or marker.
        assert tree_digest == 'd5d7d90a867220c46fa183bf963e75b3a0b3a266470594c4ae6b2bcb04a4233b'
        (cache / '.complete').write_text(f'{digest}\n{tree_digest}')
        snapshot = driver.retained_builtin_cache_snapshot(cache)
        assert snapshot['entries']['agents-md/hooks/register.ts']['sha256'] == hashlib.sha256(
            (cache / 'agents-md/hooks/register.ts').read_bytes()).hexdigest()
        assert all({'sha256', 'inode', 'mtime_ns'} <= set(value)
                   for value in snapshot['entries'].values() if value['type'] == 'file')
        checks = driver.validate_retained_builtin_cache(
            archive, cache, snapshot, snapshot,
        )
        assert all(checks.values()), checks
        assert 'hook_paths_observed' not in checks
        (cache / 'unexpected.tmp').write_text('bad')
        changed = driver.retained_builtin_cache_snapshot(cache)
        checks = driver.validate_retained_builtin_cache(
            archive, cache, snapshot, changed,
        )
        assert not checks['no_extra_entries']
        assert not checks['identity_unchanged']


def test_retained_builtin_launch_behavior_contract():
    driver = load_driver()
    prompt = 'S7_COLD_PROMPT'
    agents_marker = 'S7_COLD_AGENTS_MARKER'
    diff_marker = 'S7_COLD_DIFF_MARKER'
    requests = [{
        'sequence': 7,
        'method': 'POST',
        'path': '/v1/responses',
        'authorization': {'matches_dummy': True},
        'response_kind': 'retained-readiness',
        'body': {
            'instructions': f'project instructions: {agents_marker}',
            'input': [{'role': 'user', 'content': prompt}],
        },
    }]
    checks = driver.validate_retained_builtin_launch_behavior(
        requests=requests,
        request_offset=0,
        prompt=prompt,
        agents_marker=agents_marker,
        tracked_filename='00-s7-fixture.txt',
        diff_marker=diff_marker,
        response_pane=f'RELEASE_RETAINED_RESPONSE\n{prompt}\n❯',
        diff_list_pane='Diff · files  00-s7-fixture.txt',
        diff_detail_pane=f'Diff · detail 00-s7-fixture.txt\n+{diff_marker}',
        closed_pane='❯',
    )
    assert all(checks.values()), checks
    assert checks['provider_request_sequence'] == 7
    assert checks['provider_request_path'] == '/v1/responses'

    contaminated = [*requests, {
        **requests[0],
        'sequence': 8,
        'body': {'instructions': 'other launch',
                 'input': [{'role': 'user', 'content': prompt}]},
    }]
    checks = driver.validate_retained_builtin_launch_behavior(
        requests=contaminated,
        request_offset=0,
        prompt=prompt,
        agents_marker=agents_marker,
        tracked_filename='00-s7-fixture.txt',
        diff_marker=diff_marker,
        response_pane='RELEASE_RETAINED_RESPONSE\n❯',
        diff_list_pane='00-s7-fixture.txt',
        diff_detail_pane=diff_marker,
        closed_pane='❯',
    )
    assert not checks['one_corresponding_provider_request']


def test_retained_builtin_response_ready_contract():
    driver = load_driver()
    prompt = 'S7_FIRST_PROMPT'
    marker = 'S7_FIRST_AGENTS_MARKER'
    request = {
        'method': 'POST', 'path': '/v1/responses',
        'authorization': {'matches_dummy': True},
        'response_kind': 'retained-readiness',
        'body': {'instructions': f'Project instructions:\n{marker}\nAdditional context',
                 'input': [{'role': 'user', 'content': prompt}]},
    }
    pane = 'RELEASE_RETAINED_RESPONSE\n❯\n'
    assert driver.retained_builtin_response_ready(pane, request, prompt, marker)
    for changed in (
        {**request, 'method': 'GET'},
        {**request, 'path': '/v1/models'},
        {**request, 'response_kind': 'title'},
        {**request, 'authorization': {'matches_dummy': False}},
        {**request, 'body': {**request['body'], 'instructions': 'missing project marker'}},
    ):
        assert not driver.retained_builtin_response_ready(pane, changed, prompt, marker)
    assert not driver.retained_builtin_response_ready(pane, request, 'other prompt', marker)
    assert not driver.retained_builtin_response_ready('❯', request, prompt, marker)
    assert not driver.retained_builtin_response_ready(
        pane + 'esc to interrupt', request, prompt, marker,
    )


def test_retained_builtin_diff_phase_contract():
    driver = load_driver()
    filename = '00-s7-fixture.txt'
    marker = 'S7_FIRST_DIFF_MARKER'
    listing = f'Diff · files\n› {filename}\n+{marker}\nEnter view · Esc close'
    detail = f'Diff · detail\n{filename}\n+{marker}'
    assert driver.retained_builtin_diff_list_ready(listing, filename)
    assert not driver.retained_builtin_diff_detail_ready(listing, filename, marker)
    assert driver.retained_builtin_diff_detail_ready(detail, filename, marker)
    assert not driver.retained_builtin_diff_list_ready(detail, filename)
    for pane in [f'{filename}\n+{marker}', 'Diff · files\nother.txt', '❯ /diff']:
        assert not driver.retained_builtin_diff_list_ready(pane, filename)
    for pane in ['Diff · detail\nother.txt', f'Diff · detail\n{filename}\nNo textual diff',
                 f'Diff · detail\nother.txt\n+{marker}']:
        assert not driver.retained_builtin_diff_detail_ready(pane, filename, marker)


def test_retained_builtin_restart_launch_fixture():
    driver = load_driver()
    baseline = load_baseline()
    with tempfile.TemporaryDirectory(prefix='s7-launch-fixture-', dir='/private/tmp') as directory:
        root = Path(directory)
        evidence = root / 'evidence'
        evidence.mkdir()
        observed = {}
        real_run = subprocess.run

        def run(argv, **kwargs):
            if argv[0] != '/fixture/tmux':
                return real_run(argv, **kwargs)
            if 'new-session' in argv:
                width = int(argv[argv.index('-x') + 1])
                fixture = root / 'cwd'
                staged = real_run(['git', '-C', str(fixture), 'diff', '--cached'],
                                  capture_output=True, text=True, check=True).stdout
                unstaged = real_run(['git', '-C', str(fixture), 'diff'],
                                    capture_output=True, text=True, check=True).stdout
                observed.update(dialog_width=width < 110,
                                current_staged_body='S7_FIRST_DIFF_MARKER' in staged,
                                no_stale_staged_body=not unstaged)
                raise RuntimeError('fixture inspected before native launch')
            return subprocess.CompletedProcess(argv, 0, '', '')

        process = SimpleNamespace(poll=lambda: 0, wait=lambda **_kwargs: 0)
        provider = SimpleNamespace(start=lambda: 'http://127.0.0.1:12345',
                                   snapshot=lambda: [], stop=lambda: None)
        with patch.object(driver, 'subprocess', SimpleNamespace(
                 run=run, Popen=lambda *_args, **_kwargs: process,
                 TimeoutExpired=subprocess.TimeoutExpired)), \
             patch.object(driver.shutil, 'which', return_value='/fixture/tmux'), \
             patch.object(driver, 'MockOpenAIServer', return_value=provider), \
             patch.object(driver, 'seed_retained_ripgrep_cache', return_value={}):
            result = driver.retained_builtin_cache_restart(
                root, Path('/fixture/binary'), SCRIPTS_DIR.parents[3], evidence, baseline,
            )
        assert result['status'] == 'failed'
        assert 'fixture inspected before native launch' in result['error'], result
        assert observed and all(observed.values()), observed


def test_retained_builtin_cache_restart_integration():
    driver = load_driver()
    baseline = load_baseline()
    with tempfile.TemporaryDirectory(prefix='s7-integration-', dir='/private/tmp') as directory:
        root = Path(directory)
        evidence = root / 'evidence'
        evidence.mkdir()
        readiness = {'label': 'readiness-smoke', 'status': 'passed',
                     'validation_verdict': 'passed'}
        s7 = {'label': 'builtin-mods', 'status': 'passed', 'validation_verdict': 'passed'}
        args = SimpleNamespace(repo=Path('/repo'), run_root=root, binary=Path('/binary'),
                               baseline=root / 'baseline.json', evidence_root=evidence,
                               base_ref=None, g5_scenario=None)
        state = {'binary': {}, 'protected_root_binary': {}}
        with patch('importlib.util.spec_from_file_location', return_value=SimpleNamespace(
                 loader=SimpleNamespace(exec_module=lambda _module: None))), \
             patch('importlib.util.module_from_spec', return_value=baseline), \
             patch.object(baseline, 'retained_paths', return_value=(root, args.binary)), \
             patch.object(baseline, 'retained_repository_state', return_value=state), \
             patch.object(baseline, 'retained_environment', return_value={}), \
             patch.object(baseline, 'tree_manifest', return_value={}), \
             patch.object(driver, 'collect_required_target_inputs', return_value={'all_paths': []}), \
             patch.object(driver, 'required_targets_for_paths', return_value={'builtin-mods'}), \
             patch.object(driver, 'plan_targets', return_value=['builtin-mods']), \
             patch.object(driver, 'retained_readiness', return_value=readiness) as ready, \
             patch.object(driver, 'retained_builtin_cache_restart', return_value=s7) as restart:
            args.baseline.write_text(json.dumps({
                'run_root': str(root), 'retain_artifacts': True, 'repo': '/repo', **state,
            }))
            # retained_preflight requires a pristine root containing only baseline.json.
            evidence.rmdir()
            assert driver.retained_preflight(args, ['builtin-mods']) == 2
        assert ready.call_count == restart.call_count == 1
        assert driver.retained_target_policy(['builtin-mods'])['blocked_targets']['builtin-mods'] \
            != 'child driver does not support retention'
        manifest = json.loads((root / 'evidence/driver-final-manifest.json').read_text())
        assert [run['label'] for run in manifest['runs']] == ['readiness-smoke', 'builtin-mods']
        assert manifest['overall_verdict'] == 'blocked'
        assert manifest['blocked_targets']['builtin-mods'] == \
            'full builtin-mods acceptance contract not covered by retained S7'
        assert manifest['required_target_coverage']['passed'] is False


def test_retained_ripgrep_cache_no_delete():
    import hashlib
    import os
    import stat

    repo = SCRIPTS_DIR.parents[3]
    root = Path(tempfile.mkdtemp(prefix='.retained-ripgrep-test-')).resolve()
    print(f'retained evidence: {root}', flush=True)
    for name in ('home', 'tmp'):
        (root / name).mkdir()
    env = {**load_baseline().retained_environment(root),
           'BUN_RUNTIME_TRANSPILER_CACHE_PATH': '0',
           'PATH': os.environ.get('PATH', '/usr/bin:/bin')}
    driver = load_driver()
    source = repo / 'node_modules/@vscode/ripgrep-darwin-arm64/bin/rg'
    version = json.loads((repo / 'node_modules/@vscode/ripgrep/package.json').read_text())['version']
    expected = root / f'home/Library/Caches/claude-cli-nodejs/ripgrep/{version}-arm64-darwin/rg'
    data = source.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    forbidden = AssertionError('deletion attempted')
    with patch('os.unlink', side_effect=forbidden), patch('os.remove', side_effect=forbidden), patch('os.rmdir', side_effect=forbidden), patch('shutil.rmtree', side_effect=forbidden):
        evidence = driver.seed_retained_ripgrep_cache(repo, root, env)
        assert Path(evidence['path']) == expected
        assert evidence['source'] == str(source)
        assert evidence['version'] == version
        assert expected.read_bytes() == data
        assert hashlib.sha256(expected.read_bytes()).hexdigest() == evidence['sha256'] == digest
        assert stat.S_IMODE(expected.stat().st_mode) == 0o755
        before = load_baseline().tree_manifest(root / 'home')
        try:
            driver.seed_retained_ripgrep_cache(repo, root, env)
        except FileExistsError:
            pass
        else:
            raise AssertionError('existing cache accepted for writing')
        assert load_baseline().tree_manifest(root / 'home') == before

    # Embed the real packaging input with the packaging shim's own wiring.
    shim = (repo / 'scripts/shims/embedded-ripgrep.js').read_text()
    wiring = '\n'.join(line for line in shim.splitlines()
                       if 'embeddedRipgrepPath' in line or 'EMBEDDED_RIPGREP_VERSION' in line)
    wiring = wiring.replace('__CLAUDE_CODE_RIPGREP_BINARY__', json.dumps(str(source)))
    wiring = wiring.replace('__CLAUDE_CODE_RIPGREP_VERSION__', version)
    probe = wiring + '\n' + '''
import fs from 'node:fs';
const { getEmbeddedRipgrepPath } = await import(PRODUCT_PATH);
const mutations = [];
for (const name of ['mkdirSync', 'writeFileSync', 'chmodSync', 'renameSync', 'rmSync', 'unlinkSync', 'rmdirSync']) {
  fs[name] = () => { mutations.push(name); throw new Error(`mutation attempted: ${name}`); };
}
const hit = getEmbeddedRipgrepPath();
if (hit !== process.argv.at(-1)) throw new Error(`wrong cache target: ${hit}`);
if (mutations.length) throw new Error(`mutations: ${mutations}`);
console.log(JSON.stringify({cacheHit: true, path: hit, mutations}));
'''.replace('PRODUCT_PATH', json.dumps(str(repo / 'src/utils/embeddedRipgrep.ts')))
    probe_path = root / 'product-ripgrep-probe.ts'
    probe_path.write_text(probe)
    binary = root / 'product-ripgrep-probe'
    result = subprocess.run(['bun', 'build', '--compile', str(probe_path), '--outfile', str(binary)],
                            cwd=root, env=env, capture_output=True, text=True, timeout=120)
    (root / 'build.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, result.stdout + result.stderr
    profile = root / 'probe.sb'
    profile.write_text(driver.retained_sandbox_profile(root, 12345))
    result = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(profile), str(binary), str(expected)],
                            cwd=root, env=env, capture_output=True, text=True, timeout=30)
    (root / 'product-probe.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout) == {'cacheHit': True, 'path': str(expected), 'mutations': []}
    assert load_baseline().tree_manifest(root / 'home') == before
    assert list(expected.parent.iterdir()) == [expected]
    (root / 'cache-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(result.stdout, end='')


def test_retained_policy_pure():
    baseline = load_baseline()
    driver = load_driver()
    repo = Path('/repo')
    root = repo / 'new-run'
    binary = repo / 'new-build/output/built-claude'
    with patch.object(Path, 'resolve', lambda self: self), patch.object(Path, 'is_symlink', return_value=False):
        assert baseline.retained_paths(repo, root, binary) == (root, binary)
        for invalid in (repo, Path('/outside'), repo / '.git/run'):
            try:
                baseline.retained_paths(repo, invalid, binary)
            except ValueError:
                pass
            else:
                raise AssertionError(f'accepted unsafe root: {invalid}')
    with patch.object(baseline, 'command', return_value='new-run/evidence\0unknown.pyc\0dist/new\0'), patch.object(Path, 'is_symlink', return_value=False), patch.object(Path, 'is_file', return_value=True), patch.object(baseline, 'sha256', return_value='hash'):
        manifest = baseline.git_paths_manifest(repo, '--others', excluded_roots=('new-run',), strict=True)
        assert set(manifest) == {'unknown.pyc', 'dist/new'}
    planned = driver.plan_targets(['builtin-mods'], {'terminal-interaction'}, retain_artifacts=True)
    assert set(driver.DEFAULT_TARGETS) <= set(planned)
    assert {'builtin-mods', 'terminal-interaction'} <= set(planned)
    policy = driver.retained_target_policy(planned)
    assert policy['overall_verdict'] == 'blocked'
    assert policy['readiness_smoke']['status'] == 'blocked'
    assert set(policy['blocked_targets']) == {'readiness-smoke', *planned}
    assert not policy['runs'] and not policy['matrix_complete']
    assert 'commit' in policy['blocked_targets']['terminal-interaction']
    assert 'S7 cold-cache restart' in policy['blocked_targets']['builtin-mods']
    env = baseline.retained_environment(root)
    assert env['TMPDIR'] == env['CLAUDE_CODE_TMPDIR'] == str(root / 'tmp')
    assert env['HOME'] == str(root / 'home')
    assert env['GIT_CONFIG_GLOBAL'] == '/dev/null'


def test_retained_owned_atomic_config():
    import os
    driver = load_driver()
    root = Path(tempfile.mkdtemp(prefix='owned-atomic-')).resolve()
    (root / 'config').mkdir()
    target = root / 'config/.claude.json'
    target.write_text('before')
    protected = root / 'keep-evidence'
    protected.write_text('keep')
    profile = root / 'profile.sb'
    profile.write_text(driver.retained_sandbox_profile(root, 12345))
    script = '''from pathlib import Path
import sys
r=Path(sys.argv[1]); c=r/'config/.claude.json'
t=c.with_name(c.name+'.tmp.123.456'); t.write_text('after'); t.replace(c)
l=c.with_name(c.name+'.lock'); l.mkdir(); l.rmdir()
try: (r/'keep-evidence').unlink()
except PermissionError: pass
else: raise AssertionError('unrelated evidence deletion allowed')
'''
    result = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(profile),
                             sys.executable, '-c', script, str(root)],
                            env=dict(os.environ), capture_output=True, text=True, timeout=10)
    print(result.stderr, end='')
    assert result.returncode == 0
    assert target.read_text() == 'after' and protected.read_text() == 'keep'


def test_retained_readiness_contract_pure():
    driver = load_driver()
    root = Path('/repo/.r-test')
    profile = driver.retained_sandbox_profile(root, 12345)
    assert '(deny file-write-unlink)' in profile
    assert '(deny network*)' in profile
    assert '(remote ip "localhost:12345")' in profile
    assert '/usr/bin/security' in profile
    assert 'keychain' in profile.lower()
    assert '(subpath "/repo/.r-test")' in profile
    request = {'method': 'POST', 'path': '/v1/responses',
               'authorization': {'matches_dummy': True},
               'body': {'input': [{'role': 'user', 'content': 'RELEASE_RETAINED_INPUT'}]},
               'response_kind': 'retained-readiness'}
    assert driver.retained_readiness_request([request])
    assert not driver.retained_readiness_request([])
    request['authorization']['matches_dummy'] = False
    assert not driver.retained_readiness_request([request])


def test_retained_submitted_contract_pure():
    import inspect
    driver = load_driver()
    request = {'method': 'POST', 'path': '/v1/responses',
               'authorization': {'matches_dummy': True},
               'body': {'input': [{'role': 'user', 'content': [
                   {'type': 'input_text', 'text': 'RELEASE_RETAINED_INPUT'}]}]},
               'response_kind': 'retained-readiness'}
    completed = ('❯ RELEASE_RETAINED_INPUT\n\n⏺ RELEASE_RETAINED_RESPONSE\n'
                 '────────────────\n❯\u00a0\n────────────────\n')
    # Exercise the exact predicate wired into the real retained wait_pane.
    source = inspect.getsource(driver.retained_readiness)
    predicate_source = source.split("wait_pane('submitted', ", 1)[1].split("\n            wait_pane('response'", 1)[0]
    predicate = eval('(' + predicate_source.rstrip().removesuffix(')') + ')', {
        **vars(driver), 'raw': b'RELEASE_RETAINED_INPUT',
        'provider': SimpleNamespace(snapshot=lambda: requests)})
    requests = [request]
    assert predicate(completed), 'completed transcript plus matching request must count as submitted'
    draft = '────────────────\n❯ RELEASE_RETAINED_INPUT\n────────────────\n'
    assert not predicate(draft), 'draft is not a submitted transcript'
    assert not predicate('⏺ RELEASE_RETAINED_RESPONSE\n────────────────\n❯\n────────────────\n')
    requests = []
    assert not predicate(completed)
    for key, value in [('method', 'GET'), ('path', '/v1/chat/completions'),
                       ('response_kind', 'title'),
                       ('authorization', {'matches_dummy': False}),
                       ('body', {}), ('body', {'input': []}),
                       ('body', {'input': [{'role': 'assistant', 'content': 'RELEASE_RETAINED_INPUT'}]}),
                       ('body', {'input': [{'role': 'user', 'content': 'NOT_RELEASE_RETAINED_INPUT'}]})]:
        requests = [{**request, key: value}]
        assert not predicate(completed), (key, value)


def test_retained_cli_pure():
    driver = load_driver()
    baseline = load_baseline()
    args = ['--repo', '/repo', '--binary', '/repo/build/built-claude',
            '--run-root', '/repo/run', '--retain-artifacts']
    with patch.object(sys, 'argv', ['driver', *args, '--baseline', '/repo/run/baseline.json', '--evidence-root', '/repo/run/evidence']), patch.object(driver, 'retained_preflight', return_value=2) as preflight, patch.object(driver, 'BinaryGate', side_effect=AssertionError('legacy gate constructed')):
        assert driver.main() == 2
        assert preflight.call_count == 1
        assert preflight.call_args.args[0].binary == Path('/repo/build/built-claude')
    with patch.object(sys, 'argv', ['baseline', *args, '--output', '/repo/run/baseline.json']), patch.object(baseline, 'capture_retained_baseline', return_value=0) as capture:
        assert baseline.main() == 0
        assert capture.call_count == 1
    with patch.object(Path, 'is_file', return_value=True), patch.object(Path, 'stat', return_value=SimpleNamespace(st_size=42, st_mtime_ns=123)), patch.object(baseline, 'sha256', return_value='fresh-hash'):
        identity = baseline.binary_identity(Path('/repo/build/built-claude'))
        assert identity == {'path': '/repo/build/built-claude', 'exists': True, 'size': 42, 'mtime_ns': 123, 'sha256': 'fresh-hash'}
    launcher = LAUNCHER_PATH.read_text()
    assert launcher.index('exit 2') < launcher.index('\ncd ')
    policy = driver.retained_target_policy(['builtin-mods'])
    assert policy['planned_targets'] == ['readiness-smoke', 'builtin-mods']
    assert driver.validate_required_target_results({'terminal-interaction'}, [])['passed'] is False


def test_retained_launcher_frame_directory_and_permissions():
    import os
    root = Path(tempfile.mkdtemp(prefix='mods-launcher-', dir=Path('/tmp').resolve())).resolve()
    for name in ('home', 'config', 'cwd', 'evidence', 'plugin'):
        (root / name).mkdir()
    fake = root / 'fake-binary'
    fake.write_text('#!/usr/bin/python3\nimport json,os,sys\nprint(json.dumps({"argv":sys.argv[1:],"frame":os.environ.get("CLAUDE_CODE_FRAME_EVIDENCE_PATH"),"dirs":os.environ.get("CLAUDE_CODE_PLUGIN_DIRS")}))\n')
    fake.chmod(0o700)
    env = {**os.environ, 'CC_VALIDATION_RETAIN_ARTIFACTS':'1', 'CC_VALIDATION_RUN_ROOT':str(root),
           'CC_VALIDATION_REPO_ROOT':str(LAUNCHER_PATH.parents[4]), 'CC_VALIDATION_BINARY':str(fake),
           'CC_VALIDATION_HOME':str(root/'home'), 'CC_VALIDATION_CONFIG_DIR':str(root/'config'),
           'CC_VALIDATION_CWD':str(root/'cwd'), 'CC_VALIDATION_EVIDENCE_DIR':str(root/'evidence'),
           'CC_VALIDATION_OPENAI_BASE_URL':'http://127.0.0.1:12345',
           'CC_VALIDATION_FRAME_EVIDENCE_PATH':str(root/'evidence/frames.jsonl'),
           'CC_VALIDATION_PLUGIN_DIRS':str(root/'plugin')}
    for skip in ('0', '1'):
        completed = subprocess.run(['/bin/sh',str(LAUNCHER_PATH),'--print','marker'],env={**env,'CC_VALIDATION_SKIP_PERMISSIONS':skip},capture_output=True,text=True,check=True)
        value = json.loads(completed.stdout)
        assert value['frame'] == str(root/'evidence/frames.jsonl')
        assert value['dirs'] == str(root/'plugin')
        assert ('--dangerously-skip-permissions' in value['argv']) == (skip == '0')
        assert value['argv'][-2:] == ['--print','marker']
    for key, path in [('CC_VALIDATION_FRAME_EVIDENCE_PATH','/tmp/outside.jsonl'), ('CC_VALIDATION_PLUGIN_DIRS',str(root/'../outside'))]:
        completed = subprocess.run(['/bin/sh',str(LAUNCHER_PATH)],env={**env,key:path},capture_output=True,text=True)
        assert completed.returncode == 2


def test_retained_default_entrypoint_contract():
    from contextlib import redirect_stdout
    from io import StringIO

    retained = {name for name, test in globals().items()
                if name.startswith('test_retained_') and callable(test)}
    calls = []
    replacements = {
        name: (lambda name=name: calls.append(name)) for name in retained
    }
    replacements.update({name: (lambda *args: None)
                         for name in globals() if name.startswith('assert_')})
    replacements.update(load_driver=lambda: None, load_baseline=lambda: None)
    with patch.dict(globals(), replacements), redirect_stdout(StringIO()):
        main()
    assert set(calls) == retained and len(calls) == len(retained), \
        f'default entrypoint skipped retained tests: {sorted(retained - set(calls))}'

    failure = RuntimeError('retained regression failed')
    def fail():
        raise failure
    replacements[sorted(retained)[0]] = fail
    with patch.dict(globals(), replacements), redirect_stdout(StringIO()):
        try:
            main()
        except RuntimeError as error:
            assert error is failure
        else:
            raise AssertionError('default entrypoint ignored a retained test failure')


def make_gate(module, repo, evidence, baseline_manifest, baseline_exists):
    gate = object.__new__(module.BinaryGate)
    gate.repo = repo
    gate.evidence_root = evidence
    gate.workflow_runs = repo / '.claude' / 'workflow-runs'
    gate.workflow_task_ids = set()
    gate.workflow_run_ids = set()
    gate.workflow_runs_initial_manifest = baseline_manifest
    gate.baseline = {}
    return gate


def write_transcript(path, entries):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(json.dumps(entry) + '\n' for entry in entries))


def deep_research_entries(phase, index, *, error=None, tool_id=None,
                          fetch_url=None, selected_url=None,
                          source_quality=None, claims=None):
    tool = 'WebSearch' if phase == 'search' else 'WebFetch'
    tool_id = tool_id or f'{phase}-{index}-tool'
    entries = []
    tool_input = {}
    if phase == 'fetch':
        fetch_url = fetch_url or f'https://example.test/source-{index}'
        selected_url = selected_url or fetch_url
        entries.append({
            'type': 'user',
            'message': {
                'role': 'user',
                'content': (
                    f'Fetch exactly one source: source {index} in that '
                    f'one-based order. Upstream source: {selected_url}'
                ),
            },
        })
        tool_input = {'url': fetch_url, 'prompt': 'extract claims'}
    entries.extend([{
        'type': 'assistant',
        'message': {
            'role': 'assistant',
            'content': [{
                'type': 'tool_use',
                'id': tool_id,
                'name': tool,
                'input': tool_input,
            }],
        },
    }, {
        'type': 'user',
        'message': {
            'role': 'user',
            'content': [{
                'type': 'tool_result',
                'tool_use_id': tool_id,
                **({'is_error': True, 'content': error}
                   if error is not None else {'content': 'ok'}),
            }],
        },
    }])
    if phase == 'fetch':
        entries.append({
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{
                    'type': 'text',
                    'text': json.dumps({
                        'selectedSource': {
                            'oneBasedRank': index,
                            'url': selected_url,
                        },
                        'sourceQuality': source_quality or (
                            'unreliable' if error is not None else 'primary'
                        ),
                        'claims': [] if claims is None else claims,
                    }),
                }],
            },
        })
    return entries


def deep_research_select_sources_entries(count=15):
    output = {
        'sources': [
            {
                'oneBasedRank': index,
                'url': f'https://example.test/source-{index}',
                'title': f'Source {index}',
                'originatingSearchWorker': 1,
            }
            for index in range(1, count + 1)
        ],
    }
    if count < 15:
        output['shortfall'] = {'missingCount': 15 - count}
    return [{
        'type': 'assistant',
        'message': {
            'role': 'assistant',
            'content': [{
                'type': 'text',
                'text': json.dumps(output),
            }],
        },
    }]


def deep_research_shortfall_entries(index):
    return [{
        'type': 'user',
        'message': {
            'role': 'user',
            'content': (
                f'Select only source {index}. The upstream source list has no '
                'source at that rank.'
            ),
        },
    }, {
        'type': 'assistant',
        'message': {
            'role': 'assistant',
            'content': [{
                'type': 'text',
                'text': json.dumps({
                    'selectedSource': {
                        'oneBasedRank': index,
                        'url': None,
                    },
                    'sourceQuality': 'unreliable',
                    'claims': [],
                    'missingReason': 'source list shortfall',
                }),
            }],
        },
    }]


def write_select_sources_worker(subagents, entries=None, description=None):
    stem = 'agent-select-sources'
    (subagents / f'{stem}.meta.json').parent.mkdir(parents=True, exist_ok=True)
    (subagents / f'{stem}.meta.json').write_text(json.dumps({
        'agentId': stem,
        'description': description or 'deep-research: select-sources',
    }))
    write_transcript(
        subagents / f'{stem}.jsonl',
        deep_research_select_sources_entries() if entries is None else entries,
    )



def make_required_assertion(source_dir, *, assertion_id='assertion-1',
                            validation_verdict='passed', runtime_state='done',
                            evidence_name='pane.txt', include_source_run=True,
                            include_assertion_id=True,
                            include_runtime_state=True,
                            evidence_absolute=True, create_evidence=True):
    evidence_path = source_dir / evidence_name
    if create_evidence:
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_path.write_text('evidence\n')
    assertion = {
        'validation_verdict': validation_verdict,
        'required_evidence': [str(evidence_path if evidence_absolute else Path(evidence_name))],
        'observed_evidence_paths': [
            str(evidence_path if evidence_absolute else Path(evidence_name))
        ],
    }
    if include_assertion_id:
        assertion['assertion_id'] = assertion_id
    if include_source_run:
        assertion['source_run'] = source_dir.name
    if include_runtime_state:
        assertion['runtime_state'] = runtime_state
    return assertion



def assert_driver_behavior(module, baseline_module):
    with tempfile.TemporaryDirectory(prefix='release-driver-single-submit-') as directory:
        gate = object.__new__(module.BinaryGate)
        gate.pid = 1
        gate.session_index = 1
        commands = []
        gate.tmux = lambda *args, **kwargs: commands.append(args)
        captures = iter((
            '❯ /tasks\n────────────────────────\nDebug mode\n',
            'Background tasks',
        ))
        gate.capture = lambda *args: next(captures)
        with patch.object(module.time, 'sleep'):
            gate.send('pane', Path(directory), '/tasks', 'input.txt')
        assert (Path(directory) / 'input.txt').read_bytes() == b'\x1b[200~/tasks\x1b[201~'
        assert sum(command[0] == 'send-keys' and command[-1] == 'Enter'
                   for command in commands) == 1

    with tempfile.TemporaryDirectory(prefix='release-driver-test-') as root_string:
        root = Path(root_string)
        repo = root / 'repo'
        evidence = root / 'evidence'
        runs = repo / '.claude' / 'workflow-runs'
        runs.mkdir(parents=True)
        evidence.mkdir()
        (runs / 'existing.json').write_text('existing\n')
        baseline = module.tree_manifest(runs)
        gate = make_gate(module, repo, evidence, baseline, True)
        gate.workflow_task_ids.add('task_owned')
        gate.workflow_run_ids.add('wf_owned')
        (runs / 'task_owned.json').write_text('task\n')
        owned = runs / 'wf_owned'
        owned.mkdir()
        (owned / 'session.json').write_text('session\n')

        result = module.BinaryGate.archive_and_remove_workflow_runs(gate)
        assert result['passed'] is True
        assert (runs / 'existing.json').read_text() == 'existing\n'
        assert not (runs / 'task_owned.json').exists()
        assert not owned.exists()
        assert (evidence / 'workflow-runs-artifacts/task_owned.json').is_file()
        assert (evidence / 'workflow-runs-artifacts/wf_owned/session.json').is_file()

        (runs / 'external.json').write_text('external\n')
        result = module.BinaryGate.archive_and_remove_workflow_runs(gate)
        assert result['passed'] is True
        assert result['external_paths_ignored'] == ['external.json']
        assert (runs / 'external.json').is_file()

    with tempfile.TemporaryDirectory(prefix='release-driver-test-') as root_string:
        root = Path(root_string)
        repo = root / 'repo'
        evidence = root / 'evidence'
        runs = repo / '.claude' / 'workflow-runs'
        runs.mkdir(parents=True)
        evidence.mkdir()
        (runs / 'existing.json').write_text('existing\n')
        baseline = module.tree_manifest(runs)
        gate = make_gate(module, repo, evidence, baseline, True)
        gate.workflow_task_ids.add('existing')
        (runs / 'existing.json').write_text('changed\n')

        result = module.BinaryGate.archive_and_remove_workflow_runs(gate)
        assert result['passed'] is True
        assert result['state_before_cleanup']['modified_paths'] == ['existing.json']
        assert result['owned_added_paths'] == []
        assert (runs / 'existing.json').read_text() == 'changed\n'

    with tempfile.TemporaryDirectory(prefix='release-driver-test-') as root_string:
        root = Path(root_string)
        repo = root / 'repo'
        repo.mkdir()
        subprocess.run(['git', '-C', str(repo), 'init'], check=True, capture_output=True)
        untracked = repo / 'untracked.txt'
        untracked.write_text('before\n')
        before = module.untracked_manifest(repo)
        untracked.write_text('after\n')
        after = module.untracked_manifest(repo)
        assert before.keys() == after.keys()
        assert module.tree_sha256(before) != module.tree_sha256(after)

        workflow_runs = repo / '.claude' / 'workflow-runs'
        workflow_runs.mkdir(parents=True)
        workflow_artifact = workflow_runs / 'run.json'
        workflow_artifact.write_text('before\n')
        assert not any(
            path == module.WORKFLOW_RUNS_ROOT
            or path.startswith(f'{module.WORKFLOW_RUNS_ROOT}/')
            for path in module.untracked_manifest(repo)
        )
        before = module.tree_manifest(workflow_runs)
        workflow_artifact.write_text('after\n')
        after = module.tree_manifest(workflow_runs)
        assert module.tree_sha256(before) != module.tree_sha256(after)

        (repo / '.gitignore').write_text(
            'ignored.txt\n.*.bun-build\n__pycache__/\n*.py[cod]\n'
        )
        ignored = repo / 'ignored.txt'
        ignored.write_text('before\n')
        before = module.ignored_manifest(repo)
        ignored.write_text('after\n')
        after = module.ignored_manifest(repo)
        assert before.keys() == after.keys()
        assert module.tree_sha256(before) != module.tree_sha256(after)

        bun_build_temporary = repo / '.0123456789abcdef-00000000.bun-build'
        bun_build_temporary.write_text('temporary\n')
        assert str(bun_build_temporary.relative_to(repo)) not in module.ignored_manifest(repo)
        assert str(bun_build_temporary.relative_to(repo)) not in baseline_module.ignored_manifest(repo)
        regular_bun_build = repo / '.not-a-temporary.bun-build'
        regular_bun_build.write_text('not a Bun temporary filename\n')
        assert str(regular_bun_build.relative_to(repo)) in module.ignored_manifest(repo)
        assert str(regular_bun_build.relative_to(repo)) in baseline_module.ignored_manifest(repo)

        pycache = repo / 'src/__pycache__'
        pycache.mkdir(parents=True)
        bytecode = pycache / 'module.cpython-314.pyc'
        bytecode.write_bytes(b'ephemeral bytecode')
        assert str(bytecode.relative_to(repo)) not in module.ignored_manifest(repo)
        assert (
            str(bytecode.relative_to(repo))
            not in baseline_module.ignored_manifest(repo)
        )

        ignored_dir = repo / 'ignored-dir'
        ignored_dir.mkdir()
        nested_ignored = ignored_dir / 'nested.txt'
        nested_ignored.write_text('before\n')
        original_command = module.command
        module.command = lambda *_args, **_kwargs: subprocess.CompletedProcess(
            args=[], returncode=0, stdout='ignored-dir/\0', stderr=''
        )
        try:
            before = module.ignored_manifest(repo)
            nested_ignored.write_text('after\n')
            after = module.ignored_manifest(repo)
        finally:
            module.command = original_command
        assert before['ignored-dir'] == {'type': 'dir'}
        assert before['ignored-dir/nested.txt']['type'] == 'file'
        assert module.tree_sha256(before) != module.tree_sha256(after)

    with tempfile.TemporaryDirectory(prefix='release-driver-test-') as root_string:
        run_dir = Path(root_string)
        project = run_dir / 'config/projects/project'
        main_transcript = project / 'session.jsonl'
        child_transcript = project / 'subagents/agent-child.jsonl'
        gate = object.__new__(module.BinaryGate)
        write_transcript(main_transcript, [{
            'type': 'user',
            'message': {
                'role': 'user',
                'content': 'RELEASE_NESTED_PARENT_DONE RELEASE_NESTED_CHILD_DONE',
            },
        }, {
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{
                    'type': 'tool_use',
                    'name': 'Agent',
                    'input': {'prompt': 'RELEASE_NESTED_CHILD_DONE'},
                }],
            },
        }])
        write_transcript(child_transcript, [{
            'type': 'user',
            'message': {'role': 'user', 'content': 'RELEASE_NESTED_CHILD_DONE'},
        }])
        assert module.BinaryGate.assistant_text(gate, run_dir) == ''
        assert module.BinaryGate.assistant_text(gate, run_dir, subagents=True) == ''

        write_transcript(main_transcript, [{
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{'type': 'text', 'text': 'RELEASE_NESTED_PARENT_DONE'}],
            },
        }])
        write_transcript(child_transcript, [{
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{'type': 'text', 'text': 'RELEASE_NESTED_CHILD_DONE'}],
            },
        }])
        assert module.BinaryGate.assistant_text(gate, run_dir) == 'RELEASE_NESTED_PARENT_DONE'
        assert module.BinaryGate.assistant_text(
            gate, run_dir, subagents=True
        ) == 'RELEASE_NESTED_CHILD_DONE'

        workflow_run_dir = run_dir / 'workflow-proof'
        workflow_run_dir.mkdir()
        gate.workflow_status = lambda _run_dir, _task_id: 'running'
        assert module.BinaryGate.workflow_completion_proof(
            gate, workflow_run_dir, 'task-1', 'wf_1'
        )['complete'] is False
        (workflow_run_dir / 'debug.log').write_text(
            '[workflow_worker_start] task=task-1 run=wf_1 phase=p logical=worker agent=a attempt=0\n'
            '[workflow_worker_terminal] task=task-1 run=wf_1 phase=p logical=worker agent=a attempt=0 status=completed\n'
            '[workflow_phase_terminal] task=task-1 run=wf_1 phase=p logical=- agent=- attempt=0 status=completed\n'
        )
        gate.workflow_status = lambda _run_dir, _task_id: 'completed'
        assert module.BinaryGate.workflow_completion_proof(
            gate, workflow_run_dir, 'task-1', 'wf_1'
        )['complete'] is False
        workflow_session = workflow_run_dir / 'config/projects/project/session.jsonl'
        workflow_session.parent.mkdir(parents=True)
        workflow_session.write_text(
            json.dumps({
                'type': 'user',
                'origin': {'kind': 'task-notification'},
                'message': {'role': 'user', 'content': 'done'},
            }) + '\n'
        )
        assert module.BinaryGate.workflow_completion_proof(
            gate, workflow_run_dir, 'task-1', 'wf_1'
        )['complete'] is True

        retention_terminal = 'RELEASE_RETENTION_WORKER_DONE'
        user_prompt_path = project / 'retention-user-prompt.jsonl'
        viewed_pane_path = run_dir / 'retention-viewed-pane.txt'
        worker_assistant_path = project / 'subagents/retention-worker.jsonl'
        write_transcript(user_prompt_path, [{
            'type': 'user',
            'message': {'role': 'user', 'content': retention_terminal},
        }])
        viewed_pane_path.write_text(retention_terminal)
        assert retention_terminal not in module.BinaryGate.assistant_text(
            gate, run_dir, subagents=True
        )
        write_transcript(worker_assistant_path, [{
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{'type': 'text', 'text': retention_terminal}],
            },
        }])
        assert retention_terminal in module.BinaryGate.assistant_text(
            gate, run_dir, subagents=True
        )

        task_notification = {
            'type': 'user',
            'origin': {'kind': 'task-notification'},
            'message': {
                'role': 'user',
                'content': '<task-notification><status>completed</status></task-notification>',
            },
        }
        write_transcript(main_transcript, [])
        timer = threading.Timer(
            0.05,
            lambda: write_transcript(main_transcript, [task_notification]),
        )
        timer.start()
        try:
            assert module.BinaryGate.wait_for_notification_count(
                gate, run_dir, 1, timeout=1, interval=0.01
            ) is True
        finally:
            timer.join()
        assert module.BinaryGate.notification_count(gate, run_dir) == 1

    with tempfile.TemporaryDirectory(prefix='release-driver-test-') as root_string:
        run_dir = Path(root_string)
        subagents = run_dir / 'config/projects/project/subagents'
        gate = object.__new__(module.BinaryGate)
        for phase, count, tool in (
            ('search', 5, 'WebSearch'),
            ('fetch', 15, 'WebFetch'),
        ):
            for index in range(1, count + 1):
                stem = f'agent-{phase}-{index}'
                (subagents / f'{stem}.meta.json').parent.mkdir(
                    parents=True, exist_ok=True
                )
                (subagents / f'{stem}.meta.json').write_text(json.dumps({
                    'agentId': stem,
                    'description': f'deep-research: {phase} {index}/{count}',
                }))
                write_transcript(
                    subagents / f'{stem}.jsonl',
                    deep_research_entries(phase, index),
                )
        write_select_sources_worker(subagents)
        for phase, count in (('verify', 3), ('synthesize', 1)):
            for index in range(1, count + 1):
                stem = f'agent-{phase}-{index}'
                description = (
                    f'deep-research: verify {index}/3'
                    if phase == 'verify'
                    else 'deep-research: synthesize'
                )
                (subagents / f'{stem}.meta.json').write_text(json.dumps({
                    'agentId': stem,
                    'description': description,
                }))
                write_transcript(subagents / f'{stem}.jsonl', [{
                    'type': 'assistant',
                    'message': {
                        'role': 'assistant',
                        'content': [{'type': 'text', 'text': '{}'}],
                    },
                }])
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['search']['complete'] is True
        assert evidence['select-sources']['complete'] is True
        assert evidence['fetch']['complete'] is True
        assert evidence['verify']['complete'] is True
        assert evidence['synthesize']['complete'] is True
        web_tools = module.BinaryGate.tool_evidence(
            gate, run_dir, {'WebSearch', 'WebFetch'}
        )
        assert module.BinaryGate.deep_research_web_tools_complete(
            gate, web_tools, evidence
        ) is True

        passive_path = subagents / 'agent-verify-1.jsonl'
        with passive_path.open('a') as stream:
            stream.write(json.dumps({
                'type': 'assistant',
                'message': {
                    'role': 'assistant',
                    'content': [{
                        'type': 'tool_use',
                        'id': 'verify-agent',
                        'name': 'Agent',
                        'input': {'prompt': 'delegate'},
                    }],
                },
            }) + '\n')
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['verify']['complete'] is False
        assert evidence['verify']['violating_logical_indexes'] == ['1']

        write_transcript(passive_path, [{
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{'type': 'text', 'text': '{}'}],
            },
        }])
        extra_path = subagents / 'agent-synthesize-1.jsonl'
        with extra_path.open('a') as stream:
            stream.write(json.dumps({
                'type': 'assistant',
                'message': {
                    'role': 'assistant',
                    'content': [{
                        'type': 'tool_use',
                        'id': 'extra-search',
                        'name': 'WebSearch',
                        'input': {'query': 'extra'},
                    }],
                },
            }) + '\n')
            stream.write(json.dumps({
                'type': 'user',
                'message': {
                    'role': 'user',
                    'content': [{
                        'type': 'tool_result',
                        'tool_use_id': 'extra-search',
                        'content': 'ok',
                    }],
                },
            }) + '\n')
        web_tools = module.BinaryGate.tool_evidence(
            gate, run_dir, {'WebSearch', 'WebFetch'}
        )
        assert module.BinaryGate.deep_research_web_tools_complete(
            gate, web_tools, evidence
        ) is False
        write_transcript(extra_path, [{
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{'type': 'text', 'text': '{}'}],
            },
        }])

        select_sources_path = subagents / 'agent-select-sources.jsonl'
        write_select_sources_worker(
            subagents,
            deep_research_select_sources_entries(14),
        )
        write_transcript(
            subagents / 'agent-fetch-15.jsonl',
            deep_research_shortfall_entries(15),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is True
        assert evidence['select-sources']['sources_complete'] is True
        assert evidence['fetch']['complete'] is True
        assert evidence['fetch']['shortfall_logical_indexes'] == ['15']
        assert set(evidence['fetch']['exact_once_logical_indexes']) == {
            str(index) for index in range(1, 15)
        }
        web_tools = module.BinaryGate.tool_evidence(
            gate, run_dir, {'WebSearch', 'WebFetch'}
        )
        assert module.BinaryGate.deep_research_web_tools_complete(
            gate, web_tools, evidence
        ) is True

        write_transcript(
            subagents / 'agent-fetch-15.jsonl',
            deep_research_entries('fetch', 15),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is True
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['invalid_shortfall_logical_indexes'] == ['15']
        web_tools = module.BinaryGate.tool_evidence(
            gate, run_dir, {'WebSearch', 'WebFetch'}
        )
        assert module.BinaryGate.deep_research_web_tools_complete(
            gate, web_tools, evidence
        ) is False

        invalid_shortfall_entries = deep_research_select_sources_entries(14)
        invalid_shortfall_output = json.loads(
            invalid_shortfall_entries[0]['message']['content'][0]['text']
        )
        invalid_shortfall_output['shortfall']['missingCount'] = 2
        invalid_shortfall_entries[0]['message']['content'][0]['text'] = json.dumps(
            invalid_shortfall_output
        )
        write_select_sources_worker(subagents, invalid_shortfall_entries)
        write_transcript(
            subagents / 'agent-fetch-15.jsonl',
            deep_research_shortfall_entries(15),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is False

        entries = deep_research_select_sources_entries()
        output = json.loads(entries[0]['message']['content'][0]['text'])
        output['sources'][1]['url'] = output['sources'][0]['url']
        entries[0]['message']['content'][0]['text'] = json.dumps(output)
        write_select_sources_worker(subagents, entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is False

        entries = deep_research_select_sources_entries()
        entries[0]['message']['content'][0]['text'] = '```json\n{}\n```'
        write_select_sources_worker(subagents, entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is False

        entries = deep_research_select_sources_entries()
        entries.append(entries[0].copy())
        write_select_sources_worker(subagents, entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is False

        entries = deep_research_select_sources_entries()
        output = json.loads(entries[0]['message']['content'][0]['text'])
        output['sources'][1]['oneBasedRank'] = 3
        entries[0]['message']['content'][0]['text'] = json.dumps(output)
        write_select_sources_worker(subagents, entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is False

        entries = deep_research_select_sources_entries()
        entries[0]['message']['content'].append({
            'type': 'tool_use',
            'id': 'select-sources-bash',
            'name': 'Bash',
            'input': {'command': 'pwd'},
        })
        write_select_sources_worker(subagents, entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is False
        assert evidence['select-sources']['violating_logical_indexes'] == ['1']

        write_select_sources_worker(
            subagents,
            description='deep-research: select-sources retry 1/1',
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is False

        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-15.jsonl',
            deep_research_entries('fetch', 15),
        )
        write_transcript(
            subagents / 'agent-fetch-2.jsonl',
            deep_research_entries(
                'fetch', 2,
                fetch_url='https://example.test/source-1',
                selected_url='https://example.test/source-1',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['selected_sources_match'] is False

        write_transcript(
            subagents / 'agent-fetch-2.jsonl',
            deep_research_entries('fetch', 2),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is True
        assert evidence['fetch']['selected_sources_match'] is True

        duplicate_path = subagents / 'agent-search-1.jsonl'
        with duplicate_path.open('a') as stream:
            stream.write(json.dumps({
                'type': 'assistant',
                'message': {
                    'role': 'assistant',
                    'content': [{
                        'type': 'tool_use',
                        'id': 'search-1-duplicate',
                        'name': 'WebSearch',
                        'input': {},
                    }],
                },
            }) + '\n')
            stream.write(json.dumps({
                'type': 'user',
                'message': {
                    'role': 'user',
                    'content': [{
                        'type': 'tool_result',
                        'tool_use_id': 'search-1-duplicate',
                        'is_error': True,
                        'content': 'failed',
                    }],
                },
            }) + '\n')
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['search']['complete'] is False
        assert evidence['search']['logical_worker_tool_counts']['1'] == {
            'tool_uses': 2,
            'tool_use_occurrences': 2,
            'successful_results': 1,
            'failed_results': 1,
            'invalid_results': 0,
        }

        fetch_failure_path = subagents / 'agent-fetch-1.jsonl'
        fetch_failure_path.write_text('')
        write_transcript(
            fetch_failure_path,
            deep_research_entries(
                'fetch', 1,
                error='Request failed with status code 403',
                tool_id='fetch-1-failed',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is True
        assert evidence['fetch']['external_failure_logical_indexes'] == ['1']
        assert evidence['fetch']['non_external_failure_logical_indexes'] == []
        assert '1' not in evidence['fetch']['successful_logical_indexes']
        assert evidence['fetch']['attempts']['1'][0]['failed_result_messages'] == {
            'fetch-1-failed': ['Request failed with status code 403'],
        }

        write_transcript(
            fetch_failure_path,
            deep_research_entries(
                'fetch', 1,
                error='Request failed with status code 403',
                tool_id='fetch-1-invalid-output',
                source_quality='primary',
                claims=[{'claim': 'unsupported'}],
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['external_failure_logical_indexes'] == []
        assert evidence['fetch']['failed_output_mismatch_logical_indexes'] == ['1']

        write_transcript(
            fetch_failure_path,
            deep_research_entries(
                'fetch', 1,
                error='Permission denied by policy',
                tool_id='fetch-1-denied',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['external_failure_logical_indexes'] == []
        assert evidence['fetch']['non_external_failure_logical_indexes'] == ['1']

        write_transcript(
            fetch_failure_path,
            deep_research_entries(
                'fetch', 1,
                error='WebFetch crashed unexpectedly',
                tool_id='fetch-1-denied',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['external_failure_logical_indexes'] == []
        assert evidence['fetch']['non_external_failure_logical_indexes'] == ['1']

        write_transcript(
            fetch_failure_path,
            deep_research_entries(
                'fetch', 1,
                error='Request failed with status code 403',
                tool_id='fetch-1-failed',
            ),
        )
        retry_stem = 'agent-fetch-2-retry'
        (subagents / f'{retry_stem}.meta.json').write_text(json.dumps({
            'agentId': retry_stem,
            'description': 'deep-research: fetch 2/15 retry 1/1',
        }))
        write_transcript(subagents / f'{retry_stem}.jsonl', [])
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['logical_worker_attempt_counts']['2'] == 2
        assert evidence['fetch']['retry_logical_indexes'] == ['2']
        assert '2' not in evidence['fetch']['exact_once_logical_indexes']

    with tempfile.TemporaryDirectory(prefix='release-driver-test-') as root_string:
        run_dir = Path(root_string)
        subagents = run_dir / 'config/projects/project/subagents'
        gate = object.__new__(module.BinaryGate)

        def write_complete_workers():
            for phase, count in (('search', 5), ('fetch', 15)):
                for index in range(1, count + 1):
                    stem = f'agent-{phase}-{index}'
                    (subagents / f'{stem}.meta.json').parent.mkdir(
                        parents=True, exist_ok=True
                    )
                    (subagents / f'{stem}.meta.json').write_text(json.dumps({
                        'agentId': stem,
                        'description': f'deep-research: {phase} {index}/{count}',
                    }))
                    write_transcript(
                        subagents / f'{stem}.jsonl',
                        deep_research_entries(phase, index),
                    )

        write_complete_workers()
        write_select_sources_worker(subagents)
        retry_meta = subagents / 'agent-fetch-1.meta.json'
        retry_meta.write_text(json.dumps({
            'agentId': 'agent-fetch-1',
            'description': 'deep-research: fetch 1/15 retry 1/1',
        }))
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['retry_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        duplicate_use_path = subagents / 'agent-fetch-1.jsonl'
        entries = deep_research_entries('fetch', 1)
        entries[1]['message']['content'].append(
            entries[1]['message']['content'][0].copy()
        )
        write_transcript(duplicate_use_path, entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['logical_worker_tool_counts']['1'][
            'tool_use_occurrences'
        ] == 2

        write_complete_workers()
        write_select_sources_worker(subagents)
        duplicate_result_path = subagents / 'agent-fetch-1.jsonl'
        entries = deep_research_entries('fetch', 1)
        entries[2]['message']['content'].append({
            'type': 'tool_result',
            'tool_use_id': 'fetch-1-tool',
            'is_error': True,
            'content': 'Request failed with status code 403',
        })
        write_transcript(duplicate_result_path, entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['logical_worker_tool_counts']['1'][
            'invalid_results'
        ] == 1

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-1.jsonl',
            deep_research_entries(
                'fetch', 1,
                error='HTTP status 500 internal server error',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['external_failure_logical_indexes'] == []
        assert evidence['fetch']['non_external_failure_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-1.jsonl',
            deep_research_entries(
                'fetch', 1,
                error='Permission denied by policy; HTTP status 403',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['external_failure_logical_indexes'] == []
        assert evidence['fetch']['non_external_failure_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-1.jsonl',
            deep_research_entries(
                'fetch', 1,
                fetch_url='https://example.test/source-2',
                selected_url='https://example.test/source-1',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-1.jsonl',
            deep_research_entries(
                'fetch', 1,
                fetch_url='https://example.test/source?id=2',
                selected_url='https://example.test/source?id=1',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-1.jsonl',
            deep_research_entries(
                'fetch', 1,
                fetch_url='http://example.test/source-1',
                selected_url='https://example.test/source-1',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-1.jsonl',
            deep_research_entries(
                'fetch', 1,
                fetch_url='https://example.test/source-1/',
                selected_url='https://example.test/source-1',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-2.jsonl',
            deep_research_entries(
                'fetch', 2,
                fetch_url='https://example.test/source-1',
                selected_url='https://example.test/source-1',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['duplicate_source_logical_indexes'] == ['1', '2']

        write_complete_workers()
        write_select_sources_worker(subagents)
        entries = deep_research_entries('fetch', 1)
        output = json.loads(entries[-1]['message']['content'][0]['text'])
        output['fetchedSource'] = output.pop('selectedSource')
        entries[-1]['message']['content'][0]['text'] = json.dumps(output)
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        entries = deep_research_entries('fetch', 1)
        output = json.loads(entries[-1]['message']['content'][0]['text'])
        output['selectedSource']['rank'] = output['selectedSource'].pop('oneBasedRank')
        entries[-1]['message']['content'][0]['text'] = json.dumps(output)
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        entries = deep_research_entries('fetch', 1)
        entries.append(entries[-1].copy())
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        entries = deep_research_entries('fetch', 1)
        entries[1]['message']['content'].append({
            'type': 'tool_use',
            'id': 'fetch-1-bash',
            'name': 'Bash',
            'input': {'command': 'pwd'},
        })
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['unexpected_tool_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        entries = deep_research_entries('fetch', 1)
        entries[1]['message']['content'].append({
            'type': 'tool_use',
            'id': 'fetch-1-discovery',
            'name': 'ToolSearch',
            'input': {'query': 'select:WebFetch', 'max_results': 1},
        })
        entries[2]['message']['content'].append({
            'type': 'tool_result',
            'tool_use_id': 'fetch-1-discovery',
            'content': 'loaded',
        })
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is True
        assert evidence['fetch']['unexpected_tool_logical_indexes'] == []

        write_complete_workers()
        write_select_sources_worker(subagents)
        entries = deep_research_entries('fetch', 1)
        entries[1]['message']['content'].append({
            'type': 'tool_use',
            'id': 'fetch-1-discovery',
            'name': 'ToolSearch',
            'input': {'query': 'WebFetch'},
        })
        entries[2]['message']['content'].append({
            'type': 'tool_result',
            'tool_use_id': 'fetch-1-discovery',
            'content': 'loaded',
        })
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['unexpected_tool_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        entries = deep_research_entries('fetch', 1)
        for suffix in ('a', 'b'):
            entries[1]['message']['content'].append({
                'type': 'tool_use',
                'id': f'fetch-1-discovery-{suffix}',
                'name': 'ToolSearch',
                'input': {'query': 'select:WebFetch', 'max_results': 1},
            })
            entries[2]['message']['content'].append({
                'type': 'tool_result',
                'tool_use_id': f'fetch-1-discovery-{suffix}',
                'content': 'loaded',
            })
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['unexpected_tool_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-1.jsonl',
            deep_research_entries(
                'fetch', 1,
                error='timeout of 60000ms exceeded',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is True
        assert evidence['fetch']['external_failure_logical_indexes'] == ['1']
        assert evidence['fetch']['non_external_failure_logical_indexes'] == []

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-1.jsonl',
            deep_research_entries(
                'fetch', 1,
                error='network error while contacting the model gateway',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['external_failure_logical_indexes'] == []
        assert evidence['fetch']['non_external_failure_logical_indexes'] == ['1']

    with tempfile.TemporaryDirectory(prefix='release-driver-test-') as root_string:
        root = Path(root_string)
        evidence = root / 'evidence'
        evidence.mkdir()
        home = root / 'auth-home'
        home.mkdir()
        (home / 'auth.json').write_text('secret\n')
        gate = object.__new__(module.BinaryGate)
        gate.evidence_root = evidence
        gate.active_runs = {}
        gate.mock_servers = {}
        gate.auth_homes = {home}
        gate.cleanup_started = False
        try:
            module.BinaryGate.handle_signal(gate, signal.SIGTERM, None)
        except SystemExit as error:
            assert error.code == 128 + signal.SIGTERM
        else:
            raise AssertionError('signal handler did not terminate')
        assert not home.exists()
        cleanup = json.loads((evidence / 'signal-cleanup.json').read_text())
        assert cleanup['signal'] == 'SIGTERM'
        assert cleanup['auth_homes']['errors'] == []

    with tempfile.TemporaryDirectory(prefix='release-driver-lease-') as root_string:
        root = Path(root_string)
        repo = root / 'repo'
        repo.mkdir()
        alias = root / 'repo-alias'
        alias.symlink_to(repo, target_is_directory=True)
        lease_a = object.__new__(module.BinaryGate)
        lease_a.repo = repo.resolve()
        lease_a.binary = repo / 'built-claude'
        lease_a.evidence_root = root / 'evidence-a'
        lease_a.pid = 101
        lease_a.manifest = {}
        lease_a.lease_file = lease_a.lease_path = lease_a.lease_metadata = None
        module.BinaryGate.acquire_lease(lease_a)
        assert lease_a.lease_metadata['repo'] == str(repo.resolve())
        assert lease_a.lease_metadata['binary'] == str(repo / 'built-claude')
        lease_b = object.__new__(module.BinaryGate)
        lease_b.repo = alias.resolve()
        lease_b.binary = repo / 'built-claude'
        lease_b.evidence_root = root / 'evidence-b'
        lease_b.pid = 102
        lease_b.manifest = {}
        lease_b.lease_file = lease_b.lease_path = lease_b.lease_metadata = None
        try:
            module.BinaryGate.acquire_lease(lease_b)
        except RuntimeError as error:
            assert str(repo.resolve()) in str(error)
        else:
            raise AssertionError('equivalent repo realpaths must conflict')
        assert module.BinaryGate.release_lease(lease_a)['released'] is True
        module.BinaryGate.acquire_lease(lease_b)
        assert module.BinaryGate.release_lease(lease_b)['released'] is True

    assert module.required_targets_for_paths([
        'src/commands/goal.ts',
        'src/tools/AgentTool/agentToolUtils.ts',
        'src/tools/WorkflowTool/bundled/index.ts',
    ]) == {
        'goal-lifecycle',
        'agent-fg-bg',
        'nested-agent',
        'workflow',
        'code-review',
    }
    assert module.required_targets_for_paths([
        'src/tools/AgentTool/runAgent.ts',
    ]) == {
        'agent-fg-bg',
        'nested-agent',
        'subagent-stop-failure-lifecycle',
    }
    assert module.required_targets_for_paths([
        'src/query.ts',
    ]) == {'builtin-mods', 'nested-agent'}
    assert module.required_targets_for_paths([
        'src/state/AppStateStore.ts',
    ]) == set()
    assert module.required_targets_for_paths([
        'src/tools/WorkflowTool/bundled/index.ts',
    ]) == {'workflow', 'code-review'}
    assert module.required_targets_for_paths([
        'src/tools/WorkflowTool/workflowOrchestrator.ts',
    ]) == {
        'workflow-retry-partial-failure',
        'workflow-failure-detail',
    }
    assert module.required_targets_for_paths([
        'src/services/api/openai-compat.ts',
    ]) == {
        'deferred-tool-discovery',
        'effort-openai-responses-wire',
        'fast-openai-responses-wire',
        'openai-image-input-wire',
        'openai-remote-compaction',
        'openai-responses-usage-error',
        'model-discovery-picker',
        'prompt-modes-cache-prefix',
    }
    assert module.required_targets_for_paths([
        'src/commands/fast/fast.tsx',
        'src/utils/fastMode.ts',
    ]) == {'fast-openai-responses-wire'}
    assert module.required_targets_for_paths([
        'src/commands/compact/compact.ts',
        'src/services/compact/codexCompact.ts',
    ]) == {'openai-remote-compaction'}
    assert module.required_targets_for_paths([
        '.github/workflows/release.yml',
        'scripts/build.mjs',
        'scripts/package-binary.mjs',
        'scripts/verify-bundled-image-runtime.mjs',
        'scripts/shims/embedded-ripgrep.js',
        'scripts/shims/embedded-sharp.js',
        'scripts/shims/image-processor-napi.js',
        'scripts/shims/sharp-native.cjs',
        'src/tools/FileReadTool/imageProcessor.ts',
        'src/utils/imageResizer.ts',
    ]) == {'openai-image-input-wire'}
    assert module.required_targets_for_paths([
        'src/hooks/useSSHSession.ts',
        'src/hooks/useRemoteSession.ts',
        'src/ssh/remoteHistoryReplay.ts',
        'src/screens/REPL.tsx',
        'src/entrypoints/sdk/controlSchemas.ts',
    ]) == {
        'builtin-mods',
        'effort-openai-responses-wire',
        'ssh-remote-session-lifecycle',
        'terminal-interaction',
        'terminal-canonical-diff',
    }
    assert module.required_targets_for_paths([
        'src/ssh/createSSHSession.ts',
    ]) == {'ssh-remote-session-lifecycle'}

    with tempfile.TemporaryDirectory(prefix='release-driver-ssh-fixture-') as root_string:
        root = Path(root_string)
        run_dir = root / 'run'
        run_dir.mkdir()
        gate = object.__new__(module.BinaryGate)
        gate.baseline = {'makefile_version': '9.8.7'}
        fixture = module.BinaryGate.make_ssh_transport_fixture(gate, run_dir)
        executable = Path(fixture['bin_dir']) / 'ssh'
        assert executable.is_file()
        assert executable.stat().st_mode & 0o111
        assert "print('9.8.7')" in executable.read_text()
        assert fixture['session_id'] == 'release-ssh-session-0001'
        assert fixture['task_id'] == 'release-ssh-task-0001'
        assert fixture['tool_use_id'] == 'release-ssh-tool-0001'
        assert fixture['permission_request_id'] == 'release-ssh-permission-0001'
        assert fixture['io_path'] == str(run_dir / 'fake-ssh-io.jsonl')
        probe = subprocess.run(
            [
                str(executable),
                '-o',
                'ControlMaster=auto',
                '--',
                'release-ssh-host',
                'set -eu; printf "%s\\n" "$(uname -s)" "$(uname -m)" "$HOME" "$PWD"',
            ],
            env={'CC_VALIDATION_SSH_IO': fixture['io_path']},
            capture_output=True,
            text=True,
            check=False,
        )
        assert probe.returncode == 0, probe.stderr
        assert probe.stdout == 'Linux\nx86_64\n/release-home\n/release-work\n'
        events = [json.loads(line) for line in Path(fixture['io_path']).read_text().splitlines()]
        assert [event['event'] for event in events] == ['ssh-invocation']
        assert events[0]['args'][-2:] == [
            'release-ssh-host',
            'set -eu; printf "%s\\n" "$(uname -s)" "$(uname -m)" "$HOME" "$PWD"',
        ]
        secret_probe = subprocess.run(
            [
                str(executable), '--', 'release-ssh-host',
                'set -eu; trap cleanup EXIT; env '
                'CLAUDE_CODE_SSH_REMOTE_TOKEN\\=secret-token '
                'CLAUDE_CODE_SSH_PERMISSION_BOOTSTRAP\\=secret-bootstrap '
                'CLAUDE_CODE_OAUTH_TOKEN\\=secret-oauth claude --input-format stream-json ',
            ],
            env={'CC_VALIDATION_SSH_IO': fixture['io_path']},
            input='',
            capture_output=True,
            text=True,
            check=False,
        )
        assert secret_probe.returncode == 0
        redacted_transport = Path(fixture['io_path']).read_text()
        assert 'secret-token' not in redacted_transport
        assert 'secret-bootstrap' not in redacted_transport
        assert 'secret-oauth' not in redacted_transport
        assert redacted_transport.count('[REDACTED]') >= 3

        lifecycle = subprocess.Popen(
            [
                str(executable), '--', 'release-ssh-host',
                'set -eu; trap cleanup EXIT; claude --input-format stream-json --output-format stream-json',
            ],
            env={'CC_VALIDATION_SSH_IO': fixture['io_path']},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        assert lifecycle.stdin is not None
        for message in (
            {
                'type': 'control_request',
                'request_id': 'history-request',
                'request': {'subtype': 'replay_history'},
            },
            {'type': 'user'},
            {
                'type': 'control_response',
                'response': {
                    'request_id': 'release-ssh-permission-0001',
                    'response': {
                        'behavior': 'allow',
                        'updatedInput': {'command': 'pwd'},
                    },
                },
            },
        ):
            lifecycle.stdin.write(json.dumps(message) + '\n')
        lifecycle.stdin.flush()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if Path(fixture['io_path']).exists() and 'task-result' in Path(
                fixture['io_path']
            ).read_text():
                break
            time.sleep(0.01)
        else:
            raise AssertionError('fake SSH lifecycle did not reach task result')
        try:
            assert lifecycle.wait(timeout=2) == 0
        finally:
            if lifecycle.poll() is None:
                lifecycle.kill()
                lifecycle.wait(timeout=2)
            lifecycle.stdin.close()
        lifecycle_events = [
            json.loads(line)
            for line in Path(fixture['io_path']).read_text().splitlines()
        ]
        assert lifecycle_events[-1]['event'] == 'remote-process-exit'

    assert module.BinaryGate.ssh_lifecycle_evidence({
        'session_id': 'release-ssh-session-0001',
        'task_id': 'release-ssh-task-0001',
        'tool_use_id': 'release-ssh-tool-0001',
        'permission_request_id': 'release-ssh-permission-0001',
        'events': [
            {'event': 'remote-process-start'},
            {'event': 'history-bootstrap-request'},
            {'event': 'goal-bootstrap', 'goal_id': 'release-ssh-goal-0001'},
            {'event': 'history-bootstrap-response'},
            {'event': 'task-start', 'task_id': 'release-ssh-task-0001'},
            {'event': 'tool-use', 'tool_use_id': 'release-ssh-tool-0001'},
            {
                'event': 'permission-response',
                'request_id': 'release-ssh-permission-0001',
                'behavior': 'allow',
                'tool_use_id': 'release-ssh-tool-0001',
            },
            {'event': 'task-stopped', 'task_id': 'release-ssh-task-0001'},
            {'event': 'task-result', 'task_id': 'release-ssh-task-0001'},
            {'event': 'remote-process-exit'},
            {'event': 'cleanup-command'},
            {'event': 'control-master-stop'},
        ],
    })['passed'] is True
    incomplete_ssh_evidence = module.BinaryGate.ssh_lifecycle_evidence({
        'session_id': 'release-ssh-session-0001',
        'task_id': 'release-ssh-task-0001',
        'tool_use_id': 'release-ssh-tool-0001',
        'permission_request_id': 'release-ssh-permission-0001',
        'events': [{'event': 'remote-process-start'}],
    })
    assert incomplete_ssh_evidence['passed'] is False
    assert 'task-start' in incomplete_ssh_evidence['missing_events']

    complete_events = [
        {'event': 'remote-process-start'},
        {'event': 'history-bootstrap-request'},
        {'event': 'goal-bootstrap', 'goal_id': 'release-ssh-goal-0001'},
        {'event': 'history-bootstrap-response'},
        {'event': 'task-start', 'task_id': 'release-ssh-task-0001'},
        {'event': 'tool-use', 'tool_use_id': 'release-ssh-tool-0001'},
        {
            'event': 'permission-response',
            'request_id': 'release-ssh-permission-0001',
            'behavior': 'allow',
            'tool_use_id': 'release-ssh-tool-0001',
        },
        {'event': 'task-stopped', 'task_id': 'release-ssh-task-0001'},
        {'event': 'task-result', 'task_id': 'release-ssh-task-0001'},
        {'event': 'remote-process-exit'},
        {'event': 'cleanup-command'},
        {'event': 'control-master-stop'},
    ]
    assert module.BinaryGate.ssh_lifecycle_evidence({
        **module.SSH_LIFECYCLE_IDS,
        'events': complete_events[:-2],
    }, require_cleanup=False)['passed'] is True
    assert module.BinaryGate.ssh_lifecycle_evidence({
        **module.SSH_LIFECYCLE_IDS,
        'events': complete_events,
    }, require_cleanup=False)['passed'] is True
    for mutation in (
        lambda events: events.__setitem__(4, {
            'event': 'task-start', 'task_id': 'wrong-task',
        }),
        lambda events: events.__setitem__(5, {
            'event': 'tool-use', 'tool_use_id': 'wrong-tool',
        }),
        lambda events: events.__setitem__(6, {
            'event': 'permission-response',
            'request_id': 'wrong-request',
            'behavior': 'deny',
            'tool_use_id': 'wrong-tool',
        }),
        lambda events: events.insert(5, dict(events[4])),
        lambda events: events.__setitem__(7, events.pop(8)),
    ):
        events = [dict(event) for event in complete_events]
        mutation(events)
        assert module.BinaryGate.ssh_lifecycle_evidence({
            **module.SSH_LIFECYCLE_IDS,
            'events': events,
        })['passed'] is False
    required = module.required_targets_for_paths([
        'src/utils/effort.ts',
        'src/services/api/bootstrap.ts',
        'src/utils/model/modelOptions.ts',
        'src/utils/model/openaiModelOptions.ts',
        'src/skills/bundled/updateConfig.ts',
        'src/utils/promptLayers.ts',
        'src/utils/swarm/teamHelpers.ts',
        'src/tools/WorkflowTool/workflowScriptRuntime.ts',
        'src/components/PromptInput/PromptInput.tsx',
        'src/utils/swarm/inProcessRunner.ts',
    ])
    assert required == {
        'effort-openai-responses-wire',
        'model-discovery-picker',
        'model-discovery-empty-picker',
        'first-party-bootstrap-picker',
        'model-internal-update-config-skill',
        'prompt-modes-cache-prefix',
        'team-concurrency',
        'workflow-retry-partial-failure',
        'coordinator-selector',
        'transcript-retention',
        'terminal-interaction',
        'terminal-canonical-diff',
    }

    with tempfile.TemporaryDirectory(prefix='release-driver-mock-cleanup-') as root_string:
        root = Path(root_string)
        repo = root / 'repo'
        evidence = root / 'evidence'
        auth_source = root / 'auth-source.json'
        repo.mkdir()
        evidence.mkdir()
        auth_source.write_text('{}\n')
        gate = object.__new__(module.BinaryGate)
        gate.repo = repo
        gate.evidence_root = evidence
        gate.auth_source = auth_source
        gate.auth_homes = set()
        gate.active_runs = {}
        gate.mock_servers = {}
        gate.session_index = 0
        gate.stamp = 'collision-test'
        gate.pid = 123
        gate.make_fixture = lambda run_dir, label: (
            run_dir / 'config',
            run_dir / 'home',
        )
        gate.tmux = lambda *args, **kwargs: module.subprocess.CompletedProcess(
            args, 0, '', ''
        )
        with patch.object(module.MockOpenAIServer, 'start') as mock_start:
            try:
                gate.start('effort-openai-responses-wire')
            except RuntimeError as error:
                assert 'tmux session collision' in str(error)
            else:
                raise AssertionError('collision did not abort startup')
            mock_start.assert_not_called()
        assert gate.mock_servers == {}

        orphan_dir = evidence / 'runs' / 'orphan-mock'
        orphan_dir.mkdir(parents=True)
        orphan = module.MockOpenAIServer(
            orphan_dir,
            'effort-openai-responses-wire',
        )
        orphan.start()
        gate.mock_servers['orphan-mock'] = orphan
        cleanup = gate.close_active_runs()
        assert cleanup == [{
            'session': None,
            'evidence_dir': str(evidence / 'runs' / 'orphan-mock'),
            'kill_exit': 0,
            'pane_pid': '',
            'process_remaining': False,
            'remaining_processes': [],
            'forced_termination': [],
            'mock_server': {'stopped': True, 'thread_alive': False, 'active_handlers': []},
        }]
        assert gate.mock_servers == {}

    with tempfile.TemporaryDirectory(prefix='release-retention-gc-verdict-') as root_string:
        server = module.MockOpenAIServer(Path(root_string), 'transcript-retention')
        gate = object.__new__(module.BinaryGate)
        def probe_request(phase, task, output):
            return {'body': {'input': [
                {'type': 'function_call', 'call_id': f'fc_retention_probe_{phase}',
                 'name': 'TaskOutput', 'arguments': json.dumps({'task_id': task, 'block': False})},
                {'type': 'function_call_output', 'call_id': f'fc_retention_probe_{phase}', 'output': output},
            ]}}
        before = '<task_id>task-real</task_id>\n<task_type>in_process_teammate</task_type>\n<status>completed</status>'
        server.requests = [{'method': 'GET', 'path': '/v1/models', 'body': None}]
        assert not gate.retention_probe_result(server, 'task-real', 'before')
        server.requests.append(probe_request('before', 'task-real', before))
        assert gate.retention_probe_result(server, 'task-real', 'before')
        assert not gate.retention_probe_result(server, 'wrong-task', 'before')
        assert not gate.retention_probe_result(server, 'task-real', 'after')
        missing = '<tool_use_error>No task found with ID: task-real</tool_use_error>'
        server.requests.append(probe_request('after', 'task-real', missing))
        assert gate.retention_probe_result(server, 'task-real', 'after')
        server.requests[-1]['body']['input'][-1]['output'] = missing + '\n<system-reminder>Reminder</system-reminder>'
        assert gate.retention_probe_result(server, 'task-real', 'after')
        for invalid in ('No task found with ID: task-real',
                        '<system-reminder>' + missing + '</system-reminder>',
                        '<tool_use_error>No task found with ID: other-task</tool_use_error>'):
            server.requests[-1]['body']['input'][-1]['output'] = invalid
            assert not gate.retention_probe_result(server, 'task-real', 'after')
        server.requests[-1]['body']['input'][-1]['output'] = before
        assert not gate.retention_probe_result(server, 'task-real', 'after')
        server.requests[-1]['body']['input'][-1]['output'] = 'No task found with ID: other-task'
        assert not gate.retention_probe_result(server, 'task-real', 'after')
        server.requests[-1]['body']['input'][-1]['type'] = 'message'
        server.requests[-1]['body']['input'][-1]['output'] = 'No task found with ID: task-real'
        assert not gate.retention_probe_result(server, 'task-real', 'after')

    for wait_timeout in (False, True):
        with tempfile.TemporaryDirectory(prefix='release-retention-gc-clock-') as root_string:
            run_dir = Path(root_string)
            gate = object.__new__(module.BinaryGate)
            clock = [105.0]
            sent = []
            gate.send = lambda target, directory, text, filename: sent.append((text, clock[0]))
            gate.retention_probe_result = lambda *args: True
            gate.capture = lambda *args, **kwargs: (
                'RELEASE_RETENTION_PROBE_BEFORE_DONE RELEASE_RETENTION_GC_TICK_DONE '
                'RELEASE_RETENTION_PROBE_AFTER_DONE')
            def wait_until(predicate, timeout, interval):
                if predicate():
                    return True
                if wait_timeout:
                    return False
                while clock[0] < 140:
                    clock[0] += interval
                    if predicate():
                        return True
                return False
            gate.wait_until = wait_until
            # Escape sent at 100, but its state transition was only observed at 105.
            with patch.object(module.time, 'monotonic', side_effect=lambda: clock[0]):
                passed = gate.retention_gc(run_dir, 'pane', None, 'task-real', 130, 135)
            assert passed is not wait_timeout
            ticks = [stamp for text, stamp in sent if text == 'RELEASE_RETENTION_GC_TICK']
            assert ticks == ([] if wait_timeout else [137.0])
            evidence = json.loads((run_dir / 'gc-evidence.json').read_text())
            assert evidence['before_observed'] < 130
            assert evidence['passed'] is not wait_timeout

    for scenario in ('pass', 'wrong-agent', 'stale', 'exited', 'terminal', 'no-resume',
                     'missing-interruption', 'wrong-view'):
        with tempfile.TemporaryDirectory(prefix='release-retention-abort-verdict-') as root_string:
            run_dir = Path(root_string)
            gate = object.__new__(module.BinaryGate)
            server = module.MockOpenAIServer(run_dir, 'transcript-retention')
            server.retention_child_waiting.set()
            agent = 'other@test' if scenario == 'wrong-agent' else 'retention-worker@test'
            markers = (f'[inProcessRunner] {agent} current work aborted (Escape pressed)\n'
                       f'[inProcessRunner] {agent} work interrupted, returning to idle\n')
            log = ['[spawnInProcessTeammate] Spawning retention-worker@test (taskId: task-real)\n']
            if scenario == 'stale':
                log.append(markers)
            gate.debug = lambda *args: ''.join(log)
            def press(*args, **kwargs):
                if scenario != 'stale':
                    log.append(markers)
                if scenario == 'exited':
                    log.append('[viewed_agent_changed] before=task-real after=main\n')
                if scenario == 'terminal':
                    log.append('[transcript_retention_decision] task=task-real status=completed\n')
            gate.tmux = press
            gate.wait_until = lambda predicate, *args: bool(predicate())
            pane = ('Viewing @other-worker' if scenario == 'wrong-view'
                    else 'Viewing @retention-worker')
            if scenario != 'missing-interruption':
                pane += '\nInterrupted · What should Claude do instead?'
            pane += '\nRELEASE_RETENTION_WORKER_DONE'
            gate.capture = lambda *args, **kwargs: pane
            gate.assistant_text = lambda *args, **kwargs: 'RELEASE_RETENTION_WORKER_DONE'
            def send(*args):
                assert server.retention_child_release.is_set()
                if scenario != 'no-resume':
                    server.requests.append({'response_kind': 'retention-worker-marker'})
            gate.send = send
            assert gate.retention_active_abort(run_dir, 'pane', server, 'task-real') == (scenario == 'pass')
            if scenario in ('wrong-agent', 'stale'):
                assert not server.retention_child_release.is_set()
            server.stop()

    for scenario in ('pass', 'late', 'polluted', 'disabled-rewind'):
        with tempfile.TemporaryDirectory(prefix='release-retention-escape-window-') as root_string:
            run_dir = Path(root_string)
            gate = object.__new__(module.BinaryGate)
            clock = [10.9 if scenario == 'late' else 10.1]
            writes = []
            rewinding = [False]
            def write(*args, **kwargs):
                value = args[-1]
                writes.append((value, clock[0]))
                if value == '\x1b\x1b' and scenario != 'disabled-rewind':
                    rewinding[0] = True
                elif value == 'Escape' and any(item == '\x1b\x1b' for item, _ in writes):
                    rewinding[0] = False
            gate.tmux = write
            def capture(target, path, **kwargs):
                text = 'Rewind' if scenario == 'polluted' or rewinding[0] else '❯ '
                path.write_text(text)
                return text
            gate.capture = capture
            def wait_until(predicate, timeout, interval):
                deadline = clock[0] + timeout
                while clock[0] <= deadline:
                    if predicate():
                        return True
                    clock[0] += interval
                return False
            gate.wait_until = wait_until
            with patch.object(module.time, 'monotonic', side_effect=lambda: clock[0]):
                passed = gate.retention_escape_window(run_dir, 'pane', 'task-real', 10.0)
            assert passed == (scenario == 'pass'), scenario
            evidence = json.loads((run_dir / 'escape-window-evidence.json').read_text())
            assert evidence['passed'] == passed
            if scenario == 'pass':
                assert 0 <= writes[0][1] - 10.0 < 0.8
                assert writes[1][1] - writes[0][1] > 0.9
                assert writes[1][0] == '\x1b\x1b'
                assert evidence['double_chunk_hex'] == '1b1b'
                assert writes[-1][0] == 'Escape'
                assert len(evidence['samples']) > 1
                assert clock[0] - writes[-1][1] >= 0.8
            elif scenario == 'late':
                assert not writes

    # Relevant visible rows from round8 shift-main.txt, with ANSI preserved.
    rewind_pane = (
        '\x1b[38;5;231m⏺\x1b[39m RELEASE_RETENTION_PARENT_OK\n'
        '\x1b[38;5;231m⏺\x1b[39m RELEASE_RETENTION_PARENT_OK\n'
        '\x1b[38;5;153m────────────────────────────────────────────────\n'
        '\x1b[39m \x1b[1m\x1b[38;5;153mRewind\x1b[0m\n\n'
        ' Restore the code and/or conversation to the point before…\n\n'
        '   Transcript retention binary validation. Use TeamCreate once\n\n'
        ' \x1b[1m\x1b[38;5;153m❯ \x1b[0;3m\x1b[38;5;153m(current)\x1b[0m\n\n'
        ' \x1b[3m\x1b[38;5;246mEnter to continue · Esc to exit\x1b[0m\n'
    )
    for scenario in ('no-active-abort', 'no-escape-window', 'no-gc', 'second-exit-rewind', 'parent-only', 'rewind-with-input',
                     'pass', 'team-only', 'wrong-task', 'no-reopen', 'no-marker',
                     'no-shift', 'no-spinner', 'no-tasks', 'stale-entry',
                     'duplicate-spawn', 'no-exit', 'no-selection',
                     'no-pills', 'input-only', 'stale-exit', 'wrong-exit-task',
                     'still-viewing', 'empty-main', 'unrelated-main',
                     'no-shift-transcript', 'no-spinner-transcript', 'no-tasks-transcript'):
        with tempfile.TemporaryDirectory(prefix='release-retention-handler-') as root_string:
            run_dir = Path(root_string)
            gate = object.__new__(module.BinaryGate)
            server = module.MockOpenAIServer(run_dir, 'transcript-retention')
            gate.mock_servers = {run_dir.name: server}
            log = ['team_mutation_commit\n']
            if scenario != 'team-only':
                log.append('[spawnInProcessTeammate] Spawning retention-worker@test (taskId: task-real)\n'
                           '[spawnInProcessTeammate] Registered retention-worker@test in AppState\n')
            recorded = []
            opens = []
            gate.start = lambda label: (run_dir, 'session', 'pane', True)
            gate.send = lambda *args: None
            def retention_debug(directory):
                if server.retention_release.is_set() and not any('transcript_retention_decision' in line for line in log):
                    log.append('[transcript_retention_decision] task=task-real status=completed retain=keep\n')
                return ''.join(log)

            gate.debug = retention_debug
            gate.wait_until = lambda predicate, *args: bool(predicate())
            gate.assistant_text = lambda *args, **kwargs: 'RELEASE_RETENTION_WORKER_DONE'
            gate.cleanup_passed = lambda cleanup: True
            gate.close = lambda *args: server.stop()
            gate.record = recorded.append
            gate.required_assertion = lambda *args, **kwargs: kwargs
            def retention_gc(*args):
                assert len(args) == 6
                assert args[-1] >= args[-2]
                return scenario != 'no-gc'
            gate.retention_gc = retention_gc
            gate.retention_escape_window = lambda *args: scenario != 'no-escape-window'
            gate.retention_active_abort = lambda *args: scenario != 'no-active-abort'

            ui = {'state': 'main', 'tree': False, 'index': -1, 'captures': 0}
            commands = []
            gate.send = lambda *args: ui.update(state='tasks') if args[2] == '/tasks' else None

            def retention_capture(target, path, **kwargs):
                ui['captures'] += 1
                state = ui['state']
                text = {
                    'main': '@main @retention-worker shift + ↓ expand',
                    'footer': '@main @retention-worker selected main',
                    'worker': '@main @retention-worker selected worker',
                    'selection': ('› ╒═ team-lead hide' if ui['index'] == -1 else
                                  '› ├─ retention-worker enter to view hide' if ui['index'] == 0 else
                                  '› ╘═ hide enter to collapse'),
                    'tasks': 'Background tasks › @team-lead @retention-worker',
                    'task-row': 'Background tasks › @retention-worker',
                    'detail': '@retention-worker Completed Prompt f to foreground go back',
                    'view': '@retention-worker RELEASE_RETENTION_WORKER_DONE',
                }[state]
                if scenario == 'no-marker' or (opens and scenario == f'no-{opens[-1]}-transcript'):
                    text = text.replace('RELEASE_RETENTION_WORKER_DONE', '')
                if state == 'main':
                    text += '\n⏺ RELEASE_RETENTION_PARENT_OK\n────────────────\n❯ \n────────────────'
                    if 'Escape' in commands:
                        text = {
                            'no-pills': '\x1b[32m⏺ RELEASE_RETENTION_PARENT_OK\x1b[0m\n────────────────\n❯ \n────────────────',
                            'input-only': '────────────────\n❯ \n────────────────',
                            'still-viewing': text + '\nViewing @retention-worker',
                            'empty-main': '',
                            'unrelated-main': 'No tasks available',
                            'parent-only': '⏺ RELEASE_RETENTION_PARENT_OK',
                            'rewind-with-input': text + '\n' + rewind_pane,
                        }.get(scenario, text)
                        if scenario == 'second-exit-rewind' and commands.count('Escape') >= 2:
                            text = rewind_pane
                path.write_text(text)
                return text

            def retention_tmux(*args, **kwargs):
                key = args[-1]
                commands.append(key)
                # Every navigation key must observe the previous UI before advancing.
                assert ui['captures'] > 0
                ui['captures'] = 0
                state = ui['state']
                if key == 'Down':
                    ui['state'] = 'task-row' if state == 'tasks' else 'footer'
                elif key == 'Right':
                    if scenario != 'no-selection':
                        ui['state'] = 'worker'
                elif key == 'S-Down':
                    ui['index'] = ui['index'] + 1 if ui['tree'] else -1
                    ui.update(tree=True, state='selection')
                elif key == 'S-Up':
                    ui.update(index=ui['index'] - 1, state='selection')
                elif key in ('Enter', 'f'):
                    if state == 'selection' and ui['index'] == 1:
                        ui.update(tree=False, index=-1, state='main')
                        return
                    if state == 'task-row':
                        ui['state'] = 'detail'
                        return
                    route = ('tasks' if state == 'detail' else 'spinner' if key == 'f'
                             else 'shift' if state == 'selection' else 'footer')
                    opens.append(route)
                    blocked = scenario == f'no-{route}' or (scenario == 'no-reopen' and len(opens) > 1)
                    if not blocked:
                        task = 'wrong' if scenario == 'wrong-task' else 'task-real'
                        if scenario == 'stale-exit':
                            log.append('[viewed_agent_changed] before=task-real after=main reason=exit\n')
                        if scenario != 'stale-entry' or len(opens) == 1:
                            log.append(f'[viewed_agent_changed] before=main after={task} type=in_process_teammate\n')
                        ui['state'] = 'view'
                        if scenario == 'duplicate-spawn' and len(opens) == 2:
                            log.append('[spawnInProcessTeammate] Spawning retention-worker@test (taskId: task-extra)\n')
                elif key == 'Escape' and scenario != 'no-exit':
                    if scenario != 'stale-exit':
                        task = 'wrong' if scenario == 'wrong-exit-task' else 'task-real'
                        log.append(f'[viewed_agent_changed] before={task} after=main reason=exit\n')
                    ui['state'] = 'main'
                return module.subprocess.CompletedProcess(args, 0, '', '')

            gate.capture = retention_capture
            gate.tmux = retention_tmux
            module.BinaryGate.transcript_retention(gate)
            assert recorded[0]['validation_verdict'] == ('passed' if scenario == 'pass' else 'failed'), scenario
            if scenario == 'no-gc':
                assert recorded[0]['assertions'][0]['passed']
            if scenario in ('no-pills', 'input-only'):
                assert recorded[0]['exited'], scenario
                assert recorded[0]['single_escape_exits'] == [True], scenario
                assert commands.count('Escape') == 1
                # Successful exit must not waive the required footer reentry.
                assert not recorded[0]['entry_paths']['footer']
                assert not recorded[0]['reopened']
            if scenario == 'second-exit-rewind':
                assert recorded[0]['single_escape_exits'] == [True, False], scenario
                assert commands.count('Escape') == 2
                assert opens == ['footer', 'footer']
                assert not any(key in ('S-Down', 'S-Up') for key in commands)
                assert recorded[0]['entry_paths'] == {
                    'footer': True, 'shift': False, 'spinner': False, 'tasks': False,
                }
                assert not (run_dir / 'shift-selection.txt').exists()
                assert log[-1] == '[viewed_agent_changed] before=task-real after=main reason=exit\n'
            if scenario in ('no-exit', 'stale-exit', 'wrong-exit-task',
                            'still-viewing', 'empty-main', 'unrelated-main',
                            'parent-only', 'rewind-with-input'):
                assert not recorded[0]['exited'], scenario
                assert recorded[0]['single_escape_exits'] == [False], scenario
                assert commands.count('Escape') == 1
            if scenario == 'team-only':
                assert not opens
            assert server.retention_stopped.is_set()
            if scenario == 'pass':
                assert opens == ['footer', 'footer', 'shift', 'spinner', 'tasks']
                assert commands.count('Escape') == 5
                assert all(recorded[0]['entry_paths'].values())
                assert len(recorded[0]['assertions']) == 9
            if scenario in ('no-shift', 'no-spinner', 'no-tasks'):
                assert not recorded[0]['entry_paths'][scenario[3:]]
                assert any(not assertion['passed'] for assertion in recorded[0]['assertions'])

    with tempfile.TemporaryDirectory(prefix='release-retention-active-turn-') as root_string:
        server = module.MockOpenAIServer(Path(root_string), 'transcript-retention')
        responses = []
        child_body = {'input': [{'role': 'user', 'content': 'RELEASE_RETENTION_CHILD_REQUEST'}]}
        worker = threading.Thread(target=lambda: responses.append(server.response_for(child_body)))
        try:
            assert hasattr(server, 'retention_child_waiting')
            worker.start()
            assert server.retention_child_waiting.wait(2)
            assert worker.is_alive()
            server.retention_child_release.set()
            worker.join(2)
            assert responses[0][0] == 'retention-child-cancelled'
            resumed = server.response_for({'input': child_body['input'] + [
                {'role': 'user', 'content': 'RELEASE_RETENTION_RESUME'}]})
            assert resumed[0] == 'retention-worker-marker'
            assert 'RELEASE_RETENTION_WORKER_DONE' in resumed[1]
        finally:
            server.stop()
            if worker.ident is not None:
                worker.join(2)

    assert 'transcript-retention' in module.MOCK_OPENAI_TARGETS
    with tempfile.TemporaryDirectory(prefix='release-driver-retention-') as root_string:
        run_dir = Path(root_string)
        server = module.MockOpenAIServer(run_dir, 'transcript-retention')
        base_url = server.start()

        def retention_request(items):
            request = Request(
                f'{base_url}/v1/responses',
                data=json.dumps({'input': items}).encode(),
                headers={'Content-Type': 'application/json',
                         'Authorization': f'Bearer {module.DUMMY_OPENAI_API_KEY}'},
            )
            with urlopen(request, timeout=5) as response:
                return response.read().decode()

        def retention_output(name):
            return {'type': 'function_call_output', 'call_id': f'fc_retention_{name}', 'output': 'ok'}

        parent = [{'role': 'user', 'content': 'Transcript retention binary validation.'}]
        child = [{'role': 'user', 'content': 'RELEASE_RETENTION_CHILD_REQUEST'},
                 {'role': 'user', 'content': 'RELEASE_RETENTION_RESUME'}]
        results = []
        try:
            team = retention_request(parent)
            assert '"name":"TeamCreate"' in team
            assert retention_request(parent + [{'type': 'function_call', 'arguments': 'RELEASE_RETENTION_CHILD_REQUEST'}]) == team
            agent = retention_request(parent + [retention_output('team')])
            assert '"name":"Agent"' in agent
            assert '\\"run_in_background\\":true' in agent
            assert 'retention-worker' in agent
            assert 'RELEASE_RETENTION_WORKER_DONE' in retention_request(child)
            assert server.response_for({'instructions': module.TITLE_GENERATION_INSTRUCTION})[0] == 'title'
            probe_input = parent + [retention_output('shutdown'), {
                'role': 'user', 'content': 'RELEASE_RETENTION_PROBE task-real before',
            }]
            probe = retention_request(probe_input)
            reminder = {'type': 'input_text', 'text': '<system-reminder>Reminder</system-reminder>'}
            for command, marker in [('RELEASE_RETENTION_PROBE task-real before', '"name":"TaskOutput"'),
                                    ('RELEASE_RETENTION_GC_TICK', 'RELEASE_RETENTION_GC_TICK_DONE')]:
                assert marker in retention_request(parent + [retention_output('shutdown'), {
                    'role': 'user', 'content': [{'type': 'input_text', 'text': command}, reminder],
                }])
            assert '"name":"TaskOutput"' in probe
            assert '\\"task_id\\":\\"task-real\\"' in probe
            assert '\\"block\\":false' in probe
            probe_result = probe_input + [{
                'type': 'function_call_output', 'call_id': 'fc_retention_probe_before',
                'output': 'actual tool result',
            }]
            assert 'RELEASE_RETENTION_PROBE_BEFORE_DONE' in retention_request(probe_result)
            assert 'RELEASE_RETENTION_GC_TICK_DONE' in retention_request(parent + [
                retention_output('shutdown'), {'role': 'user', 'content': 'RELEASE_RETENTION_GC_TICK'},
            ])
            worker = threading.Thread(target=lambda: results.append(retention_request(parent + [retention_output('agent')])))
            worker.start()
            assert server.retention_parent_waiting.wait(2)
            assert worker.is_alive()
            assert retention_request(parent) == team
            server.retention_release.set()
            worker.join(3)
            assert not worker.is_alive()
            assert 'shutdown_request' in results[0]
            shutdown = child + [{'role': 'user', 'content': [{
                'type': 'input_text', 'text': '<teammate-message teammate_id="team-lead">' + json.dumps({
                    'type': 'shutdown_request', 'requestId': 'actual-request-123', 'from': 'team-lead',
                }) + '</teammate-message>',
            }]}]
            approval = retention_request(shutdown)
            assert '"name":"SendMessage"' in approval
            assert '\\"to\\":\\"team-lead\\"' in approval
            assert '\\"request_id\\":\\"actual-request-123\\"' in approval
            assert '\\"approve\\":true' in approval
            assert 'shutdown_response' not in retention_request(child + [{'role': 'user', 'content': '{"type":"shutdown_request"}'}])
            assert 'shutdown_response' not in retention_request(child + [{'role': 'assistant', 'content': json.dumps({'type': 'shutdown_request', 'requestId': 'wrong'})}])
            assert 'RELEASE_RETENTION_PARENT_OK' in retention_request(parent + [retention_output('shutdown')])
            server.retention_release.clear()
            server.retention_parent_waiting.clear()
            results.clear()
            worker = threading.Thread(target=lambda: results.append(retention_request(parent + [retention_output('agent')])))
            worker.start()
            assert server.retention_parent_waiting.wait(2)
            assert server.stop()['stopped']
            worker.join(3)
            assert not worker.is_alive()
            assert 'shutdown_request' not in results[0]
            assert all(item['authorization']['matches_dummy'] for item in server.snapshot())
        finally:
            server.stop()

        gate = object.__new__(module.BinaryGate)
        gate.repo = run_dir / 'repo'
        gate.evidence_root = run_dir
        gate.auth_source = run_dir / 'must-not-read-auth'
        gate.auth_homes = set()
        fixture_dir = run_dir / 'fixture'
        fixture_dir.mkdir()
        try:
            _, home = gate.make_fixture(fixture_dir, 'transcript-retention')
            assert json.loads((home / '.codex/auth.json').read_text()) == {'OPENAI_API_KEY': module.DUMMY_OPENAI_API_KEY}
            assert json.loads((fixture_dir / 'auth-source-metadata.json').read_text())['source'] is None
        finally:
            for home in gate.auth_homes:
                shutil.rmtree(home)

    for label in ('workflow-failure-detail', 'workflow-retry-partial-failure'):
        assert label in module.MOCK_OPENAI_TARGETS
        with tempfile.TemporaryDirectory(prefix='release-workflow-protocol-') as directory:
            server = module.MockOpenAIServer(Path(directory), label)
            script = module.WORKFLOW_FAULT_SCRIPTS[label]
            parent = [{'role': 'user', 'content': 'Use Workflow with this exact inline script.\n```js\n' + script + '```'}]
            kind, wire = server.response_for({'input': parent})
            assert kind == 'workflow-search' and 'ToolSearch' in wire
            parent.append({'type': 'function_call_output', 'call_id': 'fc_workflow_search', 'output': 'Workflow discovered'})
            kind, wire = server.response_for({'input': parent})
            assert kind == 'workflow-launch' and '"name":"Workflow"' in wire
            parent.append({'type': 'function_call_output', 'call_id': 'fc_workflow_launch', 'output': 'Workflow launched in background. Task ID: wfixture'})
            assert server.response_for({'input': parent})[0] == 'workflow-parent-completed'
            assert server.response_for({'input': [{'role': 'user', 'content': 'unknown'}]})[0] == 'workflow-unrecognized'
            if label == 'workflow-retry-partial-failure':
                for worker in ('transient', 'stable'):
                    kind, wire = server.response_for({'input': [{'role': 'user', 'content': f'Return exactly {worker}-worker-ok.'}]})
                    assert kind == f'workflow-{worker}-completed' and f'{worker}-worker-ok' in wire
                    kind, wire = server.response_for({'input': [{'role': 'user', 'content': [
                        {'type': 'input_text', 'text': '<system-reminder>Runtime context</system-reminder>'},
                        {'type': 'input_text', 'text': f'Return exactly {worker}-worker-ok.'},
                    ]}]})
                    assert kind == f'workflow-{worker}-completed'
            gate = object.__new__(module.BinaryGate)
            gate.mock_servers = {Path(directory).name: server}
            kinds = ['workflow-search', 'workflow-launch', 'workflow-parent-completed']
            if label == 'workflow-retry-partial-failure':
                kinds += ['workflow-transient-completed', 'workflow-stable-completed']
            server.requests = [
                {'method': 'POST', 'path': '/v1/responses', 'body': {'input': []},
                 'response_kind': kind, 'authorization': {'matches_dummy': True}}
                for kind in kinds
            ]
            server.flush()
            assert gate.workflow_mock_wire(Path(directory), label)['validation_verdict'] == 'passed'
            server.requests.append(server.requests[1])
            assert gate.workflow_mock_wire(Path(directory), label)['validation_verdict'] == 'failed'
            server.requests.pop()
            server.requests[0]['authorization']['matches_dummy'] = False
            assert gate.workflow_mock_wire(Path(directory), label)['validation_verdict'] == 'failed'

    assert 'coordinator-selector' in module.MOCK_OPENAI_TARGETS
    with tempfile.TemporaryDirectory(prefix='release-driver-coordinator-') as root_string:
        run_dir = Path(root_string)
        server = module.MockOpenAIServer(run_dir, 'coordinator-selector')
        base_url = server.start()

        def coordinator_request(items):
            request = Request(
                f'{base_url}/v1/responses',
                data=json.dumps({'input': items}).encode(),
                headers={
                    'Content-Type': 'application/json',
                    'Authorization': f'Bearer {module.DUMMY_OPENAI_API_KEY}',
                },
            )
            with urlopen(request, timeout=5) as response:
                return response.read().decode()

        def tool_output(call_id, output):
            return {'type': 'function_call_output', 'call_id': call_id, 'output': output}

        parent = [{'role': 'user', 'content': 'Coordinator selector binary validation.'}]
        child = [{'role': 'user', 'content': 'RELEASE_COORDINATOR_CHILD_REQUEST'}]
        try:
            agent = coordinator_request(parent)
            assert '"name":"Agent"' in agent
            assert '\\"run_in_background\\":false' in agent
            assert 'RELEASE_COORDINATOR_CHILD_REQUEST' in agent
            bash = coordinator_request(child)
            assert '"name":"Bash"' in bash
            assert 'fc_release_coordinator_bash' in bash
            assert coordinator_request(parent) == agent
            assert coordinator_request(parent + [{
                'type': 'function_call', 'name': 'Agent',
                'arguments': json.dumps({'prompt': 'RELEASE_COORDINATOR_CHILD_REQUEST'}),
            }]) == agent
            assert server.response_for({'instructions': module.TITLE_GENERATION_INSTRUCTION, 'input': parent})[0] == 'title'
            assert coordinator_request(child + [tool_output('unrelated', 'ok')]) == bash
            parent_done = coordinator_request(parent + [tool_output('fc_release_coordinator_agent', 'background task result')])
            assert 'RELEASE_COORDINATOR_PARENT_OK' in parent_done
            read = coordinator_request(child + [tool_output('fc_release_coordinator_bash', 'RELEASE_COORDINATOR_BASH_OK')])
            assert '"name":"Read"' in read
            assert 'Makefile' in read
            results = []
            worker = threading.Thread(target=lambda: results.append(coordinator_request(child + [
                tool_output('fc_release_coordinator_bash', 'RELEASE_COORDINATOR_BASH_OK'),
                tool_output('fc_release_coordinator_read', 'VERSION := test'),
            ])))
            worker.start()
            assert server.coordinator_tools_done.wait(2)
            assert worker.is_alive()
            assert coordinator_request(parent + [tool_output('fc_release_coordinator_agent', 'done')]) == parent_done
            server.coordinator_release.set()
            worker.join(3)
            assert not worker.is_alive()
            assert 'RELEASE_COORDINATOR_CHILD_OK' in results[0]
            assert all(item['authorization']['matches_dummy'] for item in server.snapshot())
            assert module.DUMMY_OPENAI_API_KEY not in (run_dir / 'mock-openai-requests.json').read_text()
            server.coordinator_release.clear()
            server.coordinator_tools_done.clear()
            results.clear()
            worker = threading.Thread(target=lambda: results.append(coordinator_request(child + [
                tool_output('fc_release_coordinator_read', 'VERSION := test'),
            ])))
            worker.start()
            assert server.coordinator_tools_done.wait(2)
            assert server.stop()['stopped']
            worker.join(3)
            assert not worker.is_alive()
            assert 'RELEASE_COORDINATOR_CHILD_OK' not in results[0]
        finally:
            server.stop()

        gate = object.__new__(module.BinaryGate)
        gate.repo = run_dir / 'repo'
        gate.evidence_root = run_dir
        gate.auth_source = run_dir / 'must-not-read-auth'
        gate.auth_homes = set()
        fixture_dir = run_dir / 'fixture'
        fixture_dir.mkdir()
        try:
            _, home = gate.make_fixture(fixture_dir, 'coordinator-selector')
            assert json.loads((home / '.codex/auth.json').read_text()) == {'OPENAI_API_KEY': module.DUMMY_OPENAI_API_KEY}
            assert json.loads((fixture_dir / 'auth-source-metadata.json').read_text())['source'] is None
        finally:
            for home in gate.auth_homes:
                shutil.rmtree(home)

    with tempfile.TemporaryDirectory(prefix='release-driver-mock-openai-') as root_string:
        run_dir = Path(root_string)
        server = module.MockOpenAIServer(
            run_dir,
            'model-internal-update-config-skill',
        )
        base_url = server.start()
        try:
            model_request = Request(
                f'{base_url}/v1/models',
                headers={'Authorization': f'Bearer {module.DUMMY_OPENAI_API_KEY}'},
            )
            with urlopen(model_request, timeout=5) as response:
                models = json.loads(response.read())
            assert models['data'][0]['id'] == 'gpt-release-discovered'

            empty_run_dir = run_dir / 'empty'
            empty_run_dir.mkdir()
            empty_server = module.MockOpenAIServer(
                empty_run_dir,
                'model-discovery-empty-picker',
            )
            empty_base_url = empty_server.start()
            try:
                empty_request = Request(
                    f'{empty_base_url}/v1/models',
                    headers={
                        'Authorization': f'Bearer {module.DUMMY_OPENAI_API_KEY}'
                    },
                )
                with urlopen(empty_request, timeout=5) as response:
                    assert json.loads(response.read()) == {'data': []}
            finally:
                assert empty_server.stop() == {
                    'stopped': True,
                    'thread_alive': False,
                    'active_handlers': [],
                }

            def post_response(server_url, *, instructions, input_items=None):
                payload = {
                    'model': 'gpt-release-discovered',
                    'instructions': instructions,
                }
                if input_items is not None:
                    payload['input'] = input_items
                response_request = Request(
                    f'{server_url}/v1/responses',
                    data=json.dumps(payload).encode(),
                    method='POST',
                    headers={
                        'Authorization': f'Bearer {module.DUMMY_OPENAI_API_KEY}',
                        'Content-Type': 'application/json',
                    },
                )
                with urlopen(response_request, timeout=5) as response:
                    return response.read().decode()

            title_sse = post_response(
                base_url,
                instructions=module.TITLE_GENERATION_INSTRUCTION,
            )
            title_events = [
                json.loads(line[6:])
                for line in title_sse.splitlines()
                if line.startswith('data: ')
            ]
            assert title_events[0] == {
                'type': 'response.output_text.delta',
                'delta': '{"title":"Release validation"}',
            }
            assert title_events[-1]['type'] == 'response.completed'
            assert 'response.function_call_arguments.done' not in title_sse

            first_sse = post_response(
                base_url,
                instructions='normal system prompt',
            )
            assert 'response.function_call_arguments.done' in first_sse
            assert 'update-config' in first_sse

            second_sse = post_response(
                base_url,
                instructions='normal system prompt',
            )
            assert 'RELEASE_UPDATE_CONFIG_SKILL_OK' in second_sse
            assert 'response.reasoning_summary_text.delta' in module.sse_completed(
                'done',
                reasoning='reasoning marker',
            )
            requests = server.snapshot()
            assert [request['response_kind'] for request in requests] == [
                'models',
                'title',
                'skill-call',
                'completed',
            ]
            assert all(
                request['authorization'] == {
                    'present': True,
                    'matches_dummy': True,
                }
                for request in requests
            )
            assert module.DUMMY_OPENAI_API_KEY not in (
                run_dir / 'mock-openai-requests.json'
            ).read_text()

            image_run_dir = run_dir / 'image'
            image_run_dir.mkdir()
            image_server = module.MockOpenAIServer(
                image_run_dir,
                'openai-image-input-wire',
            )
            image_base_url = image_server.start()
            try:
                read_sse = post_response(
                    image_base_url,
                    instructions='normal system prompt',
                    input_items=[{
                        'type': 'message',
                        'role': 'user',
                        'content': [{
                            'type': 'input_text',
                            'text': 'read image',
                        }],
                    }],
                )
                assert 'response.function_call_arguments.done' in read_sse
                assert str(image_run_dir / 'fixture.png') in read_sse
                completed_sse = post_response(
                    image_base_url,
                    instructions='normal system prompt',
                    input_items=[{
                        'type': 'function_call_output',
                        'call_id': 'fc_release_read_image',
                        'output': [],
                    }],
                )
                assert 'RELEASE_OPENAI_IMAGE_WIRE_OK' in completed_sse
                assert [
                    request['response_kind']
                    for request in image_server.snapshot()
                ] == ['read-call', 'completed']
            finally:
                assert image_server.stop() == {
                    'stopped': True,
                    'thread_alive': False,
                    'active_handlers': [],
                }

            compaction_run_dir = run_dir / 'compaction'
            compaction_run_dir.mkdir()
            compaction_server = module.MockOpenAIServer(
                compaction_run_dir,
                'openai-remote-compaction',
            )
            compaction_base_url = compaction_server.start()
            try:
                def post_compaction(input_items):
                    return post_response(
                        compaction_base_url,
                        instructions='normal system prompt',
                        input_items=input_items,
                    )

                seed_sse = post_compaction([{
                    'type': 'message',
                    'role': 'user',
                    'content': [{'type': 'input_text', 'text': 'seed'}],
                }])
                assert 'RELEASE_COMPACTION_SEED_OK' in seed_sse
                first_compact_sse = post_compaction([
                    {'type': 'message', 'role': 'user', 'content': []},
                    {'type': 'compaction_trigger'},
                ])
                assert '"type":"compaction"' in first_compact_sse
                assert 'release-opaque-state-0' in first_compact_sse
                continuation = {
                    'type': 'compaction',
                    'id': 'cmp_release_0',
                    'encrypted_content': 'release-opaque-state-0',
                }
                continuation_sse = post_compaction([
                    continuation,
                    {'type': 'message', 'role': 'user', 'content': []},
                ])
                assert 'RELEASE_COMPACTION_CONTINUATION_OK' in continuation_sse
                second_compact_sse = post_compaction([
                    continuation,
                    {'type': 'message', 'role': 'user', 'content': []},
                    {'type': 'compaction_trigger'},
                ])
                assert 'release-opaque-state-1' in second_compact_sse
                assert [
                    request['response_kind']
                    for request in compaction_server.snapshot()
                ] == [
                    'completed',
                    'compaction',
                    'completed',
                    'compaction',
                ]
            finally:
                assert compaction_server.stop() == {
                    'stopped': True,
                    'thread_alive': False,
                    'active_handlers': [],
                }

            subagent_run_dir = run_dir / 'subagent-stop'
            subagent_run_dir.mkdir()
            subagent_server = module.MockOpenAIServer(
                subagent_run_dir,
                'subagent-stop-failure-lifecycle',
            )
            subagent_base_url = subagent_server.start()
            try:
                def post_subagent(input_items):
                    return post_response(
                        subagent_base_url,
                        instructions='normal system prompt',
                        input_items=input_items,
                    )

                first_subagent_sse = post_subagent([{
                    'type': 'message',
                    'role': 'user',
                    'content': [{'type': 'input_text', 'text': 'start'}],
                }])
                assert 'fc_release_subagent_stop' in first_subagent_sse
                assert '"name":"Agent"' in first_subagent_sse
                second_subagent_sse = post_subagent([{
                    'type': 'function_call_output',
                    'call_id': 'fc_release_subagent_stop',
                    'output': 'Error: RELEASE_SUBAGENT_QUERY_FAILURE',
                }])
                assert 'RELEASE_SUBAGENT_STOP_PARENT_OK' in second_subagent_sse
                assert [
                    request['response_kind']
                    for request in subagent_server.snapshot()
                ] == ['agent-call', 'parent-completed']
            finally:
                assert subagent_server.stop() == {
                    'stopped': True,
                    'thread_alive': False,
                    'active_handlers': [],
                }
        finally:
            cleanup = server.stop()
        assert cleanup == {'stopped': True, 'thread_alive': False, 'active_handlers': []}

    framed_custom_instructions = (
        'fixed release framing\n'
        + module.CUSTOM_SYSTEM_PROMPT_MARKER
        + '\nfixed repository context'
    )
    assert module.custom_prompt_instructions_stable([
        {'instructions': framed_custom_instructions},
        {'instructions': framed_custom_instructions},
    ]) is True
    assert module.custom_prompt_instructions_stable([
        {'instructions': framed_custom_instructions},
        {'instructions': framed_custom_instructions.replace(
            module.CUSTOM_SYSTEM_PROMPT_MARKER,
            module.CUSTOM_SYSTEM_PROMPT_MARKER * 2,
        )},
    ]) is False
    assert module.custom_prompt_instructions_stable([
        {'instructions': framed_custom_instructions},
        {'instructions': framed_custom_instructions + '\nchanged'},
    ]) is False

    with tempfile.TemporaryDirectory(prefix='release-driver-targets-') as root_string:
        root = Path(root_string)
        repo = root / 'repo'
        subprocess.run(['git', '-C', str(root), 'init', str(repo)], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'config', 'user.name', 'Tester'], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'config', 'user.email', 'tester@example.com'], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'config', 'commit.gpgsign', 'false'], check=True, capture_output=True)
        committed_paths = [
            repo / 'src/utils/effort.ts',
            repo / 'src/utils/model/modelOptions.ts',
            repo / 'src/utils/model/openaiModelOptions.ts',
            repo / 'src/skills/bundled/updateConfig.ts',
            repo / 'src/utils/promptLayers.ts',
            repo / 'src/utils/swarm/teamHelpers.ts',
        ]
        for path in committed_paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('before\n')
        staged = repo / 'src/components/PromptInput/PromptInput.tsx'
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_text('baseline staged\n')
        unstaged = repo / 'src/tools/WorkflowTool/workflowScriptRuntime.ts'
        unstaged.parent.mkdir(parents=True, exist_ok=True)
        unstaged.write_text('baseline unstaged\n')
        subprocess.run([
            'git', '-C', str(repo), 'add',
            *(str(path.relative_to(repo)) for path in committed_paths),
            str(staged.relative_to(repo)),
            str(unstaged.relative_to(repo)),
        ], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'commit', '-m', 'init'], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'tag', 'v0.0.1'], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'branch', 'origin/master'], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'branch', '-M', 'feature'], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'branch', '--set-upstream-to', 'origin/master'], check=True, capture_output=True)

        for path in committed_paths:
            path.write_text('after\n')
        subprocess.run([
            'git', '-C', str(repo), 'add',
            *(str(path.relative_to(repo)) for path in committed_paths),
        ], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'commit', '-m', 'change'], check=True, capture_output=True)
        assert baseline_module.default_release_base_ref(repo) == 'v0.0.1'

        staged.write_text('staged\n')
        subprocess.run(['git', '-C', str(repo), 'add', str(staged.relative_to(repo))], check=True, capture_output=True)

        unstaged.write_text('unstaged\n')

        untracked = repo / 'src/utils/swarm/inProcessRunner.ts'
        untracked.parent.mkdir(parents=True, exist_ok=True)
        untracked.write_text('untracked\n')

        release_base_commit = subprocess.run(
            ['git', '-C', str(repo), 'rev-parse', 'v0.0.1^{commit}'],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        subprocess.run(
            ['git', '-C', str(repo), 'branch', '-f', 'origin/master', 'HEAD'],
            check=True,
            capture_output=True,
        )
        baseline = {
            'upstream': 'origin/master',
            'release_base_ref': 'origin/master',
            'release_base_commit': release_base_commit,
        }
        inputs = module.collect_required_target_inputs(repo, baseline)
        assert inputs['release_base']['base_ref'] == 'origin/master'
        assert inputs['release_base']['merge_base'] == release_base_commit
        assert inputs['release_base']['source'] == 'baseline immutable release base commit'
        assert inputs['paths_by_source']['committed_release_range'] == [
            'src/skills/bundled/updateConfig.ts',
            'src/utils/effort.ts',
            'src/utils/model/modelOptions.ts',
            'src/utils/model/openaiModelOptions.ts',
            'src/utils/promptLayers.ts',
            'src/utils/swarm/teamHelpers.ts',
        ]
        assert inputs['paths_by_source']['staged'] == [
            'src/components/PromptInput/PromptInput.tsx'
        ]
        assert inputs['paths_by_source']['unstaged'] == [
            'src/tools/WorkflowTool/workflowScriptRuntime.ts'
        ]
        assert inputs['paths_by_source']['untracked'] == [
            'src/utils/swarm/inProcessRunner.ts'
        ]
        assert module.required_targets_for_paths(inputs['all_paths']) == required
        explicit = module.collect_required_target_inputs(repo, {}, explicit_base_ref='origin/master')
        assert explicit['release_base']['base_ref'] == 'origin/master'
        assert 'origin/master..HEAD' not in module.code_review_prompt(
            explicit['release_base']['merge_base']
        )
        assert (
            f"{explicit['release_base']['merge_base']}..HEAD"
            in module.code_review_prompt(explicit['release_base']['merge_base'])
        )
        try:
            module.collect_required_target_inputs(repo, {'upstream': 'origin/master'})
        except RuntimeError as error:
            assert 'release_base_commit' in str(error)
            assert '--base-ref <commit-ish>' in str(error)
        else:
            raise AssertionError('expected missing release base to fail closed')

        try:
            module.collect_required_target_inputs(repo, {})
        except RuntimeError as error:
            assert '--base-ref <commit-ish>' in str(error)
        else:
            raise AssertionError('expected missing release base to fail closed')

    assert module.submitted_input_pending(
        '❯ /deep-research inspect workflow behavior\n'
    ) is True
    assert module.submitted_input_pending(
        '❯ /deep-research inspect workflow behavior\n✶ Working…\n❯ \n'
    ) is False
    assert module.submitted_input_pending(
        '❯ /deep-research old request\n'
        '● Finished old request\n'
        '❯ /deep-research current request\n'
    ) is True
    assert module.submitted_input_pending(
        '────────────────────────────────────────\n'
        '❯ /code-review high Read-only validation using exactly: git diff base..HEAD -- first.ts\n'
        '  second.ts. Do not modify files or create worktrees.\n'
        '────────────────────────────────────────\n'
        '  bypass permissions on  Debug mode\n'
    ) is True
    assert module.submitted_input_pending(
        '────────────────────────────────────────\n'
        '❯ /workflows\n'
        '────────────────────────────────────────\n'
        '  /workflows  View dynamic workflow runs\n'
        '  /workflow-help  Another suggestion\n'
    ) is True
    assert module.submitted_input_pending(
        '❯ /stats\n'
        '────────────────────────────────────────\n'
        '  Status   Config   Usage   Stats\n'
        '  Overview   Models   OpenAI\n'
        '  No stats available yet. Start using Claude Code!\n'
    ) is False
    assert module.submitted_input_pending(
        '❯ RELEASE_RETENTION_RESUME\n'
        '⏺ RELEASE_RETENTION_WORKER_DONE\n'
        '──────────────────────────── @retention-worker ──\n'
        '❯ Message @retention-worker…\n'
        '────────────────────────────────────────\n'
        '  @main @retention-worker · shift + ↓ to expand\n'
    ) is False
    assert module.submitted_input_pending(
        '❯ RELEASE_RETENTION_RESUME\n'
        '────────────────────────────────────────\n'
        '  @main @retention-worker · shift + ↓ to expand\n'
        '  bypass permissions on  Debug mode\n'
    ) is True
    assert module.submitted_input_pending(
        '❯ Inspect the prompt cache boundary without implementation.\n'
        '────────────────────────────────────────\n'
        '  plan mode on  high · /effort\n'
        '  Debug mode\n'
    ) is True
    assert module.submitted_input_visible(
        '❯ RELEASE_SSH_TASK_START\n'
        '────────────────────────────────────────\n'
        '  Native installation exists but ~/.local/bin is not in your PATH.\n'
        '  Goal is set\n',
        'RELEASE_SSH_TASK_START',
    ) is True
    assert module.submitted_input_visible(
        '❯ /workflows detail wp5qaxd20\n'
        '────────────────────────────────────────\n'
        '  bypass permissions on  Debug mode\n'
        '  ◯ release-failure-detail  failed  1/1 agents\n',
        '/workflows detail wp5qaxd20',
    ) is True
    assert module.submitted_input_visible(
        '❯ Use Workflow with this exact inline script.\n'
        '  ```js\n'
        "  const value = await agent('Return a value.')\n"
        '  return value\n'
        '  ```\n'
        '────────────────────────────────────────\n',
        "Use Workflow with this exact inline script.\n```js\n"
        "const value = await agent('Return a value.')\n"
        'return value\n```',
    ) is True
    assert module.submitted_input_visible(
        '❯ [Pasted text #1 +4 lines]\n'
        '────────────────────────────────────────\n'
        '  bypass permissions on  Debug mode\n',
        "Use Workflow with this exact inline script.\n```js\n"
        "const value = await agent('Return a value.')\n"
        'return value\n```',
    ) is True
    assert module.submitted_input_visible(
        '❯ [Pasted text #1 +3 lines]\n'
        '────────────────────────────────────────\n',
        "Use Workflow with this exact inline script.\n```js\n"
        "const value = await agent('Return a value.')\n"
        'return value\n```',
    ) is False
    assert module.submitted_input_visible(
        '❯ /code-review high Read-only validation using exactly: git diff base..HEAD -- first.ts\n'
        '  second.ts. Do not widen the diff range or path scope, run repository-wide searches, inspect unrelated commits, modify files, commit, push, release, or create\n'
        '  worktrees.\n'
        '────────────────────────────────────────\n',
        '/code-review high Read-only validation using exactly: git diff base..HEAD -- first.ts\n'
        'second.ts. Do not widen the diff range or path scope, run repository-wide searches, inspect unrelated commits, modify files, commit, push, release, or create worktrees.',
    ) is True
    assert module.submitted_input_visible(
        '❯ RELEASE_SSH_TASK_START\n',
        'different input',
    ) is False
    assert module.submitted_input_pending('❯ \n') is False
    assert module.input_prompt_ready('❯ /goal wait for token\nGoal is set\n') is False
    assert module.input_prompt_ready(
        '❯ /goal wait for token\nGoal is set\n✶ Working…\n❯ \n'
        'esc to interrupt\n'
    ) is False
    assert module.input_prompt_ready(
        '❯ /goal wait for token\nGoal is set\n❯ \n'
    ) is True
    assert module.input_prompt_ready('status without prompt\n') is False

    title_request = {
        'method': 'POST',
        'path': '/v1/responses',
        'body': {
            'instructions': (
                'system prefix\n'
                + module.TITLE_GENERATION_INSTRUCTION
                + ' (3-7 words)\nReturn JSON.'
            ),
        },
    }
    main_request = {
        'method': 'POST',
        'path': '/v1/responses',
        'body': {'instructions': 'normal system prompt'},
    }
    mock_gate = object.__new__(module.BinaryGate)
    mock_gate.mock_servers = {
        'run': type(
            'SnapshotServer',
            (),
            {'snapshot': lambda self: [title_request, main_request]},
        )(),
    }
    assert mock_gate.mock_response_requests(Path('run')) == [main_request]

    assert module.parse_target_list(None) == []
    assert module.parse_target_list('team-concurrency,workflow') == [
        'team-concurrency', 'workflow'
    ]
    for raw, expected in (
        ('', 'targets must not be empty'),
        ('workflow,,team-concurrency', 'empty target'),
        ('workflow,workflow', 'duplicate target'),
    ):
        try:
            module.parse_target_list(raw)
        except ValueError as error:
            assert expected in str(error)
        else:
            raise AssertionError(f'expected parse_target_list({raw!r}) to fail')

    code_review_prompt = module.code_review_prompt('release-base-sha')
    assert (
        'git diff release-base-sha..HEAD -- '
        'src/tools/WorkflowTool/bundled/index.ts '
        'src/tools/WorkflowTool/bundled/index.test.ts'
    ) in code_review_prompt
    assert 'Do not widen the diff range or path scope' in code_review_prompt
    assert 'current changes' not in code_review_prompt
    assert 'src/tools/AgentTool' not in code_review_prompt
    assert 'src/tasks/LocalWorkflowTask' not in code_review_prompt
    assert 'src/utils/sessionStorage.ts' not in code_review_prompt

    planned = module.plan_targets(['team-concurrency'], {'workflow-failure-detail'})
    assert planned == ['workflow-failure-detail', 'team-concurrency']
    assert module.plan_targets(['builtin-mods'], {'agent-fg-bg'}) == ['agent-fg-bg', 'builtin-mods']
    for path in (
        'src/tasks/InProcessTeammateTask/types.ts',
        'src/hooks/useBackgroundTaskNavigation.ts',
        'src/components/tasks/BackgroundTasksDialog.tsx',
        'src/components/tasks/InProcessTeammateDetailDialog.tsx',
        'src/components/tasks/backgroundTasksDialogState.ts',
        'src/components/PromptInput/PromptInput.tsx',
    ):
        assert 'transcript-retention' in module.required_targets_for_paths([path]), path
    assert module.plan_targets([], {'ssh-remote-session-lifecycle'}) == [
        'ssh-remote-session-lifecycle',
    ]
    assert module.required_targets_for_paths([
        'scripts/mods-test-lab.mjs',
        'src/services/mods/runtime.ts',
        'src/components/ModsPane.tsx',
    ]) == {'builtin-mods', 'terminal-interaction', 'terminal-canonical-diff', 'mods-process-spawn'}
    driver_source = Path(module.__file__).read_text()
    for assertion in (
        'completeness', 'cleanup', 'agents', 'diff', 'security', 'ui',
        'dynamicTools', 'suggestionReload', 'telemetry', 'terminalEvidence',
    ):
        assert repr(assertion) in driver_source
    assert 'compiled native sec-default policy and ModsPane interaction' in driver_source
    assert module.required_targets_for_paths([
        'src/components/LogoV2/CondensedLogo.tsx',
        'src/components/diff/DiffView.tsx',
        'src/hooks/useTextInput.ts',
        'src/ink/parse-keypress.ts',
        'src/ink/log-update.ts',
    ]) == {'terminal-interaction', 'terminal-canonical-diff'}
    source_root = Path('/private/tmp/mods-release-source')
    target_root = Path('/private/tmp/release-evidence/builtin-mods/acceptance-cache')
    remapped = module.remap_path_strings({
        'evidence': str(source_root / 'runs/r-123/evidence'),
        'captures': [str(source_root / 'runs/r-123/capture.txt')],
        'target': 'session:0.0',
    }, source_root, target_root)
    assert remapped == {
        'evidence': str(target_root / 'runs/r-123/evidence'),
        'captures': [str(target_root / 'runs/r-123/capture.txt')],
        'target': 'session:0.0',
    }

    with tempfile.TemporaryDirectory(prefix='release-driver-assertions-') as root_string:
        root = Path(root_string)
        source_run = root / 'run-a'
        source_run.mkdir()
        foreign_run = root / 'run-b'
        foreign_run.mkdir()
        source_runs = {'run-a': source_run.resolve(strict=False)}
        valid_assertion = make_required_assertion(source_run)
        assert module.assertion_is_valid(valid_assertion, source_runs) is True
        assert module.assertion_is_valid(
            make_required_assertion(source_run, include_assertion_id=False),
            source_runs,
        ) is False
        assert module.assertion_is_valid(
            make_required_assertion(source_run, include_source_run=False),
            source_runs,
        ) is False
        assert module.assertion_is_valid(
            make_required_assertion(source_run, include_runtime_state=False),
            source_runs,
        ) is False
        assert module.assertion_is_valid(
            make_required_assertion(source_run, runtime_state='invalid-state'),
            source_runs,
        ) is False
        assert module.assertion_is_valid(
            make_required_assertion(source_run, evidence_absolute=False),
            source_runs,
        ) is False
        assert module.assertion_is_valid(
            make_required_assertion(
                source_run,
                create_evidence=False,
                evidence_name='missing.txt',
            ),
            source_runs,
        ) is False
        foreign_assertion = make_required_assertion(source_run)
        foreign_assertion['observed_evidence_paths'] = [str(foreign_run / 'pane.txt')]
        (foreign_run / 'pane.txt').write_text('foreign\n')
        assert module.assertion_is_valid(foreign_assertion, source_runs) is False

        audit_runs = []
        for target in required:
            directory = root / target
            directory.mkdir()
            (directory / 'run-metadata.json').write_text(json.dumps({
                'label': target, 'driver_run': 'driver-a', 'source_run': directory.name,
                'evidence_dir': str(directory.resolve()),
            }))
            audit_runs.append({'label': target, 'validation_verdict': 'passed',
                'driver_run': 'driver-a', 'evidence_dir': str(directory),
                'assertions': [_terminal_acceptance_fixture(module, directory, target)
                    if target in module.TERMINAL_ACCEPTANCE else make_required_assertion(directory)]})
        registered = {str(Path(run['evidence_dir']).resolve()):
                      (Path(run['evidence_dir']) / 'run-metadata.json').read_text()
                      for run in audit_runs}
        # Synthetic terminal fixtures isolate the physical replay process.
        with patch.object(module, 'revalidate_terminal_assertion', return_value=True):
            coverage = module.validate_required_target_results(required, audit_runs, registered)
            assert coverage['passed'] is True
            assert coverage['missing_targets'] == []
            assert coverage['invalid_targets'] == []
            for field, value in [('driver_run', 'foreign-driver'), ('source_run', 'forged'),
                                 ('evidence_dir', str(root)), ('label', 'forged')]:
                metadata_path = Path(audit_runs[0]['evidence_dir']) / 'run-metadata.json'
                original = metadata_path.read_text()
                metadata = json.loads(original)
                metadata[field] = value
                metadata_path.write_text(json.dumps(metadata))
                assert not module.validate_required_target_results(required, audit_runs, registered)['passed'], field
                metadata_path.write_text(original)
            assert not module.validate_required_target_results(required, audit_runs)['passed']
            forged_runs = json.loads(json.dumps(audit_runs))
            for run in forged_runs:
                run['driver_run'] = 'forged-driver'
                path = Path(run['evidence_dir']) / 'run-metadata.json'
                metadata = json.loads(path.read_text())
                metadata['driver_run'] = 'forged-driver'
                path.write_text(json.dumps(metadata))
            assert not module.validate_required_target_results(
                required, forged_runs, registered)['passed']
            for directory, original in registered.items():
                (Path(directory) / 'run-metadata.json').write_text(original)
            forged_runs = json.loads(json.dumps(audit_runs))
            forged_dir = root / 'unregistered-source'
            forged_dir.mkdir()
            forged = forged_runs[0]
            forged['evidence_dir'] = str(forged_dir)
            forged['assertions'] = [make_required_assertion(forged_dir)]
            (forged_dir / 'run-metadata.json').write_text(json.dumps({
                'label': forged['label'], 'driver_run': 'driver-a',
                'source_run': forged_dir.name, 'evidence_dir': str(forged_dir.resolve()),
            }))
            assert not module.validate_required_target_results(required, forged_runs, registered)['passed']
            cross_target = json.loads(json.dumps(audit_runs))
            assert module.validate_required_target_results(required, cross_target, registered)['passed']
            cross_target[0]['assertions'] = cross_target[1]['assertions']
            assert not module.validate_required_target_results(required, cross_target, registered)['passed']
            cross_run = json.loads(json.dumps(audit_runs))
            assert module.validate_required_target_results(required, cross_run, registered)['passed']
            cross_run[0]['driver_run'] = 'foreign-driver'
            assert not module.validate_required_target_results(required, cross_run, registered)['passed']
            assert not module.validate_required_target_results({'audit'}, [{
                'label': 'audit', 'validation_verdict': 'passed',
                'evidence_dir': str(source_run), 'driver_run': 'driver-a',
                'assertions': [make_required_assertion(source_run)],
            }])['passed'], 'missing source metadata must not pass'

        coverage = module.validate_required_target_results(
            required,
            [{
                'label': 'team-concurrency',
                'validation_verdict': 'passed',
                'evidence_dir': str(source_run),
                'assertions': [],
            }],
        )
        assert coverage['passed'] is False
        assert 'workflow-retry-partial-failure' in coverage['missing_targets']
        assert coverage['invalid_targets'] == ['team-concurrency']

        coverage = module.validate_required_target_results(
            {'workflow-failure-detail'},
            [{
                'label': 'workflow-failure-detail',
                'validation_verdict': 'passed',
                'evidence_dir': str(source_run),
                'assertions': [foreign_assertion],
            }],
        )
        assert coverage['passed'] is False
        assert coverage['invalid_targets'] == ['workflow-failure-detail']

    driver = DRIVER_PATH.read_text()
    assert module.openai_request_metadata_matches(
        {
            'session-id': 'cache-key',
            'thread-id': 'cache-key',
            'x-client-request-id': 'request-1',
            'x-app': 'cli',
            'x-claude-code-session-id': 'cache-key',
            'user-agent': 'claude-code/test',
        },
        'cache-key',
    ) is True
    assert module.openai_request_metadata_matches(
        {
            'session-id': 'cache-key',
            'thread-id': 'cache-key',
            'x-client-request-id': '',
            'x-app': 'cli',
            'x-claude-code-session-id': 'cache-key',
            'user-agent': 'claude-code/test',
        },
        'cache-key',
    ) is False
    cleanup_gate = object.__new__(module.BinaryGate)
    cleanup_base = {
        'process_remaining': False,
        'forced_termination': [],
        'mock_server': {'stopped': True, 'thread_alive': False},
    }
    assert cleanup_gate.cleanup_passed({
        **cleanup_base,
        'kill_exit': 1,
        'session_exists_after': False,
    }) is True
    assert cleanup_gate.cleanup_passed({
        **cleanup_base,
        'kill_exit': 1,
        'session_exists_after': True,
    }) is False
    assert "f'Goal: {condition}'" in driver
    assert 'status_dismissed' in driver
    assert "log.count('Removed session hooks for event Stop and source ')" in driver
    assert "def workflow_completion_proof(" in driver
    assert "def agent_completion_proof(" in driver
    assert "self.workflow_completion_proof(" in driver
    assert "self.agent_completion_proof(" in driver
    assert "parent_result = 'RELEASE_NESTED_PARENT_DONE' in self.assistant_text(\n            run_dir, subagents=True\n        )" in driver
    assert "'RELEASE_NESTED_PARENT_DONE'\n                    in self.assistant_text(run_dir, subagents=True)" in driver
    assert "'RELEASE_FGBG_CHILD_REQUEST: Read Makefile" in driver
    assert "'run_in_background': False" in driver
    assert "expected_output='RELEASE_FGBG_CHILD_DONE'" in driver
    assert "server.agent_fgbg_child_waiting.wait(timeout=30)" in driver
    assert "server.agent_fgbg_release.set()" in driver
    assert "CC_VALIDATION_CWD={fixture}" in driver
    assert "raw-diff-down-enter.bin" in driver
    assert "raw('delayed-paste-head', b'\\x1b[200~RECOVERY_LITERAL')" in driver
    assert "raw('delayed-paste-continuation', b'_CONTINUATION\\x1b[201~')" in driver
    assert "raw('delayed-paste-enter', b'\\r')" in driver
    assert "'[diff] dialog close user'" in driver
    assert "'OMEGA_RELEASE_BODY'" in driver
    assert "observe('08b-files'" not in driver
    assert "observe('08-resize-109'" in driver
    assert "observe('08a-resize-110'" in driver
    terminal_interaction = driver.split(
        '    def terminal_interaction(self):', 1
    )[1].split('\n    def ', 1)[0]
    assert terminal_interaction.index(
        'cleanup = self.close(run_dir, session, target)'
    ) < terminal_interaction.index(
        "json.loads(frame_report.read_text())"
    )
    assert "tempfile.mkdtemp(prefix='mods-release-', dir='/private/tmp')" in driver
    assert "shutil.rmtree(cache)" in driver
    assert "'cache_cleanup': cache_removed" in driver
    assert "workflow did not reach a terminal status before timeout" in driver
    assert "'goal-lifecycle': self.goal_lifecycle" in driver
    assert "def goal_lifecycle(self):" in driver
    assert "'subagent-stop-failure-lifecycle': self.subagent_stop_failure_lifecycle" in driver
    assert "def subagent_stop_failure_lifecycle(self):" in driver
    assert "'subagent-stop-query-failure-propagation'" in driver
    assert "'subagent-stop-fallback-exactly-once'" in driver
    assert "'goal-lifecycle-set-status-clear'" in driver
    assert "'agent-foreground-background-lifecycle'" in driver
    assert "'nested-agent-lifecycle'" in driver
    assert "run_dir, session, target, ready = self.start('workflow')" in driver
    assert "result = {'label': 'workflow', 'evidence_dir': str(run_dir)}" in driver
    assert "'inline-workflow-lifecycle'" in driver
    assert "f'{kind}-workflow-lifecycle'" in driver
    assert "'team-concurrency': self.team_concurrency" in driver
    assert "'workflow-retry-partial-failure': self.workflow_retry_partial_failure" in driver
    assert "'workflow-failure-detail': self.workflow_failure_detail" in driver
    assert "'coordinator-selector': self.coordinator_selector" in driver
    assert "'transcript-retention': self.transcript_retention" in driver
    assert "'terminal-interaction': self.terminal_interaction" in driver
    assert "def terminal_interaction(self):" in driver
    assert "def team_concurrency(self):" in driver
    assert "def workflow_retry_partial_failure(self):" in driver
    assert "def workflow_failure_detail(self):" in driver
    assert "def coordinator_selector(self):" in driver
    assert "def transcript_retention(self):" in driver
    assert "def run_target(self, label, action):" in driver
    assert "'driver_sha256': sha256(Path(__file__).resolve())" in driver
    assert "self.manifest['readiness_smoke'] = {" in driver
    assert "'status': readiness_result['validation_verdict']" in driver
    assert "result['repository_state_expected_workflow_artifacts']" in driver
    assert "self.run_target(target, actions[target])" in driver
    assert "result_label = 'inline-workflow' if target == 'workflow' else target" not in driver
    assert "global_config_path = config / (" in driver
    assert "'.claude-local-oauth.json'" in driver
    assert "if label in {'goal-lifecycle', 'openai-responses-usage-error'}:" in driver
    assert "'CC_VALIDATION_DISABLE_NONSTREAMING_FALLBACK=1'" in driver
    assert "'CC_VALIDATION_MAX_RETRIES=0'" in driver
    assert "'history-bootstrap-response' in self.ssh_fixture_events(run_dir)" in driver
    assert "or 'task-result' in self.ssh_fixture_events(run_dir)" in driver
    assert "run_dir / '04-prompt-after-detail-dialog.txt'" in driver
    assert "re.fullmatch(r'\\s*❯\\s*', line)" in driver
    assert "f'/workflows detail {task_id}'" in driver
    assert 'structured shutdown_request' in driver
    assert 'then return. Do not modify files.' in driver
    assert "status=completed retain=keep" in driver
    assert "input-transcript-retention-exit.txt" not in driver
    assert "passed=marker_ok and no_retry" in driver
    assert "logical_workers == ['probe-a', 'probe-b']" in driver
    assert "self.tmux('send-keys', '-t', target, 'Escape', check=True)" in driver
    assert "'-e', 'CC_VALIDATION_AGENT_TEAMS=1'" in driver
    assert "CC_VALIDATION_WORKFLOW_FAULT_INJECTION=service_unavailable:transient-worker:attempt:0" in driver
    assert "page_ok = detail_ok = agent_ok = None" in driver
    assert "ui_skipped_reason = 'workflow did not complete'" in driver
    assert "ui_skipped_reason = 'readiness failed'" in driver
    assert "'skipped_reason': ui_skipped_reason" in driver
    assert "specified/not executable" in driver
    assert "--base-ref" in driver
    assert "required_target_inputs" in driver
    assert "extra targets to append after diff-required targets" in driver

    assert "'effort-openai-responses-wire': self.effort_openai_responses_wire" in driver
    assert "'fast-openai-responses-wire': self.fast_openai_responses_wire" in driver
    assert "'openai-image-input-wire': self.openai_image_input_wire" in driver
    assert "'openai-remote-compaction': self.openai_remote_compaction" in driver
    assert "'openai-responses-usage-error': self.openai_responses_usage_error" in driver
    assert "'model-discovery-picker': self.model_discovery_picker" in driver
    assert "'model-discovery-empty-picker': self.model_discovery_empty_picker" in driver
    assert "'first-party-bootstrap-picker': self.first_party_bootstrap_picker" in driver
    assert "'model-internal-update-config-skill': self.model_internal_update_config_skill" in driver
    assert "'prompt-modes-cache-prefix': self.prompt_modes_cache_prefix" in driver
    assert 'def effort_openai_responses_wire(self):' in driver
    assert 'def fast_openai_responses_wire(self):' in driver
    assert 'def openai_image_input_wire(self):' in driver
    assert 'def openai_remote_compaction(self):' in driver
    assert 'def openai_responses_usage_error(self):' in driver
    assert 'def model_discovery_picker(self):' in driver
    assert 'def model_discovery_empty_picker(self):' in driver
    assert 'def first_party_bootstrap_picker(self):' in driver
    assert 'def model_internal_update_config_skill(self):' in driver
    assert 'def prompt_modes_cache_prefix(self):' in driver
    effort_method = driver.split(
        '    def effort_openai_responses_wire(self):', 1
    )[1].split('\n    def ', 1)[0]
    for effort, expected in (
        ('none', 'none'),
        ('minimal', 'minimal'),
        ('low', 'low'),
        ('medium', 'medium'),
        ('high', 'high'),
        ('xhigh', 'xhigh'),
        ('max', 'max'),
        ('ultra', 'ultra'),
        ('ultracode', 'xhigh'),
    ):
        assert repr((effort, expected)) in effort_method
    assert "thinking_path = run_dir / '05-thinking-transcript-pane.txt'" in effort_method
    assert "self.tmux('send-keys', '-t', target, 'C-o', check=True)" in effort_method
    assert "prompt_restored = self.wait_until(" in effort_method
    assert "self.capture(target, terminal_path, history=False)" in effort_method
    assert "if prompt_restored:" in effort_method
    assert "thinking_visible = prompt_restored and self.wait_until(" in effort_method
    assert "'prompt_restored_before_transcript': prompt_restored" in effort_method
    assert 'thinking_path.read_text(errors=\'replace\')' in effort_method
    assert 'thinking_transcript_shows_marker = (' in effort_method
    assert 'and thinking_transcript_shows_marker' in effort_method
    assert "'thinking_transcript_shows_marker': thinking_transcript_shows_marker" in effort_method
    assert '            thinking_path,' in effort_method
    usage_error_method = driver.split(
        '    def openai_responses_usage_error(self):', 1
    )[1].split('\n    def ', 1)[0]
    assert "'input_tokens': 100" in usage_error_method
    assert "'cache_read_input_tokens': 60" in usage_error_method
    assert "'cache_creation_input_tokens': 15" in usage_error_method
    assert "'response.incomplete'" in driver
    assert 'RELEASE_OPENAI_INCOMPLETE_REASON' in usage_error_method
    assert 'openai-responses-usage-normalization' in usage_error_method
    assert 'openai-responses-error-propagation' in usage_error_method
    model_picker_method = driver.split(
        '    def model_discovery_picker(self):', 1
    )[1].split('\n    def ', 1)[0]
    assert "self.tmux('send-keys', '-t', target, 'M-p', check=True)" in model_picker_method
    assert "'Set model to gpt-release-discovered'" not in model_picker_method
    assert 'self.record(result)' in model_picker_method
    empty_model_picker_method = driver.split(
        '    def model_discovery_empty_picker(self):', 1
    )[1].split('\n    def ', 1)[0]
    first_party_bootstrap_method = driver.split(
        '    def first_party_bootstrap_picker(self):', 1
    )[1].split('\n    def ', 1)[0]
    assert 'RELEASE_FIRST_PARTY_BOOTSTRAP_MODEL' in first_party_bootstrap_method
    assert "'RELEASE_FIRST_PARTY_BOOTSTRAP_MODEL ✔'" in first_party_bootstrap_method
    assert "'/model current'" not in first_party_bootstrap_method
    assert "'/api/claude_cli/bootstrap'" in driver
    assert 'first-party-bootstrap-startup-cache' in first_party_bootstrap_method
    assert 'first-party-bootstrap-picker' in first_party_bootstrap_method
    assert "'model-discovery-empty-picker'" in driver
    assert "self.tmux('send-keys', '-t', target, 'M-p', check=True)" in empty_model_picker_method
    assert "'input-empty-model-picker.txt'" in empty_model_picker_method
    assert "('GPT-5.5', 'GPT-5.4-Mini')" in empty_model_picker_method
    assert "'gpt-empty-discovery-current ✔'" in empty_model_picker_method
    assert "for marker in ('Select model', 'gpt-empty-discovery-current')" not in empty_model_picker_method
    assert "'gpt-empty-discovery-current ·'" not in empty_model_picker_method
    assert 'gpt-empty-discovery-current' in empty_model_picker_method
    assert "'model-discovery-empty-picker'" in empty_model_picker_method
    assert "'Empty discovered model list'" in empty_model_picker_method

    with tempfile.TemporaryDirectory(prefix='release-driver-empty-picker-') as root_string:
        run_dir = Path(root_string) / 'model-discovery-empty-picker'
        run_dir.mkdir()
        recorded = []
        empty_picker_gate = object.__new__(module.BinaryGate)
        empty_picker_gate.start = lambda _label: (
            run_dir,
            'empty-picker-session',
            'empty-picker-target',
            True,
        )
        empty_picker_gate.tmux = lambda *args, **kwargs: module.subprocess.CompletedProcess(
            args, 0, '', ''
        )
        def capture_empty_picker(_target, path, **_kwargs):
            path.write_text(
                'Select model\n'
                'gpt-empty-discovery-current · API Usage Billing\n'
                '1. gpt-empty-discovery-current ✔  Custom model\n'
            )
            return path.read_text()

        empty_picker_gate.capture = capture_empty_picker
        empty_picker_gate.wait_until = lambda predicate, *_args: predicate()
        empty_picker_gate.mock_servers = {
            run_dir.name: SimpleNamespace(snapshot=lambda: [{
                'method': 'GET',
                'path': '/v1/models',
                'authorization': {
                    'present': True,
                    'matches_dummy': True,
                },
            }]),
        }
        empty_picker_gate.mock_response_requests = lambda _run_dir: []
        empty_picker_gate.close = lambda *_args: {
            'kill_exit': 0,
            'process_remaining': False,
            'remaining_processes': [],
            'forced_termination': [],
            'mock_server': {'stopped': True, 'thread_alive': False},
        }
        empty_picker_gate.required_assertion = (
            lambda _run_dir, assertion_id, *_args, passed, **_kwargs: [
                assertion_id,
                'passed' if passed else 'failed',
            ]
        )
        empty_picker_gate.record = recorded.append
        empty_picker_gate.model_discovery_empty_picker()
        assert recorded[0]['validation_verdict'] == 'passed'
        assert recorded[0]['empty_discovery_honored'] is True
        assert (run_dir / 'input-empty-model-picker.txt').read_text().startswith('M-p ')

    model_mock = module.MockOpenAIServer(Path('/unused'), 'model-discovery-picker')
    for case in ('EXPLICIT', 'DEFAULT'):
        kind, response = model_mock.response_for({'input': [
            {'role': 'user', 'content': 'RELEASE_EXPLICIT_MODEL_REQUEST'},
            {'role': 'user', 'content': [{'type': 'input_text', 'text': f'RELEASE_{case}_MODEL_REQUEST'}]},
        ]})
        assert kind == 'model-mapping-completed'
        assert f'RELEASE_{case}_MODEL_OK' in response

    for faulty in (None, 'alias-model', 'explicit-model', 'missing-response', 'missing-pane', 'duplicate-response'):
        with tempfile.TemporaryDirectory(prefix='release-driver-default-model-') as root_string:
            run_dir = Path(root_string)
            gate = object.__new__(module.BinaryGate)
            gate.start = lambda _label: (run_dir, 'model-session', 'model-target', True)
            requests = [{
                'method': 'GET', 'path': '/v1/models',
                'authorization': {'present': True, 'matches_dummy': True},
            }]
            gate.mock_servers = {run_dir.name: SimpleNamespace(snapshot=lambda: requests)}
            gate.tmux = lambda *args, **kwargs: None
            def capture_model(_target, path, **_kwargs):
                text = {
                    '03-model-picker-pane.txt': 'Select model\nGPT Release Discovered',
                    '04-model-selected-pane.txt': 'gpt-release-discovered',
                    '05-model-current-pane.txt': 'Current model: gpt-release-discovered',
                    '06-explicit-model-pane.txt': 'RELEASE_EXPLICIT_MODEL_OK',
                    '07-alias-selected-pane.txt': 'Set model to gpt-5.6-terra',
                    '08-default-model-pane.txt': 'RELEASE_DEFAULT_MODEL_OK',
                }.get(path.name, '')
                if faulty == 'missing-pane' and path.name == '08-default-model-pane.txt':
                    text = ''
                path.write_text(text)
                return text
            gate.capture = capture_model
            gate.wait_until = lambda predicate, *_args: predicate()
            def send_model(_target, _run_dir, text, filename, **_kwargs):
                (run_dir / filename).write_text(text)
                if text.startswith('/') or faulty == 'missing-response':
                    return
                explicit = 'RELEASE_EXPLICIT_MODEL_REQUEST' in text
                model = 'gpt-release-discovered' if explicit else 'gpt-5.6-terra'
                if faulty == ('explicit-model' if explicit else 'alias-model'):
                    model = 'wrong-model'
                request = {
                    'method': 'POST', 'path': '/v1/responses',
                    'sequence': len(requests) + 1,
                    'authorization': {'present': True, 'matches_dummy': True},
                    'body': {'model': model, 'input': [{'role': 'user', 'content': text}]},
                    'response_kind': 'model-mapping-completed',
                }
                requests.append(request)
                if faulty == 'duplicate-response':
                    requests.append(dict(request))
            gate.send = send_model
            gate.close = lambda *_args: {'kill_exit': 0, 'process_remaining': False,
                'remaining_processes': [], 'forced_termination': [],
                'mock_server': {'stopped': True, 'thread_alive': False}}
            gate.required_assertion = lambda _dir, assertion_id, *_args, passed, **_kwargs: {
                'assertion_id': assertion_id, 'passed': passed,
            }
            recorded = []
            gate.record = recorded.append
            gate.model_discovery_picker()
            assert recorded[0]['validation_verdict'] == ('passed' if faulty is None else 'failed'), faulty
            if faulty is None:
                assert {item['assertion_id'] for item in recorded[0]['assertions']} >= {
                    'openai-default-model-alias', 'openai-explicit-model-preserved',
                }
                assert (run_dir / 'input-model-alias.txt').read_text() == '/model sonnet'

    for assertion_id in (
        'openai-wire-cross-client-prefix',
        'openai-wire-create-compact-isolation',
        'effort-all-configured-openai-wire',
        'effort-ultracode-openai-wire',
        'fast-openai-priority-wire',
        'fast-openai-disable-wire',
        'openai-remote-compaction-trigger',
        'openai-remote-compaction-continuation',
        'openai-responses-usage-normalization',
        'openai-responses-error-propagation',
        'model-discovery-picker-selection',
        'model-discovery-empty-picker',
        'first-party-bootstrap-startup-cache',
        'first-party-bootstrap-picker',
        'update-config-skill-tool-lifecycle',
        'update-config-full-settings-schema',
        'custom-prompt-stable-cache-routing',
        'plan-release-artifact-read-only-boundary',
    ):
        assert assertion_id in driver

    with tempfile.TemporaryDirectory(prefix='release-driver-effort-thinking-') as root_string:
        run_dir = Path(root_string) / 'effort-openai-responses-wire'
        (run_dir / 'config').mkdir(parents=True)
        (run_dir / 'config' / 'settings.json').write_text(
            json.dumps({'effortLevel': 'minimal'})
        )
        effort_cases = (
            ('none', 'none'),
            ('minimal', 'minimal'),
            ('low', 'low'),
            ('medium', 'medium'),
            ('high', 'high'),
            ('xhigh', 'xhigh'),
            ('max', 'max'),
            ('ultra', 'ultra'),
            ('ultracode', 'xhigh'),
        )

        effort_gate = object.__new__(module.BinaryGate)
        transcript_open = False
        visible_requests = 0
        tmux_calls = []
        recorded = []
        requests = [
            {
                'body': {
                    'reasoning': {'effort': expected},
                    'prompt_cache_key': 'cache-key',
                },
                'headers': {
                    'session-id': 'cache-key',
                    'thread-id': 'cache-key',
                    'x-client-request-id': f'request-{index}',
                    'x-app': 'cli',
                    'x-claude-code-session-id': 'cache-key',
                    'user-agent': 'claude-code/test',
                },
                'authorization': {'present': True, 'matches_dummy': True},
            }
            for index, (_, expected) in enumerate(effort_cases, 1)
        ]

        def capture_effort(target, path, *, history=True):
            nonlocal transcript_open
            if path.name.startswith('03-effort-'):
                effort = path.stem.removesuffix('-pane').split('-', 3)[-1]
                text = f'Set effort level to {effort}\n'
            elif path.name == '05-thinking-transcript-pane.txt':
                text = (
                    'Showing detailed transcript\n'
                    'Release validation reasoning marker.\n'
                    if transcript_open else ''
                )
            else:
                text = 'RELEASE_EFFORT_WIRE_OK\n❯\n'
            path.write_text(text)
            return text

        def tmux_effort(*args, **kwargs):
            nonlocal transcript_open
            tmux_calls.append(args)
            if args[-1] == 'C-o':
                transcript_open = True
            return subprocess.CompletedProcess(args, 0, '', '')

        effort_gate.start = lambda label: (run_dir, 'session', 'target', True)

        def send_effort(*args):
            nonlocal visible_requests
            prompt = str(args[2])
            (run_dir / args[3]).write_text(prompt)
            (run_dir / 'mock-openai-requests.json').write_text(json.dumps(requests[:visible_requests + int(prompt.startswith('Reply with'))]))
            (run_dir / 'debug.log').touch()
            if prompt.startswith('Reply with'):
                visible_requests += 1
            elif prompt == '/effort ultracode':
                (run_dir / 'config' / 'settings.json').write_text(
                    json.dumps({'effortLevel': 'ultracode'})
                )

        effort_gate.send = send_effort
        effort_gate.wait_until = lambda predicate, timeout, interval=0.5: predicate()
        effort_gate.capture = capture_effort
        effort_gate.tmux = tmux_effort
        effort_gate.mock_response_requests = lambda _: requests[:visible_requests]
        effort_gate.mock_servers = {run_dir.name: SimpleNamespace(snapshot=lambda: requests[:visible_requests])}
        effort_gate.assistant_text = lambda _: 'RELEASE_EFFORT_WIRE_OK'
        effort_gate.transcript = lambda _: 'Release validation reasoning marker.'
        effort_gate.close = lambda *args: {'stopped': True}
        effort_gate.cleanup_passed = lambda _: True
        effort_gate.record = recorded.append

        module.BinaryGate.effort_openai_responses_wire(effort_gate)

        assert recorded[0]['validation_verdict'] == 'failed', (
            'wire diagnostics require product debug logs, not fixture transcripts'
        )
        assert recorded[0]['wire_efforts'] == {
            'none': 'none',
            'minimal': 'minimal',
            'low': 'low',
            'medium': 'medium',
            'high': 'high',
            'xhigh': 'xhigh',
            'max': 'max',
            'ultra': 'ultra',
            'ultracode': 'xhigh',
        }
        assert recorded[0]['thinking_transcript_shows_marker'] is True
        assert ('send-keys', '-t', 'target', 'C-o') in tmux_calls
        assert 'Release validation reasoning marker.' not in (
            run_dir / '04-terminal-pane.txt'
        ).read_text()
        assert 'Release validation reasoning marker.' in (
            run_dir / '05-thinking-transcript-pane.txt'
        ).read_text()

        effort_assertions = {a['assertion_id']: a for a in recorded[0]['assertions']}
        assert effort_assertions['effort-all-configured-openai-wire']['validation_verdict'] == 'passed'
        assert effort_assertions['effort-ultracode-openai-wire']['validation_verdict'] == 'passed'

        # Existing effort lifecycle remains a positive unit case with an explicit
        # analyzer stub, not a fixture masquerading as a product debug log.
        visible_requests = 0
        transcript_open = False
        recorded.clear()
        with patch.object(module, 'analyze_openai_wire_debug', return_value={
            'matched': True, 'cross_client_append_only': True,
        }):
            module.BinaryGate.effort_openai_responses_wire(effort_gate)
        assert recorded[0]['validation_verdict'] == 'passed'

    with tempfile.TemporaryDirectory(prefix='release-driver-fast-wire-') as root_string:
        run_dir = Path(root_string) / 'fast-openai-responses-wire'
        (run_dir / 'config').mkdir(parents=True)
        (run_dir / 'config' / 'settings.json').write_text('{}\n')
        recorded = []
        visible_requests = 0
        fast_enabled = False
        fast_gate = object.__new__(module.BinaryGate)
        requests = [{
            'body': {'service_tier': 'priority'},
            'authorization': {'present': True, 'matches_dummy': True},
        }, {
            'body': {},
            'authorization': {'present': True, 'matches_dummy': True},
        }]
        fast_gate.start = lambda _label: (
            run_dir,
            'fast-session',
            'fast-target',
            True,
        )

        def send_fast(_target, _run_dir, text, _filename):
            nonlocal visible_requests, fast_enabled
            if text == '/fast on':
                fast_enabled = True
            elif text == '/fast off':
                fast_enabled = False
                (run_dir / 'config' / 'settings.json').write_text('{}\n')
            elif text.startswith('Reply with'):
                visible_requests += 1

        def capture_fast(_target, path, **_kwargs):
            if path.name == '03-fast-enabled-pane.txt':
                text = 'Fast mode ON\n'
            elif path.name == '05-fast-disabled-pane.txt':
                text = 'Fast mode OFF\n'
            else:
                text = 'RELEASE_FAST_WIRE_OK\n❯\n'
            path.write_text(text)
            return text

        fast_gate.send = send_fast
        fast_gate.wait_until = lambda predicate, *_args: predicate()
        fast_gate.capture = capture_fast
        fast_gate.mock_response_requests = lambda _run_dir: requests[:visible_requests]
        fast_gate.assistant_text = lambda _run_dir: 'RELEASE_FAST_WIRE_OK'
        fast_gate.close = lambda *_args: {'stopped': True}
        fast_gate.cleanup_passed = lambda _cleanup: True
        fast_gate.record = recorded.append
        fast_gate.required_assertion = (
            module.BinaryGate.required_assertion.__get__(
                fast_gate,
                module.BinaryGate,
            )
        )

        module.BinaryGate.fast_openai_responses_wire(fast_gate)

        assert recorded[0]['validation_verdict'] == 'passed'
        assert recorded[0]['service_tiers'] == ['priority', None]
        assert recorded[0]['preference_disabled_at_end'] is True
        assert fast_enabled is False

    with tempfile.TemporaryDirectory(prefix='release-driver-image-wire-') as root_string:
        run_dir = Path(root_string) / 'openai-image-input-wire'
        run_dir.mkdir()
        recorded = []
        visible_requests = 0
        image_gate = object.__new__(module.BinaryGate)
        processed_base64 = (
            'iVBORw0KGgoAAAANSUhEUgAAB9AAAAABCAIAAAAJn6IqAAAAHUlEQVR4nO3BMQEA'
            'AADCoPVPbQhfoAAAAAAAgNsAF3EAAW1SnXoAAAAASUVORK5CYII='
        )
        requests = [{
            'response_kind': 'read-call',
            'body': {'input': [{'type': 'message'}]},
            'authorization': {'present': True, 'matches_dummy': True},
        }, {
            'response_kind': 'completed',
            'body': {
                'input': [{
                    'type': 'function_call',
                    'id': 'fc_release_read_image',
                    'call_id': 'fc_release_read_image',
                    'name': 'Read',
                    'arguments': json.dumps({
                        'file_path': str(run_dir / 'fixture.png'),
                    }, separators=(',', ':')),
                }, {
                    'type': 'function_call_output',
                    'call_id': 'fc_release_read_image',
                    'output': [{
                        'type': 'input_image',
                        'image_url': f'data:image/png;base64,{processed_base64}',
                        'detail': 'high',
                    }],
                }],
            },
            'authorization': {'present': True, 'matches_dummy': True},
        }]
        image_gate.start = lambda _label: (
            run_dir,
            'image-session',
            'image-target',
            True,
        )

        def send_image(*_args):
            nonlocal visible_requests
            visible_requests = 2

        def capture_image(_target, path, **_kwargs):
            text = 'Read fixture.png\nRELEASE_OPENAI_IMAGE_WIRE_OK\n❯\n'
            path.write_text(text)
            return text

        image_gate.send = send_image
        image_gate.wait_until = lambda predicate, *_args: predicate()
        image_gate.capture = capture_image
        image_gate.mock_response_requests = (
            lambda _run_dir: requests[:visible_requests]
        )
        image_gate.assistant_text = (
            lambda _run_dir: 'RELEASE_OPENAI_IMAGE_WIRE_OK'
        )
        image_gate.close = lambda *_args: {'stopped': True}
        image_gate.cleanup_passed = lambda _cleanup: True
        image_gate.record = recorded.append
        image_gate.required_assertion = (
            module.BinaryGate.required_assertion.__get__(
                image_gate,
                module.BinaryGate,
            )
        )

        module.BinaryGate.openai_image_input_wire(image_gate)

        assert recorded[0]['validation_verdict'] == 'passed'
        assert recorded[0]['request_count'] == 2
        assert recorded[0]['response_kinds'] == ['read-call', 'completed']
        analysis = json.loads(
            (run_dir / 'openai-image-wire-analysis.json').read_text()
        )
        assert analysis['read_function_call_wire'] is True
        assert analysis['function_call_output_image_wire'] is True

    # Parser-only examples stay in memory, never in binary evidence/debug.log.
    wire_requests = [
        {'response_kind': kind, 'body': {
            'instructions': 'private instruction', 'tools': [],
            'input': items, 'prompt_cache_key': 'unit-thread',
        }}
        for kind, items in (
            ('completed', ['private seed']),
            ('completed', ['private seed', 'next']),
            ('compaction', ['private seed', 'next', 'trigger']),
            ('completed', ['opaque', 'continued']),
            ('compaction', ['opaque', 'continued', 'trigger']),
        )
    ]
    diagnostic_examples = []
    for index, (request, prefix, append) in enumerate(zip(
        wire_requests, (0, 1, 0, 0, 0), ('false', 'true', 'false', 'false', 'false')
    )):
        kind = 'compact' if request['response_kind'] == 'compaction' else 'create'
        items = request['body']['input']
        size = len(json.dumps(items, separators=(',', ':')).encode())
        diagnostic_examples.append(
            '[OpenAI Compat] SSE client → http://unit.invalid/responses\n'
            f'[OpenAI Compat] Wire prefix kind={kind} '
            'instructions=aaaaaaaaaaaaaaaa/19B tools=bbbbbbbbbbbbbbbb/2B/0 '
            f'input={index:016x}/{size}B/{len(items)} '
            f'commonPrefixItems={prefix} appendOnly={append}'
        )
    diagnostic_text = '\n'.join(diagnostic_examples)
    wire_analysis = module.analyze_openai_wire_debug(diagnostic_text, wire_requests)
    assert wire_analysis['matched']
    assert wire_analysis['cross_client_append_only']
    assert wire_analysis['create_compact_isolated']
    ambiguous_requests = [wire_requests[0], {**wire_requests[0], 'body': {
        **wire_requests[0]['body'], 'prompt_cache_key': 'other-thread'}}]
    ambiguous_text = '\n'.join([diagnostic_examples[0]] * 2)
    assert not module.analyze_openai_wire_debug(ambiguous_text, ambiguous_requests)['matched']
    other_scope = json.loads(json.dumps(wire_requests))
    other_scope[0]['body']['prompt_cache_key'] = 'title-thread'
    scoped_text = diagnostic_text.replace('commonPrefixItems=1 appendOnly=true',
                                          'commonPrefixItems=0 appendOnly=false')
    assert module.analyze_openai_wire_debug(scoped_text, other_scope)['matched']
    with_models = [{'method': 'GET', 'path': '/v1/models', 'body': None}, *wire_requests]
    assert module.analyze_openai_wire_debug(diagnostic_text, with_models)['matched']
    title_only = json.loads(json.dumps(wire_requests))
    for request in title_only:
        request['body']['instructions'] = module.TITLE_GENERATION_INSTRUCTION
    title_text = diagnostic_text.replace('19B', str(len(module.TITLE_GENERATION_INSTRUCTION.encode())) + 'B')
    title_analysis = module.analyze_openai_wire_debug(title_text, title_only)
    assert title_analysis['matched']
    assert not title_analysis['create_compact_isolated']
    assert not title_analysis['cross_client_append_only']
    for broken in (
        '',
        diagnostic_text.replace('commonPrefixItems=1 appendOnly=true',
                                'commonPrefixItems=0 appendOnly=false'),
        diagnostic_text.replace('kind=compact', 'kind=create', 1),
        diagnostic_text.replace('19B', '20B', 1),
        diagnostic_text.replace('aaaaaaaaaaaaaaaa', 'cccccccccccccccc', 1),
        diagnostic_text.replace('appendOnly=true', 'appendOnly=true private seed'),
        diagnostic_text + '\n[OpenAI Compat] Wire prefix analysis failed: failure',
        diagnostic_text + '\n' + diagnostic_examples[-1],
    ):
        assert not module.analyze_openai_wire_debug(broken, wire_requests)['matched']
    no_client = diagnostic_text.replace('[OpenAI Compat] SSE client → ', 'not a client ')
    assert not module.analyze_openai_wire_debug(
        no_client, wire_requests
    )['cross_client_append_only']
    shared_baseline = diagnostic_text.replace(
        diagnostic_examples[2], diagnostic_examples[2].replace(
            'commonPrefixItems=0 appendOnly=false',
            'commonPrefixItems=2 appendOnly=true',
        ),
    )
    assert not module.analyze_openai_wire_debug(shared_baseline, wire_requests)['matched']

    with tempfile.TemporaryDirectory(prefix='release-driver-remote-compact-') as root_string:
        run_dir = Path(root_string) / 'openai-remote-compaction'
        transcript_path = run_dir / 'config' / 'projects' / 'release.jsonl'
        entries = []
        write_transcript(transcript_path, entries)
        recorded = []
        visible_requests = 0
        second_boundary_pending = False
        compact_gate = object.__new__(module.BinaryGate)
        first_item = {
            'type': 'compaction',
            'id': 'cmp_release_0',
            'encrypted_content': 'release-opaque-state-0',
        }
        second_item = {
            'type': 'compaction',
            'id': 'cmp_release_1',
            'encrypted_content': 'release-opaque-state-1',
        }
        requests = [{
            'response_kind': 'completed',
            'body': {'input': [{'type': 'message'}]},
            'authorization': {'present': True, 'matches_dummy': True},
        }, {
            'response_kind': 'compaction',
            'body': {'input': [{'type': 'message'}, {'type': 'compaction_trigger'}]},
            'authorization': {'present': True, 'matches_dummy': True},
        }, {
            'response_kind': 'completed',
            'body': {'input': [first_item, {'type': 'message'}]},
            'authorization': {'present': True, 'matches_dummy': True},
        }, {
            'response_kind': 'compaction',
            'body': {'input': [first_item, {'type': 'message'}, {'type': 'compaction_trigger'}]},
            'authorization': {'present': True, 'matches_dummy': True},
        }]
        compact_gate.start = lambda _label: (
            run_dir,
            'compact-session',
            'compact-target',
            True,
        )

        def send_compact(_target, _run_dir, text, _filename):
            nonlocal visible_requests, second_boundary_pending
            visible_requests += 1
            if text.startswith('Reply with the remote compaction seed'):
                entries.append({
                    'type': 'assistant',
                    'message': {
                        'role': 'assistant',
                        'content': [{'type': 'text', 'text': 'RELEASE_COMPACTION_SEED_OK'}],
                    },
                })
            elif text == '/compact RELEASE_COMPACT_CALLER' and visible_requests == 2:
                entries.append({
                    'type': 'system',
                    'subtype': 'compact_boundary',
                    'content': 'Conversation compacted',
                    'openAICompaction': first_item,
                    'compactMetadata': {'mode': 'codex'},
                })
            elif text.startswith('Reply with the remote compaction continuation'):
                entries.append({
                    'type': 'assistant',
                    'message': {
                        'role': 'assistant',
                        'content': [{'type': 'text', 'text': 'RELEASE_COMPACTION_CONTINUATION_OK'}],
                    },
                })
            elif text == '/compact' and visible_requests == 4:
                second_boundary_pending = True
            write_transcript(transcript_path, entries)

        def wait_compact(predicate, *_args):
            nonlocal second_boundary_pending
            if predicate():
                return True
            if second_boundary_pending:
                entries.append({
                    'type': 'system',
                    'subtype': 'compact_boundary',
                    'content': 'Conversation compacted',
                    'openAICompaction': second_item,
                    'compactMetadata': {'mode': 'codex'},
                })
                second_boundary_pending = False
                write_transcript(transcript_path, entries)
                if getattr(compact_gate, 'checkpoint_boundaries', False):
                    for entry in entries:
                        if entry.get('subtype') == 'compact_boundary':
                            entry['compactMetadata'].update({
                                'provider': 'openai',
                                'preCompactTokens': 100,
                                'postCompactTokens': 20,
                                'compactionCallTokens': 30,
                                'compactionResponseId': entry['openAICompaction']['id'],
                            })
                    write_transcript(transcript_path, entries)
            return predicate()

        def capture_compact(_target, path, **_kwargs):
            text = 'Conversation compacted\nRELEASE_COMPACTION_CONTINUATION_OK\n❯\n'
            path.write_text(text)
            return text

        compact_gate.send = send_compact
        compact_gate.wait_until = wait_compact
        compact_gate.capture = capture_compact
        compact_gate.mock_response_requests = (
            lambda _run_dir: requests[:visible_requests]
        )
        compact_gate.mock_servers = {run_dir.name: SimpleNamespace(snapshot=lambda: requests[:visible_requests])}
        compact_gate.transcript_paths = (
            lambda _run_dir, **_kwargs: [transcript_path]
        )
        compact_gate.transcript = (
            module.BinaryGate.transcript.__get__(compact_gate, module.BinaryGate)
        )
        compact_gate.path_entries = (
            module.BinaryGate.path_entries.__get__(compact_gate, module.BinaryGate)
        )
        compact_gate.assistant_text = (
            module.BinaryGate.assistant_text.__get__(compact_gate, module.BinaryGate)
        )
        compact_gate.compact_boundaries = (
            module.BinaryGate.compact_boundaries.__get__(compact_gate, module.BinaryGate)
        )
        compact_gate.close = lambda *_args: {'stopped': True}
        compact_gate.cleanup_passed = lambda _cleanup: True
        compact_gate.record = recorded.append
        compact_gate.required_assertion = (
            module.BinaryGate.required_assertion.__get__(
                compact_gate,
                module.BinaryGate,
            )
        )

        module.BinaryGate.openai_remote_compaction(compact_gate)

        assert recorded[0]['response_kinds'] == [
            'completed',
            'compaction',
            'completed',
            'compaction',
        ]
        assert recorded[0]['persisted_compaction_count'] == 2
        assert recorded[0]['validation_verdict'] == 'failed', (
            'compact boundaries without checkpoint metadata must fail'
        )

        assert not json.loads((run_dir / 'openai-remote-compaction-analysis.json').read_text())['persisted_chain']
        original_send = compact_gate.send

        def send_with_checkpoint(*args):
            compact_gate.checkpoint_boundaries = True
            original_send(*args)
            for entry in entries:
                if entry.get('subtype') == 'compact_boundary':
                    entry['compactMetadata'].update({
                        'provider': 'openai',
                        'preCompactTokens': 100,
                        'postCompactTokens': 20,
                        'compactionCallTokens': 30,
                        'compactionResponseId': entry['openAICompaction']['id'],
                    })
            write_transcript(transcript_path, entries)

        entries.clear()
        visible_requests = 0
        second_boundary_pending = False
        compact_gate.checkpoint_boundaries = False
        recorded.clear()
        compact_gate.send = send_with_checkpoint
        module.BinaryGate.openai_remote_compaction(compact_gate)
        assert recorded[0]['validation_verdict'] == 'failed', (
            'checkpoint fixtures cannot substitute for create/compact product diagnostics'
        )
        assert json.loads((run_dir / 'openai-remote-compaction-analysis.json').read_text())['persisted_chain']
        requests[1]['body']['instructions'] = 'system\n\nRELEASE_COMPACT_CALLER\n\nRELEASE_PRECOMPACT_HOOK'
        requests[3]['body']['instructions'] = 'system\n\nRELEASE_PRECOMPACT_HOOK'
        # Test handler composition separately, without fabricating product log files.
        with patch.object(module, 'analyze_openai_wire_debug', return_value={
            'matched': True, 'create_compact_isolated': True,
        }):
            for sender, expected in ((original_send, 'failed'),
                                     (send_with_checkpoint, 'passed')):
                entries.clear()
                visible_requests = 0
                second_boundary_pending = False
                compact_gate.checkpoint_boundaries = False
                recorded.clear()
                compact_gate.send = sender
                module.BinaryGate.openai_remote_compaction(compact_gate)
                assert recorded[0]['validation_verdict'] == expected
            for invalid in ('', 'system\n\nRELEASE_PRECOMPACT_HOOK',
                            'RELEASE_PRECOMPACT_HOOK\n\nRELEASE_COMPACT_CALLER',
                            'RELEASE_COMPACT_CALLER\n\nRELEASE_PRECOMPACT_HOOK\n\nRELEASE_PRECOMPACT_HOOK'):
                requests[1]['body']['instructions'] = invalid
                entries.clear()
                visible_requests = 0
                second_boundary_pending = False
                compact_gate.checkpoint_boundaries = False
                recorded.clear()
                compact_gate.send = send_with_checkpoint
                module.BinaryGate.openai_remote_compaction(compact_gate)
                assert recorded[0]['validation_verdict'] == 'failed', (
                    'missing, reordered or duplicate compact instructions must fail'
                )

    with tempfile.TemporaryDirectory(prefix='release-driver-usage-error-') as root_string:
        run_dir = Path(root_string) / 'openai-responses-usage-error'
        transcript_path = run_dir / 'config' / 'projects' / 'release.jsonl'
        write_transcript(transcript_path, [{
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{
                    'type': 'text',
                    'text': 'RELEASE_OPENAI_USAGE_OK',
                }],
                'usage': {
                    'input_tokens': 25,
                    'output_tokens': 7,
                    'cache_read_input_tokens': 60,
                    'cache_creation_input_tokens': 15,
                },
            },
        }, {
            'type': 'assistant',
            'isApiErrorMessage': True,
            'message': {
                'role': 'assistant',
                'content': 'RELEASE_OPENAI_INCOMPLETE_REASON',
            },
        }])
        recorded = []
        visible_requests = 0
        usage_error_gate = object.__new__(module.BinaryGate)
        requests = [{
            'response_kind': 'usage-completed',
        }, {
            'response_kind': 'response.incomplete',
        }]
        usage_error_gate.start = lambda _label: (
            run_dir,
            'usage-error-session',
            'usage-error-target',
            True,
        )

        def send_usage_error(*_args):
            nonlocal visible_requests
            visible_requests += 1

        def capture_usage_error(_target, path, **_kwargs):
            text = 'RELEASE_OPENAI_INCOMPLETE_REASON\n❯\n'
            path.write_text(text)
            return text

        usage_error_gate.send = send_usage_error
        usage_error_gate.wait_until = lambda predicate, *_args: predicate()
        usage_error_gate.capture = capture_usage_error
        usage_error_gate.mock_response_requests = (
            lambda _run_dir: requests[:visible_requests]
        )
        usage_error_gate.transcript_paths = (
            lambda _run_dir, **_kwargs: [transcript_path]
        )
        usage_error_gate.path_entries = module.BinaryGate.path_entries.__get__(
            usage_error_gate,
            module.BinaryGate,
        )
        usage_error_gate.close = lambda *_args: {'stopped': True}
        usage_error_gate.cleanup_passed = lambda _cleanup: True
        usage_error_gate.record = recorded.append
        usage_error_gate.required_assertion = (
            module.BinaryGate.required_assertion.__get__(
                usage_error_gate,
                module.BinaryGate,
            )
        )

        module.BinaryGate.openai_responses_usage_error(usage_error_gate)

        assert recorded[0]['validation_verdict'] == 'passed'
        assert recorded[0]['request_count'] == 2
        assert recorded[0]['observed_normalized_usage'] == {
            'input_tokens': 25,
            'output_tokens': 7,
            'cache_read_input_tokens': 60,
            'cache_creation_input_tokens': 15,
        }
        assert recorded[0]['error_propagated'] is True
        assert recorded[0]['no_fallback_or_retry'] is True

    with tempfile.TemporaryDirectory(prefix='release-driver-first-party-') as root_string:
        run_dir = Path(root_string) / 'first-party-bootstrap-picker'
        config = run_dir / 'config'
        config.mkdir(parents=True)
        option = {
            'value': 'release-first-party-bootstrap-model',
            'label': 'RELEASE_FIRST_PARTY_BOOTSTRAP_MODEL',
            'description': 'Release validation bootstrap model',
        }
        (config / '.claude.json').write_text('{}\n')
        (run_dir / 'debug.log').write_text('')
        base_url = 'http://127.0.0.1:54321'
        expected_key = 'anthropic:' + base_url + '/v1:api-key:' + hashlib.sha256(module.DUMMY_ANTHROPIC_API_KEY.encode()).hexdigest()[:16]
        (run_dir / 'run-metadata.json').write_text(json.dumps({'mock_openai': {'base_url': base_url}}))
        bootstrap_requests = []
        recorded = []
        first_party_gate = object.__new__(module.BinaryGate)
        first_party_gate.start = lambda _label: (
            run_dir,
            'first-party-session',
            'first-party-target',
            True,
        )
        def first_party_tmux(*args, **_kwargs):
            if args[:4] == ('send-keys', '-t', 'first-party-target', 'M-p'):
                assert bootstrap_requests == [{
                    'path': '/api/claude_cli/bootstrap',
                }]
            return subprocess.CompletedProcess(args, 0, '', '')

        first_party_gate.tmux = first_party_tmux
        first_party_gate.send = lambda *_args: (_ for _ in ()).throw(AssertionError('unexpected model current command'))

        def capture_first_party(_target, path, **_kwargs):
            if not bootstrap_requests:
                bootstrap_requests.append({'path': '/api/claude_cli/bootstrap'})
                (config / '.claude-local-oauth.json').write_text(json.dumps({
                    'additionalModelOptionsCache': [option],
                    'additionalModelOptionsCacheKey': expected_key,
                    'bootstrapCacheKey': expected_key,
                }))
            text = 'Select model\nRELEASE_FIRST_PARTY_BOOTSTRAP_MODEL ✔\n'
            path.write_text(text)
            return text

        first_party_gate.capture = capture_first_party

        def wait_first_party(predicate, *_args):
            if not bootstrap_requests:
                bootstrap_requests.append({'path': '/api/claude_cli/bootstrap'})
                (config / '.claude-local-oauth.json').write_text(json.dumps({
                    'additionalModelOptionsCache': [option],
                    'additionalModelOptionsCacheKey': expected_key,
                    'bootstrapCacheKey': expected_key,
                }))
            return predicate()

        first_party_gate.wait_until = wait_first_party
        first_party_gate.mock_servers = {
            run_dir.name: SimpleNamespace(snapshot=lambda: bootstrap_requests),
        }
        first_party_gate.close = lambda *_args: {'stopped': True}
        first_party_gate.cleanup_passed = lambda _cleanup: True
        first_party_gate.record = recorded.append
        first_party_gate.required_assertion = (
            module.BinaryGate.required_assertion.__get__(
                first_party_gate,
                module.BinaryGate,
            )
        )

        module.BinaryGate.first_party_bootstrap_picker(first_party_gate)

        assert recorded[0]['validation_verdict'] == 'passed'
        assert recorded[0]['keyed_cache'] is True
        assert recorded[0]['bootstrap_endpoint_once'] is True
        assert recorded[0]['picker_visible'] is True
        assert recorded[0]['current_model_confirmed'] is True
        assert all(
            'bootstrap-cache-seed.json' not in path
            for assertion in recorded[0]['assertions']
            for path in assertion['observed_evidence_paths']
        )

        for mutation in ('model-key', 'bootstrap-key', 'options'):
            value = {'additionalModelOptionsCache': [option], 'additionalModelOptionsCacheKey': expected_key, 'bootstrapCacheKey': expected_key}
            if mutation == 'model-key': value['additionalModelOptionsCacheKey'] = 'wrong-account'
            elif mutation == 'bootstrap-key': value['bootstrapCacheKey'] = 'wrong-endpoint'
            else: value['additionalModelOptionsCache'] = []
            (config / '.claude-local-oauth.json').write_text(json.dumps(value))
            (run_dir / 'input-first-party-model-picker.txt').unlink(missing_ok=True)
            recorded.clear()
            module.BinaryGate.first_party_bootstrap_picker(first_party_gate)
            assert recorded[0]['validation_verdict'] == 'failed'
            assert recorded[0]['keyed_cache'] is False
            assert recorded[0]['picker_visible'] is False
            assert all(not path.endswith('input-first-party-model-picker.txt') for assertion in recorded[0]['assertions'] for path in assertion['observed_evidence_paths'])

    class OrphanMockServer:
        def __init__(self):
            self.stop_calls = 0

        def stop(self):
            self.stop_calls += 1
            return {'stopped': True, 'thread_alive': False}

    orphan_gate = object.__new__(module.BinaryGate)
    orphan_gate.active_runs = {}
    orphan_gate.mock_servers = {'orphan-run': OrphanMockServer()}
    orphan_gate.evidence_root = Path('/tmp/release-driver-orphan-evidence')
    orphan_server = orphan_gate.mock_servers['orphan-run']
    orphan_cleanup = module.BinaryGate.close_active_runs(orphan_gate)
    assert orphan_server.stop_calls == 1
    assert orphan_cleanup == [{
        'session': None,
        'evidence_dir': '/tmp/release-driver-orphan-evidence/runs/orphan-run',
        'kill_exit': 0,
        'pane_pid': '',
        'process_remaining': False,
        'remaining_processes': [],
        'forced_termination': [],
        'mock_server': {'stopped': True, 'thread_alive': False},
    }]

    assert "if label in MOCK_OPENAI_TARGETS:" in driver
    repository_state_method = driver.split(
        '    def repository_state(self):', 1
    )[1].split('\n    def ', 1)[0]
    assert "'mtime_ns'" not in repository_state_method
    assert "'size': self.binary.stat().st_size" in repository_state_method
    assert "'sha256': sha256(self.binary)" in repository_state_method
    baseline_binary = BASELINE_PATH.read_text().split(
        "        'binary': {", 1
    )[1].split('        },', 1)[0]
    assert "'mtime_ns'" not in baseline_binary
    assert "'size': binary.stat().st_size" in baseline_binary
    assert "'sha256': sha256(binary)" in baseline_binary
    start_method = driver.split('    def start(self, label):', 1)[1].split('\n    def ', 1)[0]
    collision_check = start_method.index("if self.tmux('has-session', '-t', session).returncode == 0:")
    mock_server_start = start_method.index('mock_base_url = mock_server.start()')
    assert collision_check < mock_server_start

    launcher = LAUNCHER_PATH.read_text()
    assert "value = os.environ.get(f'CC_VALIDATION_{name}') or os.environ.get(name)" in driver
    assert "value = merge_no_proxy(value, '127.0.0.1', 'localhost')" in driver
    assert "uses_local_mock = label in MOCK_OPENAI_TARGETS or label == 'first-party-bootstrap-picker'" in driver
    assert "if uses_local_mock:\n            mock_server = MockOpenAIServer(run_dir, label)" in driver
    assert "if name == 'NO_PROXY' and uses_local_mock:" in driver
    assert 'set -- env -i' in launcher
    assert 'exec "$@"' in launcher
    assert 'CLAUDE_CODE_USE_OPENAI="${CC_VALIDATION_USE_OPENAI:-1}"' in launcher
    assert 'ANTHROPIC_API_KEY="$CC_VALIDATION_ANTHROPIC_API_KEY"' in launcher
    assert 'CC_VALIDATION_LOCAL_OAUTH_API_BASE' in launcher
    assert 'USE_LOCAL_OAUTH=1' in launcher
    assert 'CLAUDE_LOCAL_OAUTH_API_BASE="$CC_VALIDATION_LOCAL_OAUTH_API_BASE"' in launcher
    assert 'DISABLE_AUTOUPDATER=1' in launcher
    assert 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="${CC_VALIDATION_AGENT_TEAMS:-}"' in launcher
    assert 'CLAUDE_CODE_RUN_AGENT_FAULT_INJECTION_FOR_TESTING="${CC_VALIDATION_RUN_AGENT_FAULT_INJECTION:-}"' in launcher
    assert 'CC_VALIDATION_RUN_AGENT_FAULT_INJECTION=after_query_start' in driver
    assert 'CC_VALIDATION_SSH_IO="${CC_VALIDATION_SSH_IO:-}"' in launcher
    assert 'CC_VALIDATION_SSH_BIN="${CC_VALIDATION_SSH_BIN:-}"' in launcher
    assert 'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK="${CC_VALIDATION_DISABLE_NONSTREAMING_FALLBACK:-}"' in launcher
    assert 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${CC_VALIDATION_DISABLE_NONESSENTIAL_TRAFFIC:-}"' in launcher
    assert 'CLAUDE_CODE_MAX_RETRIES="${CC_VALIDATION_MAX_RETRIES:-}"' in launcher
    for name in (
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'NO_PROXY',
        'http_proxy',
        'https_proxy',
        'all_proxy',
        'no_proxy',
    ):
        assert f'{name}="${{CC_VALIDATION_{name.upper()}:-${{{name}:-}}}}"' in launcher
    for name in module.AUTH_ENV_VARS:
        if name == 'ANTHROPIC_API_KEY':
            continue
        assert f'{name}=' not in launcher

    with tempfile.TemporaryDirectory(prefix='release-launcher-test-') as root_string:
        root = Path(root_string)
        repo = root / 'repo'
        evidence = root / 'evidence'
        config = root / 'config'
        home = root / 'home'
        for path in (repo, evidence, config, home):
            path.mkdir()
        binary = repo / 'built-claude'
        binary.write_text(
            '#!/bin/sh\n'
            '/usr/bin/env > "$HOME/child.env"\n'
            '/usr/bin/printf "%s\\n" "$@" > "$HOME/child.args"\n'
        )
        binary.chmod(0o755)
        proxy_env = {
            name: f'http://{name.lower()}.example.test:7890'
            for name in (
                'HTTP_PROXY',
                'HTTPS_PROXY',
                'ALL_PROXY',
                'NO_PROXY',
                'http_proxy',
                'https_proxy',
                'all_proxy',
                'no_proxy',
            )
        }
        validation_proxy_env = {
            f'CC_VALIDATION_{name.upper()}': f'http://validation-{name.lower()}.example.test:7891'
            for name in ('HTTP_PROXY', 'NO_PROXY', 'http_proxy', 'no_proxy')
        }
        launch_env = {
            'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
            'CC_VALIDATION_REPO_ROOT': str(repo),
            'CC_VALIDATION_EVIDENCE_DIR': str(evidence),
            'CC_VALIDATION_CONFIG_DIR': str(config),
            'CC_VALIDATION_HOME': str(home),
            'CC_VALIDATION_USE_OPENAI': '1',
            'CC_VALIDATION_OPENAI_BASE_URL': 'http://127.0.0.1:34567',
            'CC_VALIDATION_SYSTEM_PROMPT': 'release launcher prompt marker',
            'CC_VALIDATION_DISABLE_NONSTREAMING_FALLBACK': '1',
            'CC_VALIDATION_DISABLE_NONESSENTIAL_TRAFFIC': '1',
            'CC_VALIDATION_MAX_RETRIES': '0',
            'CC_VALIDATION_PATH_PREFIX': str(root / 'driver bin'),
            'RELEASE_DRIVER_UNRELATED': 'must-not-pass',
            **proxy_env,
            **validation_proxy_env,
            **{name: 'must-not-pass' for name in module.AUTH_ENV_VARS},
        }
        subprocess.run(
            [str(LAUNCHER_PATH)],
            check=True,
            env=launch_env,
            capture_output=True,
            text=True,
        )
        child_env = dict(
            line.split('=', 1)
            for line in (home / 'child.env').read_text().splitlines()
            if '=' in line
        )
        expected_proxy_env = {
            name: launch_env.get(f'CC_VALIDATION_{name.upper()}', value)
            for name, value in proxy_env.items()
        }
        assert {name: child_env.get(name) for name in proxy_env} == expected_proxy_env
        assert child_env['CLAUDE_CODE_USE_OPENAI'] == '1'
        assert child_env['CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK'] == '1'
        assert child_env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] == '1'
        assert child_env['CLAUDE_CODE_MAX_RETRIES'] == '0'
        assert child_env['DISABLE_AUTOUPDATER'] == '1'
        assert child_env['OPENAI_BASE_URL'] == 'http://127.0.0.1:34567'
        assert 'ANTHROPIC_API_KEY' not in child_env
        assert 'CLAUDE_LOCAL_OAUTH_API_BASE' not in child_env
        assert child_env['PATH'] == str(root / 'driver bin') + ':' + launch_env['PATH']
        assert 'CC_VALIDATION_PATH_PREFIX' not in child_env
        assert 'RELEASE_DRIVER_UNRELATED' not in child_env
        for name in module.AUTH_ENV_VARS:
            assert name not in child_env
        assert (home / 'child.args').read_text().splitlines() == [
            '--dangerously-skip-permissions',
            '--debug',
            '--debug-file',
            str(evidence / 'debug.log'),
            '--system-prompt',
            'release launcher prompt marker',
        ]

        launch_env['CC_VALIDATION_ANTHROPIC_API_KEY'] = (
            module.DUMMY_ANTHROPIC_API_KEY
        )
        subprocess.run(
            [str(LAUNCHER_PATH)],
            check=True,
            env=launch_env,
            capture_output=True,
            text=True,
        )
        validation_child_env = dict(
            line.split('=', 1)
            for line in (home / 'child.env').read_text().splitlines()
            if '=' in line
        )
        assert validation_child_env['ANTHROPIC_API_KEY'] == (
            module.DUMMY_ANTHROPIC_API_KEY
        )

    with tempfile.TemporaryDirectory(prefix='release-driver-fixture-') as root_string:
        root = Path(root_string)
        repo = root / 'repo'
        evidence = root / 'evidence'
        auth_source = root / 'auth-source.json'
        repo.mkdir()
        evidence.mkdir()
        auth_source.write_text('{"real": "credential"}\n')
        gate = object.__new__(module.BinaryGate)
        gate.repo = repo
        gate.evidence_root = evidence
        gate.auth_source = auth_source
        gate.auth_homes = set()
        run_dir = evidence / 'runs' / 'dummy-effort-run'
        run_dir.mkdir(parents=True)
        config, home = module.BinaryGate.make_fixture(
            gate,
            run_dir,
            'effort-openai-responses-wire',
        )
        try:
            auth_target = home / '.codex' / 'auth.json'
            assert json.loads(auth_target.read_text()) == {
                'OPENAI_API_KEY': module.DUMMY_OPENAI_API_KEY,
            }
            assert auth_target.stat().st_mode & 0o777 == 0o600
            assert json.loads((run_dir / 'auth-source-metadata.json').read_text()) == {
                'source': None,
                'strategy': (
                    'write a fixed dummy API key into a private temporary HOME; '
                    'the local mock server accepts no real credential'
                ),
                'source_exists': None,
                'uses_dummy_credential': True,
                'target_outside_evidence': True,
                'target_outside_repository': True,
                'target_mode': '0o600',
            }
            fixture_settings = json.loads((config / 'settings.json').read_text())
            assert fixture_settings['enableWorkflows'] is True
            assert 'model' not in fixture_settings
            assert 'effortLevel' not in fixture_settings
        finally:
            shutil.rmtree(home)

        code_review_run_dir = evidence / 'runs' / 'code-review-run'
        code_review_run_dir.mkdir(parents=True)
        code_review_config, code_review_home = module.BinaryGate.make_fixture(
            gate,
            code_review_run_dir,
            'code-review',
        )
        try:
            code_review_settings = json.loads(
                (code_review_config / 'settings.json').read_text()
            )
            assert code_review_settings['planModeAvailable'] is True
        finally:
            shutil.rmtree(code_review_home)

        first_party_run_dir = evidence / 'runs' / 'first-party-run'
        first_party_run_dir.mkdir(parents=True)
        first_party_config, first_party_home = module.BinaryGate.make_fixture(
            gate,
            first_party_run_dir,
            'first-party-bootstrap-picker',
        )
        try:
            assert json.loads(
                (first_party_home / '.codex' / 'auth.json').read_text()
            ) == {}
            first_party_global_config = json.loads(
                (first_party_config / '.claude-local-oauth.json').read_text()
            )
            assert 'additionalModelOptionsCache' not in first_party_global_config
            assert 'additionalModelOptionsCacheKey' not in first_party_global_config
            assert first_party_global_config['customApiKeyResponses']['approved'] == [
                module.DUMMY_ANTHROPIC_API_KEY[-20:]
            ]
            assert json.loads(
                (first_party_config / 'settings.json').read_text()
            )['model'] == 'release-first-party-bootstrap-model'
            first_party_auth_metadata = json.loads(
                (first_party_run_dir / 'auth-source-metadata.json').read_text()
            )
            assert first_party_auth_metadata['uses_dummy_credential'] is True
            assert first_party_auth_metadata['source'] is None
        finally:
            shutil.rmtree(first_party_home)


def assert_deferred_tool_discovery(module):
    assert 'deferred-tool-discovery' in dict(module.TARGET_PATH_RULES)
    assert callable(getattr(module.BinaryGate, 'deferred_tool_discovery', None))
    assert 'deferred-tool-discovery' in module.MOCK_OPENAI_TARGETS
    assert 'deferred-tool-discovery-off' in module.MOCK_OPENAI_TARGETS
    assert not module.BinaryGate.deferred_discovery_evidence([], True)['passed']
    terminal_schema = {'type': 'object', 'required': ['action'], 'properties': {
        'action': {'enum': ['new-session', 'list-panes', 'send-keys', 'capture-pane',
                            'resize-pane', 'send-signal', 'display-message', 'kill-pane']},
        **{name: {'type': kind} for name, kind in [('target', 'string'), ('text', 'string'),
            ('cols', 'integer'), ('rows', 'integer'), ('enter', 'boolean')]},
    }}
    for enabled in (False, True):
        # Synthetic wire inputs exercise the driver only, not the product binary.
        label = 'deferred-tool-discovery' if enabled else 'deferred-tool-discovery-off'
        with tempfile.TemporaryDirectory() as tmp:
            server = module.MockOpenAIServer(Path(tmp), label)
            body = {'tools': [{'name': 'ToolSearch'}], 'input': []}
            requests = []
            results = {
                'deferred-search': 'Terminal, Workflow' if enabled else 'Terminal',
                'deferred-workflow-off': 'No matching deferred tools found',
                'deferred-open': json.dumps({'target': 'unit-session', 'isRunning': True, 'pid': 88097,
                    'command': '/bin/sh', 'args': ['-c', 'stty -echo; exec cat'],
                    'cols': 80, 'rows': 24, 'preview': ''}),
                'deferred-write': json.dumps({'target': 'unit-session', 'accepted': True, 'isRunning': True}),
                'deferred-resize': json.dumps({'target': 'unit-session', 'cols': 91, 'rows': 31, 'isRunning': True}),
                'deferred-read': json.dumps({'target': 'unit-session', 'text': 'RELEASE_TERMINAL_ROUNDTRIP\r\n',
                    'fromCursor': 0, 'toCursor': 28, 'cols': 91, 'rows': 31, 'isRunning': True,
                    'exitCode': None, 'truncatedBeforeCursor': False, 'mode': 'full',
                    'compressed': False, 'originalBytes': 28, 'returnedBytes': 28}),
                'deferred-status': json.dumps({'target': 'unit-session', 'pid': 88097,
                    'isRunning': True, 'exitCode': None, 'cols': 91, 'rows': 31,
                    'bufferCursor': 1, 'startedAt': 1789060572000, 'lastActivityAt': 1789060573000}),
                'deferred-signal': json.dumps({'target': 'unit-session', 'accepted': True, 'isRunning': True}),
                'deferred-close': json.dumps({'target': 'unit-session', 'closed': True, 'exitCode': 0}),
                'deferred-closed-status': json.dumps({'target': 'unit-session', 'pid': 88097,
                    'isRunning': False, 'exitCode': 0, 'cols': 91, 'rows': 31,
                    'bufferCursor': 1, 'startedAt': 1789060572000, 'lastActivityAt': 1789060574000}),
            }
            for _ in range(12):
                kind, sse = server.response_for(body)
                requests.append({'body': json.loads(json.dumps(body)), 'response_kind': kind,
                                 'authorization': {'present': True, 'matches_dummy': True}})
                if kind == 'deferred-completed':
                    break
                events = [json.loads(line[6:]) for line in sse.splitlines() if line.startswith('data: ')]
                call = next(event for event in events if event['type'] == 'response.function_call_arguments.done')
                assert call['call_id'] == 'fc_' + kind
                assert all(event.get('item', {}).get('id', 'fc_').startswith('fc_') for event in events)
                arguments = json.loads(call['arguments'])
                if kind not in ('deferred-search', 'deferred-workflow-off', 'deferred-open'):
                    assert call['name'] == 'Terminal' and arguments['target'] == 'unit-session'
                body['input'].append({'type': 'function_call', 'call_id': call['call_id'],
                                      'name': call['name'], 'arguments': call['arguments']})
                body['input'].append({'type': 'function_call_output', 'call_id': 'fc_' + kind, 'output': results[kind]})
                body['tools'] = [{'name': 'ToolSearch'}, {'name': 'Terminal', 'parameters': terminal_schema}]
                if enabled:
                    body['tools'].append({'name': 'Workflow', 'parameters': {'type': 'object', 'properties': {
                        name: {'type': 'string'} for name in ('name', 'script', 'scriptPath')}}})
            if enabled:
                notification = ('<task-notification>\n<task-id>unit-task</task-id>\n'
                    '<tool-use-id>fc_deferred-open</tool-use-id>\n'
                    '<task-type>interactive_terminal</task-type>\n'
                    '<output-file>/tmp/tasks/unit-task.output</output-file>\n'
                    '<status>killed</status>\n'
                    '<summary>Terminal unit-session was stopped</summary>\n</task-notification>')
                body['input'].append({'role': 'user', 'content': [
                    {'type': 'input_text', 'text': notification}]})
                kind, sse = server.response_for(body)
                requests.append({'body': json.loads(json.dumps(body)), 'response_kind': kind,
                                 'authorization': {'present': True, 'matches_dummy': True}})
            assert module.BinaryGate.deferred_discovery_evidence(requests, enabled)['passed']
            if enabled:
                assert kind == 'deferred-notification-ack'
                assert 'RELEASE_DEFERRED_NOTIFICATION_ACK' in sse
                assert not module.BinaryGate.deferred_discovery_evidence(requests[:-1], True)['passed']
                for mutation in ('foreign-session', 'foreign-tool', 'foreign-task', 'wrong-type',
                                 'wrong-status', 'duplicate-notification', 'no-notification',
                                 'extra-round', 'early-notification', 'duplicate-call',
                                 'duplicate-result', 'missing-result', 'reordered-call', 'reordered-round'):
                    broken = json.loads(json.dumps(requests))
                    items = broken[-1]['body']['input']
                    text = items[-1]['content'][0]['text']
                    replacements = {
                        'foreign-session': ('Terminal unit-session', 'Terminal foreign-session'),
                        'foreign-tool': ('fc_deferred-open', 'fc_foreign-open'),
                        'foreign-task': ('<task-id>unit-task', '<task-id>foreign-task'),
                        'wrong-type': ('interactive_terminal', 'local_bash'),
                        'wrong-status': ('<status>killed', '<status>running'),
                    }
                    if mutation in replacements:
                        items[-1]['content'][0]['text'] = text.replace(*replacements[mutation])
                    elif mutation == 'duplicate-notification':
                        items.append(items[-1])
                    elif mutation == 'no-notification':
                        items.pop()
                    elif mutation == 'extra-round':
                        broken.append(broken[-1])
                    elif mutation == 'early-notification':
                        broken[-2]['body']['input'].append(items[-1])
                    elif mutation == 'duplicate-call':
                        items.insert(0, items[0])
                    elif mutation == 'duplicate-result':
                        items.insert(1, items[1])
                    elif mutation == 'missing-result':
                        items.pop(1)
                    elif mutation == 'reordered-call':
                        items[0], items[2] = items[2], items[0]
                    else:
                        broken[3], broken[4] = broken[4], broken[3]
                    assert not module.BinaryGate.deferred_discovery_evidence(broken, True)['passed'], mutation
                # The first DONE pane is not a completion barrier: notification
                # delivery and rendering of its acknowledgement are separate ticks.
                gate = object.__new__(module.BinaryGate)
                gate.start = lambda label: (Path(tmp), 'session', 'pane', True)
                gate.send = lambda *args: None
                gate.close = lambda *args: {}
                gate.cleanup_passed = lambda cleanup: True
                gate.record = lambda result: None
                gate.required_assertion = lambda *args, **kwargs: {
                    'validation_verdict': 'passed' if kwargs['passed'] else 'failed'}
                tick = {'value': 0}
                gate.mock_response_requests = lambda directory: (
                    requests if tick['value'] >= 1 else requests[:-1])
                def capture(target, path):
                    text = ('RELEASE_DEFERRED_NOTIFICATION_ACK' if tick['value'] >= 2
                            else 'RELEASE_DEFERRED_DONE')
                    path.write_text(text)
                    return text
                gate.capture = capture
                waits = []
                def wait(predicate, *args):
                    for value in range(3):
                        tick['value'] = value
                        waits.append(bool(predicate()))
                    return waits[-1]
                gate.wait_until = wait
                # Isolate the enabled case while retaining the handler's two-case loop.
                original = module.BinaryGate.deferred_discovery_evidence
                gate.deferred_discovery_evidence = lambda rows, active: (
                    original(rows, True) if active else {'passed': True})
                module.BinaryGate.deferred_tool_discovery(gate)
                assert waits[-3:] == [False, False, True]
                for step, field, value in [
                    *[(step, 'target', 'foreign-session') for step in
                      ('open', 'write', 'resize', 'read', 'status', 'signal', 'close', 'closed-status')],
                    ('open', 'isRunning', False), ('write', 'accepted', False),
                    ('write', 'isRunning', False), ('resize', 'cols', 80),
                    ('resize', 'rows', 24), ('resize', 'isRunning', False),
                    ('read', 'text', ''), ('status', 'isRunning', False),
                    ('signal', 'accepted', False), ('close', 'closed', False),
                    ('closed-status', 'isRunning', True),
                ]:
                    broken = json.loads(json.dumps(requests))
                    for request in broken:
                        for item in request['body']['input']:
                            if item.get('type') == 'function_call_output' and item.get('call_id') == f'fc_deferred-{step}':
                                result = json.loads(item['output'])
                                result[field] = value
                                if step == 'read':
                                    result['preview'] = 'RELEASE_TERMINAL_ROUNDTRIP'
                                item['output'] = json.dumps(result)
                    assert not module.BinaryGate.deferred_discovery_evidence(broken, True)['passed'], (step, field)
            for mutation in ('schema', 'result', 'auth', 'completion', 'initial'):
                broken = json.loads(json.dumps(requests))
                if mutation == 'schema':
                    broken[1]['body']['tools'][1]['parameters']['properties'].pop('target')
                elif mutation == 'result':
                    for request in broken:
                        request['body']['input'] = [item for item in request['body']['input']
                            if item.get('call_id') != ('fc_deferred-close' if enabled else 'fc_deferred-workflow-off')]
                elif mutation == 'auth':
                    broken[-1]['authorization']['matches_dummy'] = False
                elif mutation == 'completion':
                    broken[-1]['response_kind'] = 'deferred-invalid-open'
                else:
                    broken[0]['body']['tools'].append({'name': 'Terminal'})
                assert not module.BinaryGate.deferred_discovery_evidence(broken, enabled)['passed'], mutation


def assert_plugins_reload(module):
    assert 'plugins-reload' in dict(module.TARGET_PATH_RULES)
    assert 'plugins-reload' in module.MOCK_OPENAI_TARGETS
    for path in ('src/utils/plugins/refresh.ts', 'src/services/plugins/pluginOperations.ts',
                 'src/commands/reload-plugins/reload-plugins.ts', 'src/services/mcp/utils.ts'):
        assert 'plugins-reload' in module.required_targets_for_paths([path])
    assert callable(getattr(module.BinaryGate, 'plugins_reload', None))
    assert not module.BinaryGate.plugins_reload_evidence([], [])['passed']
    requests, events = [], []
    for index, phase in enumerate(('v1', 'v2', 'repeat')):
        version = 'v1' if phase == 'v1' else 'v2'
        items = []
        for step, server_version, pid in [('plugin', version, 100 + index), ('other', 'other', 200)]:
            result = {'pid': pid, 'version': server_version, 'phase': phase}
            items.append({'type': 'function_call_output', 'call_id': f'fc_plugins-{phase}-{step}', 'output': json.dumps(result)})
            events.append({'pid': pid, 'version': server_version, 'request': {
                'method': 'tools/call', 'params': {'name': f'probe_{server_version}', 'arguments': {'phase': phase}}}})
        for name in ('version', 'standalone', 'removed-command', 'removed-skill'):
            removed = phase != 'v1' and name.startswith('removed-')
            items.append({'type': 'function_call_output', 'call_id': f'fc_plugins-{phase}-{name}',
                          'output': f'Unknown skill: fixture:{name}' if removed else 'Launching skill'})
            if not removed:
                items.append({'role': 'user', 'content': f'PLUGIN_CONTENT_{name}_{version}'})
        items.append({'type': 'function_call_output', 'call_id': 'fc_plugins-update-update',
                      'output': 'Plugin "fixture" updated from 1.0.0 to 2.0.0 for scope user.'})
        requests.append({'response_kind': f'plugins-{phase}-completed',
                         'authorization': {'present': True, 'matches_dummy': True},
                         'body': {'input': items, 'tools': [{'name': f'mcp__plugin_fixture_server__probe_{version}',
                                  'parameters': {'properties': {'phase': {'type': 'string'}}}}]}})
    assert module.BinaryGate.plugins_reload_evidence(requests, events)['passed']
    for mutation in ('missing-call', 'reused-plugin', 'lost-other', 'stale-skill', 'stale-schema', 'no-update', 'real-auth'):
        rows, logs = json.loads(json.dumps(requests)), json.loads(json.dumps(events))
        if mutation == 'missing-call':
            logs.pop()
        elif mutation == 'reused-plugin':
            logs[4]['pid'] = logs[2]['pid']
        elif mutation == 'lost-other':
            logs[5]['pid'] = 201
        elif mutation == 'stale-skill':
            rows[1]['body']['input'] = [item for item in rows[1]['body']['input'] if item.get('role') != 'user']
        elif mutation == 'stale-schema':
            rows[1]['body']['tools'].extend(rows[0]['body']['tools'])
        elif mutation == 'no-update':
            for row in rows:
                row['body']['input'] = [item for item in row['body']['input'] if item.get('call_id') != 'fc_plugins-update-update']
        else:
            rows[0]['authorization']['matches_dummy'] = False
        assert not module.BinaryGate.plugins_reload_evidence(rows, logs)['passed'], mutation
    with tempfile.TemporaryDirectory(prefix='plugins-driver-unit-') as directory:
        root = Path(directory)
        config, home = root / 'config', root / 'home'
        config.mkdir()
        home.mkdir()
        (config / '.claude.json').write_text('{}')
        gate = object.__new__(module.BinaryGate)
        gate.binary = root / 'must-not-run-binary'
        with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='', stderr='')) as install:
            gate.make_plugin_fixture(root, config, home)
        assert install.call_count == 2
        assert all(call.kwargs['env']['HOME'] == str(home) for call in install.call_args_list)
        assert all('ANTHROPIC_API_KEY' not in call.kwargs['env'] for call in install.call_args_list)
        ast.parse((root / 'plugin-mcp.py').read_text())
        rpc = [{'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2024-11-05'}},
               {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
               {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'probe_v1', 'arguments': {'phase': 'v1'}}}]
        result = subprocess.run([sys.executable, str(root / 'plugin-mcp.py'), 'v1'],
                                input=''.join(json.dumps(row) + '\n' for row in rpc), capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, result.stderr
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        assert replies[1]['result']['tools'][0]['name'] == 'probe_v1'
        assert json.loads(replies[2]['result']['content'][0]['text'])['phase'] == 'v1'
        gate.write_plugin_version(root, 'v2')
        assert not (root / 'marketplace/fixture/commands/removed-command.md').exists()
        assert not (root / 'marketplace/fixture/skills/removed-skill/SKILL.md').exists()
        assert 'PLUGIN_CONTENT_version_v2' in (root / 'marketplace/fixture/commands/version.md').read_text()
        server = module.MockOpenAIServer(root, 'plugins-reload')
        base = server.start()
        try:
            assert base.startswith('http://127.0.0.1:')
            payload = {'model': 'gpt-test', 'input': [{'role': 'user', 'content': 'Run plugin probe'}]}
            request = Request(base + '/v1/responses', data=json.dumps(payload).encode(),
                              headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {module.DUMMY_OPENAI_API_KEY}'})
            with urlopen(request, timeout=10) as response:
                text = response.read().decode()
            assert 'ToolSearch' in text and 'probe_v1' in text
            assert server.snapshot()[-1]['authorization']['matches_dummy']
        finally:
            server.stop()


def assert_openai_stats(module):
    for path in ('src/components/Stats.tsx', 'src/components/Stats.openai.test.tsx',
                 'src/components/OpenAIActivity.tsx', 'src/services/api/usage-chatgpt.ts',
                 'src/services/api/usage.ts', 'src/utils/auth.ts'):
        assert 'openai-stats' in module.required_targets_for_paths([path]), path
    assert callable(getattr(module.BinaryGate, 'openai_stats', None))
    with tempfile.TemporaryDirectory(prefix='stats-auth-unit-') as tmp:
        gate = object.__new__(module.BinaryGate)
        gate.repo = DRIVER_PATH.parents[4]
        gate.evidence_root = Path(tmp)
        gate.auth_source = Path(tmp) / 'must-not-read-real-auth'
        gate.auth_homes = set()
        try:
            for label in ('openai-stats', 'openai-stats-api-key'):
                _, home = gate.make_fixture(Path(tmp) / label, label)
                auth = json.loads((home / '.codex/auth.json').read_text())
                assert auth == {'auth_mode': 'chatgpt', 'tokens': {'access_token': module.OpenAIStatsServer.token}}
                metadata = json.loads((Path(tmp) / label / 'auth-source-metadata.json').read_text())
                assert metadata['uses_dummy_credential'] and metadata['source'] is None
        finally:
            assert not gate.remove_auth_homes()['errors']
    import http.client
    import ssl
    with tempfile.TemporaryDirectory(prefix='stats-driver-unit-') as tmp:
        root = Path(tmp)
        server = module.OpenAIStatsServer(root, root)
        proxy = server.start()
        port = int(proxy.rsplit(':', 1)[1])
        try:
            context = ssl.create_default_context(cafile=str(server.ca))
            def request(path, token=server.token):
                connection = http.client.HTTPSConnection('127.0.0.1', port, context=context, timeout=5)
                try:
                    connection.request('GET', path, headers={'Authorization': f'Bearer {token}'})
                    response = connection.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    connection.close()
            endpoint = 'https://chatgpt.com' + server.activity_path
            assert request(endpoint) == (200, {'stats': {'lifetime_tokens': 42, 'daily_usage_buckets': []}})
            server.fail = True
            assert request(endpoint)[0] == 503
            server.fail = False
            assert request(endpoint)[0] == 200
            for path in ('https://example.invalid/', 'https://chatgpt.com/unknown',
                         endpoint + '?unexpected=1', 'http://chatgpt.com' + server.activity_path):
                assert request(path)[0] == 403
            assert request(endpoint, 'not-a-credential')[0] == 403
            try:
                connection = http.client.HTTPSConnection('127.0.0.1', port, timeout=5)
                connection.request('GET', endpoint)
            except ssl.SSLCertVerificationError:
                pass
            else:
                raise AssertionError('fixture CA unexpectedly trusted globally')
            finally:
                connection.close()
            # Exercise the actual axios/Bun transport, not the product binary or UI.
            env = {'PATH': module.os.environ.get('PATH', ''), 'HOME': tmp,
                   'NODE_EXTRA_CA_CERTS': str(server.ca), 'HTTPS_PROXY': proxy,
                   'HTTP_PROXY': proxy, 'NO_PROXY': '127.0.0.1,localhost'}
            script = ('import axios from "axios";'
                      'const r = await axios.get(process.argv[1], {headers: '
                      '{Authorization: "Bearer " + process.argv[2]}, timeout: 5000});'
                      'console.log(JSON.stringify(r.data));')
            result = subprocess.run(['bun', '-e', script, endpoint, server.token],
                                    cwd=DRIVER_PATH.parents[4], env=env,
                                    capture_output=True, text=True, timeout=15)
            assert result.returncode == 0, (server.snapshot(), result.stderr)
            assert json.loads(result.stdout)['stats']['lifetime_tokens'] == 42
            assert server.token not in (root / 'openai-stats-http.json').read_text()
        finally:
            assert server.stop()['tls_removed']
        assert not server.tls_dir.exists()
        assert server.stop()['tls_removed']
    # Synthetic panes exercise driver verdict rejection, never product validation.
    for mutation in (None, 'pane', 'http', 'override', 'cleanup', 'stale-local'):
        with tempfile.TemporaryDirectory(prefix='stats-verdict-unit-') as tmp:
            root = Path(tmp)
            gate = object.__new__(module.BinaryGate)
            gate.evidence_root = root
            gate.mock_servers = {}
            registered = {}
            state = {}
            recorded = []
            def start(label):
                run = root / 'runs' / label
                run.mkdir(parents=True)
                (run / 'run-metadata.json').write_text(json.dumps({
                    'driver_run': 'stats-unit', 'source_run': run.name,
                    'label': label, 'evidence_dir': str(run.resolve()),
                }))
                registered[str(run.resolve())] = (run / 'run-metadata.json').read_text()
                (run / 'pane-target.txt').write_text('synthetic-only')
                (run / 'openai-stats-http.json').write_text('[]')
                state.update(label=label, tab=0, rows=[], parent_focused=True)
                stub = SimpleNamespace(fail=False, snapshot=lambda: list(state['rows']))
                gate.mock_servers[label] = stub
                return run, label, label, True
            def tmux(*args):
                assert args[3:].count('Tab') <= 1, 'navigate one tab per observed state'
                for key in args[3:]:
                    if key == 'Down':
                        state['parent_focused'] = False
                    elif key == 'Tab':
                        if state['parent_focused']:
                            continue
                        state['tab'] = (state['tab'] + 1) % (2 if state['label'].endswith('api-key') else 3)
                        if state['tab'] == 2 and not state['rows']:
                            state['rows'].append({'route': 'activity', 'status': 200, 'matches_dummy': True})
                    elif key == 'r':
                        state['rows'].append({'route': 'activity', 'status':
                            503 if gate.mock_servers[state['label']].fail else 200, 'matches_dummy': True})
            def capture(target, path, **kwargs):
                text = 'OpenAI provider header\nOverview  Models'
                if not state['label'].endswith('api-key') or mutation == 'override':
                    text += '  OpenAI'
                active = ('Overview', 'Models', 'OpenAI')[state['tab']]
                if mutation == 'stale-local' and state['tab'] == 1:
                    active = 'Overview'
                selected_reset = '\n\x1b[0m' if active == 'OpenAI' else '\x1b[0m'
                text = text.replace('  ' + active if active != 'Overview' else '\nOverview',
                                    ('  ' if active != 'Overview' else '\n')
                                    + '\x1b[1m\x1b[48;5;174m ' + active + ' ' + selected_reset, 1)
                text += '\nNo stats available yet'
                if state['tab'] == 2:
                    text += '\n' + ('Failed to load OpenAI activity' if gate.mock_servers[state['label']].fail
                            else 'Lifetime tokens: 42')
                    text += '\nEsc to cancel · r to refresh'
                if mutation == 'pane':
                    text = 'unrelated pane'
                if mutation == 'http' and state['rows']:
                    state['rows'][0]['matches_dummy'] = False
                path.write_text(text)
                return text
            gate.start = start
            gate.tmux = tmux
            gate.capture = capture
            gate.send = lambda *args: None
            gate.wait_until = lambda predicate, *args: predicate()
            gate.close = lambda *args: {'process_remaining': mutation == 'cleanup', 'forced_termination': []}
            gate.record = recorded.append
            with patch.object(module.time, 'sleep', return_value=None):
                gate.openai_stats()
            result = recorded[0]
            result['driver_run'] = 'stats-unit'
            assert (result['validation_verdict'] == 'passed') == (mutation is None), mutation
            if mutation is None:
                assert module.validate_required_target_results({'openai-stats'}, recorded, registered)['passed']


def assert_team_concurrency_mock(module):
    source = DRIVER_PATH.read_text().split(
        '    def team_concurrency(self):', 1
    )[1].split('\n    def ', 1)[0]
    assert "if terminal:\n                self.send(target, run_dir, '/tasks'" in source
    assert "'Background tasks' in (" in source
    assert "f'Team: {team_name} (4)' in text" in source
    assert "not submitted_input_pending(text)" in source

    assert 'team-concurrency' in module.MOCK_OPENAI_TARGETS
    server = module.MockOpenAIServer(Path('/unused'), 'team-concurrency')
    body = {
        'input': [{'role': 'user', 'content': 'Binary-side team concurrency validation.'}],
    }
    child_kind, child_sse = server.response_for({
        'input': [{
            'role': 'user',
            'content': 'Reply exactly worker-a. Do not use tools or modify files.',
        }],
    })
    assert child_kind == 'team-worker-completed'
    assert 'worker-a' in child_sse
    expected = [
        ('team-create', 'fc_team_create', 'TeamCreate'),
        ('team-agents', 'fc_team_worker_a', 'Agent'),
        ('team-completed', None, None),
    ]
    for expected_kind, expected_call_id, expected_name in expected:
        kind, sse = server.response_for(body)
        assert kind == expected_kind
        if expected_call_id is None:
            assert 'RELEASE_TEAM_CONCURRENCY_DONE' in sse
            continue
        events = [
            json.loads(line[6:])
            for line in sse.splitlines()
            if line.startswith('data: ')
        ]
        calls = [
            event
            for event in events
            if event['type'] == 'response.function_call_arguments.done'
        ]
        if expected_kind == 'team-create':
            assert len(calls) == 1
        else:
            assert len(calls) == 3
            assert [call['call_id'] for call in calls] == [
                'fc_team_worker_a', 'fc_team_worker_b', 'fc_team_worker_c',
            ]
            assert [json.loads(call['arguments'])['name'] for call in calls] == [
                'worker-a', 'worker-b', 'worker-c',
            ]
            assert all(json.loads(call['arguments'])['run_in_background'] for call in calls)
        assert calls[0]['call_id'] == expected_call_id
        assert calls[0]['name'] == expected_name
        for call in calls:
            body['input'].append({
                'type': 'function_call_output',
                'call_id': call['call_id'],
                'output': json.dumps({'status': 'ok'}),
            })


def assert_terminal_repository_ignores_global_signing(module):
    with tempfile.TemporaryDirectory(prefix='terminal-repository-unit-') as tmp:
        root = Path(tmp)
        global_config = root / 'global.gitconfig'
        global_config.write_text('[commit]\n\tgpgSign = true\n')
        fixture = root / 'fixture'
        with patch.dict(module.os.environ, {'GIT_CONFIG_GLOBAL': str(global_config)}):
            module.initialize_terminal_interaction_repository(fixture)
        result = subprocess.run(
            ['git', '-C', str(fixture), 'log', '-1', '--format=%s'],
            check=True,
            capture_output=True,
            text=True,
            env={**module.os.environ, 'GIT_CONFIG_GLOBAL': str(global_config)},
        )
        assert result.stdout.strip() == 'fixture'
        assert subprocess.run(
            ['git', '-C', str(fixture), 'status', '--porcelain'],
            check=True,
            capture_output=True,
            text=True,
        ).stdout == ''
        module.mutate_terminal_interaction_repository(fixture)
        assert (fixture / 'alpha.txt').read_text().endswith('ALPHA_RELEASE_BODY\n')
        assert (fixture / 'omega.txt').read_text().endswith('OMEGA_RELEASE_BODY\n')
        assert subprocess.run(
            ['git', '-C', str(fixture), 'config', '--local', '--get', 'commit.gpgSign'],
            capture_output=True,
            text=True,
            env={**module.os.environ, 'GIT_CONFIG_GLOBAL': str(global_config)},
        ).returncode == 1


def assert_failed_discovery_panes(module):
    for method in ('plugins_reload', 'deferred_tool_discovery',
                   'effort_openai_responses_wire', 'openai_remote_compaction'):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            gate = object.__new__(module.BinaryGate)
            def start(label):
                directory = root / label
                directory.mkdir()
                gate.mock_servers = {directory.name: SimpleNamespace(snapshot=lambda: [])}
                return directory, label, label, False
            def capture(target, path):
                path.write_text('actual failed pane')
                return 'actual failed pane'
            def close(directory, *args):
                panes = list(directory.glob('*pane.txt'))
                assert panes and all(p.read_text() == 'actual failed pane' for p in panes)
                return {}
            gate.start = start
            gate.capture = capture
            gate.close = close
            gate.mock_response_requests = lambda directory: []
            gate.required_assertion = lambda *args, **kwargs: {'validation_verdict': 'failed'}
            gate.record = lambda result: None
            getattr(gate, method)()


def assert_fixture_materializes_builtin_marketplace(module):
    with tempfile.TemporaryDirectory(prefix='release-marketplace-fixture-') as directory:
        root = Path(directory)
        gate = object.__new__(module.BinaryGate)
        gate.evidence_root = root / 'evidence'
        gate.evidence_root.mkdir()
        gate.repo = root / 'repo'
        gate.repo.mkdir()
        gate.auth_homes = set()
        gate.auth_source = root / 'auth.json'
        gate.auth_source.write_text('{}\n')

        config, home = gate.make_fixture(root / 'run', 'nested-agent')
        marketplaces = json.loads(
            (config / 'plugins/known_marketplaces.json').read_text()
        )
        entry = marketplaces['Esonhugh-Marketplace']
        assert entry['source'] == {
            'source': 'github',
            'repo': 'Esonhugh/Marketplace',
        }
        install_location = Path(entry['installLocation'])
        assert install_location.is_dir()
        manifest = json.loads(
            (install_location / '.claude-plugin/marketplace.json').read_text()
        )
        assert manifest['name'] == 'Esonhugh-Marketplace'
        assert manifest['plugins'] == []
        assert entry['autoUpdate'] is False
        assert home in gate.auth_homes


def assert_send_uses_atomic_bracketed_paste(module):
    with tempfile.TemporaryDirectory(prefix='release-send-atomic-') as directory:
        root = Path(directory)
        gate = object.__new__(module.BinaryGate)
        pasted = []
        keys = []
        gate.paste_bytes = lambda target, run_dir, data, filename: pasted.append(
            (target, run_dir, data, filename)
        )
        gate.tmux = lambda *args, **kwargs: keys.append(args)
        gate.wait_until = lambda predicate, *args: any(
            predicate() for _ in range(5)
        )

        text = 'first line\nsecond line'
        captures = iter((
            '❯ first line\n  second line\n'
            '────────────────────────────────────────\n'
            '  bypass permissions on  Debug mode\n',
            '❯ ',
        ))
        gate.capture = lambda *args, **kwargs: next(captures)
        gate.send('pane', root, text, 'input.txt')

        assert pasted == [(
            'pane',
            root,
            b'\x1b[200~' + text.encode() + b'\x1b[201~',
            'input.txt',
        )]
        assert keys == [('send-keys', '-t', 'pane', 'Enter')]

        pending = (
            '❯ first line\n'
            '  second line\n'
            '────────────────────────────────────────\n'
            '  bypass permissions on  Debug mode\n'
        )
        keys.clear()
        captures = iter((pending, pending, '❯ '))
        gate.capture = lambda *args, **kwargs: next(captures)
        gate.send('pane', root, text, 'wrapped-input.txt')
        assert keys == [
            ('send-keys', '-t', 'pane', 'Enter'),
            ('send-keys', '-t', 'pane', 'Enter'),
        ]

        keys.clear()
        captures = iter((
            '❯ \n  Pasting text…\n',
            '❯ first line\n  second line\n'
            '────────────────────────────────────────\n'
            '  bypass permissions on  Debug mode\n',
            '❯ ',
        ))
        gate.capture = lambda *args, **kwargs: next(captures)
        gate.send('pane', root, text, 'paste-publishing-input.txt')
        assert keys == [('send-keys', '-t', 'pane', 'Enter')]

        stats_open = (
            '❯ /stats\n'
            '────────────────────────────────────────\n'
            '   Status   Config   Usage   Stats\n'
            '   Overview   Models   OpenAI\n'
            '  No stats available yet. Start using Claude Code!\n'
            '    Esc to cancel · r to cycle dates · ctrl+s to copy\n'
        )
        keys.clear()
        captures = iter((
            '❯ /stats\n────────────────────────────────────────\n  bypass permissions on\n',
            stats_open,
        ))
        gate.capture = lambda *args, **kwargs: next(captures)
        gate.send('pane', root, '/stats', 'stats-input.txt')
        assert keys == [('send-keys', '-t', 'pane', 'Enter')]

        pasted_ref = '❯ [Pasted text #1 +1 lines]\n────────────────────────────────────────\n'
        keys.clear()
        captures = iter((pasted_ref, '❯ '))
        gate.capture = lambda *args, **kwargs: next(captures)
        gate.send('pane', root, text, 'pasted-ref-input.txt')
        assert keys == [('send-keys', '-t', 'pane', 'Enter')]

        ssh_text = 'RELEASE_SSH_TASK_START'
        ssh_pending = (
            '❯ RELEASE_SSH_TASK_START\n'
            '────────────────────────────────────────\n'
            '  xhigh · /effort · Goal is set\n'
            '  Debug mode\n'
        )
        keys.clear()
        captures = iter((ssh_pending, ssh_pending, '❯ '))
        gate.capture = lambda *args, **kwargs: next(captures)
        gate.send('pane', root, ssh_text, 'ssh-goal-input.txt')
        assert keys == [
            ('send-keys', '-t', 'pane', 'Enter'),
            ('send-keys', '-t', 'pane', 'Enter'),
        ]

        ssh_install_pending = (
            '❯ RELEASE_SSH_TASK_START\n'
            '────────────────────────────────────────\n'
            '  Native installation exists but ~/.local/bin is not in your PATH. Run:\n'
            '  echo export PATH · Goal is set\n'
            '  Debug mode\n'
        )
        permission = (
            '❯ RELEASE_SSH_TASK_START\n'
            '⏺ Bash(pwd)\n'
            '────────────────────────────────────────\n'
            '  Tool use\n'
            '  Do you want to proceed?\n'
            '  ❯ 1. Yes\n'
        )
        keys.clear()
        captures = iter((ssh_install_pending, permission))
        gate.capture = lambda *args, **kwargs: next(captures)
        gate.send('pane', root, ssh_text, 'ssh-permission-input.txt')
        assert keys == [('send-keys', '-t', 'pane', 'Enter')]

        keys.clear()
        gate.capture = lambda *args, **kwargs: pending
        try:
            gate.send('pane', root, text, 'still-pending-input.txt')
        except RuntimeError as error:
            assert 'input remained pending after confirmation' in str(error)
        else:
            raise AssertionError('send must fail when confirmation leaves input pending')
        assert keys == [
            ('send-keys', '-t', 'pane', 'Enter'),
            ('send-keys', '-t', 'pane', 'Enter'),
        ]


def assert_terminal_request_predicate(module):
    def request(*texts):
        return {'method': 'POST', 'path': '/v1/responses', 'body': {'input': [
            {'role': 'user', 'content': [{'type': 'input_text', 'text': text}]}
            for text in texts
        ]}}

    def request_with_blocks(*texts):
        result = request()
        result['body']['input'] = [{
            'role': 'user',
            'content': [{'type': 'input_text', 'text': text} for text in texts],
        }]
        return result

    old = request('中文')
    assert not module.terminal_request_submitted([old], 1, '中文')
    assert not module.terminal_request_submitted([old, request('中文', 'wrong')], 1, '中文')
    assert not module.terminal_request_submitted([old, request('prefix中文')], 1, '中文')
    assert not module.terminal_request_submitted([old, request('中文suffix')], 1, '中文')
    assert module.terminal_request_submitted([old, request('old', '中文')], 1, '中文')
    assert not module.terminal_request_submitted([old, request('中文'), request('中文')], 1, '中文')
    assert not module.terminal_request_submitted([old, request('中文'), request('wrong')], 1, '中文')

    title = request('中文')
    title['body']['instructions'] = module.TITLE_GENERATION_INSTRUCTION
    main = request_with_blocks(
        '<available-deferred-tools>ToolSearch</available-deferred-tools>',
        '<system-reminder>context</system-reminder>',
        '<system-reminder>more context</system-reminder>',
        '中文',
    )
    assert module.terminal_request_submitted([old, title, main], 1, '中文')
    assert module.terminal_request_submitted([old, main, title], 1, '中文')
    assert not module.terminal_request_submitted([
        old,
        title,
        request_with_blocks('<system-reminder>context</system-reminder>', 'wrong'),
    ], 1, '中文')

    continued = request('中文')
    continued['body']['input'].append({'type': 'function_call_output', 'output': 'ok'})
    assert not module.terminal_request_submitted([old, continued], 1, '中文')
    extra = request_with_blocks(
        '<system-reminder>context</system-reminder>', 'extra', '中文',
    )
    assert not module.terminal_request_submitted([old, extra], 1, '中文')
    non_text = request_with_blocks('中文')
    non_text['body']['input'][-1]['content'].insert(0, {'type': 'input_image', 'image_url': 'data:'})
    assert not module.terminal_request_submitted([old, non_text], 1, '中文')


def assert_terminal_git_wrapper(module):
    with tempfile.TemporaryDirectory(prefix='terminal-git-wrapper-') as tmp:
        root = Path(tmp)
        module.initialize_terminal_interaction_repository(root / 'project')
        module.mutate_terminal_interaction_repository(root / 'project')
        wrapper = module.create_terminal_git_wrapper(root)
        base = [str(wrapper / 'git'), '--no-optional-locks',
                f'--git-dir={root / "project/.git"}',
                f'--work-tree={root / "project"}', '--literal-pathspecs',
                'diff', '--no-ext-diff', '--no-textconv', '--no-color',
                '--ignore-submodules=dirty', 'HEAD']
        # Stats, other paths, and multi-path commands must never wait on the FIFO.
        for suffix in (['--numstat', '-z', '--', 'omega.txt'],
                       ['--shortstat', '--', 'omega.txt'],
                       ['--', 'alpha.txt'], ['--', 'alpha.txt', 'omega.txt']):
            subprocess.run(base + suffix, cwd=root / 'project', check=True,
                           capture_output=True, timeout=10)
        assert not (root / 'omega-body-blocked.json').exists()
        process = subprocess.Popen(base + ['--', 'omega.txt'], cwd=root / 'project',
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            # FIFO readiness is observable; no timed success barrier.
            deadline = time.monotonic() + 10
            while not (root / 'omega-body-blocked.json').exists():
                assert process.poll() is None
                assert time.monotonic() < deadline, 'wrapper never reached body barrier'
            assert process.poll() is None
            marker = json.loads((root / 'omega-body-blocked.json').read_text())
            assert marker['argv'] == base[1:] + ['--', 'omega.txt']
            module.release_terminal_git_wrapper(root)
            stdout, stderr = process.communicate(timeout=10)
            assert process.returncode == 0, stderr
            assert b'OMEGA_RELEASE_BODY' in stdout
            # Release is latched and idempotent, including future body requests.
            module.release_terminal_git_wrapper(root)
            subprocess.run(base + ['--', 'omega.txt'], cwd=root / 'project',
                           check=True, capture_output=True, timeout=10)
        finally:
            module.release_terminal_git_wrapper(root)
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=10)


def assert_terminal_matrix_execution(module):
    for failure in (None, 'paste-head', 'omega-loading', 'resize-109'):
        with tempfile.TemporaryDirectory(prefix='terminal-matrix-execution-') as tmp:
            root = Path(tmp)
            (root / 'project').mkdir()
            (root / 'omega-body-blocked.json').write_text('{}')
            gate = object.__new__(module.BinaryGate)
            gate.start = lambda label: (root, 'session', 'pane', True)
            rows = []
            gate.mock_servers = {root.name: SimpleNamespace(snapshot=lambda: list(rows))}
            gate.wait_until = lambda predicate, *args: bool(predicate())
            state = {
                'width': 200,
                'closed': False,
                'released': False,
                'phase': '',
                'cleanup': False,
                'diff_mode': 'files',
                'selection': 'alpha',
            }
            chunks = []
            def request(text):
                rows.append({'method': 'POST', 'path': '/v1/responses', 'body': {'input': [
                    {'role': 'user', 'content': text}]}})
            def paste(target, directory, chunk, name):
                chunks.append((name, chunk))
                expected = {
                    'raw-same_chunk_utf8_submit.bin': '中文',
                    'raw-csi_u_submit.bin': '中文',
                    'raw-raw_backspace_submit.bin': '中',
                    'raw-raw_del_submit.bin': '中',
                    'raw-forward_delete_submit.bin': '中',
                    'raw-cursor_combination_submit.bin': '首中甲文乙尾',
                    'raw-delayed-paste-enter.bin': 'RECOVERY_LITERAL_CONTINUATION',
                }
                if name in expected:
                    request(expected[name])
                if name == 'raw-delayed-paste-continuation.bin':
                    assert state['phase'] == '05a-paste-head-pane'
                if name == 'raw-delayed-paste-enter.bin':
                    assert state['phase'] == '05b-paste-continuation-pane'
                if name == 'raw-diff-down-enter.bin':
                    assert state['phase'] == '06a-partial-publish-pane'
                    assert not state['released'] and chunk == b'\x1b[B\r'
                    state['selection'] = 'omega'
                    state['diff_mode'] = 'detail'
                if name == 'raw-resize-detail-back.bin':
                    assert state['diff_mode'] == 'detail'
                    state['diff_mode'] = 'files'
                if name == 'raw-resize-up-enter.bin':
                    assert state['diff_mode'] == 'files'
                    assert chunk == b'\x1b[A\r'
                    state['selection'] = 'alpha'
                    state['diff_mode'] = 'detail'
                if name == 'raw-detail-back.bin':
                    assert state['diff_mode'] == 'detail'
                    state['diff_mode'] = 'files'
                if name == 'raw-diff-close.bin':
                    assert state['diff_mode'] == 'files'
                    state['closed'] = True
                    state['diff_mode'] = 'closed'
                if name == 'raw-diff-reopen.bin':
                    state['closed'] = False
                    state['diff_mode'] = 'files'
            gate.paste_bytes = paste
            gate.send = lambda *args: None
            def tmux(*args, **kwargs):
                if args[0] == 'resize-window':
                    state['width'] = int(args[args.index('-x') + 1])
                return SimpleNamespace(stdout=f'{state["width"]}x34', returncode=0)
            gate.tmux = tmux
            gate.debug = lambda directory: '[diff] dialog close user' if state['closed'] else ''
            def capture(target, path, **kwargs):
                state['phase'] = path.stem
                if failure and failure in path.stem:
                    text = 'Base: session Diff · detail stale state'
                elif 'startup' in path.stem:
                    text = ' '.join('CLAWD_RELEASE_ROW_' + name for name in
                                    ('ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN'))
                    text += ' CLAWD_RELEASE_WIDE_ bypass permissions on'
                elif 'paste-head' in path.stem:
                    text = 'RECOVERY_LITERAL'
                elif 'paste-continuation' in path.stem:
                    text = 'RECOVERY_LITERAL_CONTINUATION'
                elif 'alpha-ready' in path.stem or 'dialog-entry' in path.stem:
                    text = 'Diff · files alpha.txt ALPHA_RELEASE_BODY'
                elif 'alpha-detail' in path.stem:
                    text = 'Diff · detail alpha.txt ALPHA_RELEASE_BODY'
                elif 'partial-publish' in path.stem or 'reopened' in path.stem:
                    text = 'Diff · files alpha.txt omega.txt ALPHA_RELEASE_BODY'
                elif 'omega-loading' in path.stem:
                    text = 'Diff · detail omega.txt Loading diff body'
                elif 'omega-ready' in path.stem:
                    assert state['released']
                    text = 'Diff · detail omega.txt OMEGA_RELEASE_BODY'
                elif 'resize-109' in path.stem:
                    assert state['diff_mode'] == 'detail'
                    text = 'Diff · detail omega.txt OMEGA_RELEASE_BODY'
                elif 'resize-110' in path.stem:
                    assert state['released']
                    assert state['diff_mode'] == 'detail'
                    text = 'Diff · detail omega.txt OMEGA_RELEASE_BODY'
                elif 'alpha-detail' in path.stem:
                    assert state['diff_mode'] == 'detail'
                    assert state['selection'] == 'alpha'
                    text = 'Diff · detail alpha.txt ALPHA_RELEASE_BODY'
                elif 'files' in path.stem:
                    assert state['diff_mode'] == 'files'
                    text = 'Diff · files alpha.txt omega.txt'
                elif 'closed' in path.stem:
                    assert state['diff_mode'] == 'closed'
                    text = '❯'
                else:
                    text = '❯'
                path.write_text(text)
                return text
            gate.capture = capture
            def release(directory):
                state['released'] = True
            def close(*args):
                assert state['released']
                state['cleanup'] = True
                return {}
            gate.close = close
            gate.cleanup_passed = lambda cleanup: True
            gate.required_assertion = lambda *args, **kwargs: kwargs
            results = []
            gate.record = results.append
            with patch.object(module, 'release_terminal_git_wrapper', release):
                gate.terminal_interaction()
            assert state['cleanup']
            checks = results[0]['checks']
            if failure is None:
                incomplete = {'normal_native_exit', 'independent_pty_capture_identity',
                              'independent_pty_resize_sequence', 'bounded_terminal_evidence',
                              'full_terminal_coverage'}
                assert all(value for key, value in checks.items()
                           if not key.startswith('frame_') and key not in incomplete), checks
                assert all(checks[key] is False for key in incomplete), checks
                assert checks['frame_physical'] is False  # no evidence cannot pass
                expected_chunks = {
                    'raw-csi_u_submit.bin': b'\x1b[20013u\x1b[25991u\x1b[13u',
                    'raw-raw_backspace_submit.bin': '中文'.encode() + b'\x08\r',
                    'raw-raw_del_submit.bin': '中文'.encode() + b'\x7f\r',
                    'raw-forward_delete_submit.bin': '中文'.encode() + b'\x1b[D\x1b[3~\r',
                    'raw-cursor_combination_submit.bin': (
                        '中文'.encode() + b'\x1b[D' + '甲'.encode() + b'\x1b[C'
                        + '乙'.encode() + b'\x1b[H' + '首'.encode()
                        + b'\x1b[F' + '尾'.encode() + b'\r'),
                }
                assert {name: chunk for name, chunk in chunks if name in expected_chunks} == expected_chunks
            else:
                assert checks['scenario_completed'] is False
            assert results[0]['validation_verdict'] == 'failed'


def assert_terminal_matrix_contract(module):
    source = DRIVER_PATH.read_text().split('    def terminal_interaction(self):', 1)[1].split(
        '    def canonical_pane_states(self, run_dir):', 1)[0]
    assert 'recovery_deadline' not in source
    assert 'time.monotonic' not in source
    assert 'self.send(' not in source  # generic send has a fixed sleep barrier
    for name in ('csi_u_submit', 'raw_backspace_submit', 'raw_del_submit',
                 'forward_delete_submit', 'cursor_combination_submit',
                 'paste_head_visible', 'paste_continuation_visible',
                 'diff_alpha_ready', 'diff_partial_loading', 'resize_intent',
                 'resize_keyboard_ownership', 'frame_semantics'):
        assert name in source, name
    assert 'terminal_request_submitted' in source
    assert "raw('resize-back-to-files', b'\\x1b')" not in source
    assert "raw('resize-up-enter', b'\\x1b[A\\r')" in source
    assert source.index("'diff_alpha_ready'") < source.index("'raw-diff-down-enter.bin'")
    assert 'release_terminal_git_wrapper(run_dir)' in source
    assert 'finally:' in source
    assert "json.loads(frame_report.read_text())" in source
    # A successful verifier exit alone is insufficient.
    assert 'terminal_frame_report_checks' in source
    frames = [
        {'frameId': 1, 'columns': 110, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'files', 'alphaBody': True}},
        {'frameId': 2, 'columns': 110, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'detail', 'omegaFile': True, 'loading': True, 'omegaBody': False}},
        {'frameId': 3, 'columns': 110, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'detail', 'omegaFile': True, 'omegaBody': True}},
        {'frameId': 4, 'columns': 109, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'detail', 'omegaFile': True, 'omegaBody': True}},
        {'frameId': 5, 'columns': 110, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'detail', 'omegaFile': True, 'omegaBody': True}},
    ]
    report = {'method': 'renderer-write-replay-v1', 'verdict': 'passed',
              'frameCount': len(frames), 'frames': frames,
              'sizeSequence': [{k: f[k] for k in ('columns', 'rows', 'frameId')}
                               for f in (frames[0], frames[3], frames[4])]}
    assert all(module.terminal_frame_report_checks(report).values())
    for bad in (None, [], {}, {**report, 'frames': None}, {**report, 'frames': [None]},
                {**report, 'frames': []}, {**report, 'sizeSequence': []},
                {**report, 'verdict': 'failed'},
                {**report, 'frames': [{**f, 'semantic': {}} for f in frames]},
                {**report, 'frames': list(reversed(frames))}):
        assert not all(module.terminal_frame_report_checks(bad).values()), bad


def assert_deterministic_lifecycle_protocol(module):
    def user(text, blocks):
        return {'role': 'user', 'content': (
            [{'type': 'input_text', 'text': '<system-reminder>Runtime context</system-reminder>'},
             {'type': 'input_text', 'text': text}] if blocks else text)}

    def output(call, text='ok'):
        return {'type': 'function_call_output', 'call_id': call['call_id'], 'output': text}

    for label in ('nested-agent', 'workflow', 'code-review'):
        for blocks in (False, True):
            with tempfile.TemporaryDirectory(prefix='release-lifecycle-protocol-') as directory:
                root = Path(directory)
                server = module.MockOpenAIServer(root, label)
                base = server.start()
                gate = object.__new__(module.BinaryGate)
                gate.mock_servers = {root.name: server}
                gate.code_review_mock_servers = {root.name: server} if label == 'code-review' else {}

                def post(items, expected, tool=None):
                    request = Request(base + '/v1/responses',
                                      data=json.dumps({'input': items}).encode(),
                                      headers={'Authorization': 'Bearer ' + module.DUMMY_OPENAI_API_KEY,
                                               'Content-Type': 'application/json'})
                    with urlopen(request, timeout=3) as response:
                        wire = response.read().decode()
                    assert server.snapshot()[-1]['response_kind'] == expected, (label, wire)
                    events = [json.loads(line[6:]) for line in wire.splitlines() if line.startswith('data: ')]
                    if tool:
                        calls = [event for event in events if event['type'] == 'response.function_call_arguments.done']
                        assert len(calls) == 1 and calls[0]['name'] == tool
                        return {**calls[0], 'args': json.loads(calls[0]['arguments'])}
                    assert events[-1]['type'] == ('response.incomplete' if expected.endswith(('unrecognized', 'duplicate')) else 'response.completed')
                    return wire

                try:
                    if label == 'nested-agent':
                        parent = [user('Release gate read-only nested Agent validation.', blocks)]
                        launch = post(parent, 'nested-root-launch', 'Agent')
                        assert launch['args']['run_in_background'] is False
                        nested = [user(launch['args']['prompt'], blocks)]
                        # Assistant arguments contain child markers, but must not route the root as a child.
                        parent.append({'type': 'function_call', 'name': 'Agent',
                                       'call_id': launch['call_id'], 'arguments': json.dumps(launch['args'])})
                        child = post(nested, 'nested-parent-launch', 'Agent')
                        assert child['args']['run_in_background'] is False
                        assert 'RELEASE_NESTED_CHILD_DONE' in post(
                            [user(child['args']['prompt'], blocks)], 'nested-child-completed')
                        nested.append(output(child, 'RELEASE_NESTED_CHILD_DONE'))
                        assert 'RELEASE_NESTED_PARENT_DONE' in post(nested, 'nested-parent-completed')
                        parent.append(output(launch, 'RELEASE_NESTED_PARENT_DONE'))
                        assert 'RELEASE_NESTED_ROOT_DONE' in post(parent, 'nested-root-completed')
                    else:
                        if label == 'workflow':
                            parent = [user('Use Workflow with this exact inline script.\n```js\n' + module.INLINE_WORKFLOW_SCRIPT + '```', blocks)]
                            search = post(parent, 'workflow-search', 'ToolSearch')
                            assert search['args'] == {'query': 'select:Workflow'}
                            parent.append(output(search, 'Workflow discovered'))
                            launch = post(parent, 'workflow-launch', 'Workflow')
                            assert launch['args'] == {'script': module.INLINE_WORKFLOW_SCRIPT}
                            assert launch['args']['script'].count('() => agent(') == 2
                            for name, path in (('a', 'Makefile'), ('b', 'package.json')):
                                worker = [user(f'Read-only. Read {path} and report only ' + ('VERSION.' if name == 'a' else 'version.'), blocks)]
                                read = post(worker, f'workflow-probe-{name}-read', 'Read')
                                assert Path(read['args']['file_path']).name == path
                                worker.append(output(read, 'fixture version'))
                                post(worker, f'workflow-probe-{name}-completed')
                        else:
                            args = module.code_review_prompt('a' * 40).removeprefix('/code-review ')
                            parent = [user('Workflow: code-review\nSource: bundled:code-review\n\nUser input:\n' + args +
                                           '\n\nExecute this validated workflow through WorkflowTool.run with selector-based input. Use selector: "code-review" and pass the user input as runArgs.', blocks)]
                            launch = post(parent, 'code-review-launch', 'WorkflowTool')
                            assert launch['args'] == {'action': 'run', 'selector': 'code-review', 'runArgs': args}
                            assert 'script' not in launch['args'] and 'plan' not in launch['args']
                            scope = [user('Establish the scope of a code review.\n\nReview target / instructions (passed by the user, verbatim): "' + args + '".', blocks)]
                            structured = post(scope, 'code-review-scope-output', 'StructuredOutput')
                            assert structured['args']['files'] == []
                            assert structured['args']['diffCommand'].startswith('git diff ')
                            assert structured['args']['summary']
                            scope.append(output(structured, 'Structured output provided successfully'))
                            post(scope, 'code-review-scope-completed')
                        parent.append(output(launch, 'Workflow launched in background. Task ID: wfixture'))
                        post(parent, label + '-parent-completed')
                        parent.append(user('<task-notification><task-id>wfixture</task-id><status>completed</status></task-notification>', blocks))
                        post(parent, label + '-notification-completed')
                    assert label in module.MOCK_OPENAI_TARGETS
                    assert gate.workflow_mock_wire(root, label)['validation_verdict'] == 'passed'
                    # Wire evidence must fail independently for missing, duplicate, unknown and non-dummy requests.
                    saved = server.snapshot()
                    for mutated in (saved[1:], saved + [saved[0]],
                                    saved + [{**saved[0], 'response_kind': 'unrecognized'}],
                                    [{**saved[0], 'authorization': {'matches_dummy': False}}, *saved[1:]]):
                        with server.lock:
                            server.requests = mutated
                        assert gate.workflow_mock_wire(root, label)['validation_verdict'] == 'failed'
                    with server.lock:
                        server.requests = list(saved)
                    assert gate.workflow_mock_wire(root, label)['validation_verdict'] == 'passed'
                    for request in saved:
                        post(request['body']['input'], label + '-duplicate')
                    assert post(parent, label + '-duplicate')
                    assert gate.workflow_mock_wire(root, label)['validation_verdict'] == 'failed'
                    assert post([user('unknown', blocks)], label + '-unrecognized')
                    assert gate.workflow_mock_wire(root, label)['validation_verdict'] == 'failed'
                    for authorization in (None, 'Bearer not-the-dummy-key'):
                        headers = {'Content-Type': 'application/json'}
                        if authorization:
                            headers['Authorization'] = authorization
                        try:
                            urlopen(Request(base + '/v1/responses', data=b'{"input":[]}',
                                            headers=headers), timeout=3)
                        except HTTPError as error:
                            assert error.code == 401
                            error.close()
                        else:
                            raise AssertionError('mock accepted non-dummy authentication')
                        assert server.snapshot()[-1]['response_kind'] == 'invalid-auth'
                        assert gate.workflow_mock_wire(root, label)['validation_verdict'] == 'failed'
                finally:
                    assert server.stop()['stopped']

        # These labels must never consult a real credential source.
        with tempfile.TemporaryDirectory(prefix='release-lifecycle-auth-') as directory:
            root = Path(directory)
            gate = object.__new__(module.BinaryGate)
            gate.repo = root
            gate.evidence_root = root
            gate.auth_source = root / 'must-not-read-auth'
            gate.auth_homes = set()
            try:
                _, home = gate.make_fixture(root, label)
                assert json.loads((home / '.codex/auth.json').read_text()) == {'OPENAI_API_KEY': module.DUMMY_OPENAI_API_KEY}
                assert json.loads((root / 'auth-source-metadata.json').read_text())['source'] is None
            finally:
                for home in gate.auth_homes:
                    shutil.rmtree(home)


def test_retained_readiness_and_local_lifecycles_never_read_account_auth():
    module = load_driver()
    for label in ('readiness-smoke', 'goal-lifecycle', 'ssh-remote-session-lifecycle'):
        assert label in module.MOCK_OPENAI_TARGETS
        with tempfile.TemporaryDirectory(prefix='release-local-readiness-') as directory:
            root = Path(directory)
            gate = object.__new__(module.BinaryGate)
            gate.repo = root / 'repo'
            gate.evidence_root = root / 'evidence'
            gate.auth_source = root / 'unavailable-auth-source'
            gate.auth_homes = set()
            run = gate.evidence_root / label
            run.mkdir(parents=True)
            try:
                _, home = gate.make_fixture(run, label)
                assert json.loads((home / '.codex/auth.json').read_text()) == {'OPENAI_API_KEY': module.DUMMY_OPENAI_API_KEY}
                metadata = json.loads((run / 'auth-source-metadata.json').read_text())
                assert metadata['source'] is None
                assert metadata['uses_dummy_credential'] is True
                assert metadata['target_outside_evidence'] is True
                assert metadata['target_outside_repository'] is True
                assert not gate.auth_source.exists()
            finally:
                for home in gate.auth_homes:
                    shutil.rmtree(home)


def test_retained_foreground_fixtures_declare_mode_and_route_actual_mock_requests():
    module = load_driver()
    requests = {
        'agent-fg-bg': {'input': [{'role': 'user', 'content': 'launch'}]},
        'nested-agent': {'input': [{'role': 'user', 'content': 'Release gate read-only nested Agent validation.'}]},
        'coordinator-selector': {'input': [{'role': 'user', 'content': 'launch'}]},
        'subagent-stop-failure-lifecycle': {'input': [{'role': 'user', 'content': 'launch'}]},
    }
    for label, body in requests.items():
        with tempfile.TemporaryDirectory(prefix='release-driver-foreground-mode-') as root_string:
            root = Path(root_string)
            gate = object.__new__(module.BinaryGate)
            gate.repo = root / 'repo'
            gate.evidence_root = root / 'evidence'
            gate.auth_source = root / 'absent-auth-source'
            gate.auth_homes = set()
            run = gate.evidence_root / label
            run.mkdir(parents=True)
            try:
                config, _ = gate.make_fixture(run, label)
                agent_type, tools = module.FOREGROUND_FIXTURES[label]
                definition = (config / f'agents/{agent_type}.md').read_text()
                assert 'background: false' in definition and f'tools: {tools}' in definition
                server = module.MockOpenAIServer(run, label)
                # response_for consults the recorded request when counting root turns.
                server.requests.append({'method': 'POST', 'path': '/v1/responses', 'body': body})
                _, reply = server.response_for(body)
                events = [json.loads(line[6:]) for line in reply.splitlines() if line.startswith('data: ')]
                calls = [event for event in events if event['type'] == 'response.function_call_arguments.done']
                assert len(calls) == 1 and calls[0]['name'] == 'Agent', (label, reply)
                arguments = json.loads(calls[0]['arguments'])
                assert arguments['subagent_type'] == agent_type, (label, arguments)
                assert arguments['run_in_background'] is False
                if label == 'nested-agent':
                    _, reply = server.response_for({'input': [{'role': 'user', 'content': arguments['prompt']}]})
                    events = [json.loads(line[6:]) for line in reply.splitlines() if line.startswith('data: ')]
                    call = next(event for event in events if event['type'] == 'response.function_call_arguments.done')
                    child = json.loads(call['arguments'])
                    assert child['subagent_type'] == agent_type and child['run_in_background'] is False
            finally:
                for home in gate.auth_homes: shutil.rmtree(home)
    assert not ({'workflow', 'code-review', 'workflow-retry-partial-failure', 'team-concurrency', 'transcript-retention'} & module.FOREGROUND_FIXTURES.keys())
    driver = DRIVER_PATH.read_text()
    assert "if label in FOREGROUND_FIXTURES:\n            args.extend(['-e', 'CC_VALIDATION_FORK_SUBAGENT=0'])" in driver
    launcher = (DRIVER_PATH.parents[2] / 'claude-agent-workflow-validation/scripts/launch-built-claude.sh').read_text()
    assert 'CLAUDE_CODE_FORK_SUBAGENT="$CC_VALIDATION_FORK_SUBAGENT"' in launcher
    assert 'CLAUDE_CODE_FORK_SUBAGENT=0' not in launcher


def test_retained_builtin_producers_and_archives_cannot_omit_binary_acceptance():
    module = load_driver()
    for path in ['src/plugins/builtinMods.ts','src/plugins/builtinShippedMods.ts','src/plugins/builtinPlugins.ts','src/plugins/bundled/index.ts','assets/builtin-mods-2.1.277.zip','assets/builtin-diff-2.1.292.zip']:
        assert 'builtin-mods' in module.required_targets_for_paths([path]), path


def test_retained_missing_assertion_evidence_fails_closed():
    driver = load_driver()
    gate = object.__new__(driver.BinaryGate)
    with tempfile.TemporaryDirectory(prefix='missing-proof-') as directory:
        run = Path(directory)
        good = run / 'real.txt'
        good.write_text('owned proof')
        missing = run / 'not-reached.txt'
        result = gate.required_assertion(run, 'missing-proof', 'proof', 'required proof exists', [good, missing], passed=True)
        assert result['validation_verdict'] == 'failed'
        assert result['observed_evidence_paths'] == [str(good.resolve())]
        assert result['missing_evidence_paths'] == [str(missing.resolve())]


def test_retained_additional_target_assertion_failure_is_not_a_pass():
    driver = load_driver()
    with tempfile.TemporaryDirectory(prefix='planned-proof-') as directory:
        gate = object.__new__(driver.BinaryGate)
        gate.stamp, gate.pid = 'unit', 1
        gate.evidence_root = Path(directory) / 'evidence'
        gate.cleanup_started = False
        gate.registered_runs = {}
        gate.manifest = {'runs': [], 'required_targets': []}
        gate.baseline = {key: None for key in ('head', 'branch', 'status_porcelain', 'unstaged_diff_sha256', 'staged_diff_sha256', 'untracked_files_sha256', 'ignored_files_excluded_roots', 'ignored_files_sha256', 'binary')}
        gate.baseline['status_porcelain'] = ''
        gate.acquire_lease = lambda: None
        gate.release_lease = lambda: {'released': True}
        gate.repository_state = lambda: dict(gate.baseline)
        gate.close_active_runs = lambda: []
        gate.remove_auth_homes = lambda: {'errors': []}
        gate.archive_and_remove_workflow_runs = lambda: {'passed': True}
        gate.run_target = lambda _label, action: action()
        gate.readiness_smoke = lambda: gate.record({'label': 'readiness-smoke', 'validation_verdict': 'passed', 'evidence_dir': str(gate.evidence_root)})
        for name in ('openai_stats', 'goal_lifecycle', 'direct_agent', 'subagent_stop_failure_lifecycle', 'nested_agent', 'effort_openai_responses_wire', 'plugins_reload', 'deferred_tool_discovery', 'fast_openai_responses_wire', 'openai_image_input_wire', 'openai_remote_compaction', 'openai_responses_usage_error', 'model_discovery_picker', 'model_discovery_empty_picker', 'first_party_bootstrap_picker', 'model_internal_update_config_skill', 'prompt_modes_cache_prefix', 'team_concurrency', 'workflow_retry_partial_failure', 'workflow_failure_detail', 'coordinator_selector', 'transcript_retention', 'ssh_remote_session_lifecycle', 'terminal_interaction', 'builtin_mods'):
            setattr(gate, name, lambda: None)
        def workflow():
            run = gate.evidence_root / 'workflow'
            run.mkdir()
            proof = gate.required_assertion(run, 'missing', 'workflow', 'proof exists', [run / 'not-reached.json'], passed=True)
            gate.record({'label': 'workflow', 'validation_verdict': 'passed', 'evidence_dir': str(run), 'assertions': [proof]})
        gate.workflow = workflow
        with patch('builtins.print'):
            assert gate.run(['workflow']) is False
        assert gate.manifest['normal_exit'] is True
        assert gate.manifest['matrix_complete'] is True
        assert gate.manifest['runs'][-1]['validation_verdict'] == 'failed'
        assert gate.manifest['planned_target_coverage']['invalid_targets'] == ['workflow']


def test_retained_required_proof_cannot_be_dropped_or_empty():
    driver = load_driver()
    with tempfile.TemporaryDirectory(prefix='proof-shape-') as directory:
        root = Path(directory).resolve()
        good = make_required_assertion(root)
        sources = {root.name: root}
        assert driver.assertion_is_valid(good, sources)
        dropped = {**good, 'required_evidence': [*good['required_evidence'], str(root / 'missing.txt')]}
        assert not driver.assertion_is_valid(dropped, sources)
        for evidence in (root / 'empty.txt', root / 'empty-directory'):
            if evidence.suffix:
                evidence.touch()
            else:
                evidence.mkdir()
            empty = {**good, 'required_evidence': [str(evidence)], 'observed_evidence_paths': [str(evidence)]}
            assert not driver.assertion_is_valid(empty, sources)
        # Empty stderr is useful ancillary evidence alongside an actual proof file.
        mixed = {**good, 'required_evidence': [*good['required_evidence'], str(root / 'empty.txt')], 'observed_evidence_paths': [*good['observed_evidence_paths'], str(root / 'empty.txt')]}
        assert driver.assertion_is_valid(mixed, sources)


def test_retained_builtin_legacy_missing_evidence_fixture():
    module = load_driver()
    with tempfile.TemporaryDirectory(prefix='builtin-proof-') as directory:
        root = Path(directory)
        gate = object.__new__(module.BinaryGate)
        gate.evidence_root = root / 'evidence'
        gate.evidence_root.mkdir()
        gate.repo, gate.binary = root / 'repo', root / 'binary'
        gate.manifest = {'binary_sha256': 'a' * 64}
        gate.stamp, gate.pid, gate.registered_runs = 'unit', 1, {}
        recorded = []
        gate.record = recorded.append
        def producer(command, **_kwargs):
            if '--cache' not in command:
                return subprocess.CompletedProcess(command, 1, '', 'No native evidence supplied')
            cache = Path(command[command.index('--cache') + 1])
            report_root = cache / 'runs' / 'r-acceptance'
            report_root.mkdir(parents=True)
            pair = {}
            for name in ('privacyOff', 'privacyOn', 'enabled', 'disabled',
                         'securityOrdinary', 'securityTeam', 'securityEnterprise'):
                run = cache / 'runs' / ('r-' + name)
                run.mkdir()
                pair[name] = {'run': str(run), 'socket': str(run / 'tmux.sock'),
                              'binarySha256': 'a' * 64, 'captures': {}}
            report = {'evidence': str(report_root), 'pair': pair,
                      'assertions': {name: {'verdict': 'passed'} for name in (
                          'completeness', 'cleanup', 'agents', 'diff', 'security',
                          'ui', 'dynamicTools', 'suggestionReload', 'telemetry')}}
            (report_root / 'acceptance.json').write_text(json.dumps(report))
            return subprocess.CompletedProcess(command, 0, json.dumps(report), '')
        with patch.object(module.subprocess, 'run', producer):
            gate.builtin_mods()
        assert len(recorded) == 1
        assert recorded[0]['validation_verdict'] == 'failed'
        assert recorded[0]['checks']['binary'] is True
        assert recorded[0]['checks']['evidence_ownership'] is True
        assert recorded[0]['checks']['assertions'] is False
        assert recorded[0]['checks']['cache_cleanup'] is True
        archive = Path(recorded[0]['evidence_dir']) / 'acceptance-cache'
        assert (archive / 'runs/r-acceptance/acceptance.json').is_file()



def test_retained_builtin_malformed_report_records_failed_without_driver_exception():
    module = load_driver()
    variants = {
        'report-null': None,
        'report-list': [],
        'run-number': {'pair': {'privacyOff': {'run': 1}}},
        'cleanup-null': {'pair': {'privacyOff': {'cleanup': None}}},
        'terminal-null': {'pair': {'privacyOff': {'cleanup': {'terminalCapture': None}}}},
        'capture-path-number': {'pair': {'privacyOff': {'captures': {'ready': 1}}}},
        'pair-list': {'pair': []},
        'side-null': {'pair': {'privacyOff': None}},
        'side-list': {'pair': {'privacyOff': []}},
        'assertion-null': {'assertions': {'cleanup': None}},
        'captures-list': {'pair': {'privacyOff': {'captures': []}}},
        'capture-file-null': {'pair': {'privacyOff': {'cleanup': {'terminalCapture': {'files': {'pty.raw': None}}}}}},
    }
    failures = []
    for name, report in variants.items():
        with tempfile.TemporaryDirectory(prefix='builtin-malformed-' + name + '-') as directory:
            root = Path(directory)
            gate = object.__new__(module.BinaryGate)
            gate.evidence_root = root / 'evidence'
            gate.evidence_root.mkdir()
            gate.repo, gate.binary = root / 'repo', root / 'binary'
            gate.manifest = {'binary_sha256': 'a' * 64}
            gate.stamp, gate.pid, gate.registered_runs = 'unit', 1, {}
            recorded = []
            gate.record = recorded.append
            producer_original = json.dumps(report)
            def producer(command, **_kwargs):
                if '--cache' not in command:
                    return subprocess.CompletedProcess(command, 1, '', 'No native evidence supplied')
                cache = Path(command[command.index('--cache') + 1])
                report_root = cache / 'runs/r-acceptance'
                report_root.mkdir(parents=True)
                (report_root / 'acceptance.json').write_text(producer_original)
                return subprocess.CompletedProcess(command, 0, producer_original, '')
            try:
                with patch.object(module.subprocess, 'run', producer):
                    gate.builtin_mods()
                assert len(recorded) == 1 and recorded[0]['validation_verdict'] == 'failed'
                evidence = Path(recorded[0]['evidence_dir'])
                checks = json.loads((evidence / 'builtin-mods-checks.json').read_text())
                assert checks['report_error'] and checks['checks']['report'] is False, checks
                assert (evidence / 'acceptance-cache/runs/r-acceptance/acceptance.json').read_text() == producer_original
                assert (evidence / 'acceptance-remapped.json').is_file()
                assert (evidence / 'builtin-cache-archive.json').is_file()
                assert recorded[0]['assertions'][0]['validation_verdict'] == 'failed'
            except (AssertionError, AttributeError, TypeError, ValueError) as error:
                failures.append((name, type(error).__name__, str(error)))
    assert not failures, failures


def test_retained_builtin_invalid_launch_keeps_failed_originals():
    module = load_driver()
    for variant in ('missing', 'bad-json', 'directory', 'symlink'):
        with tempfile.TemporaryDirectory(prefix='builtin-launch-' + variant + '-') as directory:
            root = Path(directory)
            gate = object.__new__(module.BinaryGate)
            gate.evidence_root = root / 'evidence'
            gate.evidence_root.mkdir()
            gate.repo, gate.binary = root / 'repo', root / 'binary'
            gate.manifest = {'binary_sha256': 'a' * 64}
            gate.stamp, gate.pid, gate.registered_runs = 'unit', 1, {}
            recorded = []
            gate.record = recorded.append
            outside = root / 'outside-launch.json'
            outside.write_text('{"foreign":true}')
            originals = []
            def producer(command, **_kwargs):
                if '--cache' not in command:
                    return subprocess.CompletedProcess(command, 1, '', 'No native evidence supplied')
                cache = Path(command[command.index('--cache') + 1])
                report_root = cache / 'runs/r-acceptance'
                report_root.mkdir(parents=True)
                pair = {}
                for name in module.BUILTIN_SIDE_NAMES:
                    run = cache / 'runs' / ('r-' + name)
                    run.mkdir()
                    launch = run / 'capture-launch.json'
                    if variant == 'bad-json':
                        launch.write_text('{bad')
                    elif variant == 'directory':
                        launch.mkdir()
                    elif variant == 'symlink':
                        launch.symlink_to(outside)
                    pair[name] = {'run': str(run), 'binarySha256': 'a' * 64, 'captures': {}}
                report = {'evidence': str(report_root), 'pair': pair, 'assertions': {}}
                originals.append(json.dumps(report))
                (report_root / 'acceptance.json').write_text(originals[-1])
                return subprocess.CompletedProcess(command, 0, originals[-1], '')
            with patch.object(module.subprocess, 'run', producer):
                gate.builtin_mods()
            assert len(recorded) == 1 and recorded[0]['validation_verdict'] == 'failed', variant
            evidence = Path(recorded[0]['evidence_dir'])
            assert (evidence / 'acceptance-cache/runs/r-acceptance/acceptance.json').read_text() == originals[0]
            metadata = json.loads((evidence / 'run-metadata.json').read_text())
            assert all(metadata['builtin_capture_registry'][name].get('capture_launch_error')
                       for name in module.BUILTIN_SIDE_NAMES), variant
            assert outside.read_text() == '{"foreign":true}'
            assert recorded[0]['assertions'][0]['validation_verdict'] == 'failed'


def main():
    for name, test in sorted(globals().items()):
        if name.startswith('test_retained_') and callable(test):
            test()
            print(f'{name} passed', flush=True)
    assert_deterministic_lifecycle_protocol(load_driver())
    assert_fixture_materializes_builtin_marketplace(load_driver())
    assert_send_uses_atomic_bracketed_paste(load_driver())
    assert_terminal_request_predicate(load_driver())
    assert_terminal_git_wrapper(load_driver())
    assert_terminal_matrix_contract(load_driver())
    assert_terminal_matrix_execution(load_driver())
    assert_team_concurrency_mock(load_driver())
    assert_terminal_repository_ignores_global_signing(load_driver())
    assert_failed_discovery_panes(load_driver())
    assert_openai_stats(load_driver())
    assert_plugins_reload(load_driver())
    ast.parse(DRIVER_PATH.read_text())
    ast.parse(BASELINE_PATH.read_text())
    module = load_driver()
    baseline_module = load_baseline()
    assert_deferred_tool_discovery(module)
    assert_driver_behavior(module, baseline_module)
    print('test-release-driver.py passed')



def _code_review_scope_fixture(module):
    import copy
    args = module.code_review_prompt('a' * 40).removeprefix('/code-review ')
    diff = 'git diff ' + 'a' * 40 + '..HEAD -- src/tools/WorkflowTool/bundled/index.ts src/tools/WorkflowTool/bundled/index.test.ts'
    output = {'diffCommand': diff, 'files': [], 'summary': 'Deterministic empty-scope release fixture.'}
    schema = {'type': 'object', 'required': ['diffCommand', 'files', 'summary'],
              'properties': {'diffCommand': {'type': 'string'}, 'files': {'type': 'array', 'items': {'type': 'string'}},
                             'summary': {'type': 'string'}, 'conventions': {'type': 'string'}}}
    prompt = 'Establish the scope of a code review.\nExact bounded instructions.'
    child_prompt = prompt + ('\n\nYou MUST call the `StructuredOutput` tool exactly once to return your answer.\n'
        'The tool input must match this JSON Schema:\n```json\n' + json.dumps(schema, indent=2) + '\n```\n'
        'Do NOT put your answer in a text response. The script reads ONLY the tool call.\n'
        'If schema validation fails, read the error and call the tool again with corrected input.')
    def entry(kind, stamp, content, **extra):
        return {'type': kind, 'sessionId': 'session-one', 'timestamp': '2026-10-07T20:41:01.' + stamp + 'Z',
                'uuid': kind + '-' + stamp, 'isSidechain': False,
                'message': {'role': kind, 'content': content}, **extra}
    report = {'level': 'high', 'target': args.removeprefix('high '),
              'summary': 'No changes found to review.', 'findings': [],
              'stats': {'finders': 0, 'candidates': 0, 'verified': 0}}
    notification = ('<task-notification>\n<task-id>task-one</task-id>\n'
        '<tool-use-id>launch-one</tool-use-id>\n<status>completed</status>\n'
        '<result>' + json.dumps(report) + '</result>\n'
        '<usage><total_tokens>2</total_tokens><tool_uses>1</tool_uses>'
        '<duration_ms>236</duration_ms></usage>\n</task-notification>')
    parents = [{'session_id': 'session-one', 'entries': [
        entry('assistant', '230', [{'type': 'tool_use', 'id': 'launch-one', 'name': 'WorkflowTool',
            'input': {'action': 'run', 'selector': 'code-review', 'runArgs': args}}]),
        entry('user', '259', [{'type': 'tool_result', 'tool_use_id': 'launch-one',
            'content': 'Workflow launched in background. Task ID: task-one\nRun ID: wf_one\n'}],
            parentUuid='assistant-230', sourceToolAssistantUUID='assistant-230'),
        entry('user', '513', notification, origin={'kind': 'task-notification'}),
    ]}]
    artifact = {'taskId': 'task-one', 'workflowRunId': 'wf_one', 'workflowName': 'code-review',
        'status': 'completed', 'scriptPath': 'bundled:code-review', 'runArgs': args,
        'startedAt': 1791405661256, 'updatedAt': 1791405661492, 'tokenCount': 2, 'toolUseCount': 1,
        'results': [{'phaseId': 'Scope', 'agentId': 'scope', 'index': 0, 'status': 'completed',
                     'prompt': prompt, 'output': json.dumps(output)}],
        'resumeCacheEntries': [{'phase': 'Scope', 'label': 'scope', 'index': 0,
                              'result': output, 'completedAt': 1791405661484}]}
    children = [{'session_id': 'session-one', 'agent_id': 'agent-one',
        'meta': {'agentType': 'general-purpose', 'description': 'code-review: scope',
                 'toolUseId': 'launch-one', 'permissionMode': 'plan', 'spawnDepth': 1, 'model': 'test-model'},
        'entries': [entry('user', '435', child_prompt, agentId='agent-one', isSidechain=True),
            entry('assistant', '463', [{'type': 'tool_use', 'id': 'scope-output', 'name': 'StructuredOutput', 'input': output}], agentId='agent-one', parentUuid='user-435', isSidechain=True),
            entry('user', '464', [{'type': 'tool_result', 'tool_use_id': 'scope-output', 'content': 'Structured output provided successfully'}], agentId='agent-one', parentUuid='assistant-463', sourceToolAssistantUUID='assistant-463', isSidechain=True)]}]
    params = {'selectedAgentType': 'general-purpose', 'permissionMode': 'plan', 'toolUseId': 'launch-one', 'spawnDepth': 1, 'isAsync': True, 'model': 'test-model'}
    log = ('2026-10-07T20:41:01.415Z [DEBUG] workflow_worker_start task=task-one run=wf_one phase=Scope logical=scope agent=scope attempt=0 worker=0\n'
        '2026-10-07T20:41:01.436Z [DEBUG] AgentTool launch params ' + json.dumps(params) + '\n'
        '2026-10-07T20:41:01.439Z [DEBUG] [runAgent] agentId=agent-one, agentType=general-purpose, model=test-model, tools=StructuredOutput\n'
        '2026-10-07T20:41:01.483Z [DEBUG] workflow_worker_terminal task=task-one run=wf_one phase=Scope logical=scope agent=scope attempt=0 worker=0 status=completed\n')
    wire_input = [
        {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'deferred tool names'}]},
        {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'bounded context'}, {'type': 'input_text', 'text': child_prompt}]},
    ]
    wire = [{'sequence': index + 3, 'method': 'POST', 'path': '/v1/responses',
        'authorization': {'present': True, 'matches_dummy': True},
        'headers': {'session-id': 'session-one', 'x-claude-code-session-id': 'session-one', 'thread-id': 'agent-one'},
        'response_kind': kind,
        'body': {'input': copy.deepcopy(wire_input), 'tools': [{'type': 'function', 'name': 'StructuredOutput', 'parameters': schema, 'strict': False}]}}
        for index, kind in enumerate(('code-review-scope-output', 'code-review-scope-completed'))]
    wire[1]['body']['input'].extend([
        {'type': 'function_call', 'name': 'StructuredOutput', 'id': 'scope-output', 'call_id': 'scope-output', 'arguments': json.dumps(output)},
        {'type': 'function_call_output', 'call_id': 'scope-output', 'output': 'Structured output provided successfully'},
    ])
    parent_input = [
        {'type': 'function_call', 'name': 'WorkflowTool', 'id': 'launch-one',
         'call_id': 'launch-one', 'arguments': json.dumps({'action': 'run', 'selector': 'code-review', 'runArgs': args})},
        {'type': 'function_call_output', 'call_id': 'launch-one',
         'output': parents[0]['entries'][1]['message']['content'][0]['content']},
    ]
    for sequence, kind, items in ((1, 'code-review-launch', []),
                                  (2, 'code-review-parent-completed', parent_input),
                                  (5, 'code-review-notification-completed', [*parent_input,
                                      {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': notification}]}])):
        wire.append({'sequence': sequence, 'method': 'POST', 'path': '/v1/responses',
            'authorization': {'present': True, 'matches_dummy': True},
            'headers': {'session-id': 'session-one', 'x-claude-code-session-id': 'session-one', 'thread-id': 'session-one'},
            'response_kind': kind, 'body': {'input': copy.deepcopy(items)}})
    inputs = {'run_args': args, 'task_id': 'task-one', 'run_id': 'wf_one', 'artifact': artifact,
              'parents': parents, 'children': children, 'log': log, 'wire': wire}
    return inputs


def test_retained_code_review_scope_uses_same_run_native_identity():
    import copy
    module = load_driver()
    inputs = _code_review_scope_fixture(module)
    log = inputs['log']
    child_prompt = inputs['children'][0]['entries'][0]['message']['content']
    gate = object.__new__(module.BinaryGate)
    assert gate.agent_ids(log) == []
    proof = module.code_review_scope_identity(**inputs)
    assert proof['complete'] and proof['agent_ids'] == ['agent-one'], proof
    mutations = [
        lambda x: x['wire'][1]['headers'].update({'session-id': 'foreign-session'}),
        lambda x: x['wire'][1]['headers'].update({'thread-id': 'foreign-agent'}),
        lambda x: x['wire'][1]['authorization'].update(matches_dummy=False),
        lambda x: x['wire'][1]['body']['input'][1]['content'][1].update(text='foreign prompt'),
        lambda x: x['wire'][1]['body']['tools'][0].update(parameters={}),
        lambda x: x['wire'][1]['body']['input'][2].update(arguments='{"files":[]}'),
        lambda x: x['wire'][1]['body']['input'][3].update(call_id='foreign-output'),
        lambda x: x['wire'][1]['body']['input'][3].update(output='Structured output failed'),
        lambda x: x['wire'].append(copy.deepcopy(x['wire'][1])),
        lambda x: x.update(task_id='foreign-task'),
        lambda x: x.update(run_id='wf_foreign'),
        lambda x: x['parents'][0].update(session_id='foreign-session'),
        lambda x: x['parents'][0]['entries'][1]['message']['content'][0].update(is_error=True),
        lambda x: x['children'][0].update(session_id='foreign-session'),
        lambda x: x['children'][0]['meta'].update(toolUseId='foreign-launch'),
        lambda x: x['children'][0]['meta'].update(description='unrelated worker'),
        lambda x: x['children'][0]['entries'][0]['message'].update(content=child_prompt + 'unrequested instructions'),
        lambda x: x['children'][0]['entries'][1].update(agentId='foreign-agent'),
        lambda x: x['children'][0]['entries'][2]['message']['content'][0].update(is_error=True),
        lambda x: x['children'][0]['entries'].pop(),
        lambda x: x['children'][0]['entries'][1].update(timestamp='2026-10-07T20:41:02.463Z'),
        lambda x: x['artifact']['resumeCacheEntries'][0].update(result={'files': []}),
        lambda x: x['artifact']['results'][0].update(status='failed'),
        lambda x: x['artifact']['results'].append(copy.deepcopy(x['artifact']['results'][0])),
        lambda x: x['children'].append(copy.deepcopy(x['children'][0])),
        lambda x: x.update(log=log.replace('attempt=0', 'attempt=1')),
        lambda x: x.update(log=log.replace('status=completed', 'status=failed')),
        lambda x: x.update(log=log.replace('agentId=agent-one', 'agentId=unrelated-agent')),
        lambda x: x['parents'][0]['entries'].append(copy.deepcopy(x['parents'][0]['entries'][2])),
    ]
    for index, mutate in enumerate(mutations):
        changed = copy.deepcopy(inputs)
        mutate(changed)
        rejected = module.code_review_scope_identity(**changed)
        assert not rejected['complete'], (index, rejected)
    foreign_foreground = {**inputs, 'log': log + '[AgentLifecycle] foreground_registered agent_id=foreign-agent task_id=foreign-task\n'}
    assert module.code_review_scope_identity(**foreign_foreground)['agent_ids'] == ['agent-one']


def _materialize_code_review_scope(module, inputs, root):
    run, runtime = root / 'code-review-case', root / 'workflow-runs'
    run.mkdir()
    (runtime / 'wf_one').mkdir(parents=True)
    artifact = json.dumps(inputs['artifact']).encode()
    (runtime / 'wf_one/session.json').write_bytes(artifact)
    (runtime / 'task-one.json').write_bytes(artifact)
    (run / 'run-metadata.json').write_text(json.dumps({'driver_run': 'unit-1', 'source_run': run.name, 'label': 'code-review', 'binary_sha256': 'a' * 64, 'target': 'owned-session:0.0', 'evidence_dir': str(run.resolve())}))
    (run / 'pane-target.txt').write_text('owned-session:0.0\n')
    prompt = '/code-review ' + inputs['run_args']
    (run / 'input-code-review.txt').write_bytes(b'\x1b[200~' + prompt.encode() + b'\x1b[201~')
    (run / 'debug.log').write_text(inputs['log'])
    (run / 'mock-openai-requests.json').write_text(json.dumps(inputs['wire']))
    project = run / 'config/projects/owned-project'
    child_dir = project / 'session-one/subagents'
    child_dir.mkdir(parents=True)
    (project / 'session-one.jsonl').write_text(''.join(json.dumps(entry) + '\n' for entry in inputs['parents'][0]['entries']))
    meta = child_dir / 'agent-agent-one.meta.json'
    meta.write_text(json.dumps(inputs['children'][0]['meta']))
    transcript = child_dir / 'agent-agent-one.jsonl'
    transcript.write_text(''.join(json.dumps(entry) + '\n' for entry in inputs['children'][0]['entries']))
    gate = object.__new__(module.BinaryGate)
    gate.stamp, gate.pid, gate.manifest = 'unit', 1, {'binary_sha256': 'a' * 64}
    gate.workflow_runs, gate.workflow_task_ids, gate.workflow_run_ids = runtime, {'task-one'}, {'wf_one'}
    gate.registered_runs = {str(run.resolve()): (run / 'run-metadata.json').read_text()}
    server = module.MockOpenAIServer(run, 'code-review')
    server.requests = json.loads(json.dumps(inputs['wire']))
    server.stop()
    gate.code_review_mock_servers = {run.name: server}
    return gate, run, runtime, prompt, meta, transcript


def test_retained_code_review_scope_evidence_is_owned_and_registered():
    module = load_driver()
    inputs = _code_review_scope_fixture(module)
    with tempfile.TemporaryDirectory(prefix='owned-workflow-proof-') as directory:
        gate, run, runtime, prompt, meta, transcript = _materialize_code_review_scope(module, inputs, Path(directory))
        proof = gate.code_review_scope_identity_proof(run, 'task-one', 'wf_one', prompt)
        assert proof['complete'] and proof['agent_ids'] == ['agent-one'], proof
        assert all(module.is_relative_to(path.resolve(), run.resolve()) for path in proof['evidence_paths'])
        assert proof['evidence_sha256'] == {
            str(path.resolve()): module.hashlib.sha256(path.read_bytes()).hexdigest()
            for path in proof['evidence_paths']}
        assertion = gate.required_assertion(run, 'code-review-native-scope-identity', 'Scope', 'strict native identity',
            proof['evidence_paths'], passed=proof['complete'], evidence_sha256=proof['evidence_sha256'])
        assert module.assertion_is_valid(assertion, {run.name: run.resolve()})
    for scenario in ('foreign-binary', 'foreign-pane', 'foreign-input', 'unregistered', 'different-mirror', 'symlink-meta', 'malformed-child', 'missing-child',
                     'changed-metadata', 'whole-old-wire-replay', 'different-live-parent-receipt', 'unregistered-live-server',
                     'provider-stop-incomplete', 'provider-handler-active'):
        with tempfile.TemporaryDirectory(prefix='invalid-workflow-proof-') as directory:
            gate, run, runtime, prompt, meta, transcript = _materialize_code_review_scope(module, inputs, Path(directory))
            if scenario == 'foreign-binary':
                data = json.loads((run / 'run-metadata.json').read_text()); data['binary_sha256'] = 'b' * 64
                (run / 'run-metadata.json').write_text(json.dumps(data))
            elif scenario == 'foreign-pane':
                (run / 'pane-target.txt').write_text('foreign-session:0.0\n')
            elif scenario == 'foreign-input':
                (run / 'input-code-review.txt').write_bytes(b'\x1b[200~unrequested input\x1b[201~')
            elif scenario == 'unregistered':
                gate.workflow_run_ids.clear()
            elif scenario == 'different-mirror':
                (runtime / 'task-one.json').write_text('{}')
            elif scenario == 'symlink-meta':
                outside = Path(directory) / 'foreign-meta.json'; outside.write_bytes(meta.read_bytes())
                meta.unlink(); meta.symlink_to(outside)
            elif scenario == 'malformed-child':
                transcript.write_text('{not-json}\n')
            elif scenario == 'missing-child':
                transcript.unlink()
            elif scenario == 'changed-metadata':
                data = json.loads((run / 'run-metadata.json').read_text()); data['config'] = 'foreign-config'
                (run / 'run-metadata.json').write_text(json.dumps(data))
            elif scenario == 'whole-old-wire-replay':
                for request in gate.code_review_mock_servers[run.name].requests:
                    request['headers']['session-id'] = request['headers']['x-claude-code-session-id'] = 'current-live-session'
            elif scenario == 'different-live-parent-receipt':
                request = next(x for x in gate.code_review_mock_servers[run.name].requests if x['response_kind'] == 'code-review-parent-completed')
                request['body']['input'][1]['output'] = 'Workflow launched in background. Task ID: new-live-task\nRun ID: wf_new\n'
                (run / 'mock-openai-requests.json').write_text(json.dumps(gate.code_review_mock_servers[run.name].snapshot()))
            elif scenario == 'unregistered-live-server':
                gate.code_review_mock_servers.clear()
            elif scenario == 'provider-stop-incomplete':
                gate.code_review_mock_servers[run.name].stop_result['stopped'] = False
            elif scenario == 'provider-handler-active':
                gate.code_review_mock_servers[run.name].stop_result['active_handlers'] = ['owned-handler']
            proof = gate.code_review_scope_identity_proof(run, 'task-one', 'wf_one', prompt)
            assert proof['complete'] is False and proof['agent_ids'] == [], (scenario, proof)
            assert (run / 'workflow-agent-identity-proof.json').is_file()


def test_retained_code_review_scope_rejects_missing_uuid_and_forged_notification():
    import copy
    module = load_driver()
    inputs = _code_review_scope_fixture(module)
    def missing_chain(value):
        for entry in value['children'][0]['entries']:
            entry.pop('uuid', None); entry.pop('parentUuid', None)
    def note(value, change):
        entry = value['parents'][0]['entries'][2]
        entry['message']['content'] = change(entry['message']['content'])
        request = next(x for x in value['wire'] if x['response_kind'] == 'code-review-notification-completed')
        request['body']['input'][-1]['content'][0]['text'] = entry['message']['content']
    mutations = [
        ('missing child UUID chain', missing_chain),
        ('missing parent UUID', lambda x: x['parents'][0]['entries'][1].pop('uuid')),
        ('child is not sidechain', lambda x: x['children'][0]['entries'][1].update(isSidechain=False)),
        ('foreign source assistant UUID', lambda x: x['children'][0]['entries'][2].update(sourceToolAssistantUUID='foreign-assistant')),
        ('duplicate core tag', lambda x: note(x, lambda s: s.replace('<status>completed</status>', '<status>failed</status><status>completed</status>'))),
        ('correct task hidden in result', lambda x: note(x, lambda s: s.replace('<task-id>task-one</task-id>', '<task-id>foreign-task</task-id>').replace('<result>', '<result><task-id>task-one</task-id>'))),
        ('unclosed notification', lambda x: note(x, lambda s: s.removesuffix('</task-notification>'))),
        ('wrong final result', lambda x: note(x, lambda s: s.replace('No changes found to review.', 'Different run final output'))),
        ('wrong usage', lambda x: note(x, lambda s: s.replace('<total_tokens>2</total_tokens>', '<total_tokens>200</total_tokens>'))),
        ('missing usage', lambda x: note(x, lambda s: s.replace('<usage><total_tokens>2</total_tokens><tool_uses>1</tool_uses><duration_ms>236</duration_ms></usage>', ''))),
        ('live parent receipt belongs to another task', lambda x: next(q for q in x['wire'] if q['response_kind'] == 'code-review-parent-completed')['body']['input'][1].update(output='Workflow launched in background. Task ID: foreign-task\nRun ID: wf_other\n')),
    ]
    accepted = []
    for name, mutate in mutations:
        value = copy.deepcopy(inputs); mutate(value)
        proof = module.code_review_scope_identity(**value)
        if proof['complete']:
            accepted.append(name)
    assert not accepted, accepted


def test_retained_code_review_scope_snapshot_hashes_survive_source_append():
    import hashlib
    module = load_driver()
    inputs = _code_review_scope_fixture(module)
    with tempfile.TemporaryDirectory(prefix='workflow-immutable-proof-') as directory:
        gate, run, runtime, prompt, meta, transcript = _materialize_code_review_scope(module, inputs, Path(directory))
        proof = gate.code_review_scope_identity_proof(run, 'task-one', 'wf_one', prompt)
        assert proof['complete'], proof
        with (run / 'debug.log').open('a') as stream:
            stream.write('Final native process cleanup\n')
        parent = run / 'config/projects/owned-project/session-one.jsonl'
        with parent.open('a') as stream:
            stream.write(json.dumps({'type': 'system', 'subtype': 'turn_duration'}) + '\n')
        mismatched = [path for path, digest in proof['source_hashes'].items()
                      if hashlib.sha256(Path(path).read_bytes()).hexdigest() != digest]
        assert not mismatched, mismatched
        assert all(module.is_relative_to(Path(path).resolve(), (run / 'workflow-identity-inputs').resolve())
                   for path in proof['source_hashes'])


def test_retained_code_review_scope_wire_survives_provider_shutdown():
    module = load_driver()
    inputs = _code_review_scope_fixture(module)
    with tempfile.TemporaryDirectory(prefix='workflow-closed-wire-') as directory:
        gate, run, runtime, prompt, meta, transcript = _materialize_code_review_scope(module, inputs, Path(directory))
        gate.mock_servers = {}
        assertion = gate.workflow_mock_wire(run, 'code-review')
        assert assertion['validation_verdict'] == 'passed', json.loads((run / 'workflow-mock-wire.json').read_text())
        gate.code_review_mock_servers.clear()
        assert gate.workflow_mock_wire(run, 'code-review')['validation_verdict'] == 'failed'


def test_retained_code_review_scope_accepts_fast_child_before_parent_receipt():
    module = load_driver()
    inputs = _code_review_scope_fixture(module)
    inputs['parents'][0]['entries'][1]['timestamp'] = '2026-10-07T20:41:01.495Z'
    for request in inputs['wire']:
        request['sequence'] = {'code-review-launch': 1, 'code-review-scope-output': 2,
            'code-review-scope-completed': 3, 'code-review-parent-completed': 4,
            'code-review-notification-completed': 5}[request['response_kind']]
    proof = module.code_review_scope_identity(**inputs)
    assert proof['complete'], proof


def test_retained_mock_provider_stop_waits_for_owned_request_handler():
    module = load_driver()
    with tempfile.TemporaryDirectory(prefix='provider-handler-stop-') as directory:
        server = module.MockOpenAIServer(Path(directory), 'code-review')
        entered, release, listener_closed, stopped = (threading.Event() for _ in range(4))
        observed = {}
        def response(_body):
            entered.set()
            if not release.wait(5):
                raise RuntimeError('owned handler release deadline')
            return 'completed', module.sse_completed('OWNED_REQUEST_COMPLETE')
        server.response_for = response
        base = server.start()
        original_close = server.server.server_close
        def close_listener():
            original_close()
            listener_closed.set()
        server.server.server_close = close_listener
        def request():
            try:
                with urlopen(Request(base + '/v1/responses', data=b'{}',
                        headers={'Authorization': 'Bearer ' + module.DUMMY_OPENAI_API_KEY,
                                 'Content-Type': 'application/json'}), timeout=10) as reply:
                    observed['body'] = reply.read().decode()
            except Exception as error:
                observed['request_error'] = repr(error)
        def stop():
            try:
                observed['cleanup'] = server.stop()
            finally:
                stopped.set()
        caller, stopper = threading.Thread(target=request), threading.Thread(target=stop)
        caller.start()
        try:
            assert entered.wait(2), observed
            stopper.start()
            assert listener_closed.wait(2), observed
            # A negative deadline detects premature success while this handler is
            # demonstrably held; it is never a success synchronization barrier.
            assert not stopped.wait(0.1), observed
        finally:
            release.set()
            if stopper.ident is None:
                server.stop()
            else:
                stopper.join(6)
            caller.join(6)
        assert not caller.is_alive() and not stopper.is_alive(), observed
        assert 'request_error' not in observed and 'OWNED_REQUEST_COMPLETE' in observed['body'], observed
        assert observed['cleanup']['stopped'] is True and observed['cleanup']['active_handlers'] == [], observed

def test_retained_scope_snapshot_hashes_rechecked_at_final_coverage():
    module = load_driver()
    failures = []
    for scenario in ('valid', 'snapshot-append', 'snapshot-replace', 'proof-change',
                     'missing-hashes', 'incomplete-hashes', 'wrong-hash', 'snapshot-symlink',
                     'coupled-snapshot-omission', 'missing-proof', 'foreign-path-read',
                     'missing-scope-assertion', 'renamed-scope-assertion', 'duplicate-scope-assertion',
                     'missing-wire-assertion', 'missing-lifecycle-assertion'):
        with tempfile.TemporaryDirectory(prefix='scope-final-seal-') as directory:
            gate, run, _, prompt, _, _ = _materialize_code_review_scope(
                module, _code_review_scope_fixture(module), Path(directory))
            proof = gate.code_review_scope_identity_proof(run, 'task-one', 'wf_one', prompt)
            assert proof['complete'], proof
            paths = proof['evidence_paths']
            assertion = gate.required_assertion(run, 'code-review-native-scope-identity',
                'Scope', 'native identity remains sealed at final coverage', paths, passed=True)
            # Declare original bytes explicitly so the RED exercises final aggregation,
            # rather than merely failing because an old helper lacks a new field.
            assertion['evidence_sha256'] = {
                str(path.resolve()): module.hashlib.sha256(path.read_bytes()).hexdigest()
                for path in paths}
            gate.mock_servers = {}
            wire_assertion = gate.workflow_mock_wire(run, 'code-review')
            assert wire_assertion['validation_verdict'] == 'passed'
            lifecycle_assertion = gate.required_assertion(run, 'code-review-workflow-lifecycle',
                'Scope fixture lifecycle', 'unit fixture retains the independent lifecycle assertion',
                [run / 'debug.log'], passed=True)
            row = {'label': 'code-review', 'evidence_dir': str(run),
                   'driver_run': f'{gate.stamp}-{gate.pid}', 'validation_verdict': 'passed',
                   'assertions': [assertion, wire_assertion, lifecycle_assertion]}
            snapshot = next(Path(path) for path in proof['source_hashes'])
            if scenario == 'snapshot-append':
                with snapshot.open('ab') as stream:
                    stream.write(b'\nchanged after proof\n')
            elif scenario == 'snapshot-replace':
                snapshot.write_bytes(b'nonempty replacement')
            elif scenario == 'proof-change':
                paths[0].write_text('{"complete":true,"foreign":true}\n')
            elif scenario == 'missing-hashes':
                assertion.pop('evidence_sha256')
            elif scenario == 'incomplete-hashes':
                assertion['evidence_sha256'].pop(str(snapshot.resolve()))
            elif scenario == 'wrong-hash':
                assertion['evidence_sha256'][str(snapshot.resolve())] = '0' * 64
            elif scenario == 'snapshot-symlink':
                replacement = run / 'replacement.json'
                replacement.write_bytes(snapshot.read_bytes())
                snapshot.unlink(); snapshot.symlink_to(replacement)
            elif scenario in ('coupled-snapshot-omission', 'missing-proof'):
                omitted = snapshot if scenario == 'coupled-snapshot-omission' else paths[0]
                assertion['required_evidence'].remove(str(omitted))
                assertion['observed_evidence_paths'].remove(str(omitted.resolve()))
                assertion['evidence_sha256'].pop(str(omitted.resolve()))
                if scenario == 'coupled-snapshot-omission':
                    snapshot.write_bytes(b'changed and omitted from the caller assertion')
            elif scenario == 'foreign-path-read':
                outside = Path(directory) / 'sibling.json'
                outside.write_bytes(b'owned test sibling outside this registered case')
                assertion['required_evidence'].append(str(outside))
                assertion['observed_evidence_paths'].append(str(outside.resolve()))
                assertion['evidence_sha256'][str(outside.resolve())] = module.hashlib.sha256(outside.read_bytes()).hexdigest()
            elif scenario == 'missing-scope-assertion':
                row['assertions'].remove(assertion)
            elif scenario == 'renamed-scope-assertion':
                assertion['assertion_id'] = 'unrequested-proof'
            elif scenario == 'duplicate-scope-assertion':
                row['assertions'].append(dict(assertion))
            elif scenario == 'missing-wire-assertion':
                row['assertions'].remove(wire_assertion)
            elif scenario == 'missing-lifecycle-assertion':
                row['assertions'].remove(lifecycle_assertion)
            reads = []
            original_read = module.Path.read_bytes
            def checked_read(path):
                if scenario == 'foreign-path-read' and path.resolve() == outside.resolve():
                    reads.append(str(path))
                return original_read(path)
            with patch.object(module.Path, 'read_bytes', checked_read):
                coverage = module.validate_required_target_results(
                    {'code-review'}, [row], gate.registered_runs)
            if coverage['passed'] != (scenario == 'valid'):
                failures.append({'scenario': scenario, 'coverage': coverage})
            if reads:
                failures.append({'scenario': scenario, 'read_before_ownership_check': reads})
    assert not failures, failures

def test_retained_terminal_cleanup_requires_owned_socket_release():
    module = load_driver()
    gate = object.__new__(module.BinaryGate)
    cleanup = {'session_exists_after': False, 'process_remaining': False,
               'forced_termination': [],
               'mock_server': {'stopped': True, 'thread_alive': False},
               'terminal_capture': {'socket_released': False}}
    assert gate.cleanup_passed(cleanup) is False, cleanup
    complete = {'socket_released': True, 'server_exited': True,
                'socket_root_released': True, 'seal_exit': 0}
    assert gate.cleanup_passed({**cleanup, 'terminal_capture': complete}) is True
    # Resource closure and bounded evidence availability are separate checks.
    assert gate.cleanup_passed({**cleanup, 'terminal_capture': {**complete, 'seal_exit': 1}}) is True
    for key in ('socket_released', 'server_exited', 'socket_root_released'):
        invalid = {**complete, key: False}
        assert gate.cleanup_passed({**cleanup, 'terminal_capture': invalid}) is False, key


def test_retained_terminal_socket_cleanup_preserves_live_and_replaced_endpoints():
    module = load_driver()
    with tempfile.TemporaryDirectory(prefix='cc-socket-unit-', dir='/private/tmp') as tmp:
        root = Path(tmp)
        path = root / 's'
        child = subprocess.run([sys.executable, '-c',
            'import os,socket,sys; s=socket.socket(socket.AF_UNIX); '
            's.bind(sys.argv[1]); print(os.getpid(),flush=True); s.close()', str(path)],
            check=True, capture_output=True, text=True, timeout=5)
        capture = {'socketRoot': str(root), 'socket': str(path),
                   'serverPid': int(child.stdout.strip())}
        capture['socketIdentity'] = module.terminal_socket_identity(capture)
        live = module.release_owned_terminal_socket({**capture, 'serverPid': os.getpid()})
        assert live['socket_released'] is False and path.exists(), live
        replaced = module.release_owned_terminal_socket({**capture,
            'socketIdentity': {**capture['socketIdentity'], 'inode': -1}})
        assert replaced['socket_released'] is False and path.exists(), replaced
        released = module.release_owned_terminal_socket(capture)
        assert released == {'socket_released': True, 'server_exited': True,
                            'stale_socket_removed': True}, released
        assert not path.exists()
        foreign = root / 'foreign'
        foreign.write_text('preserve replaced file')
        path.symlink_to(foreign)
        symlink = module.release_owned_terminal_socket(capture)
        assert symlink['socket_released'] is False and path.is_symlink()
        assert foreign.read_text() == 'preserve replaced file'


def test_retained_terminal_requires_native_and_canonical_diff_lanes():
    module = load_driver()
    required = module.required_targets_for_paths(['src/ink/ink.tsx'])
    assert {'terminal-interaction', 'terminal-canonical-diff'} <= required, required
    for path in ('scripts/terminal-capture-driver.mjs', 'scripts/terminal-capture-launch-check.py',
                 'scripts/terminal-input-evidence.mjs', 'scripts/terminal-frame-semantics.mjs'):
        required = module.required_targets_for_paths([path])
        assert {'terminal-interaction', 'terminal-canonical-diff', 'builtin-mods'} <= required, (path, required)



def _canonical_wire_fixture(module, root):
    session = '12345678-1234-4234-8234-123456789012'
    nonce = hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:24]
    headers = {'session-id': session, 'thread-id': session,
               'x-claude-code-session-id': session, 'x-app': 'cli',
               'user-agent': 'claude-cli/unit (external, cli)', 'content-type': 'application/json',
               'host': '127.0.0.1:1'}
    rows = [{'sequence': 1, 'method': 'GET', 'path': '/v1/models',
             'response_kind': 'models', 'headers': {},
             'authorization': {'present': True, 'matches_dummy': True}, 'body': None}]
    def append(kind, items, instructions='owned canonical unit prompt'):
        sequence = len(rows) + 1
        rows.append({'sequence': sequence, 'method': 'POST', 'path': '/v1/responses',
            'response_kind': kind, 'headers': {**headers, 'x-client-request-id':
                f'12345678-1234-4234-8234-{sequence:012d}'},
            'authorization': {'present': True, 'matches_dummy': True},
            'body': {'model': 'fixture-model', 'instructions': instructions,
                     'prompt_cache_key': session, 'stream': True, 'store': False,
                     'input': json.loads(json.dumps(items))}})
    append('title', [{'role': 'user', 'content': f'RELEASE_CANONICAL_DIFF:{nonce}:alpha'}],
           module.TITLE_GENERATION_INSTRUCTION)
    history = []
    for file in ('alpha', 'omega'):
        history.append({'role': 'user', 'content': f'RELEASE_CANONICAL_DIFF:{nonce}:{file}'})
        append(f'canonical-{file}-read', history)
        read_id = f'fc_canonical_{file}_read_{nonce}'
        write_id = f'fc_canonical_{file}_write_{nonce}'
        history.extend([{'type': 'function_call', 'name': 'Read', 'call_id': read_id,
                         'arguments': json.dumps({'file_path': str(root / f'project/{file}.txt')})},
                        {'type': 'function_call_output', 'call_id': read_id, 'output': f'{file} before'}])
        append(f'canonical-{file}-write', history)
        history.extend([{'type': 'function_call', 'name': 'Write', 'call_id': write_id,
                         'arguments': json.dumps({'file_path': str(root / f'project/{file}.txt'),
                                                 'content': module.canonical_diff_content(file)})},
                        {'type': 'function_call_output', 'call_id': write_id,
                         'output': f'The file {file}.txt has been updated successfully.'}])
        append(f'canonical-{file}-completed', history)
        history.append({'role': 'assistant', 'content': f'RELEASE_CANONICAL_{file.upper()}_DONE:{nonce}'})
    return rows, f'[ForkMode] enabled source=default sessionId={session}\n'



def _canonical_git_fixture(root):
    project = root / 'project'
    argv = ['-c', 'core.hooksPath=/dev/null',
        '--git-dir=' + str(project / '.git'), '--work-tree=' + str(project),
        '--literal-pathspecs', '--no-optional-locks',
        '-c', 'diff.relative=false', '-c', 'core.quotePath=false',
        'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty',
        '--submodule=short', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/',
        '--raw', '-z', '-p', 'HEAD', '--', 'alpha.txt', 'omega.txt']
    events = [{'phase': phase, 'pid': 9001, 'argv': argv, 'cwd': str(project),
               'lane': 'canonical-292', 'matched': True, 'monotonic': value}
              for phase, value in [('start', 11), ('blocked', 12), ('released', 12.02)]]
    watcher = {'source': 'owned-blocked-marker-watcher', 'livePidObserved': True,
               'signalStartedAt': 12.01, 'signalCompletedAt': 12.03,
               'blockedMarker': {'pid': 9001, 'argv': argv, 'lane': 'canonical-292'}}
    args_hash = hashlib.sha256(json.dumps(argv, separators=(',', ':')).encode()).hexdigest()
    output = _canonical_git_output_fixture(root, argv)
    host = [{'phase': 'start', 'pid': 9001, 'owner': 'cc-plugin-diff@builtin', 'argsSHA256': args_hash,
             'timeoutMs': 5000, 'elapsedMs': 0.01},
            {'phase': 'close', 'pid': 9001, 'owner': 'cc-plugin-diff@builtin', 'argsSHA256': args_hash,
             'timeoutMs': 5000, 'elapsedMs': 1050, 'exitCode': 0, 'stdoutBytes': output['stdoutBytes'],
             'stderrBytes': output['stderrBytes'], 'isStdoutTruncated': False, 'isStderrTruncated': False,
             'stdoutSHA256': output['stdoutSHA256']}]
    return events, watcher, host


def _canonical_git_output_fixture(root, argv):
    git = Path(shutil.which('git')).resolve()
    project = root / 'project'
    project.mkdir(exist_ok=True)
    env = {'PATH': '/opt/homebrew/bin:/usr/bin:/bin', 'HOME': str(root),
           'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}
    def run(*args):
        return subprocess.run([str(git), *args], cwd=project, env=env,
                              capture_output=True, check=True, timeout=5)
    if not (project / '.git').exists():
        run('init', '-q')
        for file in ('alpha', 'omega'):
            (project / (file + '.txt')).write_text(file + ' before\n')
        run('add', 'alpha.txt', 'omega.txt')
        run('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
            '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture')
        for file in ('alpha', 'omega'):
            (project / (file + '.txt')).write_text(load_driver().canonical_diff_content(file))
    completed = run(*argv)
    manifest = {'method': 'owned-independent-git-read-v1',
        'git': {'path': str(git), 'sha256': hashlib.sha256(git.read_bytes()).hexdigest()},
        'project': str(project), 'head': run('rev-parse', '--verify', 'HEAD').stdout.decode().strip(),
        'files': {name + '.txt': hashlib.sha256((project / (name + '.txt')).read_bytes()).hexdigest()
                  for name in ('alpha', 'omega')},
        'argv': argv, 'exitCode': 0, 'stdoutBytes': len(completed.stdout),
        'stdoutSHA256': hashlib.sha256(completed.stdout).hexdigest(),
        'stderrBytes': len(completed.stderr), 'stderrSHA256': hashlib.sha256(completed.stderr).hexdigest()}
    (root / 'canonical-git-output.raw').write_bytes(completed.stdout)
    (root / 'canonical-git-output.json').write_text(json.dumps(manifest))
    return manifest


def test_retained_canonical_git_requires_owned_real_output_and_time_containment():
    import copy
    module = load_driver()
    with tempfile.TemporaryDirectory(prefix='canonical-git-output-') as tmp:
        root = Path(tmp).resolve()
        events, watcher, host = _canonical_git_fixture(root)
        output = _canonical_git_output_fixture(root, events[0]['argv'])
        host[0]['owner'] = host[1]['owner'] = 'cc-plugin-diff@builtin'
        host[1].update(elapsedMs=1050, stdoutBytes=output['stdoutBytes'],
                       stdoutSHA256=output['stdoutSHA256'])
        def check(rows):
            debug = ''.join('[ModsProcess] ' + json.dumps(row) + '\n' for row in rows)
            return module.canonical_git_checks(root, events, watcher, debug)
        if hasattr(module, 'canonical_git_output'):
            expected, raw = module.canonical_git_output(root, events[0]['argv'])
            assert output == expected, (output, expected)
            assert (root / 'canonical-git-output.raw').read_bytes() == raw
        assert all(check(host).values()), (check(host), host, output)
        failures = []
        for scenario in ('wrong-owner', 'wrong-output', 'wrong-byte-count',
                         'short-host-time', 'changed-start-budget'):
            changed = copy.deepcopy(host)
            if scenario == 'wrong-owner': changed[0]['owner'] = changed[1]['owner'] = 'foreign-plugin'
            elif scenario == 'wrong-output': changed[1]['stdoutSHA256'] = 'a' * 64
            elif scenario == 'wrong-byte-count': changed[1]['stdoutBytes'] += 1
            elif scenario == 'short-host-time': changed[1]['elapsedMs'] = 40
            else: changed[0]['timeoutMs'] = 50
            if all(check(changed).values()): failures.append(scenario)
        assert not failures, failures


def _canonical_ui_fixture(module, root):
    import base64
    states, checkpoints, frames, inputs, geometry, io = [], [], [], [], [], []
    geometry_id, previous_columns = 0, None
    names = list(module.CANONICAL_PANE_CHECKPOINTS)
    names.insert(names.index('canonical_omega_control'), 'canonical_tab_landing_0')
    special = {
        'canonical_alpha_dock': ('canonical-open', b'/diff\r'),
        'canonical_two_files_before_select': ('omega-real-read-write', b'owned omega prompt\r'),
        'canonical_focus_landing': ('canonical-focus-chord', b'\x18\t'),
        'canonical_tab_landing_0': ('canonical-tab-0', b'\t'),
        'canonical_file_body': ('canonical-file-press', b'\r'),
        'canonical_escape_keeps_open': ('canonical-leave-focus', b'\x1b'),
        'canonical_refocus_landing': ('canonical-refocus', b'\x18\t'),
        'canonical_person_closed': ('canonical-close-chord', b'\x18x'),
        'canonical_reopened': ('canonical-reopen', b'/diff\r'),
        'canonical_command_closed': ('canonical-command-close', b'/diff\r'),
        'canonical_narrow_refused': ('canonical-too-narrow', b'/diff\r'),
    }
    for index, name in enumerate(names, 1):
        columns = 109 if name in ('canonical_inline_same_identity', 'canonical_narrow_refused') else 110
        if columns != previous_columns:
            geometry_id += 1
            io.append({'ioId': index * 10 - 1, 'kind': 'resize-ack', 'captureId': 'unit-capture',
                       'geometryId': geometry_id, 'columns': columns, 'rows': 34, 'succeeded': True})
            previous_columns = columns
        closed = name in ('canonical_person_closed', 'canonical_command_closed', 'canonical_narrow_refused')
        focused = name in ('canonical_focus_landing', 'canonical_tab_landing_0', 'canonical_omega_control',
                           'canonical_file_body', 'canonical_refocus_landing')
        key = 'base' if name == 'canonical_focus_landing' else 'file:omega.txt' if focused else None
        pane = None if closed else {
            'plugin': 'cc-plugin-diff', 'id': 'diff', 'activation': 1,
            'lease': 8 if name == 'canonical_reopened' else 2, 'drawing': index,
            'visible': True, 'shown': True, 'hasTree': True, 'focused': focused,
            'placement': 'inline' if columns == 109 else 'dock', 'bodyColumns': 39,
            **({'focusedElement': key, 'focusedPlugin': 'cc-plugin-diff'} if key else {}),
        }
        state = {'revision': index, 'pane': pane}; states.append(state)
        text = 'ALPHA_RELEASE_BODY\nALPHA_RELEASE_LINE_000'
        if name in ('canonical_two_files_before_select', 'canonical_focus_landing', 'canonical_tab_landing_0', 'canonical_omega_control'):
            text = 'alpha.txt\nomega.txt\nALPHA_RELEASE_BODY'
        elif name in ('canonical_file_body', 'canonical_escape_keeps_open', 'canonical_redocked', 'canonical_refocus_landing'):
            text = 'OMEGA_RELEASE_BODY'
        elif columns == 109:
            text = 'Resize your terminal to at least 110 columns to show the diff panel'
        left = 0 if columns == 109 or closed else 71
        cells = [[left + x, 1 + y, char, 1, ''] for y, line in enumerate(text.splitlines()) for x, char in enumerate(line)]
        rect = {'x': left, 'y': 0, 'width': columns if left == 0 else 39, 'height': 34}
        body_rect = {**rect, 'y': 1, 'height': 30}
        witness = None if closed else {**pane, 'revision': index, 'mount': index, 'rect': rect, 'bodyRect': body_rect, 'paintable': True,
            'actualFocusWithin': focused, 'paintedScrollTop': 0,
            'controls': [{'plugin': 'cc-plugin-diff', 'key': key, 'rect': body_rect, 'paintable': True, 'emptyButton': False}] if key else [],
            **({'actualFocusedElement': key, 'actualFocusedPlugin': 'cc-plugin-diff'} if key else {}),
        }
        frame = {'frameId': index, 'terminalUiRevision': index,
            'captureId': 'unit-capture', 'broker': {
                'start': {'ioId': index * 10, 'rawOffset': index * 100, 'geometryId': geometry_id, 'captureId': 'unit-capture'},
                'end': {'ioId': index * 10 + 1, 'rawOffset': index * 100 + 1, 'geometryId': geometry_id, 'captureId': 'unit-capture'}},
            'terminalPanes': [witness] if witness else [],
            'frameBase64': base64.b64encode(json.dumps({'columns': columns, 'rows': 35,
                'viewport': {'width': columns, 'height': 34}, 'buffer': 'alternate', 'cells': cells}).encode()).decode()}
        frames.append(frame)
        if name in ('canonical_inline_same_identity', 'canonical_redocked'):
            receipt = {'phase': 'resize-return', 'exitCode': 0, 'columns': columns, 'rows': 34,
                       'lastObservedFrameId': index - 1, 'lastObservedIoId': index * 10 - 2,
                       'observedRawBytes': index * 100 - 1, 'actionId': index}
            geometry.extend([{**receipt, 'phase': 'resize-send'}, receipt]); action = {'kind': 'resize', 'receipt': receipt}
        elif name == 'canonical_omega_control':
            action = checkpoints[-1]['action']
        else:
            stem, data = special[name]; path = root / f'raw-{stem}.bin'; path.write_bytes(data)
            receipt = {'phase': 'send', 'transport': 'tmux-paste-buffer', 'inputFile': str(path), 'hex': data.hex(),
                       'bytesSHA256': module.sha256(path), 'lastObservedFrameId': index - 1,
                       'lastObservedIoId': index * 10 - 2, 'observedRawBytes': index * 100 - 1, 'actionId': index}
            inputs.append(receipt); action = {'kind': 'input', 'receipt': receipt}
        observation = module.canonical_frame_snapshot([state], [frame], action['receipt']['lastObservedFrameId'])
        assert observation is not None, name
        checkpoints.append({'name': name, 'passed': True, 'pane': pane, 'observation': observation,
                            'frameFloor': action['receipt']['lastObservedFrameId'], 'action': action,
                            'lastObservedFrameId': index, 'lastObservedIoId': index * 10 + 2,
                            'observedRawBytes': index * 100 + 2})
    (root / 'canonical-ui-states.json').write_text(json.dumps(states))
    (root / 'canonical-checkpoints.json').write_text(json.dumps(checkpoints))
    for name, rows in [('frames.jsonl', frames), ('inputs.jsonl', inputs), ('geometry.jsonl', geometry), ('pty-io.jsonl', io)]:
        (root / name).write_text(''.join(json.dumps(row) + '\n' for row in rows))
    with (root / 'debug.log').open('a') as log:
        for state in states:
            log.write('[ModsUI] ' + json.dumps({'event': 'publish', 'revision': state['revision'],
                                              'panes': [state['pane']] if state['pane'] else []}) + '\n')
    assert all(module.canonical_ui_checks(root).values()), module.canonical_ui_checks(root)


def _terminal_acceptance_fixture(module, root, target):
    # Synthetic unit fixture for aggregation integrity; never native evidence.
    names = ('pty.raw', 'native-pty.raw', 'native-pty-initial.json', 'native-pty-eof.json',
             'native-input.jsonl', 'pty-io.jsonl', 'broker-cleanup.json', 'frames.jsonl',
             'geometry.jsonl', 'initial-termios.txt', 'capture-eof',
             'frame-stream-map.json', 'frame-physical-report.json', 'observations.jsonl')
    for name in names:
        (root / name).write_text('{}\n')
    frames = [
        {'frameId': 1, 'columns': 110, 'rows': 34, 'verdict': 'passed', 'semantic': {'alphaBody': True}},
        {'frameId': 2, 'columns': 110, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'detail', 'omegaFile': True, 'loading': True, 'omegaBody': False}},
        {'frameId': 3, 'columns': 110, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'detail', 'omegaFile': True, 'omegaBody': True}},
        {'frameId': 4, 'columns': 109, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'detail', 'omegaFile': True, 'omegaBody': True}},
        {'frameId': 5, 'columns': 110, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'detail', 'omegaFile': True, 'omegaBody': True}}]
    sizes = [(109, 34), (110, 34), (109, 34), (110, 34), (109, 34)] if target == 'terminal-interaction' else (
        [(110, 34), (109, 34), (110, 34), (109, 34)])
    replay = {'method': 'independent-pty-replay-v1', 'verdict': 'passed',
        'frameCount': len(frames), 'frames': frames,
        'sizeSequence': [{'columns': 110, 'rows': 34, 'frameId': 1},
                         {'columns': 109, 'rows': 34, 'frameId': 4},
                         {'columns': 110, 'rows': 34, 'frameId': 5}],
        'geometryProof': {'verdict': 'passed', 'sizes': [{'columns': x, 'rows': y} for x, y in sizes]}}
    (root / 'frame-physical-report.json').write_text(json.dumps(replay))
    for name in ('omega-body-blocked.json', 'input-chunks.json'):
        (root / name).write_text('{}')
    data = b'unit input bytes'
    input_file = root / 'raw-unit-input.bin'
    input_file.write_bytes(data)
    digest = hashlib.sha256(data).hexdigest()
    (root / 'inputs.jsonl').write_text(json.dumps({'phase': 'send',
        'transport': 'tmux-paste-buffer', 'inputFile': str(input_file),
        'hex': data.hex(), 'bytesSHA256': digest}) + '\n')
    binary = root / 'bin/claude'; binary.parent.mkdir(); binary.write_bytes(b'unit binary')
    capture = {'captureId': 'unit-capture', 'binarySha256': module.sha256(binary),
        'target': 'unit-target', 'pane': 'unit-pane', 'framePhysicalVerdict': 'passed',
        'eofPassed': True, 'files': {name: {'path': str(root / name),
            'bytes': (root / name).stat().st_size, 'sha256': module.sha256(root / name)}
            for name in (*names, 'inputs.jsonl')}}
    (root / 'terminal-capture.json').write_text(json.dumps(capture))
    side = {'run': str(root), 'captureId': capture['captureId'],
            'binarySha256': capture['binarySha256'], 'target': capture['target'], 'pane': capture['pane'],
            'cleanup': {'terminalCapture': capture}}
    (root / 'independent-pty-checks.json').write_text(json.dumps({'side': side,
        'captureIdentityPassed': True, 'recheck': {'verdict': 'passed', 'run': str(root),
                                                'captureId': capture['captureId'], 'replay': replay}}))
    (root / 'capture-launch.json').write_text(json.dumps({'run': str(root),
        'binarySha256': capture['binarySha256'], 'capture': {'captureId': capture['captureId'], 'nativeJournal': False},
        'target': capture['target'], 'pane': capture['pane']}))
    metadata_path = root / 'run-metadata.json'
    metadata = json.loads(metadata_path.read_text())
    metadata['terminal_capture'] = json.loads((root / 'capture-launch.json').read_text())
    metadata['mock_openai'] = {'base_url': 'http://127.0.0.1:1'}
    metadata_path.write_text(json.dumps(metadata))
    assertion_id, checks_name = module.TERMINAL_ACCEPTANCE[target]
    checks = {name: True for name in getattr(module, 'TERMINAL_REQUIRED_CHECKS', {}).get(
        target, ('ready', 'normal_native_exit'))}
    (root / checks_name).write_text(json.dumps(checks))
    if target == 'terminal-canonical-diff':
        wire, debug = _canonical_wire_fixture(module, root)
        (root / 'canonical-wire.json').write_text(json.dumps(wire))
        events, watcher, host = _canonical_git_fixture(root)
        (root / 'canonical-git.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in events))
        (root / 'canonical-release.json').write_text(json.dumps(watcher))
        (root / 'debug.log').write_text(debug + ''.join('[ModsProcess] ' + json.dumps(row) + '\n' for row in host))
        for name in ('canonical-checkpoints.json', 'canonical-ui-states.json', 'omega-body-blocked.json'):
            (root / name).write_text('{}')
        _canonical_ui_fixture(module, root)
        capture['files'] = {name: {'path': str(root / name), 'bytes': (root / name).stat().st_size,
                                 'sha256': module.sha256(root / name)} for name in capture['files']}
        (root / 'terminal-capture.json').write_text(json.dumps(capture))
        side['cleanup']['terminalCapture'] = capture
        fresh = json.loads((root / 'independent-pty-checks.json').read_text())
        fresh['side'] = side
        (root / 'independent-pty-checks.json').write_text(json.dumps(fresh))
    files = [path for path in root.rglob('*') if path.is_file() and path != metadata_path]
    hashes = {str(path): module.sha256(path) for path in files}
    metadata['terminal_evidence_sha256'] = hashes
    metadata_path.write_text(json.dumps(metadata))
    return {'assertion_id': assertion_id, 'source_run': root.name, 'runtime_state': 'done',
        'validation_verdict': 'passed', 'required_evidence': [str(path) for path in files],
        'observed_evidence_paths': [str(path) for path in files],
        'evidence_sha256': hashes.copy()}


def test_retained_terminal_completed_business_evidence_cannot_be_rewritten_or_omitted():
    module = load_driver()
    failures = []
    for target in module.TERMINAL_ACCEPTANCE:
        scenarios = ('extra-true-check', 'semantic-erased', 'wrong-exact-resize') if target == 'terminal-interaction' else (
            'extra-true-check', 'canonical-checkpoints.json', 'canonical-ui-states.json', 'omega-body-blocked.json')
        for scenario in scenarios:
            with tempfile.TemporaryDirectory(prefix='terminal-business-pin-') as tmp:
                root = Path(tmp).resolve()
                metadata = {'label': target, 'driver_run': 'unit-driver',
                            'source_run': root.name, 'evidence_dir': str(root)}
                (root / 'run-metadata.json').write_text(json.dumps(metadata))
                assertion = _terminal_acceptance_fixture(module, root, target)
                registered = {str(root): (root / 'run-metadata.json').read_text()}
                row = {'label': target, 'driver_run': 'unit-driver', 'evidence_dir': str(root),
                       'validation_verdict': 'passed', 'assertions': [assertion]}
                with patch.object(module, 'revalidate_terminal_assertion', return_value=True):
                    assert module.validate_required_target_results({target}, [row], registered)['passed']
                    if scenario == 'extra-true-check':
                        path = root / module.TERMINAL_ACCEPTANCE[target][1]
                        data = json.loads(path.read_text()); data['unobserved_business_success'] = True
                        path.write_text(json.dumps(data))
                    elif target == 'terminal-interaction':
                        path = root / 'independent-pty-checks.json'
                        data = json.loads(path.read_text())
                        replay = data['recheck'].setdefault('replay', {'verdict': 'passed'})
                        if scenario == 'semantic-erased':
                            for frame in replay.get('frames', []): frame['semantic'] = {}
                        else:
                            replay['geometryProof'] = {'verdict': 'passed', 'sizes': [{'columns': 110, 'rows': 34}]}
                        path.write_text(json.dumps(data))
                    else:
                        key = str(root / scenario)
                        assertion['required_evidence'].remove(key)
                        assertion['observed_evidence_paths'].remove(key)
                        assertion['evidence_sha256'].pop(key)
                    for key in assertion['evidence_sha256']:
                        assertion['evidence_sha256'][key] = module.sha256(Path(key))
                    if module.validate_required_target_results({target}, [row], registered)['passed']:
                        failures.append((target, scenario))
    assert not failures, failures


def test_retained_terminal_record_anchors_the_original_producer_evidence():
    module = load_driver()
    with tempfile.TemporaryDirectory(prefix='terminal-producer-registration-') as tmp:
        root = Path(tmp).resolve()
        path = root / 'run-metadata.json'
        path.write_text(json.dumps({'label': 'terminal-interaction', 'driver_run': 'unit-driver',
            'source_run': root.name, 'evidence_dir': str(root)}))
        assertion = _terminal_acceptance_fixture(module, root, 'terminal-interaction')
        metadata = json.loads(path.read_text()); metadata.pop('terminal_evidence_sha256')
        path.write_text(json.dumps(metadata))
        gate = object.__new__(module.BinaryGate)
        gate.registered_runs = {str(root): path.read_text()}
        gate.manifest = {'runs': []}; gate.stamp = 'unit'; gate.pid = 42
        gate.evidence_root = root
        row = {'label': 'terminal-interaction', 'driver_run': 'unit-driver',
               'evidence_dir': str(root), 'validation_verdict': 'passed', 'assertions': [assertion]}
        gate.record(row)
        anchor = json.loads(gate.registered_runs[str(root)])['terminal_evidence_sha256']
        assert anchor == assertion['evidence_sha256']
        checks = root / 'terminal-interaction-checks.json'
        value = json.loads(checks.read_text()); value['unobserved_success'] = True
        checks.write_text(json.dumps(value))
        assertion['evidence_sha256'][str(checks)] = module.sha256(checks)
        assert anchor[str(checks)] != assertion['evidence_sha256'][str(checks)]
        with patch.object(module, 'revalidate_terminal_assertion', return_value=True):
            assert not module.assertion_is_valid(assertion, {root.name: root}, gate.registered_runs)


def test_retained_terminal_final_recomputes_registered_semantics_and_exact_resize():
    module = load_driver()
    failures = []
    for scenario in ('semantics', 'resize'):
        with tempfile.TemporaryDirectory(prefix='terminal-registered-semantics-') as tmp:
            root = Path(tmp).resolve()
            metadata = {'label': 'terminal-interaction', 'driver_run': 'unit-driver',
                        'source_run': root.name, 'evidence_dir': str(root)}
            path = root / 'run-metadata.json'; path.write_text(json.dumps(metadata))
            assertion = _terminal_acceptance_fixture(module, root, 'terminal-interaction')
            source = root / 'independent-pty-checks.json'
            data = json.loads(source.read_text()); replay = data['recheck']['replay']
            if scenario == 'semantics':
                for frame in replay['frames']: frame['semantic'] = {}
            else:
                replay['geometryProof']['sizes'] = replay['geometryProof']['sizes'][1:]
            source.write_text(json.dumps(data))
            assertion['evidence_sha256'][str(source)] = module.sha256(source)
            metadata = json.loads(path.read_text())
            metadata['terminal_evidence_sha256'] = assertion['evidence_sha256'].copy()
            path.write_text(json.dumps(metadata))
            # Isolate the Python business evaluator; physical verification has
            # separate real-byte subprocess tests, not this synthetic fixture.
            with patch.object(module, 'revalidate_terminal_assertion', return_value=True):
                if module.assertion_is_valid(assertion, {root.name: root}, {str(root): path.read_text()}):
                    failures.append(scenario)
    assert not failures, failures


def test_retained_terminal_final_capture_closure_cannot_be_omitted_or_rebound():
    module = load_driver()
    # Synthetic aggregation tests isolate the actual replay process.
    with patch.object(module, 'revalidate_terminal_assertion', return_value=True):
        failures = []
        for target in module.TERMINAL_ACCEPTANCE:
            for scenario in ('valid', 'renamed-id', 'missing-hashes', 'input-file-omitted',
                             'input-file-changed', 'native-input-omitted', 'native-input-changed',
                             'termios-omitted', 'stream-omitted', 'binary-omitted',
                             'fresh-run-changed', 'capture-identity-rebound'):
                with tempfile.TemporaryDirectory(prefix='terminal-closure-unit-') as tmp:
                    root = Path(tmp).resolve()
                    metadata = {'label': target, 'driver_run': 'unit-driver',
                                'source_run': root.name, 'evidence_dir': str(root)}
                    (root / 'run-metadata.json').write_text(json.dumps(metadata))
                    assertion = _terminal_acceptance_fixture(module, root, target)
                    registered = {str(root): (root / 'run-metadata.json').read_text()}
                    row = {'label': target, 'driver_run': 'unit-driver', 'evidence_dir': str(root),
                           'validation_verdict': 'passed', 'assertions': [assertion]}
                    positive = module.validate_required_target_results({target}, [row], registered)
                    assert positive['passed'], (target, positive)
                    omitted = {'input-file-omitted': 'raw-unit-input.bin',
                               'native-input-omitted': 'native-input.jsonl',
                               'termios-omitted': 'initial-termios.txt',
                               'stream-omitted': 'frame-stream-map.json',
                               'binary-omitted': 'bin/claude'}.get(scenario)
                    if omitted:
                        key = str(root / omitted)
                        assertion['required_evidence'].remove(key)
                        assertion['observed_evidence_paths'].remove(key)
                        assertion['evidence_sha256'].pop(key)
                    elif scenario == 'renamed-id':
                        assertion['assertion_id'] = 'generic-proof'
                    elif scenario == 'missing-hashes':
                        assertion.pop('evidence_sha256')
                    elif scenario in ('input-file-changed', 'native-input-changed'):
                        name = 'raw-unit-input.bin' if scenario == 'input-file-changed' else 'native-input.jsonl'
                        (root / name).write_text('changed after seal')
                    elif scenario == 'fresh-run-changed':
                        file = root / 'independent-pty-checks.json'
                        data = json.loads(file.read_text()); data['recheck']['run'] = str(root / 'foreign')
                        file.write_text(json.dumps(data))
                        assertion['evidence_sha256'][str(file)] = module.sha256(file)
                    elif scenario == 'capture-identity-rebound':
                        for name in ('capture-launch.json', 'terminal-capture.json', 'independent-pty-checks.json'):
                            file = root / name
                            file.write_text(file.read_text().replace('unit-capture', 'foreign-capture'))
                            assertion['evidence_sha256'][str(file)] = module.sha256(file)
                    coverage = module.validate_required_target_results({target}, [row], registered)
                    if coverage['passed'] != (scenario == 'valid'):
                        failures.append((target, scenario, coverage))
        assert not failures, failures



def test_retained_terminal_final_requires_complete_check_roster_and_observations():
    module = load_driver()
    # Synthetic aggregation tests isolate the actual replay process.
    with patch.object(module, 'revalidate_terminal_assertion', return_value=True):
        failures = []
        for target in module.TERMINAL_ACCEPTANCE:
            for scenario in ('checks-replaced', 'ready-omitted', 'observations-coupled-omission'):
                with tempfile.TemporaryDirectory(prefix='terminal-roster-unit-') as tmp:
                    root = Path(tmp).resolve()
                    metadata = {'label': target, 'driver_run': 'unit-driver',
                                'source_run': root.name, 'evidence_dir': str(root)}
                    (root / 'run-metadata.json').write_text(json.dumps(metadata))
                    assertion = _terminal_acceptance_fixture(module, root, target)
                    registered = {str(root): (root / 'run-metadata.json').read_text()}
                    row = {'label': target, 'driver_run': 'unit-driver', 'evidence_dir': str(root),
                           'validation_verdict': 'passed', 'assertions': [assertion]}
                    assert module.validate_required_target_results({target}, [row], registered)['passed']
                    if scenario == 'observations-coupled-omission':
                        cap = root / 'terminal-capture.json'
                        capture = json.loads(cap.read_text())
                        capture['files'].pop('observations.jsonl')
                        cap.write_text(json.dumps(capture))
                        fresh_file = root / 'independent-pty-checks.json'
                        fresh = json.loads(fresh_file.read_text())
                        fresh['side']['cleanup']['terminalCapture'] = capture
                        fresh_file.write_text(json.dumps(fresh))
                        for file in (cap, fresh_file):
                            assertion['evidence_sha256'][str(file)] = module.sha256(file)
                        key = str(root / 'observations.jsonl')
                        assertion['required_evidence'].remove(key)
                        assertion['observed_evidence_paths'].remove(key)
                        assertion['evidence_sha256'].pop(key)
                    else:
                        file = root / module.TERMINAL_ACCEPTANCE[target][1]
                        checks = json.loads(file.read_text())
                        if scenario == 'checks-replaced':
                            checks = {'arbitraryGreen': True}
                        else:
                            checks.pop('ready')
                        file.write_text(json.dumps(checks))
                        assertion['evidence_sha256'][str(file)] = module.sha256(file)
                    coverage = module.validate_required_target_results({target}, [row], registered)
                    if coverage['passed']:
                        failures.append((target, scenario, coverage))
        assert not failures, failures



def test_retained_terminal_final_reruns_independent_replay_instead_of_trusting_green_labels():
    module = load_driver()
    for target in module.TERMINAL_ACCEPTANCE:
        with tempfile.TemporaryDirectory(prefix='terminal-final-replay-') as tmp:
            root = Path(tmp).resolve()
            metadata = {'label': target, 'driver_run': 'unit-driver',
                        'source_run': root.name, 'evidence_dir': str(root)}
            (root / 'run-metadata.json').write_text(json.dumps(metadata))
            assertion = _terminal_acceptance_fixture(module, root, target)
            registered = {str(root): (root / 'run-metadata.json').read_text()}
            row = {'label': target, 'driver_run': 'unit-driver', 'evidence_dir': str(root),
                   'validation_verdict': 'passed', 'assertions': [assertion]}
            # Explicit unit substitute for the actual pinned replay process.
            # A failed current replay must dominate old saved passed scalars.
            with patch.object(module, 'revalidate_terminal_assertion', return_value=False,
                              create=True) as replay:
                coverage = module.validate_required_target_results({target}, [row], registered)
                assert coverage['passed'] is False, (target, coverage)
                replay.assert_called_once_with(root)




def test_retained_canonical_final_recomputes_full_wire_protocol():
    import copy
    module = load_driver()
    scenarios = ('read-omitted', 'write-reordered', 'duplicate-request', 'foreign-session',
                 'duplicate-request-id', 'wrong-cache', 'missing-auth', 'wrong-tool-args')
    failures = []
    for scenario in scenarios:
        with tempfile.TemporaryDirectory(prefix='canonical-final-wire-') as tmp:
            root = Path(tmp).resolve()
            metadata = {'label': 'terminal-canonical-diff', 'driver_run': 'unit-driver',
                        'source_run': root.name, 'evidence_dir': str(root)}
            (root / 'run-metadata.json').write_text(json.dumps(metadata))
            assertion = _terminal_acceptance_fixture(module, root, 'terminal-canonical-diff')
            row = {'label': 'terminal-canonical-diff', 'driver_run': 'unit-driver',
                   'evidence_dir': str(root), 'validation_verdict': 'passed', 'assertions': [assertion]}
            registered = {str(root): (root / 'run-metadata.json').read_text()}
            with patch.object(module, 'revalidate_terminal_assertion', return_value=True):
                assert module.validate_required_target_results({'terminal-canonical-diff'}, [row], registered)['passed']
                file = root / 'canonical-wire.json'
                wire = json.loads(file.read_text())
                if scenario == 'read-omitted': wire.pop(2)
                elif scenario == 'write-reordered': wire[2], wire[3] = wire[3], wire[2]
                elif scenario == 'duplicate-request': wire.append(copy.deepcopy(wire[-1]))
                elif scenario == 'foreign-session':
                    for request in wire[1:]:
                        for key in ('session-id', 'thread-id', 'x-claude-code-session-id'):
                            request['headers'][key] = 'foreign-session'
                        request['body']['prompt_cache_key'] = 'foreign-session'
                elif scenario == 'duplicate-request-id': wire[3]['headers']['x-client-request-id'] = wire[2]['headers']['x-client-request-id']
                elif scenario == 'wrong-cache': wire[2]['body']['prompt_cache_key'] = 'wrong-cache'
                elif scenario == 'missing-auth': wire[2]['authorization'] = {'present': False, 'matches_dummy': False}
                elif scenario == 'wrong-tool-args': wire[3]['body']['input'][-2]['arguments'] = '{"file_path":"/foreign"}'
                file.write_text(json.dumps(wire))
                assertion['evidence_sha256'][str(file)] = module.sha256(file)
                if module.validate_required_target_results({'terminal-canonical-diff'}, [row], registered)['passed']:
                    failures.append(scenario)
    assert not failures, failures



def test_retained_canonical_final_requires_live_release_and_successful_git_receipt():
    module = load_driver()
    scenarios = ('released-missing', 'foreign-pid', 'wrong-argv', 'stale-watcher',
                 'cleanup-only-release', 'release-too-late', 'host-timeout', 'git-nonzero')
    failures = []
    for scenario in scenarios:
        with tempfile.TemporaryDirectory(prefix='canonical-final-git-') as tmp:
            root = Path(tmp).resolve()
            metadata = {'label': 'terminal-canonical-diff', 'driver_run': 'unit-driver',
                        'source_run': root.name, 'evidence_dir': str(root)}
            (root / 'run-metadata.json').write_text(json.dumps(metadata))
            assertion = _terminal_acceptance_fixture(module, root, 'terminal-canonical-diff')
            row = {'label': 'terminal-canonical-diff', 'driver_run': 'unit-driver',
                   'evidence_dir': str(root), 'validation_verdict': 'passed', 'assertions': [assertion]}
            registered = {str(root): (root / 'run-metadata.json').read_text()}
            with patch.object(module, 'revalidate_terminal_assertion', return_value=True, create=True):
                assert module.validate_required_target_results({'terminal-canonical-diff'}, [row], registered)['passed']
                events, watcher, host = _canonical_git_fixture(root)
                if scenario == 'released-missing': events.pop()
                elif scenario == 'foreign-pid': events[-1]['pid'] = 9002
                elif scenario == 'wrong-argv': events[-1]['argv'] = ['diff', '--', '/foreign']
                elif scenario == 'stale-watcher': watcher['signalStartedAt'] = 1
                elif scenario == 'cleanup-only-release': watcher['source'] = 'finally-cleanup'
                elif scenario == 'release-too-late': events[-1]['monotonic'] = 17
                elif scenario == 'host-timeout': host.append({**host[-1], 'phase': 'stop', 'reason': 'TimeoutError'})
                elif scenario == 'git-nonzero': host[-1]['exitCode'] = 1
                (root / 'canonical-git.jsonl').write_text(''.join(json.dumps(item) + '\n' for item in events))
                (root / 'canonical-release.json').write_text(json.dumps(watcher))
                _, debug = _canonical_wire_fixture(module, root)
                (root / 'debug.log').write_text(debug + ''.join('[ModsProcess] ' + json.dumps(item) + '\n' for item in host))
                for name in ('canonical-git.jsonl', 'canonical-release.json', 'debug.log'):
                    assertion['evidence_sha256'][str(root / name)] = module.sha256(root / name)
                if module.validate_required_target_results({'terminal-canonical-diff'}, [row], registered)['passed']:
                    failures.append(scenario)
    assert not failures, failures



def _builtin_final_integrity_fixture(module, root):
    # Synthetic unit shape, with the physical/business recomputation explicitly
    # substituted by each caller. These bytes are never native release evidence.
    pair, files = {}, []
    for name in ('privacyOff', 'privacyOn', 'enabled', 'disabled',
                 'securityOrdinary', 'securityTeam', 'securityEnterprise'):
        side_root = root / 'acceptance-cache/runs' / name
        side_root.mkdir(parents=True)
        (side_root / 'run-metadata.json').write_text('{}')
        _terminal_acceptance_fixture(module, side_root, 'terminal-interaction')
        capture = json.loads((side_root / 'terminal-capture.json').read_text())
        capture['captureId'] = 'unit-' + name
        launch_path = side_root / 'capture-launch.json'
        launch = json.loads(launch_path.read_text())
        launch['capture']['captureId'] = capture['captureId']
        launch_path.write_text(json.dumps(launch))
        side = {'run': str(side_root), 'captureId': capture['captureId'],
                'binarySha256': capture['binarySha256'], 'target': capture['target'],
                'pane': capture['pane'], 'cleanup': {'terminalCapture': capture}}
        pair[name] = side
        files.extend(Path(info['path']) for info in capture['files'].values())
        files.extend([side_root / 'bin/claude', side_root / 'raw-unit-input.bin', launch_path])
    report = root / 'acceptance-cache/runs/acceptance.json'
    report.write_text(json.dumps({'pair': pair, 'assertions': {
        name: {'verdict': 'passed'} for name in ('completeness', 'cleanup', 'agents',
            'diff', 'security', 'ui', 'dynamicTools', 'suggestionReload', 'telemetry', 'terminalEvidence')}}))
    checks = root / 'builtin-mods-checks.json'
    checks.write_text(json.dumps({'checks': {name: True for name in
        ('subprocess', 'report', 'assertions', 'binary', 'sides', 'evidence_ownership',
         'cache_cleanup', 'independent_frame_replay')}}))
    (root / 'builtin-terminal-recheck.json').write_text('{"verdict":"passed"}')
    (root / 'stdout.txt').write_text('synthetic stdout')
    (root / 'stderr.txt').write_text('')
    files.extend([report, checks, root / 'builtin-terminal-recheck.json', root / 'stdout.txt', root / 'stderr.txt'])
    metadata = {'label': 'builtin-mods', 'driver_run': 'unit-driver',
                'source_run': root.name, 'evidence_dir': str(root),
                'binary_sha256': pair['enabled']['binarySha256'],
                'acceptance_report': str(report), 'acceptance_sha256': module.sha256(report),
                'builtin_capture_registry': {name: {key: side[key]
                    for key in ('run', 'target', 'pane', 'captureId', 'binarySha256')}
                    for name, side in pair.items()}}
    for name, side in pair.items():
        launch = json.loads((Path(side['run']) / 'capture-launch.json').read_text())
        metadata['builtin_capture_registry'][name].update(
            driverPid=launch.get('driverPid'), capture=launch['capture'])
    # Synthetic aggregation shape, not actual archive/native evidence.
    metadata.update(builtin_archive_source=str(root / 'acceptance-cache'),
                    builtin_archive_root=str(root / 'acceptance-cache'))
    archive_receipt = root / 'builtin-cache-archive.json'
    archive_receipt.write_text(json.dumps({'source': metadata['builtin_archive_source'],
        'archive': metadata['builtin_archive_root'], 'archiveComplete': True,
        'sourceFilesStable': True, 'archiveFilesMatch': True, 'sourceManifest': {
            str(Path(side['run']).relative_to(root / 'acceptance-cache')) + '/capture-launch.json': {
                'type': 'file', 'sha256': module.sha256(Path(side['run']) / 'capture-launch.json')}
            for side in pair.values()}}))
    files.append(archive_receipt)
    metadata['builtin_archive_receipt_sha256'] = module.sha256(archive_receipt)
    for name, side in pair.items():
        metadata['builtin_capture_registry'][name]['originalRun'] = side['run']
    metadata_path = root / 'run-metadata.json'
    metadata_path.write_text(json.dumps(metadata))
    assertion = {'assertion_id': 'builtin-mods-compiled-acceptance', 'source_run': root.name,
        'runtime_state': 'done', 'validation_verdict': 'passed',
        'required_evidence': [str(file) for file in files],
        'observed_evidence_paths': [str(file) for file in files],
        'evidence_sha256': {str(file): module.sha256(file) for file in files}}
    row = {'label': 'builtin-mods', 'driver_run': 'unit-driver', 'evidence_dir': str(root),
           'validation_verdict': 'passed', 'assertions': [assertion]}
    return row, {str(root): metadata_path.read_text()}


def test_retained_builtin_final_seven_side_closure_is_not_replaceable():
    module = load_driver()
    scenarios = ('valid', 'capture-file-omitted', 'input-file-omitted', 'binary-omitted',
                 'report-omitted', 'recheck-omitted', 'side-deleted', 'capture-rebound',
                 'report-failed', 'roster-omitted', 'current-replay-failed',
                 'archive-omitted', 'archive-source-rebound', 'archive-root-rebound',
                 'archive-incomplete', 'archive-source-unstable', 'archive-files-differ',
                 'archive-launch-digest-rebound', 'archive-launch-omitted',
                 'original-run-rebound', 'launch-bytes-rebound', 'archive-digest-omitted')
    failures = []
    for scenario in scenarios:
        with tempfile.TemporaryDirectory(prefix='builtin-final-integrity-') as tmp:
            root = Path(tmp).resolve()
            row, registered = _builtin_final_integrity_fixture(module, root)
            assertion = row['assertions'][0]
            metadata = json.loads(registered[str(root)])
            report = Path(metadata['acceptance_report'])
            side = root / 'acceptance-cache/runs/enabled'
            omitted = {'capture-file-omitted': side / 'frames.jsonl',
                       'input-file-omitted': side / 'raw-unit-input.bin',
                       'binary-omitted': side / 'bin/claude', 'report-omitted': report,
                       'recheck-omitted': root / 'builtin-terminal-recheck.json',
                       'archive-omitted': root / 'builtin-cache-archive.json'}.get(scenario)
            if omitted:
                key = str(omitted)
                assertion['required_evidence'].remove(key)
                assertion['observed_evidence_paths'].remove(key)
                assertion['evidence_sha256'].pop(key)
            elif scenario in ('side-deleted', 'capture-rebound', 'report-failed'):
                data = json.loads(report.read_text())
                if scenario == 'side-deleted': data['pair'].pop('enabled')
                elif scenario == 'capture-rebound': data['pair']['enabled']['captureId'] = 'foreign-capture'
                else: data['assertions']['terminalEvidence']['verdict'] = 'failed'
                report.write_text(json.dumps(data))
                assertion['evidence_sha256'][str(report)] = module.sha256(report)
            elif scenario == 'roster-omitted':
                file = root / 'builtin-mods-checks.json'
                data = json.loads(file.read_text()); data['checks'].pop('independent_frame_replay')
                file.write_text(json.dumps(data)); assertion['evidence_sha256'][str(file)] = module.sha256(file)
            elif scenario.startswith('archive-') and scenario != 'archive-digest-omitted':
                file = root / 'builtin-cache-archive.json'
                data = json.loads(file.read_text())
                key = 'runs/enabled/capture-launch.json'
                if scenario == 'archive-source-rebound': data['source'] = '/private/tmp/foreign-source'
                elif scenario == 'archive-root-rebound': data['archive'] = '/private/tmp/foreign-archive'
                elif scenario == 'archive-incomplete': data['archiveComplete'] = False
                elif scenario == 'archive-source-unstable': data['sourceFilesStable'] = False
                elif scenario == 'archive-files-differ': data['archiveFilesMatch'] = False
                elif scenario == 'archive-launch-digest-rebound': data['sourceManifest'][key]['sha256'] = '0' * 64
                elif scenario == 'archive-launch-omitted': data['sourceManifest'].pop(key)
                file.write_text(json.dumps(data))
                # Rehash the coupled proof: trusted launch/source registration,
                # rather than just an old receipt digest, must reject it.
                assertion['evidence_sha256'][str(file)] = module.sha256(file)
            elif scenario == 'archive-digest-omitted':
                metadata.pop('builtin_archive_receipt_sha256')
                registered[str(root)] = json.dumps(metadata)
                (root / 'run-metadata.json').write_text(registered[str(root)])
            elif scenario == 'launch-bytes-rebound':
                launch_path = side / 'capture-launch.json'
                launch = json.loads(launch_path.read_text())
                # Keep all previously compared identity fields identical.
                launch['launchArgv'] = ['/private/tmp/foreign-binary']
                launch_path.write_text(json.dumps(launch, indent=2))
                digest = module.sha256(launch_path)
                assertion['evidence_sha256'][str(launch_path)] = digest
                file = root / 'builtin-cache-archive.json'
                data = json.loads(file.read_text())
                data['sourceManifest']['runs/enabled/capture-launch.json']['sha256'] = digest
                file.write_text(json.dumps(data))
                assertion['evidence_sha256'][str(file)] = module.sha256(file)
            elif scenario == 'original-run-rebound':
                launch_path = side / 'capture-launch.json'
                launch = json.loads(launch_path.read_text())
                launch['run'] = '/private/tmp/foreign-source/runs/enabled'
                launch_path.write_text(json.dumps(launch))
                digest = module.sha256(launch_path)
                assertion['evidence_sha256'][str(launch_path)] = digest
                file = root / 'builtin-cache-archive.json'
                data = json.loads(file.read_text())
                data['sourceManifest']['runs/enabled/capture-launch.json']['sha256'] = digest
                file.write_text(json.dumps(data))
                assertion['evidence_sha256'][str(file)] = module.sha256(file)
            with patch.object(module, 'revalidate_builtin_assertion',
                              return_value=scenario != 'current-replay-failed', create=True):
                coverage = module.validate_required_target_results({'builtin-mods'}, [row], registered)
                if coverage['passed'] != (scenario == 'valid'):
                    failures.append((scenario, coverage))
    assert not failures, failures


def test_retained_builtin_cannot_use_generic_or_coupled_omitted_final_proof():
    module = load_driver()
    with tempfile.TemporaryDirectory(prefix='builtin-final-proof-') as tmp:
        root = Path(tmp).resolve()
        metadata = {'label': 'builtin-mods', 'driver_run': 'unit-driver',
                    'source_run': root.name, 'evidence_dir': str(root)}
        (root / 'run-metadata.json').write_text(json.dumps(metadata))
        assertion = make_required_assertion(root)
        row = {'label': 'builtin-mods', 'driver_run': 'unit-driver',
               'evidence_dir': str(root), 'validation_verdict': 'passed', 'assertions': [assertion]}
        registered = {str(root): (root / 'run-metadata.json').read_text()}
        for assertion_id in ('generic-proof', 'builtin-mods-compiled-acceptance'):
            assertion['assertion_id'] = assertion_id
            assertion['evidence_sha256'] = {path: module.sha256(Path(path))
                                           for path in assertion['required_evidence']}
            coverage = module.validate_required_target_results({'builtin-mods'}, [row], registered)
            assert coverage['passed'] is False, (assertion_id, coverage)


def test_retained_terminal_cannot_replace_required_acceptance_with_generic_proof():
    module = load_driver()
    with tempfile.TemporaryDirectory(prefix='terminal-final-proof-') as tmp:
        root = Path(tmp).resolve()
        for target in ('terminal-interaction', 'terminal-canonical-diff'):
            source = root / target
            source.mkdir()
            assertion = make_required_assertion(source)
            row = {'label': target, 'validation_verdict': 'passed',
                   'driver_run': 'driver-native-unit',
                   'evidence_dir': str(source), 'assertions': [assertion]}
            metadata = json.dumps({'label': target, 'driver_run': row['driver_run'],
                'source_run': source.name, 'evidence_dir': str(source)})
            (source / 'run-metadata.json').write_text(metadata)
            registered = {str(source): metadata}
            assert module.assertion_is_valid(assertion, {source.name: source}) is True
            coverage = module.validate_required_target_results({target}, [row], registered)
            assert coverage['passed'] is False, (target, coverage)


def test_retained_canonical_body_cannot_use_frames_before_current_input():
    module = load_driver()
    import base64
    with tempfile.TemporaryDirectory(prefix='canonical-stale-frame-') as tmp:
        root = Path(tmp)
        gate = object.__new__(module.BinaryGate)
        pane = {'plugin': 'cc-plugin-diff', 'id': 'diff', 'placement': 'dock', 'bodyColumns': 39,
                'activation': 1, 'lease': 2, 'drawing': 3, 'visible': True, 'shown': True,
                'hasTree': True, 'focused': False}
        state = {'revision': 7, 'pane': pane}
        gate.canonical_pane_states = lambda _: [state]
        gate.canonical_frame_floor = 9
        frame = {'columns': 110, 'rows': 34, 'buffer': 'alternate',
                 'viewport': {'width': 110, 'height': 34},
                 'cells': [[71 + i, 0, char, 1, '']
                           for i, char in enumerate('OMEGA_RELEASE_BODY')]}
        stale = {'frameId': 9,
                 'terminalUiRevision': 7,
                 'terminalPanes': [{**pane, 'revision': 7, 'mount': 4, 'paintable': True,
                    'rect': {'x': 71, 'y': 0, 'width': 39, 'height': 34},
                    'bodyRect': {'x': 71, 'y': 0, 'width': 39, 'height': 34},
                    'actualFocusWithin': False, 'controls': [], 'paintedScrollTop': 0}],
                 'frameBase64': base64.b64encode(json.dumps(frame).encode()).decode()}
        capture_id = 'legacy-canonical-fixture'
        stale.update(captureId=capture_id, broker={'start': {'ioId': 2, 'geometryId': 1, 'rawOffset': 0, 'captureId': capture_id},
            'end': {'ioId': 3, 'geometryId': 1, 'rawOffset': 0, 'captureId': capture_id}})
        io = [{'ioId': 1, 'kind': 'resize-ack', 'geometryId': 1, 'captureId': capture_id,
               'succeeded': True, 'columns': 110, 'rows': 34}, {'ioId': 2}, {'ioId': 3}]
        (root / 'pty.raw').write_bytes(b'')
        gate.terminal_jsonl = lambda path: [stale] if path.name == 'frames.jsonl' else io
        assert gate.canonical_dock_text(root) == '', 'old frame accepted for a new input'
        gate.terminal_jsonl = lambda path: [{**stale, 'frameId': 10}] if path.name == 'frames.jsonl' else io
        assert 'OMEGA_RELEASE_BODY' in gate.canonical_dock_text(root)
        failures = []
        for key, value in [('revision', 6), ('drawing', 2), ('activation', 9), ('lease', 9),
                           ('placement', 'inline'), ('actualFocusWithin', True), ('paintable', False), ('paintable', None)]:
            changed = json.loads(json.dumps(stale))
            changed['frameId'] = 10
            changed['terminalPanes'][0][key] = value
            gate.terminal_jsonl = lambda path: [changed] if path.name == 'frames.jsonl' else io
            if gate.canonical_dock_text(root): failures.append(key)
        changed = {**stale, 'frameId': 10, 'terminalUiRevision': 6}
        gate.terminal_jsonl = lambda path: [changed] if path.name == 'frames.jsonl' else io
        if gate.canonical_dock_text(root): failures.append('global-ui-revision')
        changed = json.loads(json.dumps(stale)); changed['frameId'] = 10
        changed['terminalPanes'][0]['bodyRect']['x'] = 0
        gate.terminal_jsonl = lambda path: [changed] if path.name == 'frames.jsonl' else io
        if gate.canonical_dock_text(root): failures.append('body-outside-painted-pane')
        assert not failures, failures


def test_retained_canonical_final_cannot_accept_empty_pane_frame_proof():
    module = load_driver()
    with tempfile.TemporaryDirectory(prefix='canonical-empty-pane-proof-') as tmp:
        root = Path(tmp).resolve()
        metadata = {'label': 'terminal-canonical-diff', 'driver_run': 'unit-driver',
                    'source_run': root.name, 'evidence_dir': str(root)}
        (root / 'run-metadata.json').write_text(json.dumps(metadata))
        assertion = _terminal_acceptance_fixture(module, root, 'terminal-canonical-diff')
        (root / 'canonical-checkpoints.json').write_text('[]')
        assertion['evidence_sha256'][str(root / 'canonical-checkpoints.json')] = module.sha256(root / 'canonical-checkpoints.json')
        metadata = json.loads((root / 'run-metadata.json').read_text())
        metadata['terminal_evidence_sha256'] = assertion['evidence_sha256']
        (root / 'run-metadata.json').write_text(json.dumps(metadata))
        row = {'label': 'terminal-canonical-diff', 'driver_run': 'unit-driver',
               'evidence_dir': str(root), 'validation_verdict': 'passed', 'assertions': [assertion]}
        registered = {str(root): (root / 'run-metadata.json').read_text()}
        with patch.object(module, 'revalidate_terminal_assertion', return_value=True):
            coverage = module.validate_required_target_results({'terminal-canonical-diff'}, [row], registered)
        assert coverage['passed'] is False, 'empty Pane frame proof was accepted'


def test_retained_canonical_ui_recomputes_matched_lifecycle_and_keyboard():
    module = load_driver()
    failures = []
    for scenario in ('valid', 'missing-checkpoint', 'stale-closed-frame', 'changed-resize-lease',
                     'reopened-old-lease', 'reopened-foreign-activation', 'tab-stayed-put', 'wrong-tab-bytes',
                     'omitted-tab', 'missing-target-control', 'foreign-actual-focus', 'omega-old-action',
                     'frame-after-checkpoint', 'wrong-resize-viewport', 'missing-resize-ack',
                     'wrong-resize-epoch', 'io-after-checkpoint', 'missing-paintable',
                     'foreign-actual-focus-with-control', 'empty-button', 'ordinary-unpainted',
                     'empty-button-foreign-focus', 'empty-button-missing-control'):
        with tempfile.TemporaryDirectory(prefix='canonical-ui-recompute-') as tmp:
            root = Path(tmp).resolve(); (root / 'debug.log').write_text('')
            _canonical_ui_fixture(module, root)
            states = json.loads((root / 'canonical-ui-states.json').read_text())
            checkpoints = json.loads((root / 'canonical-checkpoints.json').read_text())
            frames = [json.loads(line) for line in (root / 'frames.jsonl').read_text().splitlines()]
            names = {'stale-closed-frame': 'canonical_person_closed', 'changed-resize-lease': 'canonical_redocked',
                     'reopened-old-lease': 'canonical_reopened', 'reopened-foreign-activation': 'canonical_reopened',
                     'tab-stayed-put': 'canonical_tab_landing_0'}
            if scenario == 'missing-checkpoint': checkpoints.pop()
            elif scenario in ('missing-paintable', 'foreign-actual-focus-with-control', 'empty-button',
                              'ordinary-unpainted', 'empty-button-foreign-focus', 'empty-button-missing-control'):
                checkpoint = next(row for row in checkpoints if row['name'] == 'canonical_focus_landing')
                index = checkpoint['observation']['frameId'] - 1
                witness = frames[index]['terminalPanes'][0]
                if scenario == 'missing-paintable': witness.pop('paintable')
                elif scenario == 'foreign-actual-focus-with-control': witness['actualFocusedElement'] = 'foreign'
                else:
                    witness['controls'][0].update(rect=None, paintable=False, emptyButton=scenario != 'ordinary-unpainted')
                    if scenario == 'empty-button-foreign-focus': witness['actualFocusedElement'] = 'foreign'
                    elif scenario == 'empty-button-missing-control': witness['controls'] = []
                checkpoint['observation'] = module.canonical_frame_snapshot([states[index]], [frames[index]], checkpoint['frameFloor'])
            elif scenario in ('missing-resize-ack', 'wrong-resize-epoch', 'io-after-checkpoint'):
                checkpoint = next(row for row in checkpoints if row['name'] == 'canonical_inline_same_identity')
                index = checkpoint['observation']['frameId'] - 1
                if scenario == 'io-after-checkpoint': checkpoint['lastObservedIoId'] = index * 10
                elif scenario == 'wrong-resize-epoch': frames[index]['broker']['end']['geometryId'] = 999
                else:
                    rows = [json.loads(line) for line in (root / 'pty-io.jsonl').read_text().splitlines()]
                    rows = [row for row in rows if row['geometryId'] != frames[index]['broker']['start']['geometryId']]
                    (root / 'pty-io.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows))
            elif scenario == 'omitted-tab':
                checkpoints = [row for row in checkpoints if row['name'] != 'canonical_tab_landing_0']
            elif scenario in ('missing-target-control', 'foreign-actual-focus', 'omega-old-action',
                              'frame-after-checkpoint', 'wrong-resize-viewport'):
                name = 'canonical_inline_same_identity' if scenario == 'wrong-resize-viewport' else 'canonical_omega_control'
                checkpoint = next(row for row in checkpoints if row['name'] == name)
                index = checkpoint['observation']['frameId'] - 1
                if scenario == 'omega-old-action':
                    checkpoint['action'] = next(row for row in checkpoints if row['name'] == 'canonical_focus_landing')['action']
                    checkpoint['frameFloor'] = checkpoint['action']['receipt']['lastObservedFrameId']
                elif scenario == 'frame-after-checkpoint': checkpoint['lastObservedFrameId'] = index
                elif scenario == 'wrong-resize-viewport':
                    import base64
                    encoded = json.loads(base64.b64decode(frames[index]['frameBase64']))
                    encoded['viewport']['width'] = encoded['columns'] = 110
                    frames[index]['frameBase64'] = base64.b64encode(json.dumps(encoded).encode()).decode()
                else:
                    frames[index]['terminalPanes'][0]['controls'] = []
                    if scenario == 'foreign-actual-focus':
                        frames[index]['terminalPanes'][0]['actualFocusedElement'] = 'foreign'
                checkpoint['observation'] = module.canonical_frame_snapshot([states[index]], [frames[index]], checkpoint['frameFloor'])
            elif scenario in names:
                checkpoint = next(row for row in checkpoints if row['name'] == names[scenario])
                index = checkpoint['observation']['frameId'] - 1
                if scenario == 'stale-closed-frame': frames[index]['terminalUiRevision'] -= 1
                else:
                    pane, witness = states[index]['pane'], frames[index]['terminalPanes'][0]
                    key, value = {'changed-resize-lease': ('lease', 9), 'reopened-old-lease': ('lease', 2),
                                  'reopened-foreign-activation': ('activation', 9),
                                  'tab-stayed-put': ('focusedElement', 'base')}[scenario]
                    pane[key] = witness[key] = value
                    if scenario == 'tab-stayed-put':
                        witness['actualFocusedElement'] = value; witness['controls'][0]['key'] = value
                    checkpoint['pane'] = pane
                    checkpoint['observation'] = module.canonical_frame_snapshot([states[index]], [frames[index]], checkpoint['frameFloor'])
            elif scenario == 'wrong-tab-bytes':
                path = root / 'raw-canonical-tab-0.bin'; path.write_bytes(b'x')
                rows = [json.loads(line) for line in (root / 'inputs.jsonl').read_text().splitlines()]
                receipt = next(row for row in rows if row['inputFile'] == str(path))
                receipt.update(hex=b'x'.hex(), bytesSHA256=module.sha256(path))
                for row in checkpoints:
                    if row['action']['kind'] == 'input' and row['action']['receipt']['inputFile'] == str(path):
                        row['action']['receipt'] = receipt
                (root / 'inputs.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows))
            (root / 'canonical-ui-states.json').write_text(json.dumps(states))
            (root / 'canonical-checkpoints.json').write_text(json.dumps(checkpoints))
            (root / 'frames.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in frames))
            (root / 'debug.log').write_text(''.join('[ModsUI] ' + json.dumps({'event': 'publish',
                'revision': state['revision'], 'panes': [state['pane']] if state['pane'] else []}) + '\n' for state in states))
            checks = module.canonical_ui_checks(root)
            if all(checks.values()) != (scenario in ('valid', 'empty-button')): failures.append((scenario, checks))
    assert not failures, failures




def test_retained_canonical_git_wrapper_matches_actual_host_argv_only():
    module = load_driver()
    from unittest.mock import patch
    with tempfile.TemporaryDirectory(prefix='canonical-git-argv-', dir='/private/tmp') as tmp:
        root = Path(tmp)
        project = root / 'project'; project.mkdir()
        # Pure fixture classification; /usr/bin/true is not native Git evidence.
        with patch.object(module.shutil, 'which', return_value='/usr/bin/true'):
            wrapper = module.create_canonical_terminal_git_wrapper(root) / 'git'
        actual = [
            '-c', 'core.hooksPath=/dev/null',
            '--git-dir=' + str(project / '.git'), '--work-tree=' + str(project),
            '--literal-pathspecs', '--no-optional-locks',
            '-c', 'diff.relative=false', '-c', 'core.quotePath=false',
            'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty',
            '--submodule=short', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/',
            '--raw', '-z', '-p', 'HEAD', '--', 'alpha.txt', 'omega.txt',
        ]
        sequences = [actual, [*actual[:-2], 'omega.txt'], actual[2:],
                     [*actual[:1], 'core.hooksPath=/foreign', *actual[2:]],
                     [*actual[:2], '--git-dir=/foreign', *actual[3:]],
                     [*actual, '--extra'], [*actual[:-2], 'foreign.txt', 'omega.txt']]
        for index, argv in enumerate(sequences):
            subprocess.run([str(wrapper), *argv], cwd=project,
                env={'PATH': '/usr/bin:/bin', 'HOME': str(root)},
                check=True, capture_output=True, timeout=5)
            record = json.loads((root / 'canonical-git.jsonl').read_text().splitlines()[-1])
            assert record['matched'] is (index < 2), (index, record)
            assert record['argv'] == argv and record['cwd'] == str(project)


def test_retained_canonical_diff_accepts_real_local_command_message_envelope():
    module = load_driver()
    with tempfile.TemporaryDirectory(prefix='canonical-local-command-', dir='/private/tmp') as tmp:
        root = Path(tmp)
        server = module.MockOpenAIServer(root, 'terminal-canonical-diff')
        nonce = hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:24]
        prompt = f'RELEASE_CANONICAL_DIFF:{nonce}:omega'
        # Actual Native12 wire shape: processUserInput merges local /diff receipts
        # with the next user prompt; prior alpha tool calls precede this message.
        texts = [
            '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>\n',
            '<command-name>/diff</command-name>\n            <command-message>diff</command-message>\n            <command-args></command-args>\n',
            '<local-command-stdout>Diff panel shown</local-command-stdout>\n',
            prompt,
        ]
        user = {'type': 'message', 'role': 'user',
                'content': [{'type': 'input_text', 'text': text} for text in texts]}
        prior = [{'role': 'user', 'content': f'RELEASE_CANONICAL_DIFF:{nonce}:alpha'},
                 {'type': 'function_call', 'call_id': 'old-alpha', 'name': 'Read',
                  'arguments': '{}'},
                 {'type': 'function_call_output', 'call_id': 'old-alpha', 'output': 'alpha before'}]
        kind, _ = server.response_for({'input': [*prior, user]})
        assert kind == 'canonical-omega-read', kind
        for invalid in [
            [*texts, 'extra user instruction'],
            [texts[0], texts[2], prompt],
            [texts[0], texts[1].replace('/diff', '/foreign'), texts[2], prompt],
            [texts[0], texts[1], texts[2] + 'extra user instruction', prompt],
            [*texts[:-1], prompt.replace(nonce, 'foreign')],
            [*texts[:-1], '<system-reminder>metadata</system-reminder>extra user instruction', prompt],
        ]:
            message = {**user, 'content': [{'type': 'input_text', 'text': text} for text in invalid]}
            kind, _ = server.response_for({'input': [*prior, message]})
            assert kind == 'canonical-invalid', (kind, invalid)


def test_retained_canonical_continuation_preserves_order_and_prior_receipts():
    import copy
    module = load_driver()
    with tempfile.TemporaryDirectory(prefix='canonical-tail-order-') as tmp:
        root = Path(tmp).resolve()
        wire, debug = _canonical_wire_fixture(module, root)
        server = object.__new__(module.MockOpenAIServer)
        server.run_dir = root
        original = wire[4]['body']
        assert server.canonical_diff_response(original)[0] == 'canonical-alpha-completed'
        failures = []
        for scenario in ('write-before-read', 'read-result-lost', 'extra-tail-item'):
            body = copy.deepcopy(original)
            if scenario == 'write-before-read':
                body['input'][-4:] = body['input'][-2:] + body['input'][-4:-2]
            elif scenario == 'read-result-lost':
                body['input'][-3]['output'] = 'unrelated Read result'
            else:
                body['input'].append({'role': 'assistant', 'content': 'unowned continuation'})
            if server.canonical_diff_response(body)[0] != 'canonical-invalid':
                failures.append(scenario)
        for scenario in ('prior-read-rewritten', 'prior-user-rewritten'):
            changed = copy.deepcopy(wire)
            if scenario == 'prior-read-rewritten':
                changed[4]['body']['input'][-3]['output'] += '\nchanged after the Write request'
            else:
                changed[4]['body']['input'][0]['content'] = [
                    {'type': 'input_text', 'text': wire[3]['body']['input'][0]['content']},
                    {'type': 'input_text', 'text': '<system-reminder>rewritten context</system-reminder>'}]
            if all(module.canonical_wire_checks(root, changed, debug, '127.0.0.1:1').values()):
                failures.append(scenario)
        assert not failures, failures


def test_retained_canonical_final_snapshot_survives_registry_cleanup():
    from unittest.mock import Mock
    module = load_driver()
    with tempfile.TemporaryDirectory(prefix='canonical-server-close-') as tmp:
        root = Path(tmp).resolve()
        (root / 'run-metadata.json').write_text(json.dumps({'mock_openai': {'base_url': 'http://127.0.0.1:1'}}))
        (root / 'independent-pty-checks.json').write_text('{}')
        gate = object.__new__(module.BinaryGate)
        server = Mock()
        records = [{'sequence': 1}]
        server.snapshot.side_effect = lambda: list(records)
        gate.mock_servers = {root.name: server}
        gate.start = Mock(return_value=(root, 'unit-session', 'unit-target', False))
        gate.terminal_capture_boundary = Mock(return_value={'lastObservedFrameId': 0})
        gate.paste_bytes = Mock(side_effect=RuntimeError('no native process in lifecycle unit'))
        gate.debug = Mock(return_value='')
        gate.required_assertion = Mock(return_value={'validation_verdict': 'failed'})
        gate.record = Mock()
        gate.cleanup_passed = Mock(return_value=True)
        def close(*args):
            assert gate.mock_servers.pop(root.name) is server
            records.append({'sequence': 2, 'response_kind': 'last-request-during-close'})
            return {}
        gate.close = Mock(side_effect=close)
        with patch.object(module, 'canonical_wire_checks', return_value={'wire': False}) as check:
            gate.terminal_canonical_diff()
        assert not gate.mock_servers
        check.assert_called_once_with(root, records, '', '127.0.0.1:1')
        assert json.loads((root / 'canonical-wire.json').read_text()) == records
        gate.record.assert_called_once()


def test_retained_canonical_diff_rejects_unpaired_or_changed_tool_calls():
    module = load_driver()
    with tempfile.TemporaryDirectory(prefix='canonical-wire-red-', dir='/private/tmp') as tmp:
        root = Path(tmp)
        server = module.MockOpenAIServer(root, 'terminal-canonical-diff')
        nonce = hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:24]
        user = {'role': 'user', 'content': f'RELEASE_CANONICAL_DIFF:{nonce}:alpha'}
        call = {'type': 'function_call', 'name': 'Read',
                'call_id': f'fc_canonical_alpha_read_{nonce}',
                'arguments': json.dumps({'file_path': str(root / 'project/alpha.txt')})}
        output = {'type': 'function_call_output', 'call_id': call['call_id'],
                  'output': 'alpha before'}
        for sequence in ([user, output], [user, output, call],
                         [user, {**call, 'name': 'Write'}, output],
                         [user, {**call, 'arguments': '{"file_path":"/foreign"}'}, output],
                         [user, call, call, output]):
            kind, _ = server.response_for({'input': sequence})
            assert kind == 'canonical-invalid', (kind, sequence)


def test_retained_canonical_diff_mock_requires_real_read_write_receipts():
    module = load_driver()
    with tempfile.TemporaryDirectory(prefix='canonical-mock-', dir='/private/tmp') as tmp:
        root = Path(tmp)
        server = module.MockOpenAIServer(root, 'terminal-canonical-diff')
        nonce = hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:24]
        prompt = f'RELEASE_CANONICAL_DIFF:{nonce}:alpha'
        body = {'input': [{'role': 'user', 'content': prompt}]}
        kind, payload = server.response_for(body)
        assert kind == 'canonical-alpha-read', (kind, payload)
        events = [json.loads(line[6:]) for line in payload.splitlines()
                  if line.startswith('data: ')]
        args = [event for event in events
                if event['type'] == 'response.function_call_arguments.done']
        assert len(args) == 1 and args[0]['name'] == 'Read'
        assert json.loads(args[0]['arguments']) == {
            'file_path': str(root / 'project/alpha.txt')}
        read_id = args[0]['call_id']
        read_call = {'type': 'function_call', 'name': 'Read', 'call_id': read_id,
                     'arguments': args[0]['arguments']}
        output = {'type': 'function_call_output', 'call_id': read_id,
                  'output': 'alpha before'}
        kind, payload = server.response_for({'input': [*body['input'], read_call, output]})
        assert kind == 'canonical-alpha-write', (kind, payload)
        events = [json.loads(line[6:]) for line in payload.splitlines()
                  if line.startswith('data: ')]
        args = [event for event in events
                if event['type'] == 'response.function_call_arguments.done']
        assert len(args) == 1 and args[0]['name'] == 'Write'
        arguments = json.loads(args[0]['arguments'])
        assert arguments == {'file_path': str(root / 'project/alpha.txt'),
                             'content': module.canonical_diff_content('alpha')}
        write_id = args[0]['call_id']
        write_call = {'type': 'function_call', 'name': 'Write', 'call_id': write_id,
                      'arguments': args[0]['arguments']}
        kind, _ = server.response_for({'input': [*body['input'], read_call, output, write_call, {
            'type': 'function_call_output', 'call_id': write_id,
            'output': 'successfully updated alpha.txt',
        }]})
        assert kind == 'canonical-alpha-completed', kind
        for invalid in [
            {'input': [*body['input'], read_call, {**output, 'output': 'Error: permission denied'}]},
            {'input': [*body['input'], read_call, output, output]},
            {'input': [{'role': 'user', 'content': 'RELEASE_CANONICAL_DIFF:foreign:alpha'}]},
        ]:
            kind, _ = server.response_for(invalid)
            assert kind == 'canonical-invalid', kind


def test_retained_stdout_mirror_never_proves_native_pty_physical_cells():
    module = load_driver()
    frames = [
        {'frameId': 1, 'columns': 110, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'files', 'alphaBody': True}},
        {'frameId': 2, 'columns': 110, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'detail', 'omegaFile': True, 'loading': True, 'omegaBody': False}},
        {'frameId': 3, 'columns': 110, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'detail', 'omegaFile': True, 'omegaBody': True}},
        {'frameId': 4, 'columns': 109, 'rows': 34, 'verdict': 'passed', 'semantic': {'diffMode': None}},
        {'frameId': 5, 'columns': 110, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'files', 'omegaFile': True, 'omegaBody': True}},
    ]
    report = {'verdict': 'passed', 'frameCount': len(frames), 'frames': frames,
              'sizeSequence': [{key: frame[key] for key in ('columns', 'rows', 'frameId')}
                               for frame in (frames[0], frames[3], frames[4])]}
    checks = module.terminal_frame_report_checks(report)
    assert checks.get('frame_physical') is not True, checks

def test_retained_process_spawn_real_entry_is_required_for_its_runtime_and_validator_paths():
    module = load_driver()
    for path in [
        'src/services/mods/hostOperations.ts', 'src/services/mods/runtime.ts',
        'src/services/mods/dispatch.ts', 'src/services/mods/protocol.ts',
        'src/services/mods/loader.ts', 'src/services/mods/environment.ts',
        'src/services/mods/worker.ts', 'src/services/mods/testing/runner.ts',
        'scripts/validate-mods-process-spawn.py', 'scripts/linux-sandbox-exec.py',
    ]:
        assert 'mods-process-spawn' in module.required_targets_for_paths([path]), path


def test_retained_process_spawn_closed_receipts_cannot_pass_without_their_child_and_stream_contracts():
    spec = importlib.util.spec_from_file_location('process_spawn_probe', SCRIPTS_DIR.parents[3] / 'scripts/validate-mods-process-spawn.py')
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    fixture = json.loads((SCRIPTS_DIR.parents[3] / 'tests/fixtures/mods-process-spawn-official-293.json').read_text())['observations']
    assert all(probe.process_spawn_checks(fixture).values())
    for field in ['caseResults', 'children']:
        changed = json.loads(json.dumps(fixture))
        changed[field] = changed[field][:-1]
        assert not all(probe.process_spawn_checks(changed).values()), field
    for field in ['normalExitPassed', 'childrenGone', 'binaryUnchanged', 'socketReleased']:
        changed = json.loads(json.dumps(fixture))
        changed[field] = False
        assert not all(probe.process_spawn_checks(changed).values()), field
    for case, field, value in [('pending','receiptState','rejected'),('before','resultState','fulfilled'),('normal','receipt',{'code':0,'signal':None}),('deny','chunks',[{'stream':'stdout','text':'obs:unexpected'}])]:
        changed = json.loads(json.dumps(fixture))
        next(row for row in changed['caseResults'] if row['case']==case)[field] = value
        assert not all(probe.process_spawn_checks(changed).values()), (case,field)
    with tempfile.TemporaryDirectory() as directory:
        root=Path(directory)
        (root/'evidence').mkdir()
        path=root/'evidence/result.json'
        path.write_text(json.dumps(fixture))
        held=hashlib.sha256(path.read_bytes()).hexdigest()
        path.write_text(json.dumps({**fixture,'childrenGone':False}))
        try:
            probe.recheck_process_spawn_report(root,held,'held-binary')
        except ValueError as error:
            assert 'closed report changed' in str(error)
        else:
            raise AssertionError('rewritten closed report was accepted')



def test_retained_process_spawn_final_rechecks_all_registered_originals_and_exact_assertion():
    module = load_driver()
    probe_path = SCRIPTS_DIR.parents[3] / 'scripts/validate-mods-process-spawn.py'
    spec = importlib.util.spec_from_file_location('process_spawn_final_probe', probe_path)
    probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
    fixture = json.loads((SCRIPTS_DIR.parents[3] / 'tests/fixtures/mods-process-spawn-official-293.json').read_text())['observations']
    failures = []
    for scenario in ('valid', 'unlisted-original-changed', 'renamed-id', 'missing-hashes', 'original-proof-omitted', 'report-rewritten-and-rehashed', 'binary-rebound', 'probe-rebound'):
        with tempfile.TemporaryDirectory(prefix='spawn-final-closure-unit-') as tmp:
            root = Path(tmp).resolve(); native = root / 'native'; native.mkdir()
            def write(relative, data):
                path = native / relative; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data); return path
            binary = write('bin/claude', b'controlled unit binary, not a native run')
            binary_sha = module.sha256(binary)
            report = json.loads(json.dumps(fixture))
            report.update(binarySHA256=binary_sha, originalBinarySHA256=binary_sha,
                          originalBinary=str(binary), driverSHA256=module.sha256(probe_path), inputs=[])
            debug = ''.join('SPAWN-ORACLE:'+json.dumps(row)+'\n' for row in report['caseResults'])
            debug += ''.join('SPAWN-NEXT:'+json.dumps({'case':case,'origin':{'plugin':'spawn-oracle-author','tier':'user'},'receipt':{'value':{'code':7,'signal':None}}})+'\n' for case in ('normal','twice','afterdeny'))
            write('evidence/debug.log', debug.encode())
            write('evidence/pty.raw', b'controlled unit transcript')
            write('evidence/driver-used.py', probe_path.read_bytes())
            write('evidence/inputs.jsonl', b'')
            write('cwd/children.jsonl', ''.join(json.dumps(row)+'\n' for row in report['children']).encode())
            extra = write('plugin/hooks/register.js', b'controlled original author module')
            report['artifactsSHA256'] = {str(path.relative_to(native)):module.sha256(path) for path in native.rglob('*') if path.is_file()}
            report_path = write('evidence/result.json', json.dumps(report).encode())
            held = module.sha256(report_path)
            checks = {'foreground_native_exit':True, **probe.recheck_process_spawn_report(native,held,binary_sha), 'closed_originals_rechecked':True}
            assert all(checks.values()), checks
            checks_path = root / 'process-spawn-checks.json'; checks_path.write_text(json.dumps({'checks':checks,'held_report_sha256':held}))
            stdout = root / 'stdout.txt'; stdout.write_text(json.dumps({'reportSHA256':held}))
            stderr = root / 'stderr.txt'; stderr.write_text('')
            proofs = [checks_path,stdout,stderr,report_path,*(native / name for name in report['artifactsSHA256'])]
            assertion = {'assertion_id':'mods-process-spawn-real-author','source_run':root.name,
                         'runtime_state':'done','validation_verdict':'passed',
                         'required_evidence':[str(path) for path in proofs],
                         'observed_evidence_paths':[str(path) for path in proofs],
                         'evidence_sha256':{str(path):module.sha256(path) for path in proofs}}
            metadata = {'label':'mods-process-spawn','source_run':root.name,'driver_run':'unit-driver',
                        'evidence_dir':str(root),'binary':str(binary),'binary_sha256':binary_sha,
                        'process_spawn_root':str(native),'process_spawn_report_sha256':held,
                        'process_spawn_probe_sha256':module.sha256(probe_path),
                        'process_spawn_evidence_sha256':assertion['evidence_sha256'].copy()}
            path = root / 'run-metadata.json'; path.write_text(json.dumps(metadata))
            registered = {str(root):path.read_text()}
            # The old method's narrow proof roster omits the author module. This scenario
            # preserves that roster and mutates only a report-listed original.
            if scenario=='unlisted-original-changed':
                keep=[checks_path,stdout,stderr,report_path,native/'evidence/debug.log',native/'evidence/pty.raw',native/'evidence/inputs.jsonl',native/'evidence/driver-used.py',native/'cwd/children.jsonl']
                assertion['required_evidence']=assertion['observed_evidence_paths']=[str(item) for item in keep]
                assertion['evidence_sha256']={str(item):module.sha256(item) for item in keep}
                metadata['process_spawn_evidence_sha256']=assertion['evidence_sha256'].copy()
                path.write_text(json.dumps(metadata)); registered={str(root):path.read_text()}
                extra.write_bytes(b'changed after immediate recheck')
            elif scenario=='renamed-id': assertion['assertion_id']='borrowed-green'
            elif scenario=='missing-hashes': assertion.pop('evidence_sha256')
            elif scenario=='original-proof-omitted':
                assertion['required_evidence'].remove(str(extra)); assertion['observed_evidence_paths'].remove(str(extra)); assertion['evidence_sha256'].pop(str(extra))
            elif scenario=='report-rewritten-and-rehashed':
                report['childrenGone']=False; report_path.write_text(json.dumps(report)); assertion['evidence_sha256'][str(report_path)]=module.sha256(report_path)
            elif scenario=='binary-rebound': metadata['binary_sha256']='0'*64; path.write_text(json.dumps(metadata)); registered={str(root):path.read_text()}
            elif scenario=='probe-rebound': metadata['process_spawn_probe_sha256']='0'*64; path.write_text(json.dumps(metadata)); registered={str(root):path.read_text()}
            run={'label':'mods-process-spawn','evidence_dir':str(root),'driver_run':'unit-driver','validation_verdict':'passed','assertions':[assertion]}
            passed=module.validate_required_target_results({'mods-process-spawn'},[run],registered)['passed']
            if passed != (scenario=='valid'): failures.append(scenario)
    assert not failures, failures

def test_retained_capture_roster_uses_prepared_protocol_not_report_labels():
    module = load_driver()
    native = {'capture': {'nativeJournal': True, 'captureId': 'owned'}}
    selected = module.terminal_capture_required_files(native)
    assert len(selected) == 26
    assert {'registration.json', 'producer-expected-native.json', 'journal.bin',
            'observer.dylib', 'native-observer.json', 'observer-compile.log'} <= selected
    assert not {'native-pty-initial.json', 'native-pty-eof.json', 'native-input.jsonl'} & selected
    for label in (None, 'legacy', 'unknown'):
        assert module.terminal_capture_required_files({**native, 'backend': label}) == selected
    legacy = {'capture': {'nativeJournal': False, 'captureId': 'owned'}}
    assert module.terminal_capture_required_files(legacy) == module.TERMINAL_CAPTURE_FILES
    assert module.terminal_capture_required_files({**legacy, 'backend': 'native-shared-slot-v1'}) == module.TERMINAL_CAPTURE_FILES


def test_retained_linux_capture_roster_follows_the_prepared_observer_platform():
    module = load_driver()
    linux = {'capture': {'nativeJournal': True, 'captureId': 'owned', 'observer': 'linux-seccomp-ptrace-v1'}}
    darwin = module.terminal_capture_required_files({'capture': {'nativeJournal': True, 'captureId': 'owned'}})
    selected = module.terminal_capture_required_files(linux)
    assert selected == (darwin - {'observer.dylib'}) | {'observer.so', 'observer-exec'}
    assert len(selected) == 27 and 'observer.dylib' not in selected
    for label in (None, 'legacy', 'unknown'):
        assert module.terminal_capture_required_files({**linux, 'backend': label}) == selected
    # A capture never mixes protocols: only a native Linux capture may name its observer.
    for invalid in ({'capture': {**linux['capture'], 'observer': value}}
                    for value in (None, '', 'darwin-interpose-v1', 'linux-seccomp-ptrace-v2')):
        assert module.terminal_capture_required_files(invalid) is None, invalid
    assert module.terminal_capture_required_files(
        {'capture': {**linux['capture'], 'nativeJournal': False}}) is None
    assert module.NATIVE_GEOMETRY_METHOD == ('native-driver-linux-frame-geometry-v2'
        if sys.platform.startswith('linux') else 'native-driver-mach-frame-geometry-v2')


def test_retained_native_exit_receipts_require_the_platform_tracer_close():
    module = load_driver()
    digest = 'a' * 64
    with tempfile.TemporaryDirectory(prefix='native-exit-platform-') as directory:
        run = Path(directory)
        darwin = {'nativeJournal': True, 'captureId': 'owned'}
        linux = {**darwin, 'observer': 'linux-seccomp-ptrace-v1'}
        tracer = {'observer': 'linux-seccomp-ptrace-v1', 'tracerPid': 43, 'tracerExitCode': 0, 'tracerReaped': True}
        closes = {'nativeClose': {'method': 'owned-broker-closed-native-v1'}, 'ioClose': {'method': 'owned-broker-closed-io-v1'}}
        closed = {'backend': 'native-shared-slot-v1', 'captureId': 'owned', 'childPid': 42, 'childExitCode': 0,
                  'childReaped': True, 'physicalEof': True, 'normalCompletion': True, 'failure': None,
                  'signalsSent': [], 'cleanupErrors': [], **closes}
        producer = {'backend': 'native-shared-slot-v1', 'captureId': 'owned', 'childPid': 42,
                    'binarySha256': digest, **closes}
        def receipts(cleanup):
            for name, value in (('start.json', {'childPid': 42, 'childPgid': 42, 'binarySha256': digest}),
                                ('cleanup.json', cleanup), ('broker-cleanup.json', cleanup),
                                ('producer-expected-native.json', producer)):
                path = run / name
                path.unlink(missing_ok=True)
                path.write_text(json.dumps(value))
                path.chmod(0o600)
        for capture, cleanup, expected in [
                (darwin, closed, True), (linux, {**closed, **tracer}, True),
                (linux, closed, False), (darwin, {**closed, **tracer}, False),
                (linux, {**closed, **tracer, 'tracerExitCode': 3}, False),
                (linux, {**closed, **tracer, 'tracerExitCode': None}, False),
                (linux, {**closed, **tracer, 'tracerReaped': False}, False),
                (linux, {**closed, **tracer, 'tracerPid': None}, False),
                (linux, {**closed, **tracer, 'observer': 'darwin-interpose-v1'}, False)]:
            receipts(cleanup)
            assert module.terminal_native_producer_exit_passed(run, capture, digest) is expected, (capture, cleanup)
        launch = {'run': str(run.resolve()), 'binarySha256': digest, 'capture': {**linux, 'wrapper': 'held'}}
        assert module.terminal_native_exit_identity(run, launch, digest)['capture'] == linux
        assert module.terminal_native_exit_identity(run, {**launch, 'capture': darwin}, digest)['capture'] == darwin


def test_retained_capture_roster_missing_or_ambiguous_intent_fails_closed():
    module = load_driver()
    for invalid in (None, {}, {'capture': {}}, {'capture': {'nativeJournal': True}},
                    *({'capture': {'nativeJournal': value, 'captureId': 'owned'}}
                      for value in (None, 0, 1, 'true', 'false')),
                    *({'capture': {'nativeJournal': True, 'captureId': value}}
                      for value in (None, '', 1))):
        assert module.terminal_capture_required_files(invalid) is None, invalid
    for target in module.TERMINAL_ACCEPTANCE:
        assert {'bounded_terminal_evidence', 'full_terminal_coverage'} <= module.TERMINAL_REQUIRED_CHECKS[target]


if __name__ == '__main__':
    main()
