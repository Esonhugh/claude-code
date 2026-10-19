#!/usr/bin/env python3
"""Run argv under Linux user+mount+net namespaces, Landlock and optional seccomp.

Usage: linux-sandbox-exec.py --policy '<json>' -- /absolute/target [args...]

The Linux counterpart of the macOS sandbox-exec profiles (see
docs/research/linux-release-gate-design-20261019.md section 1). Every failure
before execve is fatal: there is no unisolated fallback.
"""
import ctypes
import errno
import fcntl
import glob
import json
import os
import platform
import pwd
import secrets
import signal
import socket
import stat
import struct
import subprocess
import sys
import threading

# Test-only switch; each value can only force a failure, never relax isolation.
FAULT = os.environ.pop('LINUX_SANDBOX_EXEC_TEST_FAULT', '')
FAULTS = ('', 'unshare-eperm', 'landlock-abi-2')

CLONE_NEWNS, CLONE_NEWUSER, CLONE_NEWNET = 0x00020000, 0x10000000, 0x40000000
MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC = 1, 2, 4, 8
MS_REMOUNT, MS_BIND, MS_REC, MS_PRIVATE, MS_RELATIME = 32, 4096, 16384, 1 << 18, 1 << 21
MNT_DETACH = 2
PR_SET_PDEATHSIG, PR_CAPBSET_DROP, PR_SET_NO_NEW_PRIVS, PR_SET_SECCOMP, PR_CAP_AMBIENT = 1, 24, 38, 22, 47
PR_CAP_AMBIENT_CLEAR_ALL, SECCOMP_MODE_FILTER = 4, 2
SIOCGIFFLAGS, SIOCSIFFLAGS, IFF_UP = 0x8913, 0x8914, 1
SYS_LANDLOCK_CREATE_RULESET, SYS_LANDLOCK_ADD_RULE, SYS_LANDLOCK_RESTRICT_SELF = 444, 445, 446
SYS_IO_URING_SETUP = 425
LANDLOCK_CREATE_RULESET_VERSION, LANDLOCK_RULE_PATH_BENEATH = 1, 1
WRITE_FILE, TRUNCATE = 1 << 1, 1 << 14
# WRITE_FILE, REMOVE_DIR/FILE, MAKE_CHAR/DIR/REG/SOCK/FIFO/BLOCK/SYM, REFER, TRUNCATE.
# Reads, execute and IOCTL_DEV stay unhandled so PTY ioctls keep working.
WRITE_ACCESS = WRITE_FILE | sum(1 << bit for bit in range(4, 15))
# (AUDIT_ARCH, __NR_socket); io_uring_setup and the Landlock syscalls share numbers.
ARCHES = {'x86_64': (0xC000003E, 41), 'aarch64': (0xC00000B7, 198)}
KEYRING_TOOLS = ('secret-tool', 'gnome-keyring-daemon', 'kwallet-query')
TOOL_DIRS = ('/usr/bin', '/bin', '/usr/local/bin', '/usr/sbin', '/sbin')
POLICY_KEYS = {'runDir', 'repo', 'hideDirs', 'hideFiles', 'hideExecutables', 'bindReadOnly',
               'bindReadWrite', 'writeTrees', 'writeExisting', 'network', 'forwardLoopback'}


class Unavailable(Exception):
    pass


class RulesetAttr(ctypes.Structure):
    _fields_ = [('handled_access_fs', ctypes.c_uint64)]


class PathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]


class SockFilter(ctypes.Structure):
    _fields_ = [('code', ctypes.c_uint16), ('jt', ctypes.c_uint8), ('jf', ctypes.c_uint8), ('k', ctypes.c_uint32)]


class SockFprog(ctypes.Structure):
    _fields_ = [('len', ctypes.c_uint16), ('filter', ctypes.POINTER(SockFilter))]


class CapHeader(ctypes.Structure):
    _fields_ = [('version', ctypes.c_uint32), ('pid', ctypes.c_int)]


