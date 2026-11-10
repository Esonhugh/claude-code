# mkperturb2.py <tb2-root> <harbor-datasets-root> <out-root> <seed>
# Seeded anti-contamination variants for the Plan A picks. Writes <out>/<suite>/<task>/{instruction.md,tests/,solution/,setup.sh?,PERTURB.md}
import sys, os, re, shutil, random, json
TB2, HD, OUT, SEED = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
rnd = random.Random(SEED)
# REV=2 (seed1108r2): keep the original instruction wording where the first revision made tasks easier
# (polyglot instructions stated the hidden "only the source file" test rule; the SpreadsheetBench preamble
# hinted that static values in the answer range are enough). Pass rates: polyglot-rust-c 42/45 vs 7/45 original.
REV = int(os.environ.get('REV', '1'))

def src(suite, t): return f'{TB2}/{t}' if suite == 'tb2' else f'{HD}/{suite}/{t}'
def start(suite, t):
    d = f'{OUT}/{suite}/{t}'; shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    for sub in ('tests', 'solution'): shutil.copytree(f'{src(suite, t)}/{sub}', f'{d}/{sub}')
    shutil.copy(f'{src(suite, t)}/instruction.md', f'{d}/instruction.md')
    return d
def files(d):
    for root, _, fs in os.walk(d):
        for f in fs:
            p = os.path.join(root, f)
            if p.endswith(('.xlsx', '.jpg', '.png', '.bin', '.bundle')): continue
            yield p
def sub_all(d, pairs, only=None):
    for p in files(d):
        if only and not any(p.startswith(f'{d}/{o}') for o in only): continue
        try: s = open(p).read()
        except UnicodeDecodeError: continue
        n = s
        for a, b in pairs: n = n.replace(a, b)
        if n != s: open(p, 'w').write(n)
def w(p, s): open(p, 'w').write(s)
def note(d, lines): w(f'{d}/PERTURB.md', ''.join(f'- {l}\n' for l in lines) + f'- seed {SEED}; oracle = public reference solution with the same edits\n')

# ---------- TB2 ----------
t = 'polyglot-rust-c'; d = start('tb2', t)
g = [1, 1]
while len(g) < 31: g.append(g[-1] + 2 * g[-2])
assert g[30] < 2**31
cases = [(0, g[0]), (1, g[1]), (2, g[2]), (11, g[11]), (30, g[30])]
sub_all(d, [('/app/polyglot/main.rs', '/app/twin/seq.rs'), ('/app/polyglot/cmain', '/app/twin/cseq'), ('/app/polyglot/main', '/app/twin/seq'),
            ('/app/polyglot', '/app/twin'), ('["main.rs"]', '["seq.rs"]'), ('only main.rs', 'only seq.rs'),
            ('test_cases = [(0, "1"), (1, "1"), (2, "2"), (10, "89"), (42, "433494437")]', 'test_cases = ' + repr([(n, str(v)) for n, v in cases]))], only=['tests'])
sub_all(d, [('mkdir -p polyglot', 'mkdir -p /app/twin'), ('polyglot/main.rs', '/app/twin/seq.rs'), ('a += b;', 'a += 2 * b;')], only=['solution'])
if REV >= 2: w(f'{d}/instruction.md', '''Write me a single file in /app/twin/seq.rs which is a polyglot, that is, I can run

`rustc /app/twin/seq.rs && /app/twin/seq N`
or
`g++ -x c++ /app/twin/seq.rs -o /app/twin/cseq && /app/twin/cseq N`.

Both of these should print to stdout the kth term of the sequence g(0) = 1, g(1) = 1, g(n) = g(n-1) + 2*g(n-2), etc.

I'm using rustc 1.75.0 and g++ 13.2.0.
''')
else: w(f'{d}/instruction.md', '''I need one source file, `/app/twin/seq.rs`, that is valid both as Rust and as C++. Both of these must work:

    rustc /app/twin/seq.rs -o /app/twin/seq && /app/twin/seq N
    g++ -x c++ /app/twin/seq.rs -o /app/twin/cseq && /app/twin/cseq N

Each binary prints g(N) on stdout, where g(0) = 1, g(1) = 1 and g(n) = g(n-1) + 2*g(n-2) for n >= 2 (so 1, 1, 3, 5, 11, ...). N is small enough that the result fits in a signed 32-bit integer. `/app/twin/` must contain only `seq.rs` before compiling. Toolchain: rustc 1.75.0, g++ 13.2.0.
''')
note(d, ['sequence Fibonacci -> g(n)=g(n-1)+2g(n-2), new test values', 'path /app/polyglot/main.rs -> /app/twin/seq.rs, binaries main/cmain -> seq/cseq', 'instruction rewritten' if REV < 2 else 'instruction keeps the original wording (rev 2: rev 1 stated the hidden one-file test rule)'])

