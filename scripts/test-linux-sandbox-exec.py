"""Linux process isolation helper: real namespaces, Landlock and seccomp on this host."""
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest

HELPER = Path(__file__).with_name('linux-sandbox-exec.py')
PYTHON = '/usr/bin/python3'
UNAVAILABLE = 'Linux isolation unavailable: '
NO_FALLBACK = '; no unisolated fallback'

# Runs inside the sandbox; every attempt reports whether it got through.
ESCAPES = r'''
import ctypes, json, os, socket, subprocess, sys
spec = json.loads(sys.argv[1]); out = {}
def attempt(name, action):
    try:
        out[name] = {'escaped': bool(action())}
    except OSError as error:
        out[name] = {'escaped': False, 'errno': error.errno}
def write(path):
    with open(path, 'x') as stream: stream.write('escaped')
    os.unlink(path); return True
def bind(path):
    with socket.socket(socket.AF_UNIX) as server: server.bind(path)
    os.unlink(path); return True
def connect(family, address):
    with socket.socket(family, socket.SOCK_STREAM) as client:
        client.settimeout(3); client.connect(address); return True
def read(path):
    with open(path, 'rb') as stream: return stream.read() != b''
def run(path):
    return subprocess.run([path], capture_output=True, timeout=5).returncode == 0
def dns():
    socket.setdefaulttimeout(5); return bool(socket.getaddrinfo('example.com', 443))
def umount(path):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.umount2(path.encode(), 2) == 0: return True
    raise OSError(ctypes.get_errno(), 'umount2')
attempt('write_outside_run', lambda: write(spec['outside'] + '/escape'))
attempt('write_tmp', lambda: write('/tmp/linux-sandbox-escape-%d' % os.getpid()))
attempt('bind_socket_outside', lambda: bind(spec['outside'] + '/escape.sock'))
attempt('bind_socket_tmp', lambda: bind('/tmp/linux-sandbox-escape-%d.sock' % os.getpid()))
attempt('connect_external_ip', lambda: connect(socket.AF_INET, ('1.1.1.1', 443)))
attempt('connect_external_ipv6', lambda: connect(socket.AF_INET6, ('2606:4700:4700::1111', 443)))
attempt('connect_host_loopback', lambda: connect(socket.AF_INET, ('127.0.0.1', spec['port'])))
attempt('connect_host_abstract', lambda: connect(socket.AF_UNIX, spec['abstract']))
attempt('dns', dns)
attempt('read_hidden_marker', lambda: read(spec['marker']))
attempt('read_hidden_marker_via_proc_root', lambda: read('/proc/%d/root%s' % (spec['hostPid'], spec['marker'])))
attempt('read_env', lambda: read(spec['env']))
attempt('exec_hidden_tool', lambda: run(spec['tool']))
attempt('umount_hidden', lambda: umount(spec['hidden']))
def listing(path):
    try: return sorted(os.listdir(path))
    except OSError as error: return error.errno
status = dict(line.split(':\t', 1) for line in open('/proc/self/status').read().splitlines() if ':\t' in line)
out['identity'] = {'uid': os.getuid(), 'gid': os.getgid(), 'noNewPrivs': status['NoNewPrivs'].strip(),
                   'capEff': status['CapEff'].strip(), 'netns': os.readlink('/proc/self/ns/net'),
                   'mntns': os.readlink('/proc/self/ns/mnt'), 'pidns': os.readlink('/proc/self/ns/pid'),
                   'hiddenListing': listing(spec['hidden'])}
with open(spec['allowed'], 'x') as stream: stream.write('allowed')
print(json.dumps(out))
'''