class CapData(ctypes.Structure):
    _fields_ = [('effective', ctypes.c_uint32), ('permitted', ctypes.c_uint32), ('inheritable', ctypes.c_uint32)]


libc = ctypes.CDLL(None, use_errno=True)


def check(result, what):
    if result < 0:
        raise Unavailable(f'{what} failed: {os.strerror(ctypes.get_errno())}')
    return result


def syscall(number, *args):
    libc.syscall.restype = ctypes.c_long
    return libc.syscall(ctypes.c_long(number), *args)


def prctl(option, arg=0, arg2=0):
    return libc.prctl(ctypes.c_int(option), ctypes.c_ulong(arg), ctypes.c_ulong(arg2), ctypes.c_ulong(0), ctypes.c_ulong(0))


def beneath(path, root):
    return path == root or path.startswith(root.rstrip('/') + '/')


def unique(paths):
    return list(dict.fromkeys(paths))


def effective_policy(policy):
    if not isinstance(policy, dict):
        raise Unavailable('policy must be a JSON object')
    unknown = sorted(set(policy) - POLICY_KEYS)
    if unknown:
        raise Unavailable('unknown policy keys: ' + ', '.join(unknown))
    run = policy.get('runDir')
    if not isinstance(run, str) or not os.path.isabs(run) or not os.path.isdir(run):
        raise Unavailable('runDir must be an absolute directory')
    network = policy.get('network')
    mode = network.get('mode') if isinstance(network, dict) else None
    if mode not in ('none', 'loopback'):
        raise Unavailable('network.mode must be none or loopback')
    forwards = policy.get('forwardLoopback', [])
    if (not isinstance(forwards, list) or not all(
            isinstance(row, dict) and set(row) == {'port', 'unix'} and type(row['port']) is int
            and 0 < row['port'] < 65536 and isinstance(row['unix'], str) and os.path.isabs(row['unix'])
            for row in forwards) or len({row['port'] for row in forwards}) != len(forwards)):
        raise Unavailable('forwardLoopback must list {port, unix} with unique ports and absolute unix paths')
    if forwards and mode != 'loopback':
        raise Unavailable('forwardLoopback requires network.mode loopback')
    for row in forwards:
        # The forwarder could never connect, and its clients would only see a reset.
        if len(os.fsencode(row['unix'])) > 107:
            raise Unavailable(f"forward target {row['unix']} is longer than the 107-byte unix socket limit")

    def paths(key):
        values = policy.get(key, [])
        if not isinstance(values, list) or not all(isinstance(v, str) and os.path.isabs(v) for v in values):
            raise Unavailable(key + ' must be a list of absolute paths')
        return [os.path.realpath(value) for value in values]

    run = os.path.realpath(run)
    uid = os.getuid()
    homes = {entry.pw_dir for entry in pwd.getpwall()} | set(glob.glob('/home/*'))
    claude = sorted({os.path.realpath(os.path.join(home, '.claude')) for home in homes if os.path.isabs(home)})
    hide_dirs = [os.path.realpath(pwd.getpwuid(uid).pw_dir), *(p for p in claude if os.path.lexists(p)),
                 '/etc/claude-code', f'/run/user/{uid}']
    hide_files = []
    if 'repo' in policy:
        if not isinstance(policy['repo'], str) or not os.path.isabs(policy['repo']):
            raise Unavailable('repo must be an absolute path')
        repo = os.path.realpath(policy['repo'])
        hide_dirs.append(os.path.join(repo, '.claude'))
        hide_files.append(os.path.join(repo, '.env'))
    tools = [os.path.realpath(os.path.join(d, name)) for name in KEYRING_TOOLS for d in TOOL_DIRS
             if os.path.lexists(os.path.join(d, name))]
    effective = {
        'runDir': run,
        'hideDirs': unique([*hide_dirs, os.path.join(run, '.sandbox-probe-hidden'), *paths('hideDirs')]),
        'hideFiles': unique([*hide_files, *paths('hideFiles')]),
        'hideExecutables': unique([*tools, *paths('hideExecutables')]),
        'bindReadOnly': unique(paths('bindReadOnly')),
        'bindReadWrite': unique([run, *paths('bindReadWrite')]),
        'writeTrees': unique([run, *paths('writeTrees')]),
        'writeExisting': unique(paths('writeExisting')),
        'network': {'mode': mode},
        'forwardLoopback': [{'port': row['port'], 'unix': os.path.realpath(row['unix'])} for row in forwards],
    }
    hidden = {*effective['hideDirs'], *effective['hideFiles'], *effective['hideExecutables']}
    bound = {*effective['bindReadOnly'], *effective['bindReadWrite']}
    if '/' in hidden or hidden & bound:
        raise Unavailable('policy hides / or both hides and binds: ' + ', '.join(sorted(hidden & bound) or ['/']))
    return effective