t = 'polyglot-c-py'; d = start('tb2', t)
L = [2, 1]
while len(L) < 41: L.append(L[-1] + L[-2])
cases = [(40, L[40]), (9, L[9]), (0, L[0])]
sub_all(d, [('/app/polyglot/main.py.c', '/app/pair/twin.py.c'), ('/app/polyglot/cmain', '/app/pair/ctwin'), ('/app/polyglot', '/app/pair'),
            ('["main.py.c"]', '["twin.py.c"]'), ('only main.py.c', 'only twin.py.c'),
            ('test_cases = [(42, "267914296"), (10, "55"), (0, "0")]', 'test_cases = ' + repr([(n, str(v)) for n, v in cases]))], only=['tests'])
sub_all(d, [('mkdir -p polyglot', 'mkdir -p /app/pair'), ('polyglot/main.py.c', '/app/pair/twin.py.c'), ('a, b = 0, 1', 'a, b = 2, 1'), ('unsigned long long a = 0, b = 1', 'unsigned long long a = 2, b = 1')], only=['solution'])
if REV >= 2: w(f'{d}/instruction.md', '''Write me a single file in /app/pair/twin.py.c which is a polyglot, that is, I can run

`python3 /app/pair/twin.py.c N`
or
`gcc /app/pair/twin.py.c -o /app/pair/ctwin && /app/pair/ctwin N`

Both of these should print to stdout the kth Lucas number, L(0) = 2, L(1) = 1, etc.

I'm using python3 3.12.3 and gcc 13.2.0.
''')
else: w(f'{d}/instruction.md', '''Please write a single file `/app/pair/twin.py.c` that works both as a Python 3 script and as a C program:

    python3 /app/pair/twin.py.c N
    gcc /app/pair/twin.py.c -o /app/pair/ctwin && /app/pair/ctwin N

Both must print the N-th Lucas number to stdout: L(0) = 2, L(1) = 1, L(n) = L(n-1) + L(n-2). Keep `/app/pair/` containing only `twin.py.c`. Versions: Python 3.12.3, gcc 13.2.0.
''')
note(d, ['sequence Fibonacci -> Lucas numbers, new test values', 'path /app/polyglot/main.py.c -> /app/pair/twin.py.c, binary cmain -> ctwin', 'instruction rewritten' if REV < 2 else 'instruction keeps the original wording (rev 2: rev 1 stated the hidden one-file test rule)'])

t = 'mailman'; d = start('tb2', t)
sub_all(d, [('reading-group', 'astro-circle')])
w(f'{d}/instruction.md', '''Set up a mailing list `astro-circle@local.edu` for our astronomy club with postfix and mailman3 (both already installed).

Required behaviour:
- A mail to `astro-circle-join@local.edu` subscribes the sender once they confirm by replying.
- A mail to `astro-circle-leave@local.edu` unsubscribes the sender once they confirm by replying.
- A mail to `astro-circle@local.edu` is delivered to every subscriber.

Constraints:
- The mailman configuration must live at `/etc/mailman3/mailman.cfg`.
- Every address is `<user>@local.edu`, `<user>` being a local unix account; deliver each user's mail to `/var/mail/<user>` (it will be read with `mailbox.mbox`).
- No owner moderation: subscription policy is open (members still confirm their own join/leave).
- `/app/eval.py` is there to help you check your setup.
''')
note(d, ['list name reading-group -> astro-circle in instruction, tests and solution', 'instruction rewritten and reordered'])

