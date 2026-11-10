#!/usr/bin/env python3
# k8s_check.py <run-dir> <s|l> <namespace> -> JSON {ok, checks}; waits up to 60 s for rollouts the agent already started
import json, os, re, subprocess, sys, time
R, V, NS = sys.argv[1:4]
def k(*a, timeout=60):
    return subprocess.run(['/opt/k3s/bin/kubectl', '--kubeconfig', '/etc/rancher/k3s/k3s.yaml', '-n', NS, *a], capture_output=True, text=True, timeout=timeout)
def dep(name):
    r = k('get', 'deploy', name, '-o', 'json'); return json.loads(r.stdout) if r.returncode == 0 else {}
def ready(name):
    d = dep(name); s, want = d.get('status', {}), d.get('spec', {}).get('replicas', 1)
    return bool(d) and s.get('readyReplicas', 0) == want and s.get('updatedReplicas', 0) == want and s.get('replicas', 0) == want
def wait_ready(names, t=60):
    end = time.time() + t
    while time.time() < end and not all(ready(n) for n in names): time.sleep(3)
    return {n: ready(n) for n in names}
def ctr(name):
    return (dep(name).get('spec', {}).get('template', {}).get('spec', {}).get('containers') or [{}])[0]
orig = {d['metadata']['name']: d for d in __import__('yaml').safe_load_all(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), f'k8s_{V}.yaml'))) if d['kind'] == 'Deployment'}
same_cmd = lambda n: ctr(n).get('command') == orig[n]['spec']['template']['spec']['containers'][0]['command']
c = {}
if V == 's':
    c.update({f'{n}_ready': v for n, v in wait_ready(['api']).items()})
    env = {e['name']: e for e in ctr('api').get('env', [])}
    e = env.get('DB_URL', {})
    c['db_url_from_configmap'] = e.get('valueFrom', {}).get('configMapKeyRef', {}).get('key') == 'DB_URL' or e.get('value') == 'postgres://db.internal:5432/orders'
    c['startup_check_kept'] = same_cmd('api')
    c['readiness_probe_kept'] = 'readinessProbe' in ctr('api')
    c['replicas_2'] = dep('api').get('spec', {}).get('replicas') == 2
else:
    c.update({f'{n}_ready': v for n, v in wait_ready(['backend', 'frontend', 'worker']).items()})
    ep = k('get', 'endpoints', 'backend', '-o', 'json'); subsets = json.loads(ep.stdout).get('subsets') if ep.returncode == 0 else None
    c['backend_endpoints'] = bool(subsets and subsets[0].get('addresses'))
    c['frontend_reaches_backend'] = k('exec', 'deploy/frontend', '--', 'sh', '-c', 'wget -q -T 3 -O- "$BACKEND_URL/orders"').stdout.strip() == '{"orders":42}'
    c['backend_probe_kept'] = 'readinessProbe' in ctr('backend')
    c['frontend_check_kept'] = same_cmd('frontend')
    req = ctr('worker').get('resources', {}).get('requests', {})
    c['worker_requests_set'] = 'cpu' in req and 'memory' in req
    c['replicas_kept'] = dep('backend').get('spec', {}).get('replicas') == 2
    inc = open(f'{R}/w/INCIDENT.md', errors='ignore').read().lower() if os.path.exists(f'{R}/w/INCIDENT.md') else ''
    topics = {'selector': r'selector|backend-api', 'probe': r'probe|8081', 'url': r'backend_url|:8080|service port', 'requests': r'request|pending|insufficient|cpu'}
    c['incident_topics'] = sum(bool(re.search(p, inc)) for p in topics.values())
    c['incident_ok'] = c['incident_topics'] >= 4
c['ok'] = all(v for kk, v in c.items() if kk != 'incident_topics')
print(json.dumps(c))