def create_exclusive(path, data, label):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    except OSError as error:
        raise Unavailable(f'cannot record {label}: {error}') from error
    with os.fdopen(fd, 'w') as stream:
        stream.write(data)


def landlock_abi():
    if FAULT == 'landlock-abi-2':
        return 2
    return check(syscall(SYS_LANDLOCK_CREATE_RULESET, None, ctypes.c_long(0),
                         ctypes.c_long(LANDLOCK_CREATE_RULESET_VERSION)), 'Landlock ABI query')


def identity(path):
    try:
        info = os.stat(path)
    except OSError:
        return None
    return (info.st_dev, info.st_ino)


def prepare_host(effective):
    """Everything that must be opened or observed from the host view before unshare."""
    hidden = {path: identity(path)
              for path in [*effective['hideDirs'], *effective['hideFiles'], *effective['hideExecutables']]}
    token = secrets.token_hex(16)
    marker_dir = os.path.join(effective['runDir'], '.sandbox-probe-hidden')
    os.mkdir(marker_dir, 0o700)
    marker = os.path.join(marker_dir, 'marker')
    create_exclusive(marker, token, 'probe marker')
    hidden[marker_dir] = identity(marker_dir)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(('127.0.0.1', 0))
    listener.listen(8)
    abstract = b'\0linux-sandbox-exec-%d-%s' % (os.getpid(), token.encode())
    abstract_listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    abstract_listener.bind(abstract)
    abstract_listener.listen(8)
    # The negative probes are meaningful only if these endpoints work from the host view.
    for family, address in ((socket.AF_INET, listener.getsockname()), (socket.AF_UNIX, abstract)):
        with socket.socket(family, socket.SOCK_STREAM) as client:
            client.settimeout(3)
            client.connect(address)
    with open(marker) as stream:
        if stream.read() != token:
            raise Unavailable('probe marker is unreadable from the host view')
    return {'hidden': hidden, 'token': token, 'marker': marker, 'listeners': [listener, abstract_listener],
            'port': listener.getsockname()[1], 'abstract': abstract, 'hostPid': os.getppid(), 'cwd': os.getcwd()}


def enter_namespaces():
    uid, gid = os.getuid(), os.getgid()
    if FAULT == 'unshare-eperm':
        code = errno.EPERM
    else:
        code = 0 if libc.unshare(ctypes.c_int(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWNET)) == 0 else ctypes.get_errno()
    if code:
        raise Unavailable(f'unshare(user|mount|net) failed: [Errno {code}] {os.strerror(code)}')
    try:
        for name, value in (('setgroups', 'deny'), ('uid_map', f'{uid} {uid} 1\n'), ('gid_map', f'{gid} {gid} 1\n')):
            with open('/proc/self/' + name, 'w') as stream:
                stream.write(value)
    except OSError as error:
        raise Unavailable(f'uid_map write failed: {error}') from error


def mount(source, target, fstype, flags, data=None):
    encode = lambda value: None if value is None else value.encode()
    libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]
    check(libc.mount(encode(source), encode(target), encode(fstype), flags, encode(data)), f'mount {target}')


