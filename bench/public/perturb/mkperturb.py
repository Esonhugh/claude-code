# mkperturb.py <tb2-root> <out-root> <seed>: write perturbed variants (instruction, setup.sh, tests) for prototype tasks
import sys, os, re, shutil, random, json
SRC, OUT, SEED = sys.argv[1], sys.argv[2], int(sys.argv[3])
rnd = random.Random(SEED)
def task_dir(t):
    d = f'{OUT}/{t}'; shutil.rmtree(d, ignore_errors=True)
    shutil.copytree(f'{SRC}/{t}/tests', f'{d}/tests'); return d
def w(p, s): open(p, 'w').write(s)

# --- regex-log: YYYY-MM-DD -> DD/MM/YYYY, new output path, reworded, sample lines shuffled
t = 'regex-log'; d = task_dir(t)
src = open(f'{SRC}/{t}/tests/test_outputs.py').read()
conv = lambda s: re.sub(r'(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)', r'\3/\2/\1', s)
body = src[src.index('    sample_logs = ['):src.index('    # Join logs')]
ns = {}; exec(body.replace('\n    ', '\n').strip(), ns)
logs, exp = ns['sample_logs'], ns['expected_dates']
# pair each matching line with its expected date (Y lines are the ones whose last date is in exp, in order)
pairs, k = [], 0
for line in logs:
    ds = re.findall(r'(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)', line)
    if k < len(exp) and ds and ds[-1] == exp[k] and line.find(exp[k]) >= 0: pairs.append((line, exp[k])); k += 1
    else: pairs.append((line, None))
assert k == len(exp), (k, exp)
rnd.shuffle(pairs)
new_logs = [conv(l) for l, _ in pairs]; new_exp = [conv(e) for _, e in pairs if e]
w(f'{d}/tests/test_outputs.py', f'''import re
from pathlib import Path

def test_regex_matches_dates():
    regex_file = Path("/srv/logscan/date_rule.re")
    assert regex_file.exists(), f"{{regex_file}} missing"
    pattern_text = regex_file.read_text().strip()
    re.compile(pattern_text)
    sample_logs = {json.dumps(new_logs, indent=8)}
    expected_dates = {json.dumps(new_exp)}
    matches = re.findall(pattern_text, "\\n".join(sample_logs), re.MULTILINE)
    assert matches == expected_dates, f"Expected {{expected_dates}}, but got {{matches}}"
''')
w(f'{d}/instruction.md', '''We grep our access logs for calendar dates written day-first, like 07/11/2026 (DD/MM/YYYY), but only on lines that also mention an IPv4 address.

Produce a single Python regular expression and store it in `/srv/logscan/date_rule.re` (create the directory if needed). We will load it with `open(...).read().strip()` and run `re.findall(pattern, whole_log_text, re.MULTILINE)`.

Rules:
- Only lines containing at least one valid IPv4 address (dotted decimal, each octet 0-255, no leading zeros) count.
- When such a line has several dates, return only the right-most one.
- Day must be valid for its month; treat February as allowing 29 days every year.
- A date or IP that is glued to letters or digits on either side does not count (for example `x07/11/2026`, `10.0.0.1abc`); also watch for look-alike strings such as `user 1134-12-1234`.
- `findall` must return the full date string for each matching line, so use non-capturing groups where needed.
''')
w(f'{d}/PERTURB.md', '- date format YYYY-MM-DD -> DD/MM/YYYY in instruction and all test lines/answers\n- output path /app/regex.txt -> /srv/logscan/date_rule.re\n- instruction reworded; example code removed\n- test lines shuffled (seeded), expected answers reordered to match\n')

