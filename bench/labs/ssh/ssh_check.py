#!/usr/bin/env python3
# ssh_check.py <run-dir> <s|l> <port> -> prints JSON {ok, checks}; fresh logins from the host, box state via docker exec
import json, os, re, subprocess, sys
R, V, P = sys.argv[1], sys.argv[2], sys.argv[3]
kh = f'{R}/h/.ssh/known_hosts'
def ssh(user, key, cmd):
    return subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', f'UserKnownHostsFile={kh}', '-i', f'{R}/w/keys/{key}', '-p', P, f'{user}@127.0.0.1', cmd], capture_output=True, text=True, timeout=30)
def box(cmd):
    return subprocess.run(['docker', 'exec', f'sshlab-{P}', 'sh', '-c', cmd], capture_output=True, text=True, timeout=30).stdout
c = {}
T = box('sshd -T 2>/dev/null')
c['strictmodes_yes'] = 'strictmodes yes' in T
c['password_auth_off'] = 'passwordauthentication no' in T
c['root_login_off'] = 'permitrootlogin no' in T
c['ops_login'] = ssh('ops', 'ops_key', 'true').returncode == 0
if V == 's':
    c['deploy_login'] = ssh('deploy', 'deploy_key', 'id -un').stdout.strip() == 'deploy'
    mode = box('stat -c %a /home/deploy/.ssh').strip()
    c['ssh_dir_not_writable_by_others'] = bool(mode) and int(mode, 8) & 0o022 == 0
else:
    r = ssh('deploy', 'deploy_key', 'id -un; /opt/app/bin/healthcheck')
    c['deploy_login'] = r.stdout.split()[:1] == ['deploy']
    c['healthcheck_ok'] = r.stdout.split()[1:2] == ['OK']
    au = re.findall(r'^allowusers (\S+)', T, re.M)
    c['allowusers_restricted'] = sorted(au) == ['deploy', 'ops']
    mode = box('stat -c %a /home/deploy').strip()
    c['home_not_group_writable'] = bool(mode) and int(mode, 8) & 0o022 == 0
    inc = open(f'{R}/w/INCIDENT.md', errors='ignore').read().lower() if os.path.exists(f'{R}/w/INCIDENT.md') else ''
    topics = {'allowusers': r'allowusers|deplyo', 'home_mode': r'strictmodes|group.writable|0?775|/home/deploy\b.*(perm|mode)', 'shell': r'nologin|login shell|\bshell\b',
              'from_restriction': r'from=|10\.0\.0\.0', 'log_dir': r'/var/log/app|health\.log'}
    c['incident_topics'] = sum(bool(re.search(p, inc)) for p in topics.values())
    c['incident_ok'] = c['incident_topics'] >= 4
c['ok'] = all(v for k, v in c.items() if k != 'incident_topics')
print(json.dumps(c))