def preserved_flags(path):
    flags = os.statvfs(path).f_flag
    pairs = ((os.ST_NOSUID, MS_NOSUID), (os.ST_NODEV, MS_NODEV), (os.ST_NOEXEC, MS_NOEXEC),
             (os.ST_NOATIME, 1024), (os.ST_NODIRATIME, 2048), (os.ST_RELATIME, MS_RELATIME))
    return sum(mount_flag for statvfs_flag, mount_flag in pairs if flags & statvfs_flag)


def apply_mounts(effective, host):
    mount(None, '/', None, MS_REC | MS_PRIVATE)
    binds = [*effective['bindReadOnly'], *effective['bindReadWrite']]
    # Opened inside the new mount namespace (a bind source must belong to it), before anything is hidden.
    try:
        sources = {path: os.open(path, os.O_PATH | os.O_CLOEXEC) for path in binds}
    except OSError as error:
        raise Unavailable(f'cannot open bind source: {error}') from error
    entries = [*((p, 0, 'tmpfs') for p in effective['hideDirs']),
               *((p, 0, 'null') for p in [*effective['hideFiles'], *effective['hideExecutables']]),
               *((p, 1, 'ro') for p in effective['bindReadOnly']), *((p, 1, 'rw') for p in effective['bindReadWrite'])]
    # Shallow first, so binds re-expose paths inside a hidden tree and deeper hides re-cover them.
    entries.sort(key=lambda entry: (entry[0].count('/'), entry[1]))
    tmpfs, actions = [], []
    for path, _, kind in entries:
        if kind in ('tmpfs', 'null'):
            if not os.path.lexists(path):
                covered = any(beneath(path, root) for root in tmpfs)
                if host['hidden'][path] is not None and not covered:
                    raise Unavailable(f'{path} vanished before it could be hidden')
                actions.append({'path': path, 'action': 'covered' if covered else 'absent'})
                continue
            if kind == 'tmpfs':
                # Search-only (not listable) when a bind below must stay reachable without capabilities.
                mode = '111' if any(b != path and beneath(b, path) for b in binds) else '000'
                mount('tmpfs', path, 'tmpfs', MS_NOSUID | MS_NODEV | MS_NOEXEC, f'mode={mode},size=64k')
                tmpfs.append(path)
                actions.append({'path': path, 'action': 'tmpfs', 'mode': mode})
            else:
                mount('/dev/null', path, None, MS_BIND)
                actions.append({'path': path, 'action': 'dev-null'})
            continue
        if not os.path.lexists(path):
            root = next((r for r in tmpfs if beneath(path, r)), None)
            if root is None:
                raise Unavailable(f'bind target {path} is missing')
            parts = os.path.relpath(path, root).split('/')
            for index in range(1, len(parts)):
                os.makedirs(os.path.join(root, *parts[:index]), mode=0o111, exist_ok=True)
            if stat.S_ISDIR(os.fstat(sources[path]).st_mode):
                os.mkdir(path, 0o111)
            else:
                os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0))
        mount(f'/proc/self/fd/{sources[path]}', path, None, MS_BIND | MS_REC)
        if kind == 'ro':
            mount(None, path, None, MS_REMOUNT | MS_BIND | MS_RDONLY | preserved_flags(path))
        actions.append({'path': path, 'action': 'bind-' + kind})
    for root in tmpfs:
        mount(None, root, None, MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC)
    for fd in sources.values():
        os.close(fd)
    try:
        os.chdir(host['cwd'])  # re-resolve the working directory through the new mounts
    except OSError as error:
        raise Unavailable(f'working directory is hidden: {error}') from error
    return actions


def bring_up_loopback():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as control:
            flags = struct.unpack_from('16sh', fcntl.ioctl(control, SIOCGIFFLAGS, struct.pack('16sh22x', b'lo', 0)))[1]
            fcntl.ioctl(control, SIOCSIFFLAGS, struct.pack('16sh22x', b'lo', flags | IFF_UP))
            flags = struct.unpack_from('16sh', fcntl.ioctl(control, SIOCGIFFLAGS, struct.pack('16sh22x', b'lo', 0)))[1]
    except OSError as error:
        raise Unavailable(f'cannot bring up lo: {error}') from error
    if not flags & IFF_UP:
        raise Unavailable('cannot bring up lo: flag not set')