t = 'make-mips-interpreter'; d = start('tb2', t)
sub_all(d, [('vm.js', 'mipsvm.js')])
w(f'{d}/instruction.md', '''`/app/doomgeneric_mips` is a MIPS ELF build of doomgeneric; its source is in `/app/doomgeneric/`. Write a MIPS emulator in JavaScript, `/app/mipsvm.js`, including the system calls the program needs, so that `node mipsvm.js` (run from /app) executes that binary, lets it read and write files, and saves each rendered frame as it is produced. Passing means DOOM boots and the first frame it writes is correct.
''')
note(d, ['entry file vm.js -> mipsvm.js in instruction, tests and solution', 'instruction rewritten'])

t = 'write-compressor'; d = start('tb2', t)
text = open(f'{TB2}/{t}/environment/data.txt').read()
paras = text.split('\n')
sents = []
for p in paras:
    ss = re.split(r'(?<=\.) ', p); rnd.shuffle(ss); sents.append(' '.join(ss))
rnd.shuffle(sents)
new = '\n'.join(sents)
assert sorted(new.replace('\n', ' ').split()) == sorted(text.replace('\n', ' ').split())
w(f'{d}/tests/original-data.txt', new)
os.makedirs(f'{d}/setup-files', exist_ok=True); w(f'{d}/setup-files/data.txt', new)
w(f'{d}/setup.sh', 'set -e\ncat > /app/data.txt <<\'__DATA_EOF__\'\n' + new + ('' if new.endswith('\n') else '\n') + '__DATA_EOF__\n' + ("truncate -s -1 /app/data.txt\n" if not new.endswith('\n') else ''))
sub_all(d, [('data.comp', 'packed.bin')], only=['tests', 'solution'])
w(f'{d}/instruction.md', '''`/app/decomp.c` is a decompressor: it reads compressed bytes on stdin and writes the original on stdout. Produce `/app/packed.bin`, at most 2500 bytes, such that `cat /app/packed.bin | /app/decomp` reproduces `/app/data.txt` byte for byte. How you build `packed.bin` is up to you.
''')
note(d, ['data.txt: sentences shuffled within paragraphs and paragraphs shuffled (same words, different byte stream), written by setup.sh and used as the expected output', 'output data.comp -> packed.bin', 'instruction rewritten'])

t = 'configure-git-webserver'; d = start('tb2', t)
sub_all(d, [('/git/server', '/srv/repos/site'), ('8080', '8181'), ('hello.html', 'status.html'), ('hello world', 'site is live')])
sub_all(d, [('chown -R git:git /git\n', 'chown -R git:git /srv/repos\n')], only=['solution'])
w(f'{d}/instruction.md', '''Set up this machine so that, from my laptop, I can do

    git clone user@server:/srv/repos/site
    echo "site is live" > status.html
    git add status.html
    git commit -m "add status page"
    git push origin master

and the pushed file is then served by a web server on port 8181, i.e. `curl http://server:8181/status.html` prints `site is live`. Authentication is handled on my side; don't worry about login.
''')
note(d, ['repo path /git/server -> /srv/repos/site, port 8080 -> 8181, file hello.html -> status.html, content "hello world" -> "site is live" (instruction, verify.sh, solution)', 'instruction rewritten'])

t = 'merge-diff-arc-agi-task'; d = start('tb2', t)
sub_all(d, [('/app/repo', '/app/merge-work'), ('branch1', 'trunk-a'), ('branch2', 'side-b'), ('Branch1', 'trunk-a'), ('Branch2', 'side-b')])
w(f'{d}/instruction.md', '''Create `/app/merge-work` and initialise a git repository there.

1. Fetch `/app/bundle1.bundle` (its HEAD) into a local branch `trunk-a`, and `/app/bundle2.bundle` (its HEAD) into a local branch `side-b`. If HEAD is missing or ambiguous in a bundle, inspect its refs and pick the right one, but the branches must still be called `trunk-a` and `side-b`.
2. With `trunk-a` as the base, merge `side-b` into it and resolve every conflict so the tree is consistent.
3. The merged result must contain `/app/merge-work/algo.py` with a function `map(grid)` that takes a 2-D list of ints and returns a 2-D list, implementing the transformation shown by the input/output pairs in `/app/examples.json`. It must generalise: hidden inputs are checked cell by cell.
4. Check that `algo.py` reproduces every example in `/app/examples.json`.
''')
note(d, ['repo path /app/repo -> /app/merge-work, branches branch1/branch2 -> trunk-a/side-b (instruction, tests, solution)', 'algo.py / map() kept: the names live inside the provided git bundles', 'instruction rewritten as numbered steps'])

