#!/usr/bin/env python3
import ast
import importlib.util
import json
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
from unittest.mock import patch
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

    assert module.required_targets_for_paths([
        'src/services/api/openai-compat.ts',
    ]) == {
        'effort-openai-responses-wire',
        'openai-responses-usage-error',
        'prompt-modes-cache-prefix',
    }
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
        'workflow-failure-detail',
        'coordinator-selector',
        'transcript-retention',
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
            'mock_server': {'stopped': True, 'thread_alive': False},
        }]
        assert gate.mock_servers == {}

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
                }

            def post_response(instructions):
                body = json.dumps({
                    'model': 'gpt-release-discovered',
                    'instructions': instructions,
                }).encode()
                response_request = Request(
                    f'{base_url}/v1/responses',
                    data=body,
                    method='POST',
                    headers={
                        'Authorization': f'Bearer {module.DUMMY_OPENAI_API_KEY}',
                        'Content-Type': 'application/json',
                    },
                )
                with urlopen(response_request, timeout=5) as response:
                    return response.read().decode()

            title_sse = post_response(module.TITLE_GENERATION_INSTRUCTION)
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

            first_sse = post_response('normal system prompt')
            assert 'response.function_call_arguments.done' in first_sse
            assert 'update-config' in first_sse

            second_sse = post_response('normal system prompt')
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
        finally:
            cleanup = server.stop()
        assert cleanup == {'stopped': True, 'thread_alive': False}

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
    assert module.submitted_input_pending('❯ \n') is False

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
    assert 'release-base-sha..HEAD' in code_review_prompt
    assert 'Do not widen the diff range' in code_review_prompt
    assert 'current changes' not in code_review_prompt
    assert 'src/tools/AgentTool' not in code_review_prompt
    assert 'src/tools/WorkflowTool' not in code_review_prompt
    assert 'src/tasks/LocalWorkflowTask' not in code_review_prompt
    assert 'src/utils/sessionStorage.ts' not in code_review_prompt

    planned = module.plan_targets(['team-concurrency'], {'workflow-failure-detail'})
    assert planned == [
        'agent-fg-bg',
        'nested-agent',
        'workflow',
        'deep-research',
        'code-review',
        'team-concurrency',
        'workflow-failure-detail',
    ]
    try:
        module.plan_targets(['workflow'], set())
    except ValueError as error:
        assert 'already included by default' in str(error)
    else:
        raise AssertionError('expected duplicate default target to fail')

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

        coverage = module.validate_required_target_results(
            required,
            [
                {
                    'label': target,
                    'validation_verdict': 'passed',
                    'evidence_dir': str(source_run),
                    'assertions': [
                        make_required_assertion(
                            source_run,
                            assertion_id=f'{target}-assertion',
                            evidence_name=f'{target}.txt',
                        )
                    ],
                }
                for target in required
            ],
        )
        assert coverage['passed'] is True
        assert coverage['missing_targets'] == []
        assert coverage['invalid_targets'] == []

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
    assert "def workflow_completion_proof(" in driver
    assert "def agent_completion_proof(" in driver
    assert "self.workflow_completion_proof(" in driver
    assert "self.agent_completion_proof(" in driver
    assert "The child must not call Agent or delegate" in driver
    assert "workflow did not reach a terminal status before timeout" in driver
    assert "'team-concurrency': self.team_concurrency" in driver
    assert "'workflow-retry-partial-failure': self.workflow_retry_partial_failure" in driver
    assert "'workflow-failure-detail': self.workflow_failure_detail" in driver
    assert "'coordinator-selector': self.coordinator_selector" in driver
    assert "'transcript-retention': self.transcript_retention" in driver
    assert "def team_concurrency(self):" in driver
    assert "def workflow_retry_partial_failure(self):" in driver
    assert "def workflow_failure_detail(self):" in driver
    assert "def coordinator_selector(self):" in driver
    assert "def transcript_retention(self):" in driver
    assert "def run_target(self, label, action):" in driver
    assert "result['repository_state_expected_workflow_artifacts']" in driver
    assert "result_label = 'inline-workflow' if target == 'workflow' else target" in driver
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
    assert "default targets always run" in driver

    assert "'effort-openai-responses-wire': self.effort_openai_responses_wire" in driver
    assert "'openai-responses-usage-error': self.openai_responses_usage_error" in driver
    assert "'model-discovery-picker': self.model_discovery_picker" in driver
    assert "'model-discovery-empty-picker': self.model_discovery_empty_picker" in driver
    assert "'first-party-bootstrap-picker': self.first_party_bootstrap_picker" in driver
    assert "'model-internal-update-config-skill': self.model_internal_update_config_skill" in driver
    assert "'prompt-modes-cache-prefix': self.prompt_modes_cache_prefix" in driver
    assert 'def effort_openai_responses_wire(self):' in driver
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

    for assertion_id in (
        'effort-all-configured-openai-wire',
        'effort-ultracode-openai-wire',
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
                    'x-client-request-id': 'cache-key',
                },
                'authorization': {'present': True, 'matches_dummy': True},
            }
            for _, expected in effort_cases
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
        effort_gate.assistant_text = lambda _: 'RELEASE_EFFORT_WIRE_OK'
        effort_gate.transcript = lambda _: 'Release validation reasoning marker.'
        effort_gate.close = lambda *args: {'stopped': True}
        effort_gate.cleanup_passed = lambda _: True
        effort_gate.record = recorded.append

        module.BinaryGate.effort_openai_responses_wire(effort_gate)

        assert recorded[0]['validation_verdict'] == 'passed'
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
        (config / '.claude.json').write_text(json.dumps({
            'additionalModelOptionsCache': [option],
        }))
        (run_dir / 'bootstrap-cache-seed.json').write_text(json.dumps({
            'additionalModelOptionsCache': [option],
            'additionalModelOptionsCacheKey': None,
        }))
        (run_dir / 'debug.log').write_text(
            '[Bootstrap] Skipped: Nonessential traffic disabled\n'
        )
        recorded = []
        first_party_gate = object.__new__(module.BinaryGate)
        first_party_gate.start = lambda _label: (
            run_dir,
            'first-party-session',
            'first-party-target',
            True,
        )
        first_party_gate.tmux = lambda *args, **_kwargs: subprocess.CompletedProcess(
            args, 0, '', ''
        )
        first_party_gate.send = lambda *_args: (_ for _ in ()).throw(AssertionError('unexpected model current command'))

        def capture_first_party(_target, path, **_kwargs):
            text = 'Select model\nRELEASE_FIRST_PARTY_BOOTSTRAP_MODEL ✔\n'
            path.write_text(text)
            return text

        first_party_gate.capture = capture_first_party
        first_party_gate.wait_until = lambda predicate, *_args: predicate()
        first_party_gate.debug = module.BinaryGate.debug.__get__(
            first_party_gate,
            module.BinaryGate,
        )
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
        assert recorded[0]['unkeyed_cache'] is True
        assert recorded[0]['startup_cache_used_without_fetch'] is True
        assert recorded[0]['picker_visible'] is True
        assert recorded[0]['current_model_confirmed'] is True

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
    assert 'set -- env -i' in launcher
    assert 'exec "$@"' in launcher
    assert 'CLAUDE_CODE_USE_OPENAI="${CC_VALIDATION_USE_OPENAI:-1}"' in launcher
    assert 'ANTHROPIC_API_KEY="$CC_VALIDATION_ANTHROPIC_API_KEY"' in launcher
    assert 'CLAUDE_LOCAL_OAUTH_API_BASE' not in launcher
    assert 'DISABLE_AUTOUPDATER=1' in launcher
    assert 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="${CC_VALIDATION_AGENT_TEAMS:-}"' in launcher
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
                (first_party_config / '.claude.json').read_text()
            )
            assert first_party_global_config['additionalModelOptionsCache'] == [{
                'value': 'release-first-party-bootstrap-model',
                'label': 'RELEASE_FIRST_PARTY_BOOTSTRAP_MODEL',
                'description': 'Release validation bootstrap model',
            }]
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


def main():
    ast.parse(DRIVER_PATH.read_text())
    ast.parse(BASELINE_PATH.read_text())
    module = load_driver()
    baseline_module = load_baseline()
    assert_driver_behavior(module, baseline_module)
    print('test-release-driver.py passed')


if __name__ == '__main__':
    main()