def relay(source, target):
    try:
        while data := source.recv(65536):
            target.sendall(data)
        target.shutdown(socket.SHUT_WR)
    except OSError:
        for endpoint in (source, target):
            try:
                endpoint.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def relay_connection(client, path):
    with client, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as upstream:
        try:
            upstream.connect(path)
        except OSError:
            return
        reverse = threading.Thread(target=relay, args=(upstream, client), daemon=True)
        reverse.start()
        relay(client, upstream)
        reverse.join()


def serve_forward(listener, path, parent):
    """Forwarder child: off the terminal, without write access or capabilities, killed with the target."""
    os.setsid()
    check(prctl(PR_SET_PDEATHSIG, signal.SIGKILL), 'PR_SET_PDEATHSIG')
    if os.getppid() != parent:
        return
    null = os.open('/dev/null', os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    for fd in map(int, os.listdir('/proc/self/fd')):
        if fd > 2 and fd != listener.fileno():
            try:
                os.close(fd)
            except OSError:
                pass
    restrict_writes({'writeTrees': [], 'writeExisting': []})
    drop_capabilities()
    while True:
        client, _ = listener.accept()
        threading.Thread(target=relay_connection, args=(client, path), daemon=True).start()


def start_forwarders(effective):
    """Inside the new netns, 127.0.0.1:port relays to a host unix socket such as a loopback provider's."""
    started = []
    for row in effective['forwardLoopback']:
        try:
            if not stat.S_ISSOCK(os.stat(row['unix']).st_mode):
                raise Unavailable(f'forward target {row["unix"]} is not a unix socket')
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.bind(('127.0.0.1', row['port']))
            listener.listen(64)
        except OSError as error:
            raise Unavailable(f'cannot forward 127.0.0.1:{row["port"]}: {error}') from error
        parent = os.getpid()
        child = os.fork()
        if child == 0:
            try:
                serve_forward(listener, row['unix'], parent)
            finally:
                os._exit(1)
        listener.close()
        started.append({**row, 'pid': child})
    return started


def restrict_writes(effective):
    attr = RulesetAttr(WRITE_ACCESS)
    ruleset = check(syscall(SYS_LANDLOCK_CREATE_RULESET, ctypes.byref(attr), ctypes.c_long(ctypes.sizeof(attr)),
                            ctypes.c_long(0)), 'Landlock ruleset')
    rules = [*((p, WRITE_ACCESS) for p in effective['writeTrees']),
             *((p, WRITE_FILE | TRUNCATE) for p in effective['writeExisting'])]
    for path, access in rules:
        try:
            fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        except OSError as error:
            raise Unavailable(f'cannot open write root: {error}') from error
        rule = PathBeneathAttr(access, fd)
        check(syscall(SYS_LANDLOCK_ADD_RULE, ctypes.c_long(ruleset), ctypes.c_long(LANDLOCK_RULE_PATH_BENEATH),
                      ctypes.byref(rule), ctypes.c_long(0)), f'Landlock rule {path}')
        os.close(fd)
    check(prctl(PR_SET_NO_NEW_PRIVS, 1), 'PR_SET_NO_NEW_PRIVS')
    check(syscall(SYS_LANDLOCK_RESTRICT_SELF, ctypes.c_long(ruleset), ctypes.c_long(0)), 'Landlock restrict')
    os.close(ruleset)


def deny_inet_sockets():
    """socket(AF_INET|AF_INET6|AF_PACKET) and io_uring_setup -> EPERM; other ABIs denied outright."""
    if platform.machine() not in ARCHES:
        raise Unavailable('seccomp socket filter is unsupported on ' + platform.machine())
    arch, nr_socket = ARCHES[platform.machine()]
    load, jeq, jge, ret = 0x20, 0x15, 0x35, 0x06
    allow, deny = 0x7FFF0000, 0x00050000 | errno.EPERM
    program = [
        (load, 0, 0, 4), (jeq, 1, 0, arch), (ret, 0, 0, deny),
        (load, 0, 0, 0), (jge, 7, 0, 0x40000000), (jeq, 6, 0, SYS_IO_URING_SETUP), (jeq, 0, 4, nr_socket),
        (load, 0, 0, 16), (jeq, 3, 0, socket.AF_INET), (jeq, 2, 0, socket.AF_INET6), (jeq, 1, 0, socket.AF_PACKET),
        (ret, 0, 0, allow), (ret, 0, 0, deny),
    ]
    filters = (SockFilter * len(program))(*(SockFilter(code, jt, jf, k) for code, jt, jf, k in program))
    fprog = SockFprog(len(program), filters)
    check(prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.addressof(fprog)), 'seccomp filter')