t = 'custom-memory-heap-crash'; d = start('tb2', t)
shutil.copy(f'{OUT}/../seed1107/tb2/{t}/instruction.md', f'{d}/instruction.md')
note(d, ['wording only (same text as seed1107): paths, libs and tests are baked into the image'])

# ---------- SWE-bench Pro ----------
def unq(x):
    x = x.strip()
    if x.startswith('"') and x.endswith('"'): x = x[1:-1]
    return x.replace('\\n', '\n').replace('\\"', '"').replace('\\t', '\t').strip()
for line in open(f'{os.path.dirname(OUT)}/../picks-A.txt'):
    if not line.startswith('swebenchpro'): continue
    t = line.split()[1]; d = start('swebenchpro', t)
    s = open(f'{d}/instruction.md').read()
    pr = s[s.index('<pr_description>') + 16:s.index('</pr_description>')]
    i_req = pr.find('\nRequirements:'); i_if = pr.find('\nNew interfaces introduced:')
    desc = unq(pr[:i_req]); req = unq(pr[i_req + 14:i_if]); itf = unq(pr[i_if + 27:])
    desc = re.sub(r'https?://\S+', '', desc); desc = re.sub(r'(?<![\w/])#\d{2,6}\b', '', desc)
    w(f'{d}/instruction.md', f'''Repository checked out at `/app`. Implement the change below.

## What must hold when you are done
{req}

## Public interfaces this change adds
{itf}

## Context
{desc}

## Ground rules
- The tests for this change are already in place; do not edit any test files.
- Change only non-test files under `/app`, and keep the change as small as the requirements allow.
- Reproducing the problem first and re-checking after the fix is recommended.
''')
    note(d, ['instruction restructured: requirements first, then interfaces, then the issue text; escaped quoting removed; issue/PR numbers and URLs stripped; generic step list dropped', 'code identifiers, file names and tests unchanged (tests depend on them)', 'git history beyond HEAD removed at run time by harness/gitscrub.sh and restored only for grading'])

# ---------- SpreadsheetBench ----------
for line in open(f'{os.path.dirname(OUT)}/../picks-A.txt'):
    if not line.startswith('spreadsheetbench'): continue
    t = line.split()[1]; d = start('spreadsheetbench-verified', t)
    sub_all(d, [('/app/output', '/data/results'), ('/app/spreadsheets', '/data/sheets')])
    s = open(f'{d}/instruction.md').read()
    head = s[:s.index('### instruction')]
    if REV < 2: s = s.replace(head, 'Solve the spreadsheet task below with Python (openpyxl and pandas are installed). Write the result workbook to the given output path; only cells inside the answer range are graded. "Cell-Level" means only the listed cells matter, "Sheet-Level" means the whole range is compared.\n\n')
    if REV < 2: s = s.replace('You should generate Python code for the final solution of the question.', '')
    w(f'{d}/instruction.md', s)
    w(f'{d}/setup.sh', 'set -e\nmkdir -p /data/sheets /data/results\nmv /app/spreadsheets/* /data/sheets/\nrmdir /app/spreadsheets /app/output 2>/dev/null || true\n')
    note(d, ['input dir /app/spreadsheets -> /data/sheets, output dir /app/output -> /data/results (instruction, evaluate.py, test.sh, solution)', 'generic preamble rewritten' if REV < 2 else 'original preamble kept (rev 2: the rev 1 preamble hinted that static values are enough)', 'cell values and answers unchanged (answers are fixed workbooks)'])
print('ok')