@unittest.skipUnless(sys.platform == 'linux', 'Linux helper; other platforms are covered by test_non_linux_fails_closed')
class LinuxSandboxExecTest(unittest.TestCase):
    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix='linux-sandbox-test-', dir='/tmp')).resolve()
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.run_dir = self.scratch / 'run'
        self.run_dir.mkdir(mode=0o700)
        self.repo = self.scratch / 'repo'
        (self.repo / '.claude').mkdir(parents=True)
        (self.repo / '.claude/settings.json').write_text('{"secret": "repo-claude"}')
        (self.repo / '.env').write_text('ANTHROPIC_API_KEY=repo-env-secret\n')
        self.hidden = self.scratch / 'hidden-home'
        self.hidden.mkdir()
        self.marker = self.hidden / 'marker'
        self.marker.write_text('hidden-marker')
        self.tool = self.scratch / 'bin/secret-tool'
        self.tool.parent.mkdir()
        self.tool.write_text('#!/bin/sh\necho escaped\n')
        self.tool.chmod(0o755)
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(('127.0.0.1', 0)); self.listener.listen(8)
        self.addCleanup(self.listener.close)
        self.abstract = b'\0linux-sandbox-test-%d' % os.getpid()
        self.abstract_listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.abstract_listener.bind(self.abstract); self.abstract_listener.listen(8)
        self.addCleanup(self.abstract_listener.close)

    def policy(self, **changes):
        return {'runDir': str(self.run_dir), 'repo': str(self.repo), 'hideDirs': [str(self.hidden)],
                'hideExecutables': [str(self.tool)], 'bindReadOnly': [], 'bindReadWrite': [],
                'writeTrees': [], 'writeExisting': ['/dev/null'], 'network': {'mode': 'none'}, **changes}

    def helper(self, policy, argv, env=None, **kwargs):
        return subprocess.run([PYTHON, str(HELPER), '--policy', json.dumps(policy), '--', *argv],
                              capture_output=True, text=True, timeout=60,
                              env={'PATH': '/usr/bin:/bin', **(env or {})}, **kwargs)

    def escapes(self, policy):
        spec = {'outside': str(self.scratch), 'port': self.listener.getsockname()[1],
                'abstract': self.abstract.decode('latin-1'), 'marker': str(self.marker),
                'hostPid': os.getpid(), 'env': str(self.repo / '.env'), 'tool': str(self.tool),
                'hidden': str(self.hidden), 'allowed': str(self.run_dir / 'allowed.txt')}
        return self.helper(policy, [PYTHON, '-c', ESCAPES, json.dumps(spec)])

    def probe_report(self):
        path = self.run_dir / 'sandbox-probe.json'
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        return json.loads(path.read_text())

    def test_every_escape_attempt_fails_inside_and_in_the_helper_probe(self):
        completed = self.escapes(self.policy())
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        identity = result.pop('identity')
        escaped = {name for name, row in result.items() if row['escaped']}
        self.assertEqual(escaped, set(), result)
        self.assertEqual(len(result), 14)
        for name, row in result.items():
            if 'errno' in row:
                self.assertIsNotNone(row['errno'], name)  # a real kernel denial, not a client-side error
        # Network none blocks socket() itself, matching the macOS EPERM for localhost TCP.
        for name in ('connect_external_ip', 'connect_external_ipv6', 'connect_host_loopback'):
            self.assertEqual(result[name]['errno'], 1, name)
        self.assertEqual(identity['uid'], os.getuid())
        self.assertEqual(identity['gid'], os.getgid())
        self.assertEqual(identity['noNewPrivs'], '1')
        self.assertEqual(int(identity['capEff'], 16), 0)
        self.assertNotEqual(identity['netns'], os.readlink('/proc/self/ns/net'))
        self.assertNotEqual(identity['mntns'], os.readlink('/proc/self/ns/mnt'))
        self.assertEqual(identity['pidns'], os.readlink('/proc/self/ns/pid'))
        # Empty mode-000 tmpfs: no host entry is visible and, without capabilities, not even listable.
        self.assertEqual(identity['hiddenListing'], 13)
        self.assertEqual((self.run_dir / 'allowed.txt').read_text(), 'allowed')
        self.assertEqual(list(self.scratch.glob('escape*')), [])
        report = self.probe_report()
        self.assertTrue(report['ok'])
        attempts = {row['name']: row for row in report['attempts']}
        for name in ('write-outside-run', 'write-tmp', 'bind-socket-outside', 'connect-external-ip',
                     'connect-host-loopback', 'connect-host-abstract', 'read-hidden-marker',
                     'read-hidden-marker-via-proc-root', 'read-hidden-file', 'exec-hidden-tool',
                     'umount-hidden', 'hidden-dir-replaced', 'capabilities-dropped'):
            self.assertIn(name, attempts)
        self.assertFalse(any(row['escaped'] for row in report['attempts']), report)
        self.assertGreaterEqual(report['landlockABI'], 3)
        self.assertTrue(report['seccomp'])
        policy = json.loads((self.run_dir / 'sandbox.json').read_text())
        self.assertEqual(stat.S_IMODE((self.run_dir / 'sandbox.json').stat().st_mode), 0o600)
        effective = policy['effective']
        for path in ('/etc/claude-code', str(self.repo / '.claude'), str(self.hidden),
                     f'/run/user/{os.getuid()}', os.path.realpath(os.path.expanduser('~'))):
            self.assertIn(path, effective['hideDirs'])
        self.assertIn(str(self.repo / '.env'), effective['hideFiles'])
        self.assertIn(str(self.tool), effective['hideExecutables'])

    def test_repo_claude_and_env_are_hidden_even_inside_a_read_only_repo(self):
        script = ('import os,json\ntry: listing = os.listdir(%r)\nexcept OSError as error: listing = error.errno\n'
                  'print(json.dumps([listing, open(%r).read(), os.access(%r, os.W_OK)]))'
                  % (str(self.repo / '.claude'), str(self.repo / '.env'), str(self.repo)))
        completed = self.helper(self.policy(bindReadOnly=[str(self.repo)]), [PYTHON, '-c', script])
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout), [13, '', False])

    def test_loopback_mode_reaches_only_the_sandbox_loopback(self):
        script = r'''
import json, socket
server = socket.socket(); server.bind(('127.0.0.1', 0)); server.listen(1)
client = socket.create_connection(server.getsockname(), timeout=3)
try:
    socket.create_connection(('127.0.0.1', %d), timeout=3); host = True
except OSError as error:
    host = error.errno
print(json.dumps({'inside': True, 'host': host}))
''' % self.listener.getsockname()[1]
        completed = self.helper(self.policy(network={'mode': 'loopback'}), [PYTHON, '-c', script])
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertTrue(result['inside'])
        self.assertEqual(result['host'], 111)
        self.assertFalse(self.probe_report()['seccomp'])

    def test_outside_tmux_client_drives_inside_server_through_path_socket(self):
        tmux = shutil.which('tmux')
        self.assertIsNotNone(tmux, 'tmux is required for the owned socket contract')
        socket_root = Path(tempfile.mkdtemp(prefix='lsx-', dir='/tmp'))
        self.addCleanup(shutil.rmtree, socket_root, ignore_errors=True)
        path = str(socket_root / 's')
        policy = self.policy(bindReadWrite=[str(socket_root)], writeTrees=[str(socket_root)],
                             writeExisting=['/dev/null', '/dev/ptmx', '/dev/pts'])
        log = (self.run_dir / 'tmux.log').open('x')
        server = subprocess.Popen([PYTHON, str(HELPER), '--policy', json.dumps(policy), '--',
                                   tmux, '-D', '-S', path, '-f', '/dev/null'],
                                  stdout=log, stderr=log, env={'PATH': '/usr/bin:/bin', 'TERM': 'xterm-256color'},
                                  start_new_session=True)
        def client(*args):
            return subprocess.run([tmux, '-S', path, *args], capture_output=True, text=True, timeout=8)
        try:
            deadline = time.monotonic() + 15
            while not os.path.exists(path) and server.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue(stat.S_ISSOCK(os.lstat(path).st_mode), (self.run_dir / 'tmux.log').read_text())
            self.assertEqual(os.lstat(path).st_uid, os.getuid())
            created = client('new-session', '-d', '-s', 'probe', '-x', '80', '-y', '24',
                             'echo inside-pane; touch /tmp/pane-escape-%d; sleep 30' % os.getpid())
            self.assertEqual(created.returncode, 0, created.stderr)
            self.assertEqual(client('display-message', '-p', '#{pid}').stdout.strip(), str(server.pid))
            pane = int(client('display-message', '-p', '-t', 'probe', '#{pane_pid}').stdout.strip())
            self.assertNotEqual(os.readlink(f'/proc/{pane}/ns/net'), os.readlink('/proc/self/ns/net'))
            deadline = time.monotonic() + 5
            while 'inside-pane' not in client('capture-pane', '-p', '-t', 'probe').stdout and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertIn('inside-pane', client('capture-pane', '-p', '-t', 'probe').stdout)
            self.assertFalse(os.path.exists('/tmp/pane-escape-%d' % os.getpid()))
            self.assertTrue(self.probe_report()['ok'])
        finally:
            client('kill-server')
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(server.pid, 9); server.wait(timeout=5)
            log.close()

    def assert_fails_closed(self, completed, reason):
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn(UNAVAILABLE + reason, completed.stderr)
        self.assertIn(NO_FALLBACK, completed.stderr)
        self.assertFalse((self.run_dir / 'target-ran').exists())

    def target(self):
        return ['/usr/bin/touch', str(self.run_dir / 'target-ran')]

    def test_landlock_abi_below_three_fails_closed(self):
        completed = self.helper(self.policy(), self.target(), env={'LINUX_SANDBOX_EXEC_TEST_FAULT': 'landlock-abi-2'})
        self.assert_fails_closed(completed, 'Landlock ABI 2 < 3')

    def test_unshare_eperm_fails_closed(self):
        completed = self.helper(self.policy(), self.target(), env={'LINUX_SANDBOX_EXEC_TEST_FAULT': 'unshare-eperm'})
        self.assert_fails_closed(completed, 'unshare(user|mount|net) failed: [Errno 1]')

    def test_probe_escape_fails_closed_without_exec(self):
        completed = self.helper(self.policy(writeTrees=[str(self.scratch)]), self.target())
        self.assert_fails_closed(completed, 'sandbox probe escaped: write-outside-run, bind-socket-outside')
        report = self.probe_report()
        self.assertFalse(report['ok'])
        self.assertEqual([row['name'] for row in report['attempts'] if row['escaped']],
                         ['write-outside-run', 'bind-socket-outside'])
        self.assertEqual(list(self.scratch.glob('.sandbox-probe-*')), [])

    def test_existing_policy_record_is_never_overwritten(self):
        (self.run_dir / 'sandbox.json').write_text('{}')
        completed = self.helper(self.policy(), self.target())
        self.assert_fails_closed(completed, 'cannot record policy')
        self.assertEqual((self.run_dir / 'sandbox.json').read_text(), '{}')

    def test_invalid_policies_fail_closed(self):
        for policy, reason in [({**self.policy(), 'network': {'mode': 'host'}}, 'network.mode must be none or loopback'),
                               ({**self.policy(), 'runDir': 'relative'}, 'runDir must be an absolute directory'),
                               ({**self.policy(), 'unknown': True}, 'unknown policy keys: unknown')]:
            completed = self.helper(policy, self.target())
            self.assert_fails_closed(completed, reason)


class NonLinuxTest(unittest.TestCase):
    @unittest.skipIf(sys.platform == 'linux', 'covered by the Linux suite')
    def test_non_linux_fails_closed(self):
        completed = subprocess.run([sys.executable, str(HELPER), '--policy', '{}', '--', '/usr/bin/true'],
                                   capture_output=True, text=True, timeout=30)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn(UNAVAILABLE + 'platform is ' + sys.platform + NO_FALLBACK, completed.stderr)


if __name__ == '__main__':
    unittest.main()