def drop_capabilities():
    with open('/proc/sys/kernel/cap_last_cap') as stream:
        last = int(stream.read())
    for capability in range(last + 1):
        check(prctl(PR_CAPBSET_DROP, capability), 'PR_CAPBSET_DROP')
    check(prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL), 'ambient capability clear')
    header, data = CapHeader(0x20080522, 0), (CapData * 2)()
    check(libc.capset(ctypes.byref(header), data), 'capset')


def probe(effective, host):
    """Runs in a forked child under every restriction; each attempt must fail."""
    run, token = effective['runDir'], host['token']
    outside = os.path.dirname(run)
    attempts = []

    def attempt(name, target, action):
        try:
            escaped = bool(action())
            result = 'succeeded' if escaped else 'contained'
        except OSError as error:
            if error.errno is None:
                raise  # not a kernel denial; the probe itself is broken
            escaped, result = False, errno.errorcode.get(error.errno, str(error.errno))
        except subprocess.TimeoutExpired:
            escaped, result = True, 'TimeoutExpired'
        attempts.append({'name': name, 'target': target, 'escaped': escaped, 'result': result})

    def write(path):
        os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
        os.unlink(path)
        return True

    def bind(directory, name):
        os.chdir(directory)  # relative name keeps sun_path short for deep run directories
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(name)
            os.unlink(name)
            return True
        finally:
            os.chdir(host['cwd'])

    def connect(family, address):
        with socket.socket(family, socket.SOCK_STREAM) as client:
            client.settimeout(3)
            client.connect(address)
        return True

    def read(path, original):
        with open(path, 'rb') as stream:
            return stream.read() != b'' or identity(path) == original

    def umount(path):
        libc.umount2.argtypes = [ctypes.c_char_p, ctypes.c_int]
        if libc.umount2(path.encode(), MNT_DETACH) == 0:
            return True
        raise OSError(ctypes.get_errno(), 'umount2')

    def capabilities():
        with open('/proc/self/status') as stream:
            status = dict(line.split(':', 1) for line in stream.read().splitlines() if ':' in line)
        return status['NoNewPrivs'].strip() != '1' or any(int(status[key], 16) for key in ('CapEff', 'CapPrm', 'CapBnd', 'CapAmb'))

    attempt('write-outside-run', outside, lambda: write(os.path.join(outside, f'.sandbox-probe-{token}')))
    attempt('write-tmp', '/tmp', lambda: write(f'/tmp/.sandbox-probe-{token}'))
    attempt('bind-socket-outside', outside, lambda: bind(outside, f'.sandbox-probe-{token[:8]}.sock'))
    attempt('connect-external-ip', '1.1.1.1:443', lambda: connect(socket.AF_INET, ('1.1.1.1', 443)))
    attempt('connect-host-loopback', f'127.0.0.1:{host["port"]}', lambda: connect(socket.AF_INET, ('127.0.0.1', host['port'])))
    attempt('connect-host-abstract', 'abstract unix socket', lambda: connect(socket.AF_UNIX, host['abstract']))
    attempt('read-hidden-marker', host['marker'], lambda: read(host['marker'], None))
    attempt('read-hidden-marker-via-proc-root', f'/proc/{host["hostPid"]}/root{host["marker"]}',
            lambda: read(f'/proc/{host["hostPid"]}/root{host["marker"]}', None))
    present = lambda paths: [p for p in paths if host['hidden'][p] is not None]
    for path in present(effective['hideFiles']):
        attempt('read-hidden-file', path, lambda p=path: read(p, host['hidden'][p]))
    for path in present(effective['hideExecutables']):
        attempt('exec-hidden-tool', path, lambda p=path: subprocess.run(
            [p], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5) is not None)
    for name, paths in (('read-hidden-file', effective['hideFiles']), ('exec-hidden-tool', effective['hideExecutables'])):
        if not present(paths):
            attempts.append({'name': name, 'target': None, 'escaped': False, 'result': 'none-present'})
    for path in present(effective['hideDirs']):
        attempt('hidden-dir-replaced', path, lambda p=path: identity(p) == host['hidden'][p])
    attempt('umount-hidden', os.path.dirname(host['marker']), lambda: umount(os.path.dirname(host['marker'])))
    attempt('capabilities-dropped', '/proc/self/status', capabilities)
    return attempts


