#!/usr/bin/env python3
import ast
import importlib.util
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile


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


def make_gate(module, repo, evidence, baseline_manifest, baseline_exists):
    gate = object.__new__(module.BinaryGate)
    gate.repo = repo
    gate.evidence_root = evidence
    gate.workflow_runs = repo / '.claude' / 'workflow-runs'
    gate.workflow_task_ids = set()
    gate.workflow_run_ids = set()
    gate.baseline = {
        'workflow_runs_exists': baseline_exists,
        'workflow_runs_manifest': baseline_manifest,
        'workflow_runs_sha256': module.tree_sha256(baseline_manifest),
    }
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


def assert_driver_behavior(module):
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

        (runs / 'unowned.json').write_text('unowned\n')
        result = module.BinaryGate.archive_and_remove_workflow_runs(gate)
        assert result['passed'] is False
        assert result['unowned_added_paths'] == ['unowned.json']
        assert (runs / 'unowned.json').is_file()

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
        assert result['passed'] is False
        assert result['state_before_cleanup']['modified_paths'] == ['existing.json']
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

        (repo / '.gitignore').write_text('ignored.txt\n')
        ignored = repo / 'ignored.txt'
        ignored.write_text('before\n')
        before = module.ignored_manifest(repo)
        ignored.write_text('after\n')
        after = module.ignored_manifest(repo)
        assert before.keys() == after.keys()
        assert module.tree_sha256(before) != module.tree_sha256(after)

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
        assert evidence['fetch']['complete'] is True
        assert evidence['verify']['complete'] is True
        assert evidence['synthesize']['complete'] is True
        web_tools = module.BinaryGate.tool_evidence(
            gate, run_dir, {'WebSearch', 'WebFetch'}
        )
        assert module.BinaryGate.deep_research_web_tools_complete(
            gate, web_tools
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
            gate, web_tools
        ) is False
        write_transcript(extra_path, [{
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{'type': 'text', 'text': '{}'}],
            },
        }])

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
        retry_meta = subagents / 'agent-fetch-1.meta.json'
        retry_meta.write_text(json.dumps({
            'agentId': 'agent-fetch-1',
            'description': 'deep-research: fetch 1/15 retry 1/1',
        }))
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['retry_logical_indexes'] == ['1']

        write_complete_workers()
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
        entries = deep_research_entries('fetch', 1)
        output = json.loads(entries[-1]['message']['content'][0]['text'])
        output['fetchedSource'] = output.pop('selectedSource')
        entries[-1]['message']['content'][0]['text'] = json.dumps(output)
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
        entries = deep_research_entries('fetch', 1)
        output = json.loads(entries[-1]['message']['content'][0]['text'])
        output['selectedSource']['rank'] = output['selectedSource'].pop('oneBasedRank')
        entries[-1]['message']['content'][0]['text'] = json.dumps(output)
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
        entries = deep_research_entries('fetch', 1)
        entries.append(entries[-1].copy())
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
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

    launcher = LAUNCHER_PATH.read_text()
    assert 'exec env -i' in launcher
    assert 'CLAUDE_CODE_USE_OPENAI=1' in launcher
    for name in module.AUTH_ENV_VARS:
        assert f'{name}=' not in launcher


def main():
    ast.parse(DRIVER_PATH.read_text())
    ast.parse(BASELINE_PATH.read_text())
    module = load_driver()
    assert_driver_behavior(module)
    print('test-release-driver.py passed')


if __name__ == '__main__':
    main()
