"""Fill an auto-memory folder with N dated ops-log notes plus a MEMORY.md index.

usage: python3 memseed_log.py N MEMORY_DIR      (python3 memseed_log.py N --answers prints the truth)

Deterministic. Each file's mtime is its note's day. Index lines carry only the date, never a service name. Each note
records three changes to random services; a value can change many times, so the
current value is the one in the newest note (notes are numbered oldest first).
"""
import datetime
import json
import os
import random
import sys

PRE = ['ledger', 'billing', 'geo', 'invoice', 'quota', 'token', 'media', 'search', 'notify', 'audit',
       'cart', 'price', 'stock', 'route', 'auth', 'report', 'fraud', 'tax', 'promo', 'session']
SUF = ['sync', 'api', 'worker', 'gate', 'render', 'resolver', 'mint', 'cache', 'indexer', 'relay',
       'store', 'proxy', 'scheduler', 'exporter', 'feed']
SERVICES = [f'{p}-{s}' for p in PRE for s in SUF]
REGIONS = ['eu-west-3', 'us-east-2', 'ap-south-1', 'eu-central-1', 'us-west-1', 'sa-east-1', 'ap-northeast-2']
WORDS = ['kite', 'otter', 'maple', 'ember', 'quartz', 'heron', 'cobalt', 'fjord', 'lumen', 'sable', 'tundra', 'zephyr']
FILLER = ['Retro went fine.', 'Nothing else notable.', 'Follow-up ticket filed.', 'Discussed in the weekly sync.',
          'Rollback plan reviewed.', 'No customer impact.', 'Alerts were noisy during the change.']
QUESTIONS = [('ledger-sync', 'oncall'), ('geo-resolver', 'timeout'), ('invoice-render', 'dashboard'),
             ('quota-gate', 'region'), ('token-mint', 'oncall')]


def value(r, attr):
    if attr == 'oncall':
        return f'@{r.choice(WORDS)}-{r.randint(10, 99)}'
    if attr == 'timeout':
        return r.randint(2, 90) * 100
    if attr == 'dashboard':
        return f'DB-{r.randint(10000, 99999)}'
    return r.choice(REGIONS)


def sentence(r, svc, attr, v):
    return r.choice({
        'oncall': [f'On-call for `{svc}` rotated; page {v} from now on.', f'`{svc}` incidents now go to {v}.'],
        'timeout': [f'Raised the `{svc}` upstream request timeout to {v} ms.', f'`{svc}` upstream timeout set to {v} ms after load tests.'],
        'dashboard': [f'`{svc}` got a rebuilt Grafana dashboard, id {v}.', f'New Grafana board for `{svc}`: {v}.'],
        'region': [f'Migrated `{svc}` to {v}.', f'`{svc}` now runs in {v}.'],
    }[attr])


def generate(n):
    r = random.Random(1110)
    start = datetime.date(2024, 1, 1)
    notes, truth = [], {}
    # Every question's fact changes several times, the last time between 60% and 90% of the log.
    forced = {}
    for q in QUESTIONS:
        for frac in sorted(r.uniform(0.05, 0.6) for _ in range(4)) + [r.uniform(0.6, 0.9)]:
            forced.setdefault(int(frac * n), []).append(q)
    for i in range(n):
        day = start + datetime.timedelta(days=i * 1000 // n)
        facts = list(forced.get(i, []))
        while len(facts) < 3:
            svc, attr = r.choice(SERVICES), r.choice(['oncall', 'timeout', 'dashboard', 'region'])
            if (svc, attr) not in QUESTIONS:
                facts.append((svc, attr))
        lines = []
        for svc, attr in facts:
            v = value(r, attr)
            truth[(svc, attr)] = v
            lines.append(sentence(r, svc, attr, v))
        lines.append(r.choice(FILLER))
        notes.append((day, lines))
    return notes, {f'{s}:{a}': truth[(s, a)] for s, a in QUESTIONS}


def main():
    n = int(sys.argv[1])
    notes, answers = generate(n)
    if sys.argv[2] == '--answers':
        print(json.dumps(answers))
        return
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    index = ['# Memory index', '']
    for i, (day, lines) in enumerate(notes):
        fn = f'log_{i:05d}.md'
        with open(os.path.join(out, fn), 'w') as f:
            f.write(f'---\nname: ops-log-{i:05d}\ndescription: ops log entry from {day}\ntype: project\n---\n\n'
                    f'Ops log, {day}.\n\n' + '\n'.join(f'- {l}' for l in lines) + '\n')
        # Saved on the note's day, like a memory written then: recall can tell old from new.
        ts = datetime.datetime(day.year, day.month, day.day, tzinfo=datetime.timezone.utc).timestamp() + i % 86400
        os.utime(os.path.join(out, fn), (ts, ts))
        index.append(f'- [Ops log {day} #{i}]({fn}) — ops log entry')
    with open(os.path.join(out, 'MEMORY.md'), 'w') as f:
        f.write('\n'.join(index) + '\n')


if __name__ == '__main__':
    main()