def run_probe(effective, host):
    reader, writer = os.pipe()
    child = os.fork()
    if child == 0:
        try:
            os.close(reader)
            payload = json.dumps(probe(effective, host)).encode()
            with os.fdopen(writer, 'wb') as stream:
                stream.write(payload)
            os._exit(0)
        except BaseException:
            os._exit(1)
    os.close(writer)
    with os.fdopen(reader, 'rb') as stream:
        payload = stream.read()
    _, status = os.waitpid(child, 0)
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        raise Unavailable('sandbox probe did not complete')
    return json.loads(payload)


def main(argv):
    if sys.platform != 'linux':
        raise Unavailable('platform is ' + sys.platform)
    if FAULT not in FAULTS:
        raise Unavailable('unknown test fault ' + FAULT)
    if len(argv) < 4 or argv[0] != '--policy' or argv[2] != '--':
        raise Unavailable('usage: linux-sandbox-exec.py --policy JSON -- argv...')
    try:
        policy = json.loads(argv[1])
    except ValueError as error:
        raise Unavailable(f'policy is not JSON: {error}') from error
    effective = effective_policy(policy)
    target = argv[3:]
    run = effective['runDir']
    create_exclusive(os.path.join(run, 'sandbox.json'),
                     json.dumps({'version': 1, 'input': policy, 'effective': effective}, indent=2) + '\n', 'policy')
    abi = landlock_abi()
    if abi < 3:
        raise Unavailable(f'Landlock ABI {abi} < 3')
    host = prepare_host(effective)
    enter_namespaces()
    mounts = apply_mounts(effective, host)
    bring_up_loopback()
    forwarders = start_forwarders(effective)
    restrict_writes(effective)
    seccomp = effective['network']['mode'] == 'none'
    if seccomp:
        deny_inet_sockets()
    drop_capabilities()
    attempts = run_probe(effective, host)
    escaped = [row['name'] for row in attempts if row['escaped']]
    create_exclusive(os.path.join(run, 'sandbox-probe.json'), json.dumps({
        'version': 1, 'ok': not escaped, 'uid': os.getuid(), 'gid': os.getgid(), 'landlockABI': abi,
        'seccomp': seccomp, 'networkMode': effective['network']['mode'], 'forwarders': forwarders,
        'mounts': mounts, 'attempts': attempts,
    }, indent=2) + '\n', 'probe')
    for listener in host['listeners']:
        listener.close()
    if escaped:
        raise Unavailable('sandbox probe escaped: ' + ', '.join(escaped))
    try:
        os.execv(target[0], target)
    except OSError as error:
        raise Unavailable(f'exec {target[0]} failed: {error}') from error


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as error:
        reason = str(error) if isinstance(error, Unavailable) else f'{type(error).__name__}: {error}'
        print(f'Linux isolation unavailable: {reason}; no unisolated fallback', file=sys.stderr, flush=True)
        sys.exit(1)
