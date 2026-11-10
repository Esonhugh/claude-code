"""Fill an auto-memory folder with N service memories plus a MEMORY.md index.

usage: python3 memseed.py N MEMORY_DIR

Deterministic. Five target services sit at fixed fractions of the index, so with
N=300 three of them land past line 200 of MEMORY.md.
"""
import os
import random
import sys

PRE = ['ledger', 'billing', 'geo', 'invoice', 'quota', 'token', 'media', 'search', 'notify', 'audit',
       'cart', 'price', 'stock', 'route', 'auth', 'report', 'fraud', 'tax', 'promo', 'session']
SUF = ['sync', 'api', 'worker', 'gate', 'render', 'resolver', 'mint', 'cache', 'indexer', 'relay',
       'store', 'proxy', 'scheduler', 'exporter', 'feed']
REGIONS = ['eu-west-3', 'us-east-2', 'ap-south-1', 'eu-central-1', 'us-west-1', 'sa-east-1', 'ap-northeast-2']
WORDS = ['kite', 'otter', 'maple', 'ember', 'quartz', 'heron', 'cobalt', 'fjord', 'lumen', 'sable', 'tundra', 'zephyr']
# service -> position as a fraction of N
TARGETS = {'ledger-sync': 0.05, 'geo-resolver': 0.40, 'invoice-render': 0.66, 'quota-gate': 0.82, 'token-mint': 0.97}


def main():
    n, out = int(sys.argv[1]), sys.argv[2]
    rng = random.Random(1108)
    others = [f'{p}-{s}' for p in PRE for s in SUF if f'{p}-{s}' not in TARGETS]
    rng.shuffle(others)
    order = others[: n - len(TARGETS)]
    for name, frac in sorted(TARGETS.items(), key=lambda kv: kv[1]):
        order.insert(min(int(frac * n), len(order)), name)
    os.makedirs(out, exist_ok=True)
    index = ['# Memory index', '']
    for i, name in enumerate(order):
        r = random.Random(name)  # facts depend on the name only, so N does not change answers
        oncall = f'@{r.choice(WORDS)}-{r.randint(10, 99)}'
        timeout = r.randint(2, 90) * 100
        dash = f'DB-{r.randint(10000, 99999)}'
        region = r.choice(REGIONS)
        fn = f'note_{i:03d}.md'  # opaque: the file can't be guessed from the service name
        with open(os.path.join(out, fn), 'w') as f:
            f.write(f'---\nname: service-{name}\ndescription: {name} service: on-call, dashboard, region and request timeout\n'
                    f'type: project\n---\n\n'
                    f'The `{name}` service runs in {region}. Page {oncall} for incidents (on-call alias).\n'
                    f'Its Grafana dashboard id is {dash}. Upstream request timeout is {timeout} ms; '
                    f'raising it needs sign-off from the owning team.\n')
        index.append(f'- [{name} service]({fn}) — on-call, dashboard, region, timeout for {name}')
    with open(os.path.join(out, 'MEMORY.md'), 'w') as f:
        f.write('\n'.join(index) + '\n')


if __name__ == '__main__':
    main()
