/**
 * Helper globals a REPL script gets before its first script runs: file,
 * write, edit, sleep, $ and preview, written over the session's tools
 * (Read, Write, Edit, Bash) through the `tools` global, looked up at each
 * call so a later run's tool list is the one used.
 *
 * file/write/edit/sleep follow official 2.1.325 env/file.ts. `$` and preview
 * are a subset of official env/shell.ts: no spill-file streaming, no
 * background `running`, no unsandboxed-retry and no exit-code readings
 * beyond what the Bash tool itself reports.
 */

/** Read, Write and Edit as the official prelude's `read`, `writeFile` and `editOnce` primitives ({ok} or {error}). */
const FILE_PRIMITIVES = String.raw`
const str = (v) => v === undefined || v === null ? '' : String(v);
const toolCall = async (name, input) => {
  const fn = globalThis.tools && globalThis.tools[name];
  if (typeof fn !== 'function') return { error: name + ' is not available in this session' };
  try {
    return await fn(input);
  } catch (e) {
    return { error: e && e.message !== undefined ? String(e.message) : String(e) };
  }
};
const errorOf = (r) => r !== null && typeof r === 'object' && typeof r.error === 'string' ? r.error : undefined;
const NOT_READ = 'File has not been read yet';
const MISSING = /does not exist|ENOENT|no such file/i;
const read = async (path, offset, limit, probe) => {
  const input = { file_path: path };
  if (offset !== undefined) input.offset = offset;
  if (limit !== undefined) input.limit = limit;
  const r = await toolCall('Read', input);
  const error = errorOf(r);
  if (error !== undefined) {
    if (probe && MISSING.test(error)) return { missing: true, error };
    return { error };
  }
  if (r && r.type === 'text' && r.file && typeof r.file.content === 'string') return { ok: { content: r.file.content } };
  if (probe && r && typeof r === 'object') return { present: true };
  return { error: path + ' is not a text file (Read gave ' + str(r && r.type) + ')' };
};
// Write and Edit refuse a file the session has not read: read it, then try once more.
const afterRead = async (path, attempt) => {
  let r = await attempt();
  const error = errorOf(r);
  if (error !== undefined && error.includes(NOT_READ)) {
    const seen = await read(path);
    if (seen.error !== undefined && !MISSING.test(seen.error)) return r;
    r = await attempt();
  }
  return r;
};
const utf8Bytes = (s) => {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
};
const writeFile = async (path, content) => {
  const r = await afterRead(path, () => toolCall('Write', { file_path: path, content }));
  const error = errorOf(r);
  return error !== undefined ? { error } : { ok: { bytes: utf8Bytes(content) } };
};
const occurrences = (hay, needle) => needle === '' ? 0 : hay.split(needle).length - 1;
const editOnce = async (path, oldText, newText, all) => {
  const before = await read(path);
  const r = await afterRead(path, () =>
    toolCall('Edit', { file_path: path, old_string: oldText, new_string: newText, replace_all: all }),
  );
  const error = errorOf(r);
  if (error !== undefined) return { error };
  return { ok: { replacements: all && before.ok ? occurrences(before.ok.content, oldText) : 1 } };
};
`