# --- sqlite-db-truncate: same-length word rename + permuted suffixes inside the db, new output path and keys
t = 'sqlite-db-truncate'; d = task_dir(t)
perm = list(range(100)); rnd.shuffle(perm)
mapping = {f'testword{i:02d}': f'kiwiterm{perm[i]:02d}' for i in range(100)}
src = open(f'{SRC}/{t}/tests/test_outputs.py').read()
soln = eval(src[src.index('soln = ') + 7:src.index(']\n', src.index('soln = ')) + 1])
new = [{'label': mapping[r['word']], 'amount': r['value']} for r in soln]
w(f'{d}/tests/test_outputs.py', f'''import json
soln = {json.dumps(new)}
def test_json_data():
    data = json.load(open("/srv/recovery/rows.json"))
    want = {{(r["label"], r["amount"]) for r in soln}}
    got = {{(r["label"], r["amount"]) for r in data}}
    assert len(want & got) > 6, "Did not load data correctly"
''')
w(f'{d}/setup.sh', '''set -e
python3 - <<'EOF'
import json
m = json.loads(%r)
b = open('/app/trunc.db','rb').read()
for k, v in m.items(): b = b.replace(k.encode(), v.encode())
open('/srv_inventory.db','wb').write(b)
EOF
mkdir -p /srv/recovery; mv /srv_inventory.db /srv/recovery/inventory.db; rm -f /app/trunc.db
''' % json.dumps(mapping))
w(f'{d}/instruction.md', '''Our inventory SQLite file `/srv/recovery/inventory.db` got cut off partway through a copy, so it is no longer a complete database file. Salvage every row you can.

Write the recovered rows to `/srv/recovery/rows.json` as a JSON array of objects with keys `label` (the text column) and `amount` (the numeric column, as a JSON number), for example `[{"label": "kiwiterm17", "amount": 3}, ...]`.
''')
w(f'{d}/PERTURB.md', '- db moved /app/trunc.db -> /srv/recovery/inventory.db\n- every `testwordNN` renamed in-place to `kiwitermMM` (same byte length, MM = seeded permutation of NN), so word->value pairs differ from the public answer\n- output /app/recover.json -> /srv/recovery/rows.json, keys word/value -> label/amount\n- instruction reworded\n')

# --- cancel-async-tasks: rename module, function, parameter
t = 'cancel-async-tasks'; d = task_dir(t)
for f in ('test_outputs.py', 'test.py'):
    s = open(f'{d}/tests/{f}').read()
    s = s.replace('/app/run.py', '/app/jobgate.py').replace('from run import run_tasks', 'from jobgate import gated_run').replace('await run_tasks(tasks, max_concurrent)', 'await gated_run(tasks, limit=max_concurrent)')
    open(f'{d}/tests/{f}', 'w').write(s)
s = open(f'{d}/tests/test.sh').read().replace('cp /tests/test.py /app/test.py', 'cp /tests/test.py /app/test.py')
w(f'{d}/instruction.md', '''Write a module `/app/jobgate.py` exposing `async def gated_run(jobs, limit)`, importable as `from jobgate import gated_run`. `jobs` is a list of zero-argument callables that each return an awaitable; `gated_run` must run them with at most `limit` in flight at any moment and return once all are done.

Use the system Python (installing packages is fine). Important: we often stop runs with Ctrl-C. When that happens, every job that has already started must still get to run its own cleanup (e.g. `finally` blocks) before the program exits.
''')
w(f'{d}/PERTURB.md', '- file /app/run.py -> /app/jobgate.py, function run_tasks -> gated_run, parameter max_concurrent -> limit (keyword)\n- instruction reworded\n- tests: only the import/call names changed\n')

# --- custom-memory-heap-crash: wording only (binary/lib layout baked into image)
t = 'custom-memory-heap-crash'; d = task_dir(t)
w(f'{d}/instruction.md', '''The C++ program in `/app/` (main.cpp, user.cpp, user.h) runs fine when built in DEBUG configuration but crashes when built in RELEASE configuration. Make it work in both. You may edit only `/app/user.cpp`; every other file on the system must stay untouched.

Build commands we use:
- RELEASE: `g++ -std=c++17 -o /app/release /app/main.cpp /app/user.cpp -O2 -DNDEBUG -L/usr/local/gcc-custom-release/lib64 -Wl,-Bstatic -lstdc++ -Wl,-Bdynamic -lm`
- DEBUG: `g++ -std=c++17 -o /app/debug /app/main.cpp /app/user.cpp -g -O0 -L/usr/local/gcc-custom-debug/lib64 -Wl,-Bstatic -lstdc++ -Wl,-Bdynamic -lm`

The machine has two in-house libstdc++ builds: an unoptimized one under `/usr/local/gcc-custom-debug/` and an optimized one under `/usr/local/gcc-custom-release/`; their (modified) sources are in `/build/`. Valgrind must report zero leaks for the fixed program.
''')
w(f'{d}/PERTURB.md', '- wording only: instruction rewritten and reordered; paths, build commands and tests unchanged (layout is baked into the image)\n')
print('ok', SEED)