/** Official env/file.ts over the primitives above. */
const FILE_HELPERS = String.raw`
const un = (r) => {
  if (r !== null && typeof r === 'object' && r.error !== undefined && !('ok' in r)) throw new Error(r.error);
  return r === null || typeof r !== 'object' ? r : r.ok;
};
const badText = (v, who) => {
  const kind = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  const text = kind === 'object' ? String(v) : '';
  return kind === 'undefined' || kind === 'null' || kind === 'function' || kind === 'array' ||
    (text.startsWith('[object ') && text.endsWith(']'))
    ? who + ' must be a string (got ' + kind + '). Nothing was written.'
    : undefined;
};
const fail = (soft, message, replacements) => {
  if (soft) return { ok: false, replacements, error: message };
  throw new Error(message);
};
async function edit(path, a, b, c) {
  let bad = badText(path, 'edit: the path');
  const p = str(path);
  if (Array.isArray(a)) {
    const opts = b !== null && typeof b === 'object' ? b : {};
    const all = opts.all === true, soft = opts.soft === true;
    const pairs = a.map((pair, i) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        bad ??= 'edit: edit ' + (i + 1) + ' must be [old, new]';
        return ['', ''];
      }
      const [o, n] = pair;
      bad ??= badText(o, 'edit: the old text of edit ' + (i + 1)) ?? badText(n, 'edit: the new text of edit ' + (i + 1));
      return [str(o), str(n)];
    });
    if (bad !== undefined) return fail(soft, bad, 0);
    const r = await read(p);
    if (r === null || typeof r !== 'object' || !('ok' in r)) return fail(soft, 'edit: ' + p + ': ' + (r && r.error), 0);
    let text = r.ok.content;
    for (let i = 0; i < pairs.length; i++) {
      const [o, n] = pairs[i];
      const which = 'edit ' + (i + 1) + ' of ' + pairs.length;
      if (o.length === 0) return fail(soft, which + ': old text is empty; the file is untouched', 0);
      if (o === n) return fail(soft, which + ': old and new text are the same; the file is untouched', 0);
      const m = occurrences(text, o);
      if (m === 0)
        return fail(soft, which + ': text not found in ' + p + ' (after the edits before it); the file is untouched.\nText: ' + o, 0);
      if (m > 1 && !all)
        return fail(soft, which + ': found ' + m + ' matches in ' + p + ', and an edit must match exactly once; the file is untouched. Pass {all: true} to replace every match, or give more surrounding text.', 0);
      text = all ? text.split(o).join(n) : text.replace(o, () => n);
    }
    let done = 0;
    for (let i = 0; i < pairs.length; i++) {
      const rr = await editOnce(p, pairs[i][0], pairs[i][1], all);
      if (rr === null || typeof rr !== 'object' || !('ok' in rr))
        return fail(soft, 'edit ' + (i + 1) + ' of ' + pairs.length + ' failed after ' + i + ' were applied: ' + (rr && rr.error), done);
      done += rr.ok.replacements;
    }
    return { ok: true, replacements: done };
  }
  const opts = c !== null && typeof c === 'object' ? c : {};
  const soft = opts.soft === true;
  bad ??= badText(a, 'edit: the old text') ?? badText(b, 'edit: the new text');
  if (bad !== undefined) return fail(soft, bad, 0);
  const r = await editOnce(p, str(a), str(b), opts.all === true);
  if (r === null || typeof r !== 'object' || !('ok' in r)) return fail(soft, str(r && r.error), 0);
  return { ok: true, replacements: r.ok.replacements };
}
async function write(path, content) {
  const bad = badText(path, 'write: the path') ?? badText(content, 'write: the content');
  if (bad !== undefined) throw new Error(bad);
  return un(await writeFile(str(path), str(content))).bytes;
}
function file(path) {
  const p = str(path);
  const whole = async () => un(await read(p));
  return Object.freeze({
    name: p,
    async text() { return (await whole()).content; },
    async json() { return JSON.parse((await whole()).content); },
    async lines() { return (await whole()).content.split('\n'); },
    async exists() {
      const r = await read(p, 1, 1, true);
      if (r !== null && typeof r === 'object' && 'ok' in r) return true;
      if (r && r.missing === true) return false;
      if (r && r.present === true) return true;
      throw new Error(str(r && r.error));
    },
    async slice(offset, limit) { return un(await read(p, offset, limit)).content; },
  });
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, +ms || 0));
}
`
/** `$` and preview over the Bash tool. A backtick is written \x60 and "${" as '$' + '{' since this is a template literal. */
const SHELL_HELPERS = String.raw`
const quote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";
const BACKTICK = '\x60', OPEN = '$' + '{';
const piece = (v) => {
  if (Array.isArray(v)) return v.map(quote).join(' ');
  if (v !== null && typeof v === 'object' && typeof v.raw === 'string') return v.raw;
  return quote(v);
};
const render = (strings, values) => {
  let out = '';
  for (let i = 0; i < strings.raw.length; i++) {
    out += strings.raw[i].replaceAll('\\' + BACKTICK, BACKTICK).replaceAll('\\' + OPEN, OPEN);
    if (i < values.length) out += piece(values[i]);
  }
  return out;
};
const EXIT = /(?:^|\n)Exit code (\d+)(?:\n|$)/;
class ShellError extends Error {
  constructor(out) {
    super(out.error ?? ('exit ' + out.exitCode));
    this.name = 'ShellError';
    this.stdout = out.stdout;
    this.stderr = out.stderr;
    this.exitCode = out.exitCode;
  }
}
const outputText = (o) =>
  [o.stdout, o.stderr ? '[stderr] ' + o.stderr : '', o.error && o.exitCode === null ? '[error] ' + o.error : '',
    o.exitCode ? '[exit ' + o.exitCode + ']' : ''].filter(Boolean).join('\n');
const shellOutput = (r) => {
  let o;
  const error = errorOf(r);
  if (error !== undefined) {
    const m = EXIT.exec(error);
    o = m
      ? { stdout: error.replace(EXIT, '\n').replace(/^\n+|\n+$/g, ''), stderr: '', exitCode: Number(m[1]) }
      : { stdout: '', stderr: '', exitCode: null, error };
  } else {
    const d = r !== null && typeof r === 'object' ? r : {};
    o = { stdout: str(d.stdout), stderr: str(d.stderr), exitCode: d.interrupted ? null : 0 };
    if (d.interrupted) o.error = 'interrupted';
    if (typeof d.returnCodeInterpretation === 'string') o.note = d.returnCodeInterpretation;
    if (typeof d.persistedOutputPath === 'string') {
      o.file = d.persistedOutputPath;
      if (typeof d.persistedOutputSize === 'number') o.bytes = d.persistedOutputSize;
    }
  }
  o.truncated = o.file !== undefined;
  o.whole = !o.truncated;
  o.output = outputText(o);
  o.text = () => o.stdout;
  o.lines = () => o.stdout.split('\n').filter((line, i, all) => line !== '' || i < all.length - 1);
  o.json = () => JSON.parse(o.stdout);
  return o;
};
const failed = (o) => o.exitCode !== 0;
// One run per $ call; nothrow()/throws() give views of it, and timeout/cwd/env
// change it while it has not started (they are called right after $).
function view(run, throws) {
  const settled = () => run.start().then(o => {
    if (throws && failed(o)) throw new ShellError(o);
    return o;
  });
  const before = (what, change) => {
    if (run.started) throw new Error(what + '() must be called right after $, before the command starts');
    change();
    return p;
  };
  const p = {
    then: (a, b) => settled().then(a, b),
    catch: (b) => settled().catch(b),
    finally: (f) => settled().finally(f),
    nothrow: () => view(run, false),
    throws: (on) => view(run, on !== false),
    quiet: () => p,
    timeout: (ms) => before('timeout', () => { run.timeout = +ms; }),
    cwd: (dir) => before('cwd', () => { run.cwd = str(dir); }),
    env: (vars) => before('env', () => { run.env = { ...run.env, ...vars }; }),
    text: () => settled().then(o => o.text()),
    lines: () => settled().then(o => o.lines()),
    json: () => settled().then(o => o.json()),
    [Symbol.toStringTag]: 'ShellPromise',
  };
  return p;
}
function shell(command, timeout) {
  const run = {
    command, timeout, cwd: undefined, env: undefined, started: undefined,
    start() {
      if (!run.started) {
        let cmd = run.command;
        if (run.env) cmd = Object.entries(run.env).map(([k, v]) => 'export ' + k + '=' + quote(v) + '; ').join('') + cmd;
        if (run.cwd !== undefined) cmd = 'cd ' + quote(run.cwd) + ' || exit 1; ' + cmd;
        if (run.env || run.cwd !== undefined) cmd = '(' + cmd + ')';
        const input = { command: cmd };
        if (run.timeout !== undefined && Number.isFinite(run.timeout)) input.timeout = run.timeout;
        run.started = toolCall('Bash', input).then(shellOutput);
      }
      return run.started;
    },
  };
  // Started on the next microtask, like official: an unawaited $ still runs.
  Promise.resolve().then(() => run.start());
  return view(run, true);
}
function $(strings, ...values) {
  if (Array.isArray(strings) && Array.isArray(strings.raw)) return shell(render(strings, values), undefined);
  return shell(str(strings), values[0] === undefined ? undefined : +values[0]);
}
$.escape = quote;
$.ShellError = ShellError;
const PREVIEW_DEFAULT = 200;
function preview(x, n) {
  const limit = Number.isFinite(+n) && +n >= 0 ? Math.floor(+n) : PREVIEW_DEFAULT;
  const cut = (s) => s.length > limit ? s.slice(0, limit) + '\u2026[+' + (s.length - limit) + ' chars]' : s;
  if (x === null || x === undefined) return '';
  if (typeof x === 'object' && typeof x.output === 'string' && typeof x.stdout === 'string') {
    if (x.file === undefined) return cut(x.output);
    const head = x.stdout.length > limit ? x.stdout.slice(0, limit) + '...' : x.stdout;
    const size = x.bytes === undefined ? 'Output' : 'Output (' + x.bytes + ' bytes)';
    return [size + ' saved to ' + x.file, head, x.stderr ? '[stderr] ' + x.stderr : '', x.exitCode ? '[exit ' + x.exitCode + ']' : '']
      .filter(Boolean).join('\n');
  }
  return cut(String(x));
}
`

/** Runs once per context (executor `prelude`); the helpers become writable globals a script may replace. */
export const REPL_HELPERS_PRELUDE = `(() => {
'use strict';
${FILE_PRIMITIVES}
${FILE_HELPERS}
${SHELL_HELPERS}
for (const [name, value] of Object.entries({ edit, write, file, sleep, $, preview }))
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
})();`
