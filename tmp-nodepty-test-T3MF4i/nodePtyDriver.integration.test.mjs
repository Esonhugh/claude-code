import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// src/utils/pty/nodePtyDriver.integration.test.ts
import assert from "node:assert/strict";
import test from "node:test";

// src/utils/shell/resolveDefaultShell.ts
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
var require2 = createRequire(import.meta.url);
function tryGetInitialSettings() {
  try {
    return require2("../settings/settings.js").getInitialSettings();
  } catch {
    try {
      return require2("../settings/settings.ts").getInitialSettings();
    } catch {
      return null;
    }
  }
}
function resolveDefaultShell() {
  return tryGetInitialSettings()?.defaultShell ?? "bash";
}
function isExecutableCommand(command) {
  if (!command) {
    return false;
  }
  try {
    if (isAbsolute(command)) {
      accessSync(command, fsConstants.X_OK);
      return true;
    }
    const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    for (const entry of pathEntries) {
      try {
        accessSync(join(entry, command), fsConstants.X_OK);
        return true;
      } catch {
      }
    }
  } catch {
    return false;
  }
  return false;
}
function resolveInteractiveTerminalCommand() {
  const envShell = process.env.SHELL?.trim();
  if (envShell && isExecutableCommand(envShell)) {
    return envShell;
  }
  const fallbackShell = resolveDefaultShell() === "powershell" ? "powershell" : "bash";
  if (isExecutableCommand(fallbackShell)) {
    return fallbackShell;
  }
  return "bash";
}

// src/utils/pty/nodePtyDriver.ts
import { accessSync as accessSync2, chmodSync, constants as fsConstants2 } from "node:fs";
import { createRequire as createRequire2 } from "node:module";
import { delimiter as delimiter2, dirname, isAbsolute as isAbsolute2, join as join2 } from "node:path";
import pty from "node-pty";
function buildShellArgs(command) {
  if (command === "powershell" || command.endsWith("/pwsh")) {
    return ["-NoLogo"];
  }
  return [];
}
function getExecutableCandidates(command) {
  const baseCandidates = command === "powershell" ? ["pwsh", "powershell"] : [command];
  if (process.platform !== "win32") {
    return baseCandidates;
  }
  const pathExts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  return baseCandidates.flatMap((candidate) => {
    const lower = candidate.toLowerCase();
    if (pathExts.some((ext) => lower.endsWith(ext.toLowerCase()))) {
      return [candidate];
    }
    return [candidate, ...pathExts.map((ext) => `${candidate}${ext.toLowerCase()}`)];
  });
}
function resolveCommandPath(command) {
  const candidates = getExecutableCandidates(command);
  for (const candidate of candidates) {
    if (isAbsolute2(candidate)) {
      accessSync2(candidate, fsConstants2.X_OK);
      return candidate;
    }
    const pathEntries = (process.env.PATH ?? "").split(delimiter2).filter(Boolean);
    for (const entry of pathEntries) {
      const fullPath = join2(entry, candidate);
      try {
        accessSync2(fullPath, fsConstants2.X_OK);
        return fullPath;
      } catch {
      }
    }
  }
  throw new Error(`Unable to resolve terminal command: ${command}`);
}
function ensureSpawnHelperExecutable() {
  const require3 = createRequire2(import.meta.url);
  const packageJsonPath = require3.resolve("node-pty/package.json");
  const packageDir = dirname(packageJsonPath);
  const helperPath = join2(
    packageDir,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper"
  );
  try {
    accessSync2(helperPath, fsConstants2.X_OK);
  } catch {
    chmodSync(helperPath, 493);
  }
}
function createNodePtyDriver() {
  ensureSpawnHelperExecutable();
  const sessions = /* @__PURE__ */ new Map();
  return {
    resolveDefaultCommand() {
      return resolveInteractiveTerminalCommand();
    },
    open(options) {
      const command = options.command ?? resolveInteractiveTerminalCommand();
      const resolvedCommand = resolveCommandPath(command);
      const args = options.args ?? buildShellArgs(command);
      const proc = pty.spawn(resolvedCommand, args, {
        name: "xterm-color",
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.env ?? {}
        }
      });
      const session = {
        outputQueue: [],
        proc,
        status: {
          state: "running",
          pid: proc.pid
        }
      };
      proc.onData((text) => {
        session.outputQueue.push({
          text,
          stream: "stdout",
          timestamp: Date.now()
        });
      });
      proc.onExit((event) => {
        session.status = {
          state: "closed",
          exitCode: event.exitCode,
          exitedAt: Date.now(),
          signal: event.signal ? String(event.signal) : null
        };
      });
      sessions.set(options.sessionId, session);
      return { ...session.status };
    },
    write(sessionId, data) {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Unknown PTY session: ${sessionId}`);
      }
      if (data) {
        session.proc?.write(data);
      }
      return session.outputQueue.shift() ?? null;
    },
    resize(sessionId, cols, rows) {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Unknown PTY session: ${sessionId}`);
      }
      session.proc?.resize(cols, rows);
    },
    status(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Unknown PTY session: ${sessionId}`);
      }
      return { ...session.status };
    },
    kill(sessionId, signal) {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Unknown PTY session: ${sessionId}`);
      }
      const pid = session.proc?.pid ?? session.status.pid;
      session.proc?.kill(signal);
      session.proc = void 0;
      session.status = {
        state: "closed",
        exitCode: signal === "SIGTERM" ? 143 : 130,
        exitedAt: Date.now(),
        pid,
        signal
      };
      return { ...session.status };
    },
    close(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Unknown PTY session: ${sessionId}`);
      }
      if (session.status.state === "running") {
        const pid = session.proc?.pid ?? session.status.pid;
        session.proc?.kill();
        session.proc = void 0;
        session.status = {
          state: "closed",
          exitCode: session.status.exitCode ?? 0,
          exitedAt: Date.now(),
          pid,
          signal: session.status.signal ?? null
        };
      }
      return { ...session.status };
    }
  };
}

// src/utils/pty/types.ts
var INITIAL_TERMINAL_SIZE = {
  cols: 120,
  rows: 30
};

// src/utils/pty/terminalScreen.ts
function createBlankLine(cols) {
  return Array.from({ length: cols }, () => ({ char: " ", style: {} }));
}
function createTerminalScreen(cols, rows) {
  return {
    cols,
    rows,
    cursorRow: 0,
    cursorCol: 0,
    pendingWrap: false,
    lines: Array.from({ length: rows }, () => createBlankLine(cols))
  };
}
function createBlankCell(style = {}) {
  return { char: " ", style: { ...style } };
}
function moveCursorToColumn(screen, col) {
  screen.pendingWrap = false;
  screen.cursorCol = Math.max(0, Math.min(col, screen.cols - 1));
}
function moveCursorToNextRow(screen) {
  screen.pendingWrap = false;
  screen.cursorCol = 0;
  if (screen.cursorRow < screen.rows - 1) {
    screen.cursorRow += 1;
    return;
  }
  screen.lines.shift();
  screen.lines.push(Array.from({ length: screen.cols }, () => createBlankCell()));
}
function writeCharToScreen(screen, char, style = {}) {
  if (screen.pendingWrap) {
    moveCursorToNextRow(screen);
  }
  const row = screen.lines[screen.cursorRow];
  if (!row) {
    return;
  }
  row[screen.cursorCol] = { char, style: { ...style } };
  if (screen.cursorCol < screen.cols - 1) {
    screen.cursorCol += 1;
    return;
  }
  screen.pendingWrap = true;
}

// src/utils/pty/terminalScreenToPreview.ts
function sameStyle(a, b) {
  return a.fg === b.fg;
}
function stylePrefix(style) {
  return style.fg ? `\x1B[${style.fg}m` : "";
}
function styleSuffix(style) {
  return style.fg ? "\x1B[0m" : "";
}
function renderLine(line) {
  let result = "";
  let run = "";
  let currentStyle = line[0]?.style ?? {};
  for (const cell of line) {
    if (!sameStyle(currentStyle, cell.style)) {
      result += `${stylePrefix(currentStyle)}${run}${styleSuffix(currentStyle)}`;
      run = "";
      currentStyle = cell.style;
    }
    run += cell.char;
  }
  result += `${stylePrefix(currentStyle)}${run}${styleSuffix(currentStyle)}`;
  return result.trimEnd();
}
function screenToPreview(screen) {
  return screen.lines.map(renderLine).join("\n").trim();
}

// src/utils/pty/terminalScreenRenderer.ts
function applySgr(renderer, sgr) {
  const codes = sgr.split(";").map((part) => Number.parseInt(part || "0", 10)).filter((code) => !Number.isNaN(code));
  if (codes.length === 0 || codes.includes(0)) {
    renderer.currentStyle = {};
  }
  for (const code of codes) {
    if (code >= 30 && code <= 37) {
      renderer.currentStyle.fg = code;
    }
  }
}
function writeStyledChar(renderer, char) {
  writeCharToScreen(renderer.screen, char, renderer.currentStyle);
}
function consumeCsiSequence(renderer, input) {
  let index = 2;
  while (index < input.length) {
    const char = input[index];
    const isFinalByte = char >= "A" && char <= "Z" || char >= "a" && char <= "z";
    if (isFinalByte) {
      const params = input.slice(2, index);
      const command = char;
      if (command === "m") {
        applySgr(renderer, params);
      }
      renderer.pendingEscapeBuffer = "";
      return index + 1;
    }
    index += 1;
  }
  renderer.pendingEscapeBuffer = input;
  return input.length;
}
function consumeOscSequence(renderer, input) {
  let index = 2;
  while (index < input.length) {
    const char = input[index];
    if (char === "\x07") {
      renderer.pendingEscapeBuffer = "";
      return index + 1;
    }
    if (char === "\x1B" && input[index + 1] === "\\") {
      renderer.pendingEscapeBuffer = "";
      return index + 2;
    }
    index += 1;
  }
  renderer.pendingEscapeBuffer = input;
  return input.length;
}
function consumeAnsiSequence(renderer, input) {
  if (input[0] !== "\x1B") {
    return 0;
  }
  if (input[1] === "[") {
    return consumeCsiSequence(renderer, input);
  }
  if (input[1] === "]") {
    return consumeOscSequence(renderer, input);
  }
  return 1;
}
function createTerminalScreenRenderer(cols, rows) {
  return {
    cols,
    rows,
    screen: createTerminalScreen(cols, rows),
    currentStyle: {},
    pendingEscapeBuffer: ""
  };
}
function applyTerminalOutput(renderer, text) {
  let input = renderer.pendingEscapeBuffer + text;
  renderer.pendingEscapeBuffer = "";
  while (input.length > 0) {
    if (input[0] === "\x1B") {
      const consumed = consumeAnsiSequence(renderer, input);
      if (consumed === input.length && renderer.pendingEscapeBuffer) {
        return;
      }
      input = input.slice(consumed);
      continue;
    }
    const char = input[0];
    input = input.slice(1);
    if (char === "\r") {
      moveCursorToColumn(renderer.screen, 0);
      continue;
    }
    if (char === "\n") {
      moveCursorToNextRow(renderer.screen);
      continue;
    }
    writeStyledChar(renderer, char);
  }
}
function resizeTerminalScreenRenderer(renderer, cols, rows) {
  renderer.cols = cols;
  renderer.rows = rows;
  renderer.screen.cols = cols;
  renderer.screen.rows = rows;
}
function renderedPreview(renderer) {
  return screenToPreview(renderer.screen);
}

// src/utils/pty/PtySessionManager.ts
var PtySessionManager = class {
  driver;
  exitedSessionTtlMs;
  maxBufferedChunks;
  sessions = /* @__PURE__ */ new Map();
  nextSessionId = 1;
  constructor(options) {
    this.driver = options.driver;
    this.exitedSessionTtlMs = options.exitedSessionTtlMs ?? 6e4;
    this.maxBufferedChunks = options.maxBufferedChunks ?? Number.POSITIVE_INFINITY;
  }
  open(options) {
    const sessionId = `session-${this.nextSessionId++}`;
    const startedAt = Date.now();
    const cols = options.cols ?? INITIAL_TERMINAL_SIZE.cols;
    const rows = options.rows ?? INITIAL_TERMINAL_SIZE.rows;
    const status = this.driver.open({
      args: options.args,
      command: options.command,
      cols,
      cwd: options.cwd,
      env: options.env,
      rows,
      sessionId
    });
    const record = {
      cols,
      cwd: options.cwd,
      lastActivityAt: startedAt,
      lowestAvailableCursor: 0,
      nextCursor: 0,
      rows,
      sessionId,
      startedAt,
      state: status.state,
      truncatedBeforeCursor: false
    };
    this.applyDriverStatus(record, status);
    this.sessions.set(sessionId, {
      outputChunks: [],
      record,
      renderer: createTerminalScreenRenderer(cols, rows)
    });
    return this.cloneRecord(record);
  }
  write(sessionId, data) {
    this.reapExpiredSessions();
    const session = this.getWritableSession(sessionId);
    session.record.lastActivityAt = Date.now();
    const output = this.driver.write(sessionId, data);
    this.appendOutput(session, output);
  }
  read(sessionId, cursor) {
    this.reapExpiredSessions();
    const session = this.getSession(sessionId);
    this.drainDriverOutput(sessionId, session);
    const effectiveCursor = Math.max(cursor, session.record.lowestAvailableCursor);
    return {
      chunks: session.outputChunks.filter((chunk) => chunk.end > effectiveCursor).map((chunk) => {
        if (chunk.start >= effectiveCursor) {
          return { ...chunk };
        }
        const offset = effectiveCursor - chunk.start;
        const buffer = Buffer.from(chunk.text, "utf8");
        const sliced = buffer.subarray(offset);
        return {
          ...chunk,
          start: effectiveCursor,
          text: sliced.toString("utf8")
        };
      }),
      lowestAvailableCursor: session.record.lowestAvailableCursor,
      nextCursor: session.record.nextCursor,
      truncatedBeforeCursor: cursor < session.record.lowestAvailableCursor
    };
  }
  status(sessionId) {
    this.reapExpiredSessions();
    const session = this.getSession(sessionId);
    this.drainDriverOutput(sessionId, session);
    this.applyDriverStatus(session.record, this.driver.status(sessionId));
    return this.cloneRecord(session.record);
  }
  getRenderedPreview(sessionId) {
    this.reapExpiredSessions();
    const session = this.getSession(sessionId);
    this.drainDriverOutput(sessionId, session);
    return renderedPreview(session.renderer);
  }
  resize(sessionId, cols, rows) {
    this.reapExpiredSessions();
    const session = this.getWritableSession(sessionId);
    this.driver.resize?.(sessionId, cols, rows);
    session.record.cols = cols;
    session.record.rows = rows;
    resizeTerminalScreenRenderer(session.renderer, cols, rows);
    session.record.lastActivityAt = Date.now();
    return this.cloneRecord(session.record);
  }
  signal(sessionId, signal) {
    this.reapExpiredSessions();
    const session = this.getWritableSession(sessionId);
    session.record.lastActivityAt = Date.now();
    if (signal === "SIGINT") {
      this.write(sessionId, "");
      return this.status(sessionId);
    }
    const status = this.driver.kill?.(sessionId, signal) ?? this.driver.close(sessionId);
    this.applyDriverStatus(session.record, status);
    return this.cloneRecord(session.record);
  }
  close(sessionId, _force = false) {
    this.reapExpiredSessions();
    const session = this.getSession(sessionId);
    this.applyDriverStatus(session.record, this.driver.close(sessionId));
    session.record.lastActivityAt = Date.now();
    return this.cloneRecord(session.record);
  }
  reapExpiredSessions(now = Date.now()) {
    for (const [sessionId, session] of this.sessions) {
      if (session.record.state !== "closed" && session.record.state !== "exited") {
        continue;
      }
      if (now - session.record.lastActivityAt >= this.exitedSessionTtlMs) {
        this.sessions.delete(sessionId);
      }
    }
  }
  appendOutput(session, output) {
    if (!output) {
      return;
    }
    const start = session.record.nextCursor;
    const end = start + Buffer.byteLength(output.text, "utf8");
    session.outputChunks.push({
      ...output,
      start,
      end
    });
    applyTerminalOutput(session.renderer, output.text);
    session.record.nextCursor = end;
    session.record.lastActivityAt = Date.now();
    this.trimBuffer(session);
  }
  drainDriverOutput(sessionId, session) {
    while (true) {
      const output = this.driver.write(sessionId, "");
      if (!output) {
        break;
      }
      this.appendOutput(session, output);
    }
  }
  trimBuffer(session) {
    while (session.outputChunks.length > this.maxBufferedChunks) {
      const removedChunk = session.outputChunks.shift();
      if (!removedChunk) {
        break;
      }
      session.record.lowestAvailableCursor = removedChunk.end;
      session.record.truncatedBeforeCursor = true;
    }
  }
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown PTY session: ${sessionId}`);
    }
    return session;
  }
  getWritableSession(sessionId) {
    const session = this.getSession(sessionId);
    if (session.record.state === "closed" || session.record.state === "exited") {
      throw new Error(`SESSION_ALREADY_CLOSED: ${sessionId}`);
    }
    return session;
  }
  applyDriverStatus(record, status) {
    record.state = status.state;
    record.exitCode = status.exitCode;
    record.exitedAt = status.exitedAt;
    record.pid = status.pid;
    record.signal = status.signal;
  }
  cloneRecord(record) {
    return {
      ...record
    };
  }
};

// src/utils/pty/nodePtyDriver.integration.test.ts
async function waitFor(predicate, timeoutMs = 1500) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
test("node-pty driver starts the resolved interactive terminal shell and emits output", async () => {
  const driver = createNodePtyDriver();
  const shell = resolveInteractiveTerminalCommand();
  const sessionId = "term_test";
  assert.equal(driver.resolveDefaultCommand(), shell);
  driver.open({
    command: shell,
    args: shell.endsWith("pwsh") || shell === "powershell" ? ["-NoLogo"] : [],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    sessionId
  });
  let output = "";
  driver.write(
    sessionId,
    shell.endsWith("pwsh") || shell === "powershell" ? "Write-Output PTY_OK\r" : "echo PTY_OK\r"
  );
  await waitFor(() => {
    const chunk = driver.write(sessionId, "");
    if (chunk?.text) {
      output += chunk.text;
    }
    return /PTY_OK/.test(output);
  });
  assert.match(output, /PTY_OK/);
  const closed = driver.close(sessionId);
  assert.equal(closed.state, "closed");
});
test("falls back from invalid SHELL to configured/default shell command", () => {
  const originalShell = process.env.SHELL;
  try {
    process.env.SHELL = "/definitely/missing-shell";
    const fallback = resolveDefaultShell() === "powershell" ? "powershell" : "bash";
    assert.equal(resolveInteractiveTerminalCommand(), fallback);
  } finally {
    if (originalShell === void 0) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
  }
});
test("node-pty driver starts an explicit bash command with explicit args", async () => {
  const driver = createNodePtyDriver();
  const sessionId = "term_explicit_bash";
  driver.open({
    command: "bash",
    args: ["--noprofile", "--norc"],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    sessionId
  });
  let output = "";
  driver.write(sessionId, "echo PTY_EXPLICIT_OK\r");
  await waitFor(() => {
    const chunk = driver.write(sessionId, "");
    if (chunk?.text) {
      output += chunk.text;
    }
    return /PTY_EXPLICIT_OK/.test(output);
  });
  assert.match(output, /PTY_EXPLICIT_OK/);
  const closed = driver.close(sessionId);
  assert.equal(closed.state, "closed");
});
test("node-pty driver throws when the explicit command cannot be resolved", () => {
  const driver = createNodePtyDriver();
  assert.throws(
    () => {
      driver.open({
        command: "definitely-not-found-bin",
        args: [],
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        sessionId: "term_missing_bin"
      });
    },
    /Unable to resolve terminal command: definitely-not-found-bin/
  );
});
test("supports a real interrupt flow against a live PTY shell", async () => {
  const driver = createNodePtyDriver();
  const manager = new PtySessionManager({
    driver,
    maxBufferedChunks: 64,
    exitedSessionTtlMs: 6e4
  });
  const opened = manager.open({
    command: resolveInteractiveTerminalCommand(),
    args: [],
    cwd: process.cwd(),
    cols: 80,
    rows: 24
  });
  manager.write(opened.sessionId, "sleep 5\r");
  const signaled = manager.signal(opened.sessionId, "SIGINT");
  assert.equal(typeof signaled.state, "string");
  const closed = manager.close(opened.sessionId, false);
  assert.equal(closed.state, "closed");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3V0aWxzL3B0eS9ub2RlUHR5RHJpdmVyLmludGVncmF0aW9uLnRlc3QudHMiLCAiLi4vc3JjL3V0aWxzL3NoZWxsL3Jlc29sdmVEZWZhdWx0U2hlbGwudHMiLCAiLi4vc3JjL3V0aWxzL3B0eS9ub2RlUHR5RHJpdmVyLnRzIiwgIi4uL3NyYy91dGlscy9wdHkvdHlwZXMudHMiLCAiLi4vc3JjL3V0aWxzL3B0eS90ZXJtaW5hbFNjcmVlbi50cyIsICIuLi9zcmMvdXRpbHMvcHR5L3Rlcm1pbmFsU2NyZWVuVG9QcmV2aWV3LnRzIiwgIi4uL3NyYy91dGlscy9wdHkvdGVybWluYWxTY3JlZW5SZW5kZXJlci50cyIsICIuLi9zcmMvdXRpbHMvcHR5L1B0eVNlc3Npb25NYW5hZ2VyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCdcbmltcG9ydCB0ZXN0IGZyb20gJ25vZGU6dGVzdCdcblxuaW1wb3J0IHtcbiAgcmVzb2x2ZURlZmF1bHRTaGVsbCxcbiAgcmVzb2x2ZUludGVyYWN0aXZlVGVybWluYWxDb21tYW5kLFxufSBmcm9tICcuLi9zaGVsbC9yZXNvbHZlRGVmYXVsdFNoZWxsLmpzJ1xuaW1wb3J0IHsgY3JlYXRlTm9kZVB0eURyaXZlciB9IGZyb20gJy4vbm9kZVB0eURyaXZlci5qcydcbmltcG9ydCB7IFB0eVNlc3Npb25NYW5hZ2VyIH0gZnJvbSAnLi9QdHlTZXNzaW9uTWFuYWdlci5qcydcblxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvcihwcmVkaWNhdGU6ICgpID0+IGJvb2xlYW4sIHRpbWVvdXRNcyA9IDE1MDApOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgc3RhcnQgPSBEYXRlLm5vdygpXG4gIHdoaWxlICghcHJlZGljYXRlKCkpIHtcbiAgICBpZiAoRGF0ZS5ub3coKSAtIHN0YXJ0ID4gdGltZW91dE1zKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ3dhaXRGb3IgdGltZW91dCcpXG4gICAgfVxuICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCAyNSkpXG4gIH1cbn1cblxudGVzdCgnbm9kZS1wdHkgZHJpdmVyIHN0YXJ0cyB0aGUgcmVzb2x2ZWQgaW50ZXJhY3RpdmUgdGVybWluYWwgc2hlbGwgYW5kIGVtaXRzIG91dHB1dCcsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgZHJpdmVyID0gY3JlYXRlTm9kZVB0eURyaXZlcigpXG4gIGNvbnN0IHNoZWxsID0gcmVzb2x2ZUludGVyYWN0aXZlVGVybWluYWxDb21tYW5kKClcbiAgY29uc3Qgc2Vzc2lvbklkID0gJ3Rlcm1fdGVzdCdcblxuICBhc3NlcnQuZXF1YWwoZHJpdmVyLnJlc29sdmVEZWZhdWx0Q29tbWFuZCgpLCBzaGVsbClcblxuICBkcml2ZXIub3Blbih7XG4gICAgY29tbWFuZDogc2hlbGwsXG4gICAgYXJnczogc2hlbGwuZW5kc1dpdGgoJ3B3c2gnKSB8fCBzaGVsbCA9PT0gJ3Bvd2Vyc2hlbGwnID8gWyctTm9Mb2dvJ10gOiBbXSxcbiAgICBjd2Q6IHByb2Nlc3MuY3dkKCksXG4gICAgY29sczogODAsXG4gICAgcm93czogMjQsXG4gICAgc2Vzc2lvbklkLFxuICB9KVxuXG4gIGxldCBvdXRwdXQgPSAnJ1xuICBkcml2ZXIud3JpdGUoXG4gICAgc2Vzc2lvbklkLFxuICAgIHNoZWxsLmVuZHNXaXRoKCdwd3NoJykgfHwgc2hlbGwgPT09ICdwb3dlcnNoZWxsJ1xuICAgICAgPyAnV3JpdGUtT3V0cHV0IFBUWV9PS1xccidcbiAgICAgIDogJ2VjaG8gUFRZX09LXFxyJyxcbiAgKVxuXG4gIGF3YWl0IHdhaXRGb3IoKCkgPT4ge1xuICAgIGNvbnN0IGNodW5rID0gZHJpdmVyLndyaXRlKHNlc3Npb25JZCwgJycpXG4gICAgaWYgKGNodW5rPy50ZXh0KSB7XG4gICAgICBvdXRwdXQgKz0gY2h1bmsudGV4dFxuICAgIH1cbiAgICByZXR1cm4gL1BUWV9PSy8udGVzdChvdXRwdXQpXG4gIH0pXG5cbiAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgL1BUWV9PSy8pXG5cbiAgY29uc3QgY2xvc2VkID0gZHJpdmVyLmNsb3NlKHNlc3Npb25JZClcbiAgYXNzZXJ0LmVxdWFsKGNsb3NlZC5zdGF0ZSwgJ2Nsb3NlZCcpXG59KVxuXG50ZXN0KCdmYWxscyBiYWNrIGZyb20gaW52YWxpZCBTSEVMTCB0byBjb25maWd1cmVkL2RlZmF1bHQgc2hlbGwgY29tbWFuZCcsICgpID0+IHtcbiAgY29uc3Qgb3JpZ2luYWxTaGVsbCA9IHByb2Nlc3MuZW52LlNIRUxMXG5cbiAgdHJ5IHtcbiAgICBwcm9jZXNzLmVudi5TSEVMTCA9ICcvZGVmaW5pdGVseS9taXNzaW5nLXNoZWxsJ1xuICAgIGNvbnN0IGZhbGxiYWNrID0gcmVzb2x2ZURlZmF1bHRTaGVsbCgpID09PSAncG93ZXJzaGVsbCcgPyAncG93ZXJzaGVsbCcgOiAnYmFzaCdcbiAgICBhc3NlcnQuZXF1YWwocmVzb2x2ZUludGVyYWN0aXZlVGVybWluYWxDb21tYW5kKCksIGZhbGxiYWNrKVxuICB9IGZpbmFsbHkge1xuICAgIGlmIChvcmlnaW5hbFNoZWxsID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5TSEVMTFxuICAgIH0gZWxzZSB7XG4gICAgICBwcm9jZXNzLmVudi5TSEVMTCA9IG9yaWdpbmFsU2hlbGxcbiAgICB9XG4gIH1cbn0pXG5cbnRlc3QoJ25vZGUtcHR5IGRyaXZlciBzdGFydHMgYW4gZXhwbGljaXQgYmFzaCBjb21tYW5kIHdpdGggZXhwbGljaXQgYXJncycsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgZHJpdmVyID0gY3JlYXRlTm9kZVB0eURyaXZlcigpXG4gIGNvbnN0IHNlc3Npb25JZCA9ICd0ZXJtX2V4cGxpY2l0X2Jhc2gnXG5cbiAgZHJpdmVyLm9wZW4oe1xuICAgIGNvbW1hbmQ6ICdiYXNoJyxcbiAgICBhcmdzOiBbJy0tbm9wcm9maWxlJywgJy0tbm9yYyddLFxuICAgIGN3ZDogcHJvY2Vzcy5jd2QoKSxcbiAgICBjb2xzOiA4MCxcbiAgICByb3dzOiAyNCxcbiAgICBzZXNzaW9uSWQsXG4gIH0pXG5cbiAgbGV0IG91dHB1dCA9ICcnXG4gIGRyaXZlci53cml0ZShzZXNzaW9uSWQsICdlY2hvIFBUWV9FWFBMSUNJVF9PS1xccicpXG5cbiAgYXdhaXQgd2FpdEZvcigoKSA9PiB7XG4gICAgY29uc3QgY2h1bmsgPSBkcml2ZXIud3JpdGUoc2Vzc2lvbklkLCAnJylcbiAgICBpZiAoY2h1bms/LnRleHQpIHtcbiAgICAgIG91dHB1dCArPSBjaHVuay50ZXh0XG4gICAgfVxuICAgIHJldHVybiAvUFRZX0VYUExJQ0lUX09LLy50ZXN0KG91dHB1dClcbiAgfSlcblxuICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvUFRZX0VYUExJQ0lUX09LLylcblxuICBjb25zdCBjbG9zZWQgPSBkcml2ZXIuY2xvc2Uoc2Vzc2lvbklkKVxuICBhc3NlcnQuZXF1YWwoY2xvc2VkLnN0YXRlLCAnY2xvc2VkJylcbn0pXG5cbnRlc3QoJ25vZGUtcHR5IGRyaXZlciB0aHJvd3Mgd2hlbiB0aGUgZXhwbGljaXQgY29tbWFuZCBjYW5ub3QgYmUgcmVzb2x2ZWQnLCAoKSA9PiB7XG4gIGNvbnN0IGRyaXZlciA9IGNyZWF0ZU5vZGVQdHlEcml2ZXIoKVxuXG4gIGFzc2VydC50aHJvd3MoXG4gICAgKCkgPT4ge1xuICAgICAgZHJpdmVyLm9wZW4oe1xuICAgICAgICBjb21tYW5kOiAnZGVmaW5pdGVseS1ub3QtZm91bmQtYmluJyxcbiAgICAgICAgYXJnczogW10sXG4gICAgICAgIGN3ZDogcHJvY2Vzcy5jd2QoKSxcbiAgICAgICAgY29sczogODAsXG4gICAgICAgIHJvd3M6IDI0LFxuICAgICAgICBzZXNzaW9uSWQ6ICd0ZXJtX21pc3NpbmdfYmluJyxcbiAgICAgIH0pXG4gICAgfSxcbiAgICAvVW5hYmxlIHRvIHJlc29sdmUgdGVybWluYWwgY29tbWFuZDogZGVmaW5pdGVseS1ub3QtZm91bmQtYmluLyxcbiAgKVxufSlcblxudGVzdCgnc3VwcG9ydHMgYSByZWFsIGludGVycnVwdCBmbG93IGFnYWluc3QgYSBsaXZlIFBUWSBzaGVsbCcsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgZHJpdmVyID0gY3JlYXRlTm9kZVB0eURyaXZlcigpXG4gIGNvbnN0IG1hbmFnZXIgPSBuZXcgUHR5U2Vzc2lvbk1hbmFnZXIoe1xuICAgIGRyaXZlcixcbiAgICBtYXhCdWZmZXJlZENodW5rczogNjQsXG4gICAgZXhpdGVkU2Vzc2lvblR0bE1zOiA2MF8wMDAsXG4gIH0pXG5cbiAgY29uc3Qgb3BlbmVkID0gbWFuYWdlci5vcGVuKHtcbiAgICBjb21tYW5kOiByZXNvbHZlSW50ZXJhY3RpdmVUZXJtaW5hbENvbW1hbmQoKSxcbiAgICBhcmdzOiBbXSxcbiAgICBjd2Q6IHByb2Nlc3MuY3dkKCksXG4gICAgY29sczogODAsXG4gICAgcm93czogMjQsXG4gIH0pXG5cbiAgbWFuYWdlci53cml0ZShvcGVuZWQuc2Vzc2lvbklkLCAnc2xlZXAgNVxccicpXG4gIGNvbnN0IHNpZ25hbGVkID0gbWFuYWdlci5zaWduYWwob3BlbmVkLnNlc3Npb25JZCwgJ1NJR0lOVCcpXG5cbiAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBzaWduYWxlZC5zdGF0ZSwgJ3N0cmluZycpXG5cbiAgY29uc3QgY2xvc2VkID0gbWFuYWdlci5jbG9zZShvcGVuZWQuc2Vzc2lvbklkLCBmYWxzZSlcbiAgYXNzZXJ0LmVxdWFsKGNsb3NlZC5zdGF0ZSwgJ2Nsb3NlZCcpXG59KVxuIiwgImltcG9ydCB7IGFjY2Vzc1N5bmMsIGNvbnN0YW50cyBhcyBmc0NvbnN0YW50cyB9IGZyb20gJ25vZGU6ZnMnXG5pbXBvcnQgeyBkZWxpbWl0ZXIsIGlzQWJzb2x1dGUsIGpvaW4gfSBmcm9tICdub2RlOnBhdGgnXG5pbXBvcnQgeyBjcmVhdGVSZXF1aXJlIH0gZnJvbSAnbm9kZTptb2R1bGUnXG5cbmNvbnN0IHJlcXVpcmUgPSBjcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybClcblxudHlwZSBTaGVsbFNldHRpbmdzID0ge1xuICBkZWZhdWx0U2hlbGw/OiAnYmFzaCcgfCAncG93ZXJzaGVsbCdcbn1cblxuZnVuY3Rpb24gdHJ5R2V0SW5pdGlhbFNldHRpbmdzKCk6IFNoZWxsU2V0dGluZ3MgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVxdWlyZSgnLi4vc2V0dGluZ3Mvc2V0dGluZ3MuanMnKS5nZXRJbml0aWFsU2V0dGluZ3MoKVxuICB9IGNhdGNoIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHJlcXVpcmUoJy4uL3NldHRpbmdzL3NldHRpbmdzLnRzJykuZ2V0SW5pdGlhbFNldHRpbmdzKClcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBudWxsXG4gICAgfVxuICB9XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgZGVmYXVsdCBzaGVsbCBmb3IgaW5wdXQtYm94IGAhYCBjb21tYW5kcy5cbiAqXG4gKiBSZXNvbHV0aW9uIG9yZGVyIChkb2NzL2Rlc2lnbi9wcy1zaGVsbC1zZWxlY3Rpb24ubWQgXHUwMEE3NC4yKTpcbiAqICAgc2V0dGluZ3MuZGVmYXVsdFNoZWxsIFx1MjE5MiAnYmFzaCdcbiAqXG4gKiBQbGF0Zm9ybSBkZWZhdWx0IGlzICdiYXNoJyBldmVyeXdoZXJlIFx1MjAxNCB3ZSBkbyBOT1QgYXV0by1mbGlwIFdpbmRvd3MgdG9cbiAqIFBvd2VyU2hlbGwgKHdvdWxkIGJyZWFrIGV4aXN0aW5nIFdpbmRvd3MgdXNlcnMgd2l0aCBiYXNoIGhvb2tzKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVEZWZhdWx0U2hlbGwoKTogJ2Jhc2gnIHwgJ3Bvd2Vyc2hlbGwnIHtcbiAgcmV0dXJuIHRyeUdldEluaXRpYWxTZXR0aW5ncygpPy5kZWZhdWx0U2hlbGwgPz8gJ2Jhc2gnXG59XG5cbmZ1bmN0aW9uIGlzRXhlY3V0YWJsZUNvbW1hbmQoY29tbWFuZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmICghY29tbWFuZCkge1xuICAgIHJldHVybiBmYWxzZVxuICB9XG5cbiAgdHJ5IHtcbiAgICBpZiAoaXNBYnNvbHV0ZShjb21tYW5kKSkge1xuICAgICAgYWNjZXNzU3luYyhjb21tYW5kLCBmc0NvbnN0YW50cy5YX09LKVxuICAgICAgcmV0dXJuIHRydWVcbiAgICB9XG5cbiAgICBjb25zdCBwYXRoRW50cmllcyA9IChwcm9jZXNzLmVudi5QQVRIID8/ICcnKS5zcGxpdChkZWxpbWl0ZXIpLmZpbHRlcihCb29sZWFuKVxuICAgIGZvciAoY29uc3QgZW50cnkgb2YgcGF0aEVudHJpZXMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGFjY2Vzc1N5bmMoam9pbihlbnRyeSwgY29tbWFuZCksIGZzQ29uc3RhbnRzLlhfT0spXG4gICAgICAgIHJldHVybiB0cnVlXG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gVHJ5IG5leHQgUEFUSCBlbnRyeS5cbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZVxuICB9XG5cbiAgcmV0dXJuIGZhbHNlXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlSW50ZXJhY3RpdmVUZXJtaW5hbENvbW1hbmQoKTogc3RyaW5nIHtcbiAgY29uc3QgZW52U2hlbGwgPSBwcm9jZXNzLmVudi5TSEVMTD8udHJpbSgpXG4gIGlmIChlbnZTaGVsbCAmJiBpc0V4ZWN1dGFibGVDb21tYW5kKGVudlNoZWxsKSkge1xuICAgIHJldHVybiBlbnZTaGVsbFxuICB9XG5cbiAgY29uc3QgZmFsbGJhY2tTaGVsbCA9XG4gICAgcmVzb2x2ZURlZmF1bHRTaGVsbCgpID09PSAncG93ZXJzaGVsbCcgPyAncG93ZXJzaGVsbCcgOiAnYmFzaCdcbiAgaWYgKGlzRXhlY3V0YWJsZUNvbW1hbmQoZmFsbGJhY2tTaGVsbCkpIHtcbiAgICByZXR1cm4gZmFsbGJhY2tTaGVsbFxuICB9XG5cbiAgcmV0dXJuICdiYXNoJ1xufVxuIiwgImltcG9ydCB7IGFjY2Vzc1N5bmMsIGNobW9kU3luYywgY29uc3RhbnRzIGFzIGZzQ29uc3RhbnRzIH0gZnJvbSAnbm9kZTpmcydcbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tICdub2RlOm1vZHVsZSdcbmltcG9ydCB7IGRlbGltaXRlciwgZGlybmFtZSwgaXNBYnNvbHV0ZSwgam9pbiB9IGZyb20gJ25vZGU6cGF0aCdcbmltcG9ydCBwdHkgZnJvbSAnbm9kZS1wdHknXG5pbXBvcnQgeyByZXNvbHZlSW50ZXJhY3RpdmVUZXJtaW5hbENvbW1hbmQgfSBmcm9tICcuLi9zaGVsbC9yZXNvbHZlRGVmYXVsdFNoZWxsLmpzJ1xuaW1wb3J0IHR5cGUge1xuICBQdHlEcml2ZXIsXG4gIFB0eURyaXZlck9wZW5PcHRpb25zLFxuICBQdHlEcml2ZXJTZXNzaW9uU3RhdHVzLFxuICBUZXJtaW5hbE91dHB1dENodW5rLFxufSBmcm9tICcuL3R5cGVzLmpzJ1xuXG5pbnRlcmZhY2UgTm9kZVB0eVNlc3Npb24ge1xuICBvdXRwdXRRdWV1ZTogQXJyYXk8T21pdDxUZXJtaW5hbE91dHB1dENodW5rLCAnc3RhcnQnIHwgJ2VuZCc+PlxuICBwcm9jPzogcHR5LklQdHlcbiAgc3RhdHVzOiBQdHlEcml2ZXJTZXNzaW9uU3RhdHVzXG59XG5cbmZ1bmN0aW9uIGJ1aWxkU2hlbGxBcmdzKGNvbW1hbmQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgaWYgKGNvbW1hbmQgPT09ICdwb3dlcnNoZWxsJyB8fCBjb21tYW5kLmVuZHNXaXRoKCcvcHdzaCcpKSB7XG4gICAgcmV0dXJuIFsnLU5vTG9nbyddXG4gIH1cbiAgcmV0dXJuIFtdXG59XG5cbmZ1bmN0aW9uIGdldEV4ZWN1dGFibGVDYW5kaWRhdGVzKGNvbW1hbmQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3QgYmFzZUNhbmRpZGF0ZXMgPVxuICAgIGNvbW1hbmQgPT09ICdwb3dlcnNoZWxsJyA/IFsncHdzaCcsICdwb3dlcnNoZWxsJ10gOiBbY29tbWFuZF1cblxuICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ3dpbjMyJykge1xuICAgIHJldHVybiBiYXNlQ2FuZGlkYXRlc1xuICB9XG5cbiAgY29uc3QgcGF0aEV4dHMgPSAocHJvY2Vzcy5lbnYuUEFUSEVYVCA/PyAnLkVYRTsuQ01EOy5CQVQ7LkNPTScpXG4gICAgLnNwbGl0KCc7JylcbiAgICAuZmlsdGVyKEJvb2xlYW4pXG5cbiAgcmV0dXJuIGJhc2VDYW5kaWRhdGVzLmZsYXRNYXAoY2FuZGlkYXRlID0+IHtcbiAgICBjb25zdCBsb3dlciA9IGNhbmRpZGF0ZS50b0xvd2VyQ2FzZSgpXG4gICAgaWYgKHBhdGhFeHRzLnNvbWUoZXh0ID0+IGxvd2VyLmVuZHNXaXRoKGV4dC50b0xvd2VyQ2FzZSgpKSkpIHtcbiAgICAgIHJldHVybiBbY2FuZGlkYXRlXVxuICAgIH1cbiAgICByZXR1cm4gW2NhbmRpZGF0ZSwgLi4ucGF0aEV4dHMubWFwKGV4dCA9PiBgJHtjYW5kaWRhdGV9JHtleHQudG9Mb3dlckNhc2UoKX1gKV1cbiAgfSlcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZUNvbW1hbmRQYXRoKGNvbW1hbmQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBnZXRFeGVjdXRhYmxlQ2FuZGlkYXRlcyhjb21tYW5kKVxuXG4gIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICBpZiAoaXNBYnNvbHV0ZShjYW5kaWRhdGUpKSB7XG4gICAgICBhY2Nlc3NTeW5jKGNhbmRpZGF0ZSwgZnNDb25zdGFudHMuWF9PSylcbiAgICAgIHJldHVybiBjYW5kaWRhdGVcbiAgICB9XG5cbiAgICBjb25zdCBwYXRoRW50cmllcyA9IChwcm9jZXNzLmVudi5QQVRIID8/ICcnKS5zcGxpdChkZWxpbWl0ZXIpLmZpbHRlcihCb29sZWFuKVxuICAgIGZvciAoY29uc3QgZW50cnkgb2YgcGF0aEVudHJpZXMpIHtcbiAgICAgIGNvbnN0IGZ1bGxQYXRoID0gam9pbihlbnRyeSwgY2FuZGlkYXRlKVxuICAgICAgdHJ5IHtcbiAgICAgICAgYWNjZXNzU3luYyhmdWxsUGF0aCwgZnNDb25zdGFudHMuWF9PSylcbiAgICAgICAgcmV0dXJuIGZ1bGxQYXRoXG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gVHJ5IG5leHQgY2FuZGlkYXRlL3BhdGguXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgdGhyb3cgbmV3IEVycm9yKGBVbmFibGUgdG8gcmVzb2x2ZSB0ZXJtaW5hbCBjb21tYW5kOiAke2NvbW1hbmR9YClcbn1cblxuZnVuY3Rpb24gZW5zdXJlU3Bhd25IZWxwZXJFeGVjdXRhYmxlKCk6IHZvaWQge1xuICBjb25zdCByZXF1aXJlID0gY3JlYXRlUmVxdWlyZShpbXBvcnQubWV0YS51cmwpXG4gIGNvbnN0IHBhY2thZ2VKc29uUGF0aCA9IHJlcXVpcmUucmVzb2x2ZSgnbm9kZS1wdHkvcGFja2FnZS5qc29uJylcbiAgY29uc3QgcGFja2FnZURpciA9IGRpcm5hbWUocGFja2FnZUpzb25QYXRoKVxuICBjb25zdCBoZWxwZXJQYXRoID0gam9pbihcbiAgICBwYWNrYWdlRGlyLFxuICAgICdwcmVidWlsZHMnLFxuICAgIGAke3Byb2Nlc3MucGxhdGZvcm19LSR7cHJvY2Vzcy5hcmNofWAsXG4gICAgJ3NwYXduLWhlbHBlcicsXG4gIClcblxuICB0cnkge1xuICAgIGFjY2Vzc1N5bmMoaGVscGVyUGF0aCwgZnNDb25zdGFudHMuWF9PSylcbiAgfSBjYXRjaCB7XG4gICAgY2htb2RTeW5jKGhlbHBlclBhdGgsIDBvNzU1KVxuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVOb2RlUHR5RHJpdmVyKCk6IFB0eURyaXZlciAmIHtcbiAgcmVzb2x2ZURlZmF1bHRDb21tYW5kKCk6IHN0cmluZ1xufSB7XG4gIGVuc3VyZVNwYXduSGVscGVyRXhlY3V0YWJsZSgpXG4gIGNvbnN0IHNlc3Npb25zID0gbmV3IE1hcDxzdHJpbmcsIE5vZGVQdHlTZXNzaW9uPigpXG5cbiAgcmV0dXJuIHtcbiAgICByZXNvbHZlRGVmYXVsdENvbW1hbmQoKSB7XG4gICAgICByZXR1cm4gcmVzb2x2ZUludGVyYWN0aXZlVGVybWluYWxDb21tYW5kKClcbiAgICB9LFxuXG4gICAgb3BlbihvcHRpb25zOiBQdHlEcml2ZXJPcGVuT3B0aW9ucyk6IFB0eURyaXZlclNlc3Npb25TdGF0dXMge1xuICAgICAgY29uc3QgY29tbWFuZCA9IG9wdGlvbnMuY29tbWFuZCA/PyByZXNvbHZlSW50ZXJhY3RpdmVUZXJtaW5hbENvbW1hbmQoKVxuICAgICAgY29uc3QgcmVzb2x2ZWRDb21tYW5kID0gcmVzb2x2ZUNvbW1hbmRQYXRoKGNvbW1hbmQpXG4gICAgICBjb25zdCBhcmdzID0gb3B0aW9ucy5hcmdzID8/IGJ1aWxkU2hlbGxBcmdzKGNvbW1hbmQpXG4gICAgICBjb25zdCBwcm9jID0gcHR5LnNwYXduKHJlc29sdmVkQ29tbWFuZCwgYXJncywge1xuICAgICAgICBuYW1lOiAneHRlcm0tY29sb3InLFxuICAgICAgICBjb2xzOiBvcHRpb25zLmNvbHMsXG4gICAgICAgIHJvd3M6IG9wdGlvbnMucm93cyxcbiAgICAgICAgY3dkOiBvcHRpb25zLmN3ZCxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgLi4ucHJvY2Vzcy5lbnYsXG4gICAgICAgICAgLi4uKG9wdGlvbnMuZW52ID8/IHt9KSxcbiAgICAgICAgfSxcbiAgICAgIH0pXG5cbiAgICAgIGNvbnN0IHNlc3Npb246IE5vZGVQdHlTZXNzaW9uID0ge1xuICAgICAgICBvdXRwdXRRdWV1ZTogW10sXG4gICAgICAgIHByb2MsXG4gICAgICAgIHN0YXR1czoge1xuICAgICAgICAgIHN0YXRlOiAncnVubmluZycsXG4gICAgICAgICAgcGlkOiBwcm9jLnBpZCxcbiAgICAgICAgfSxcbiAgICAgIH1cblxuICAgICAgcHJvYy5vbkRhdGEodGV4dCA9PiB7XG4gICAgICAgIHNlc3Npb24ub3V0cHV0UXVldWUucHVzaCh7XG4gICAgICAgICAgdGV4dCxcbiAgICAgICAgICBzdHJlYW06ICdzdGRvdXQnLFxuICAgICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgICAgfSlcbiAgICAgIH0pXG5cbiAgICAgIHByb2Mub25FeGl0KGV2ZW50ID0+IHtcbiAgICAgICAgc2Vzc2lvbi5zdGF0dXMgPSB7XG4gICAgICAgICAgc3RhdGU6ICdjbG9zZWQnLFxuICAgICAgICAgIGV4aXRDb2RlOiBldmVudC5leGl0Q29kZSxcbiAgICAgICAgICBleGl0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgICAgICBzaWduYWw6IGV2ZW50LnNpZ25hbCA/IFN0cmluZyhldmVudC5zaWduYWwpIGFzIE5vZGVKUy5TaWduYWxzIDogbnVsbCxcbiAgICAgICAgfVxuICAgICAgfSlcblxuICAgICAgc2Vzc2lvbnMuc2V0KG9wdGlvbnMuc2Vzc2lvbklkLCBzZXNzaW9uKVxuICAgICAgcmV0dXJuIHsgLi4uc2Vzc2lvbi5zdGF0dXMgfVxuICAgIH0sXG5cbiAgICB3cml0ZShzZXNzaW9uSWQ6IHN0cmluZywgZGF0YTogc3RyaW5nKSB7XG4gICAgICBjb25zdCBzZXNzaW9uID0gc2Vzc2lvbnMuZ2V0KHNlc3Npb25JZClcbiAgICAgIGlmICghc2Vzc2lvbikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gUFRZIHNlc3Npb246ICR7c2Vzc2lvbklkfWApXG4gICAgICB9XG4gICAgICBpZiAoZGF0YSkge1xuICAgICAgICBzZXNzaW9uLnByb2M/LndyaXRlKGRhdGEpXG4gICAgICB9XG4gICAgICByZXR1cm4gc2Vzc2lvbi5vdXRwdXRRdWV1ZS5zaGlmdCgpID8/IG51bGxcbiAgICB9LFxuXG4gICAgcmVzaXplKHNlc3Npb25JZDogc3RyaW5nLCBjb2xzOiBudW1iZXIsIHJvd3M6IG51bWJlcikge1xuICAgICAgY29uc3Qgc2Vzc2lvbiA9IHNlc3Npb25zLmdldChzZXNzaW9uSWQpXG4gICAgICBpZiAoIXNlc3Npb24pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIFBUWSBzZXNzaW9uOiAke3Nlc3Npb25JZH1gKVxuICAgICAgfVxuICAgICAgc2Vzc2lvbi5wcm9jPy5yZXNpemUoY29scywgcm93cylcbiAgICB9LFxuXG4gICAgc3RhdHVzKHNlc3Npb25JZDogc3RyaW5nKSB7XG4gICAgICBjb25zdCBzZXNzaW9uID0gc2Vzc2lvbnMuZ2V0KHNlc3Npb25JZClcbiAgICAgIGlmICghc2Vzc2lvbikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gUFRZIHNlc3Npb246ICR7c2Vzc2lvbklkfWApXG4gICAgICB9XG4gICAgICByZXR1cm4geyAuLi5zZXNzaW9uLnN0YXR1cyB9XG4gICAgfSxcblxuICAgIGtpbGwoc2Vzc2lvbklkOiBzdHJpbmcsIHNpZ25hbDogJ1NJR0lOVCcgfCAnU0lHVEVSTScpIHtcbiAgICAgIGNvbnN0IHNlc3Npb24gPSBzZXNzaW9ucy5nZXQoc2Vzc2lvbklkKVxuICAgICAgaWYgKCFzZXNzaW9uKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBQVFkgc2Vzc2lvbjogJHtzZXNzaW9uSWR9YClcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBpZCA9IHNlc3Npb24ucHJvYz8ucGlkID8/IHNlc3Npb24uc3RhdHVzLnBpZFxuICAgICAgc2Vzc2lvbi5wcm9jPy5raWxsKHNpZ25hbClcbiAgICAgIHNlc3Npb24ucHJvYyA9IHVuZGVmaW5lZFxuICAgICAgc2Vzc2lvbi5zdGF0dXMgPSB7XG4gICAgICAgIHN0YXRlOiAnY2xvc2VkJyxcbiAgICAgICAgZXhpdENvZGU6IHNpZ25hbCA9PT0gJ1NJR1RFUk0nID8gMTQzIDogMTMwLFxuICAgICAgICBleGl0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgICAgcGlkLFxuICAgICAgICBzaWduYWwsXG4gICAgICB9XG4gICAgICByZXR1cm4geyAuLi5zZXNzaW9uLnN0YXR1cyB9XG4gICAgfSxcblxuICAgIGNsb3NlKHNlc3Npb25JZDogc3RyaW5nKSB7XG4gICAgICBjb25zdCBzZXNzaW9uID0gc2Vzc2lvbnMuZ2V0KHNlc3Npb25JZClcbiAgICAgIGlmICghc2Vzc2lvbikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gUFRZIHNlc3Npb246ICR7c2Vzc2lvbklkfWApXG4gICAgICB9XG4gICAgICBpZiAoc2Vzc2lvbi5zdGF0dXMuc3RhdGUgPT09ICdydW5uaW5nJykge1xuICAgICAgICBjb25zdCBwaWQgPSBzZXNzaW9uLnByb2M/LnBpZCA/PyBzZXNzaW9uLnN0YXR1cy5waWRcbiAgICAgICAgc2Vzc2lvbi5wcm9jPy5raWxsKClcbiAgICAgICAgc2Vzc2lvbi5wcm9jID0gdW5kZWZpbmVkXG4gICAgICAgIHNlc3Npb24uc3RhdHVzID0ge1xuICAgICAgICAgIHN0YXRlOiAnY2xvc2VkJyxcbiAgICAgICAgICBleGl0Q29kZTogc2Vzc2lvbi5zdGF0dXMuZXhpdENvZGUgPz8gMCxcbiAgICAgICAgICBleGl0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgICAgICBwaWQsXG4gICAgICAgICAgc2lnbmFsOiBzZXNzaW9uLnN0YXR1cy5zaWduYWwgPz8gbnVsbCxcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIHsgLi4uc2Vzc2lvbi5zdGF0dXMgfVxuICAgIH0sXG4gIH1cbn1cbiIsICJleHBvcnQgY29uc3QgU0VTU0lPTl9TVEFURVMgPSBbXG4gICdzdGFydGluZycsXG4gICdydW5uaW5nJyxcbiAgJ2V4aXRlZCcsXG4gICdjbG9zZWQnLFxuICAnZmFpbGVkJyxcbl0gYXMgY29uc3RcblxuZXhwb3J0IHR5cGUgVGVybWluYWxTZXNzaW9uU3RhdGUgPSAodHlwZW9mIFNFU1NJT05fU1RBVEVTKVtudW1iZXJdXG5cbmV4cG9ydCBjb25zdCBJTklUSUFMX1RFUk1JTkFMX1NJWkUgPSB7XG4gIGNvbHM6IDEyMCxcbiAgcm93czogMzAsXG59IGFzIGNvbnN0XG5cbmV4cG9ydCBjb25zdCBTUEVDSUFMX0tFWVMgPSBbXG4gICdFTlRFUicsXG4gICdUQUInLFxuICAnRVNDJyxcbiAgJ0JBQ0tTUEFDRScsXG4gICdVUCcsXG4gICdET1dOJyxcbiAgJ0xFRlQnLFxuICAnUklHSFQnLFxuICAnQ1RSTF9DJyxcbiAgJ0NUUkxfRCcsXG4gICdDVFJMX0wnLFxuXSBhcyBjb25zdFxuXG5leHBvcnQgdHlwZSBUZXJtaW5hbFNwZWNpYWxLZXkgPSAodHlwZW9mIFNQRUNJQUxfS0VZUylbbnVtYmVyXVxuXG5leHBvcnQgaW50ZXJmYWNlIFRlcm1pbmFsT3V0cHV0Q2h1bmsge1xuICBzdGFydDogbnVtYmVyXG4gIGVuZDogbnVtYmVyXG4gIHRleHQ6IHN0cmluZ1xuICBzdHJlYW06ICdzdGRvdXQnIHwgJ3N0ZGVycidcbiAgdGltZXN0YW1wOiBudW1iZXJcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUZXJtaW5hbFJlYWRSZXN1bHQge1xuICBjaHVua3M6IFRlcm1pbmFsT3V0cHV0Q2h1bmtbXVxuICBsb3dlc3RBdmFpbGFibGVDdXJzb3I6IG51bWJlclxuICBuZXh0Q3Vyc29yOiBudW1iZXJcbiAgdHJ1bmNhdGVkQmVmb3JlQ3Vyc29yOiBib29sZWFuXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVGVybWluYWxTZXNzaW9uUmVjb3JkIHtcbiAgY29sczogbnVtYmVyXG4gIGN3ZDogc3RyaW5nXG4gIGV4aXRlZEF0PzogbnVtYmVyXG4gIGV4aXRDb2RlPzogbnVtYmVyIHwgbnVsbFxuICBsYXN0QWN0aXZpdHlBdDogbnVtYmVyXG4gIGxvd2VzdEF2YWlsYWJsZUN1cnNvcjogbnVtYmVyXG4gIG5leHRDdXJzb3I6IG51bWJlclxuICBwaWQ/OiBudW1iZXJcbiAgcm93czogbnVtYmVyXG4gIHNlc3Npb25JZDogc3RyaW5nXG4gIHNpZ25hbD86IE5vZGVKUy5TaWduYWxzIHwgbnVsbFxuICBzdGFydGVkQXQ6IG51bWJlclxuICBzdGF0ZTogVGVybWluYWxTZXNzaW9uU3RhdGVcbiAgdHJ1bmNhdGVkQmVmb3JlQ3Vyc29yOiBib29sZWFuXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgT3BlblRlcm1pbmFsU2Vzc2lvbk9wdGlvbnMge1xuICBhcmdzPzogc3RyaW5nW11cbiAgY29scz86IG51bWJlclxuICBjb21tYW5kPzogc3RyaW5nXG4gIGN3ZDogc3RyaW5nXG4gIGVudj86IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbiAgcm93cz86IG51bWJlclxufVxuXG5leHBvcnQgaW50ZXJmYWNlIFB0eURyaXZlck9wZW5PcHRpb25zIHtcbiAgYXJncz86IHN0cmluZ1tdXG4gIGNvbHM6IG51bWJlclxuICBjb21tYW5kPzogc3RyaW5nXG4gIGN3ZDogc3RyaW5nXG4gIGVudj86IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbiAgcm93czogbnVtYmVyXG4gIHNlc3Npb25JZDogc3RyaW5nXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHR5RHJpdmVyU2Vzc2lvblN0YXR1cyB7XG4gIGV4aXRlZEF0PzogbnVtYmVyXG4gIGV4aXRDb2RlPzogbnVtYmVyIHwgbnVsbFxuICBwaWQ/OiBudW1iZXJcbiAgc2lnbmFsPzogTm9kZUpTLlNpZ25hbHMgfCBudWxsXG4gIHN0YXRlOiBUZXJtaW5hbFNlc3Npb25TdGF0ZVxufVxuXG5leHBvcnQgaW50ZXJmYWNlIFB0eURyaXZlciB7XG4gIGNsb3NlKHNlc3Npb25JZDogc3RyaW5nKTogUHR5RHJpdmVyU2Vzc2lvblN0YXR1c1xuICBraWxsPyhzZXNzaW9uSWQ6IHN0cmluZywgc2lnbmFsOiAnU0lHSU5UJyB8ICdTSUdURVJNJyk6IFB0eURyaXZlclNlc3Npb25TdGF0dXNcbiAgb3BlbihvcHRpb25zOiBQdHlEcml2ZXJPcGVuT3B0aW9ucyk6IFB0eURyaXZlclNlc3Npb25TdGF0dXNcbiAgcmVzaXplPyhzZXNzaW9uSWQ6IHN0cmluZywgY29sczogbnVtYmVyLCByb3dzOiBudW1iZXIpOiB2b2lkXG4gIHN0YXR1cyhzZXNzaW9uSWQ6IHN0cmluZyk6IFB0eURyaXZlclNlc3Npb25TdGF0dXNcbiAgd3JpdGUoc2Vzc2lvbklkOiBzdHJpbmcsIGRhdGE6IHN0cmluZyk6IE9taXQ8VGVybWluYWxPdXRwdXRDaHVuaywgJ3N0YXJ0JyB8ICdlbmQnPiB8IG51bGxcbn1cbiIsICJleHBvcnQgdHlwZSBUZXJtaW5hbFNjcmVlbkNlbGwgPSB7XG4gIGNoYXI6IHN0cmluZ1xuICBzdHlsZTogVGVybWluYWxTY3JlZW5TdHlsZVxufVxuXG5leHBvcnQgdHlwZSBUZXJtaW5hbFNjcmVlblN0eWxlID0ge1xuICBmZz86IG51bWJlclxufVxuXG5leHBvcnQgdHlwZSBUZXJtaW5hbFNjcmVlbiA9IHtcbiAgY29sczogbnVtYmVyXG4gIHJvd3M6IG51bWJlclxuICBjdXJzb3JSb3c6IG51bWJlclxuICBjdXJzb3JDb2w6IG51bWJlclxuICBwZW5kaW5nV3JhcDogYm9vbGVhblxuICBsaW5lczogVGVybWluYWxTY3JlZW5DZWxsW11bXVxufVxuXG5mdW5jdGlvbiBjcmVhdGVCbGFua0xpbmUoY29sczogbnVtYmVyKTogVGVybWluYWxTY3JlZW5DZWxsW10ge1xuICByZXR1cm4gQXJyYXkuZnJvbSh7IGxlbmd0aDogY29scyB9LCAoKSA9PiAoeyBjaGFyOiAnICcsIHN0eWxlOiB7fSB9KSlcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVRlcm1pbmFsU2NyZWVuKGNvbHM6IG51bWJlciwgcm93czogbnVtYmVyKTogVGVybWluYWxTY3JlZW4ge1xuICByZXR1cm4ge1xuICAgIGNvbHMsXG4gICAgcm93cyxcbiAgICBjdXJzb3JSb3c6IDAsXG4gICAgY3Vyc29yQ29sOiAwLFxuICAgIHBlbmRpbmdXcmFwOiBmYWxzZSxcbiAgICBsaW5lczogQXJyYXkuZnJvbSh7IGxlbmd0aDogcm93cyB9LCAoKSA9PiBjcmVhdGVCbGFua0xpbmUoY29scykpLFxuICB9XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUJsYW5rQ2VsbChzdHlsZTogVGVybWluYWxTY3JlZW5TdHlsZSA9IHt9KTogVGVybWluYWxTY3JlZW5DZWxsIHtcbiAgcmV0dXJuIHsgY2hhcjogJyAnLCBzdHlsZTogeyAuLi5zdHlsZSB9IH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1vdmVDdXJzb3JUb0NvbHVtbihzY3JlZW46IFRlcm1pbmFsU2NyZWVuLCBjb2w6IG51bWJlcik6IHZvaWQge1xuICBzY3JlZW4ucGVuZGluZ1dyYXAgPSBmYWxzZVxuICBzY3JlZW4uY3Vyc29yQ29sID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oY29sLCBzY3JlZW4uY29scyAtIDEpKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gbW92ZUN1cnNvclRvTmV4dFJvdyhzY3JlZW46IFRlcm1pbmFsU2NyZWVuKTogdm9pZCB7XG4gIHNjcmVlbi5wZW5kaW5nV3JhcCA9IGZhbHNlXG4gIHNjcmVlbi5jdXJzb3JDb2wgPSAwXG4gIGlmIChzY3JlZW4uY3Vyc29yUm93IDwgc2NyZWVuLnJvd3MgLSAxKSB7XG4gICAgc2NyZWVuLmN1cnNvclJvdyArPSAxXG4gICAgcmV0dXJuXG4gIH1cblxuICBzY3JlZW4ubGluZXMuc2hpZnQoKVxuICBzY3JlZW4ubGluZXMucHVzaChBcnJheS5mcm9tKHsgbGVuZ3RoOiBzY3JlZW4uY29scyB9LCAoKSA9PiBjcmVhdGVCbGFua0NlbGwoKSkpXG59XG5cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZUNoYXJUb1NjcmVlbihcbiAgc2NyZWVuOiBUZXJtaW5hbFNjcmVlbixcbiAgY2hhcjogc3RyaW5nLFxuICBzdHlsZTogVGVybWluYWxTY3JlZW5TdHlsZSA9IHt9LFxuKTogdm9pZCB7XG4gIGlmIChzY3JlZW4ucGVuZGluZ1dyYXApIHtcbiAgICBtb3ZlQ3Vyc29yVG9OZXh0Um93KHNjcmVlbilcbiAgfVxuXG4gIGNvbnN0IHJvdyA9IHNjcmVlbi5saW5lc1tzY3JlZW4uY3Vyc29yUm93XVxuICBpZiAoIXJvdykge1xuICAgIHJldHVyblxuICB9XG5cbiAgcm93W3NjcmVlbi5jdXJzb3JDb2xdID0geyBjaGFyLCBzdHlsZTogeyAuLi5zdHlsZSB9IH1cbiAgaWYgKHNjcmVlbi5jdXJzb3JDb2wgPCBzY3JlZW4uY29scyAtIDEpIHtcbiAgICBzY3JlZW4uY3Vyc29yQ29sICs9IDFcbiAgICByZXR1cm5cbiAgfVxuXG4gIHNjcmVlbi5wZW5kaW5nV3JhcCA9IHRydWVcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxpbmVUZXh0KHNjcmVlbjogVGVybWluYWxTY3JlZW4sIHJvdzogbnVtYmVyKTogc3RyaW5nIHtcbiAgcmV0dXJuIChzY3JlZW4ubGluZXNbcm93XSA/PyBbXSkubWFwKGNlbGwgPT4gY2VsbC5jaGFyKS5qb2luKCcnKVxufVxuIiwgImltcG9ydCB0eXBlIHsgVGVybWluYWxTY3JlZW4sIFRlcm1pbmFsU2NyZWVuQ2VsbCB9IGZyb20gJy4vdGVybWluYWxTY3JlZW4uanMnXG5cbmZ1bmN0aW9uIHNhbWVTdHlsZShhOiBUZXJtaW5hbFNjcmVlbkNlbGxbJ3N0eWxlJ10sIGI6IFRlcm1pbmFsU2NyZWVuQ2VsbFsnc3R5bGUnXSk6IGJvb2xlYW4ge1xuICByZXR1cm4gYS5mZyA9PT0gYi5mZ1xufVxuXG5mdW5jdGlvbiBzdHlsZVByZWZpeChzdHlsZTogVGVybWluYWxTY3JlZW5DZWxsWydzdHlsZSddKTogc3RyaW5nIHtcbiAgcmV0dXJuIHN0eWxlLmZnID8gYFx1MDAxQlske3N0eWxlLmZnfW1gIDogJydcbn1cblxuZnVuY3Rpb24gc3R5bGVTdWZmaXgoc3R5bGU6IFRlcm1pbmFsU2NyZWVuQ2VsbFsnc3R5bGUnXSk6IHN0cmluZyB7XG4gIHJldHVybiBzdHlsZS5mZyA/ICdcdTAwMUJbMG0nIDogJydcbn1cblxuZnVuY3Rpb24gcmVuZGVyTGluZShsaW5lOiBUZXJtaW5hbFNjcmVlbkNlbGxbXSk6IHN0cmluZyB7XG4gIGxldCByZXN1bHQgPSAnJ1xuICBsZXQgcnVuID0gJydcbiAgbGV0IGN1cnJlbnRTdHlsZSA9IGxpbmVbMF0/LnN0eWxlID8/IHt9XG5cbiAgZm9yIChjb25zdCBjZWxsIG9mIGxpbmUpIHtcbiAgICBpZiAoIXNhbWVTdHlsZShjdXJyZW50U3R5bGUsIGNlbGwuc3R5bGUpKSB7XG4gICAgICByZXN1bHQgKz0gYCR7c3R5bGVQcmVmaXgoY3VycmVudFN0eWxlKX0ke3J1bn0ke3N0eWxlU3VmZml4KGN1cnJlbnRTdHlsZSl9YFxuICAgICAgcnVuID0gJydcbiAgICAgIGN1cnJlbnRTdHlsZSA9IGNlbGwuc3R5bGVcbiAgICB9XG4gICAgcnVuICs9IGNlbGwuY2hhclxuICB9XG5cbiAgcmVzdWx0ICs9IGAke3N0eWxlUHJlZml4KGN1cnJlbnRTdHlsZSl9JHtydW59JHtzdHlsZVN1ZmZpeChjdXJyZW50U3R5bGUpfWBcbiAgcmV0dXJuIHJlc3VsdC50cmltRW5kKClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNjcmVlblRvUHJldmlldyhzY3JlZW46IFRlcm1pbmFsU2NyZWVuKTogc3RyaW5nIHtcbiAgcmV0dXJuIHNjcmVlbi5saW5lcy5tYXAocmVuZGVyTGluZSkuam9pbignXFxuJykudHJpbSgpXG59XG4iLCAiaW1wb3J0IHtcbiAgY3JlYXRlVGVybWluYWxTY3JlZW4sXG4gIG1vdmVDdXJzb3JUb0NvbHVtbixcbiAgbW92ZUN1cnNvclRvTmV4dFJvdyxcbiAgdHlwZSBUZXJtaW5hbFNjcmVlbixcbiAgdHlwZSBUZXJtaW5hbFNjcmVlblN0eWxlLFxuICB3cml0ZUNoYXJUb1NjcmVlbixcbn0gZnJvbSAnLi90ZXJtaW5hbFNjcmVlbi5qcydcbmltcG9ydCB7IHNjcmVlblRvUHJldmlldyB9IGZyb20gJy4vdGVybWluYWxTY3JlZW5Ub1ByZXZpZXcuanMnXG5cbnR5cGUgU3R5bGVTdGF0ZSA9IFRlcm1pbmFsU2NyZWVuU3R5bGVcblxuZXhwb3J0IHR5cGUgVGVybWluYWxTY3JlZW5SZW5kZXJlciA9IHtcbiAgY29sczogbnVtYmVyXG4gIHJvd3M6IG51bWJlclxuICBzY3JlZW46IFRlcm1pbmFsU2NyZWVuXG4gIGN1cnJlbnRTdHlsZTogU3R5bGVTdGF0ZVxuICBwZW5kaW5nRXNjYXBlQnVmZmVyOiBzdHJpbmdcbn1cblxuZnVuY3Rpb24gYXBwbHlTZ3IocmVuZGVyZXI6IFRlcm1pbmFsU2NyZWVuUmVuZGVyZXIsIHNncjogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGNvZGVzID0gc2dyXG4gICAgLnNwbGl0KCc7JylcbiAgICAubWFwKHBhcnQgPT4gTnVtYmVyLnBhcnNlSW50KHBhcnQgfHwgJzAnLCAxMCkpXG4gICAgLmZpbHRlcihjb2RlID0+ICFOdW1iZXIuaXNOYU4oY29kZSkpXG5cbiAgaWYgKGNvZGVzLmxlbmd0aCA9PT0gMCB8fCBjb2Rlcy5pbmNsdWRlcygwKSkge1xuICAgIHJlbmRlcmVyLmN1cnJlbnRTdHlsZSA9IHt9XG4gIH1cblxuICBmb3IgKGNvbnN0IGNvZGUgb2YgY29kZXMpIHtcbiAgICBpZiAoY29kZSA+PSAzMCAmJiBjb2RlIDw9IDM3KSB7XG4gICAgICByZW5kZXJlci5jdXJyZW50U3R5bGUuZmcgPSBjb2RlXG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHdyaXRlU3R5bGVkQ2hhcihyZW5kZXJlcjogVGVybWluYWxTY3JlZW5SZW5kZXJlciwgY2hhcjogc3RyaW5nKTogdm9pZCB7XG4gIHdyaXRlQ2hhclRvU2NyZWVuKHJlbmRlcmVyLnNjcmVlbiwgY2hhciwgcmVuZGVyZXIuY3VycmVudFN0eWxlKVxufVxuXG5mdW5jdGlvbiBjb25zdW1lQ3NpU2VxdWVuY2UocmVuZGVyZXI6IFRlcm1pbmFsU2NyZWVuUmVuZGVyZXIsIGlucHV0OiBzdHJpbmcpOiBudW1iZXIge1xuICBsZXQgaW5kZXggPSAyXG4gIHdoaWxlIChpbmRleCA8IGlucHV0Lmxlbmd0aCkge1xuICAgIGNvbnN0IGNoYXIgPSBpbnB1dFtpbmRleF0hXG4gICAgY29uc3QgaXNGaW5hbEJ5dGUgPVxuICAgICAgKGNoYXIgPj0gJ0EnICYmIGNoYXIgPD0gJ1onKSB8fCAoY2hhciA+PSAnYScgJiYgY2hhciA8PSAneicpXG4gICAgaWYgKGlzRmluYWxCeXRlKSB7XG4gICAgICBjb25zdCBwYXJhbXMgPSBpbnB1dC5zbGljZSgyLCBpbmRleClcbiAgICAgIGNvbnN0IGNvbW1hbmQgPSBjaGFyXG5cbiAgICAgIGlmIChjb21tYW5kID09PSAnbScpIHtcbiAgICAgICAgYXBwbHlTZ3IocmVuZGVyZXIsIHBhcmFtcylcbiAgICAgIH1cblxuICAgICAgcmVuZGVyZXIucGVuZGluZ0VzY2FwZUJ1ZmZlciA9ICcnXG4gICAgICByZXR1cm4gaW5kZXggKyAxXG4gICAgfVxuICAgIGluZGV4ICs9IDFcbiAgfVxuXG4gIHJlbmRlcmVyLnBlbmRpbmdFc2NhcGVCdWZmZXIgPSBpbnB1dFxuICByZXR1cm4gaW5wdXQubGVuZ3RoXG59XG5cbmZ1bmN0aW9uIGNvbnN1bWVPc2NTZXF1ZW5jZShyZW5kZXJlcjogVGVybWluYWxTY3JlZW5SZW5kZXJlciwgaW5wdXQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGxldCBpbmRleCA9IDJcbiAgd2hpbGUgKGluZGV4IDwgaW5wdXQubGVuZ3RoKSB7XG4gICAgY29uc3QgY2hhciA9IGlucHV0W2luZGV4XSFcbiAgICBpZiAoY2hhciA9PT0gJ1x1MDAwNycpIHtcbiAgICAgIHJlbmRlcmVyLnBlbmRpbmdFc2NhcGVCdWZmZXIgPSAnJ1xuICAgICAgcmV0dXJuIGluZGV4ICsgMVxuICAgIH1cbiAgICBpZiAoY2hhciA9PT0gJ1x1MDAxQicgJiYgaW5wdXRbaW5kZXggKyAxXSA9PT0gJ1xcXFwnKSB7XG4gICAgICByZW5kZXJlci5wZW5kaW5nRXNjYXBlQnVmZmVyID0gJydcbiAgICAgIHJldHVybiBpbmRleCArIDJcbiAgICB9XG4gICAgaW5kZXggKz0gMVxuICB9XG5cbiAgcmVuZGVyZXIucGVuZGluZ0VzY2FwZUJ1ZmZlciA9IGlucHV0XG4gIHJldHVybiBpbnB1dC5sZW5ndGhcbn1cblxuZnVuY3Rpb24gY29uc3VtZUFuc2lTZXF1ZW5jZShyZW5kZXJlcjogVGVybWluYWxTY3JlZW5SZW5kZXJlciwgaW5wdXQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGlmIChpbnB1dFswXSAhPT0gJ1x1MDAxQicpIHtcbiAgICByZXR1cm4gMFxuICB9XG5cbiAgaWYgKGlucHV0WzFdID09PSAnWycpIHtcbiAgICByZXR1cm4gY29uc3VtZUNzaVNlcXVlbmNlKHJlbmRlcmVyLCBpbnB1dClcbiAgfVxuXG4gIGlmIChpbnB1dFsxXSA9PT0gJ10nKSB7XG4gICAgcmV0dXJuIGNvbnN1bWVPc2NTZXF1ZW5jZShyZW5kZXJlciwgaW5wdXQpXG4gIH1cblxuICByZXR1cm4gMVxufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlVGVybWluYWxTY3JlZW5SZW5kZXJlcihcbiAgY29sczogbnVtYmVyLFxuICByb3dzOiBudW1iZXIsXG4pOiBUZXJtaW5hbFNjcmVlblJlbmRlcmVyIHtcbiAgcmV0dXJuIHtcbiAgICBjb2xzLFxuICAgIHJvd3MsXG4gICAgc2NyZWVuOiBjcmVhdGVUZXJtaW5hbFNjcmVlbihjb2xzLCByb3dzKSxcbiAgICBjdXJyZW50U3R5bGU6IHt9LFxuICAgIHBlbmRpbmdFc2NhcGVCdWZmZXI6ICcnLFxuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseVRlcm1pbmFsT3V0cHV0KFxuICByZW5kZXJlcjogVGVybWluYWxTY3JlZW5SZW5kZXJlcixcbiAgdGV4dDogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGxldCBpbnB1dCA9IHJlbmRlcmVyLnBlbmRpbmdFc2NhcGVCdWZmZXIgKyB0ZXh0XG4gIHJlbmRlcmVyLnBlbmRpbmdFc2NhcGVCdWZmZXIgPSAnJ1xuXG4gIHdoaWxlIChpbnB1dC5sZW5ndGggPiAwKSB7XG4gICAgaWYgKGlucHV0WzBdID09PSAnXHUwMDFCJykge1xuICAgICAgY29uc3QgY29uc3VtZWQgPSBjb25zdW1lQW5zaVNlcXVlbmNlKHJlbmRlcmVyLCBpbnB1dClcbiAgICAgIGlmIChjb25zdW1lZCA9PT0gaW5wdXQubGVuZ3RoICYmIHJlbmRlcmVyLnBlbmRpbmdFc2NhcGVCdWZmZXIpIHtcbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG4gICAgICBpbnB1dCA9IGlucHV0LnNsaWNlKGNvbnN1bWVkKVxuICAgICAgY29udGludWVcbiAgICB9XG5cbiAgICBjb25zdCBjaGFyID0gaW5wdXRbMF0hXG4gICAgaW5wdXQgPSBpbnB1dC5zbGljZSgxKVxuXG4gICAgaWYgKGNoYXIgPT09ICdcXHInKSB7XG4gICAgICBtb3ZlQ3Vyc29yVG9Db2x1bW4ocmVuZGVyZXIuc2NyZWVuLCAwKVxuICAgICAgY29udGludWVcbiAgICB9XG5cbiAgICBpZiAoY2hhciA9PT0gJ1xcbicpIHtcbiAgICAgIG1vdmVDdXJzb3JUb05leHRSb3cocmVuZGVyZXIuc2NyZWVuKVxuICAgICAgY29udGludWVcbiAgICB9XG5cbiAgICB3cml0ZVN0eWxlZENoYXIocmVuZGVyZXIsIGNoYXIpXG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlc2l6ZVRlcm1pbmFsU2NyZWVuUmVuZGVyZXIoXG4gIHJlbmRlcmVyOiBUZXJtaW5hbFNjcmVlblJlbmRlcmVyLFxuICBjb2xzOiBudW1iZXIsXG4gIHJvd3M6IG51bWJlcixcbik6IHZvaWQge1xuICByZW5kZXJlci5jb2xzID0gY29sc1xuICByZW5kZXJlci5yb3dzID0gcm93c1xuICByZW5kZXJlci5zY3JlZW4uY29scyA9IGNvbHNcbiAgcmVuZGVyZXIuc2NyZWVuLnJvd3MgPSByb3dzXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJlZFByZXZpZXcocmVuZGVyZXI6IFRlcm1pbmFsU2NyZWVuUmVuZGVyZXIpOiBzdHJpbmcge1xuICByZXR1cm4gc2NyZWVuVG9QcmV2aWV3KHJlbmRlcmVyLnNjcmVlbilcbn1cbiIsICJpbXBvcnQge1xuICBJTklUSUFMX1RFUk1JTkFMX1NJWkUsXG4gIHR5cGUgT3BlblRlcm1pbmFsU2Vzc2lvbk9wdGlvbnMsXG4gIHR5cGUgUHR5RHJpdmVyLFxuICB0eXBlIFRlcm1pbmFsT3V0cHV0Q2h1bmssXG4gIHR5cGUgVGVybWluYWxSZWFkUmVzdWx0LFxuICB0eXBlIFRlcm1pbmFsU2Vzc2lvblJlY29yZCxcbn0gZnJvbSAnLi90eXBlcy5qcydcbmltcG9ydCB7XG4gIGFwcGx5VGVybWluYWxPdXRwdXQsXG4gIGNyZWF0ZVRlcm1pbmFsU2NyZWVuUmVuZGVyZXIsXG4gIHJlbmRlcmVkUHJldmlldyxcbiAgcmVzaXplVGVybWluYWxTY3JlZW5SZW5kZXJlcixcbiAgdHlwZSBUZXJtaW5hbFNjcmVlblJlbmRlcmVyLFxufSBmcm9tICcuL3Rlcm1pbmFsU2NyZWVuUmVuZGVyZXIuanMnXG5cbmludGVyZmFjZSBQdHlTZXNzaW9uTWFuYWdlck9wdGlvbnMge1xuICBkcml2ZXI6IFB0eURyaXZlclxuICBleGl0ZWRTZXNzaW9uVHRsTXM/OiBudW1iZXJcbiAgbWF4QnVmZmVyZWRDaHVua3M/OiBudW1iZXJcbn1cblxuaW50ZXJmYWNlIE1hbmFnZWRTZXNzaW9uIHtcbiAgb3V0cHV0Q2h1bmtzOiBUZXJtaW5hbE91dHB1dENodW5rW11cbiAgcmVjb3JkOiBUZXJtaW5hbFNlc3Npb25SZWNvcmRcbiAgcmVuZGVyZXI6IFRlcm1pbmFsU2NyZWVuUmVuZGVyZXJcbn1cblxuZXhwb3J0IGNsYXNzIFB0eVNlc3Npb25NYW5hZ2VyIHtcbiAgcHJpdmF0ZSByZWFkb25seSBkcml2ZXI6IFB0eURyaXZlclxuICBwcml2YXRlIHJlYWRvbmx5IGV4aXRlZFNlc3Npb25UdGxNczogbnVtYmVyXG4gIHByaXZhdGUgcmVhZG9ubHkgbWF4QnVmZmVyZWRDaHVua3M6IG51bWJlclxuICBwcml2YXRlIHJlYWRvbmx5IHNlc3Npb25zID0gbmV3IE1hcDxzdHJpbmcsIE1hbmFnZWRTZXNzaW9uPigpXG4gIHByaXZhdGUgbmV4dFNlc3Npb25JZCA9IDFcblxuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBQdHlTZXNzaW9uTWFuYWdlck9wdGlvbnMpIHtcbiAgICB0aGlzLmRyaXZlciA9IG9wdGlvbnMuZHJpdmVyXG4gICAgdGhpcy5leGl0ZWRTZXNzaW9uVHRsTXMgPSBvcHRpb25zLmV4aXRlZFNlc3Npb25UdGxNcyA/PyA2MF8wMDBcbiAgICB0aGlzLm1heEJ1ZmZlcmVkQ2h1bmtzID0gb3B0aW9ucy5tYXhCdWZmZXJlZENodW5rcyA/PyBOdW1iZXIuUE9TSVRJVkVfSU5GSU5JVFlcbiAgfVxuXG4gIG9wZW4ob3B0aW9uczogT3BlblRlcm1pbmFsU2Vzc2lvbk9wdGlvbnMpOiBUZXJtaW5hbFNlc3Npb25SZWNvcmQge1xuICAgIGNvbnN0IHNlc3Npb25JZCA9IGBzZXNzaW9uLSR7dGhpcy5uZXh0U2Vzc2lvbklkKyt9YFxuICAgIGNvbnN0IHN0YXJ0ZWRBdCA9IERhdGUubm93KClcbiAgICBjb25zdCBjb2xzID0gb3B0aW9ucy5jb2xzID8/IElOSVRJQUxfVEVSTUlOQUxfU0laRS5jb2xzXG4gICAgY29uc3Qgcm93cyA9IG9wdGlvbnMucm93cyA/PyBJTklUSUFMX1RFUk1JTkFMX1NJWkUucm93c1xuICAgIGNvbnN0IHN0YXR1cyA9IHRoaXMuZHJpdmVyLm9wZW4oe1xuICAgICAgYXJnczogb3B0aW9ucy5hcmdzLFxuICAgICAgY29tbWFuZDogb3B0aW9ucy5jb21tYW5kLFxuICAgICAgY29scyxcbiAgICAgIGN3ZDogb3B0aW9ucy5jd2QsXG4gICAgICBlbnY6IG9wdGlvbnMuZW52LFxuICAgICAgcm93cyxcbiAgICAgIHNlc3Npb25JZCxcbiAgICB9KVxuXG4gICAgY29uc3QgcmVjb3JkOiBUZXJtaW5hbFNlc3Npb25SZWNvcmQgPSB7XG4gICAgICBjb2xzLFxuICAgICAgY3dkOiBvcHRpb25zLmN3ZCxcbiAgICAgIGxhc3RBY3Rpdml0eUF0OiBzdGFydGVkQXQsXG4gICAgICBsb3dlc3RBdmFpbGFibGVDdXJzb3I6IDAsXG4gICAgICBuZXh0Q3Vyc29yOiAwLFxuICAgICAgcm93cyxcbiAgICAgIHNlc3Npb25JZCxcbiAgICAgIHN0YXJ0ZWRBdCxcbiAgICAgIHN0YXRlOiBzdGF0dXMuc3RhdGUsXG4gICAgICB0cnVuY2F0ZWRCZWZvcmVDdXJzb3I6IGZhbHNlLFxuICAgIH1cblxuICAgIHRoaXMuYXBwbHlEcml2ZXJTdGF0dXMocmVjb3JkLCBzdGF0dXMpXG4gICAgdGhpcy5zZXNzaW9ucy5zZXQoc2Vzc2lvbklkLCB7XG4gICAgICBvdXRwdXRDaHVua3M6IFtdLFxuICAgICAgcmVjb3JkLFxuICAgICAgcmVuZGVyZXI6IGNyZWF0ZVRlcm1pbmFsU2NyZWVuUmVuZGVyZXIoY29scywgcm93cyksXG4gICAgfSlcblxuICAgIHJldHVybiB0aGlzLmNsb25lUmVjb3JkKHJlY29yZClcbiAgfVxuXG4gIHdyaXRlKHNlc3Npb25JZDogc3RyaW5nLCBkYXRhOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLnJlYXBFeHBpcmVkU2Vzc2lvbnMoKVxuICAgIGNvbnN0IHNlc3Npb24gPSB0aGlzLmdldFdyaXRhYmxlU2Vzc2lvbihzZXNzaW9uSWQpXG4gICAgc2Vzc2lvbi5yZWNvcmQubGFzdEFjdGl2aXR5QXQgPSBEYXRlLm5vdygpXG4gICAgY29uc3Qgb3V0cHV0ID0gdGhpcy5kcml2ZXIud3JpdGUoc2Vzc2lvbklkLCBkYXRhKVxuICAgIHRoaXMuYXBwZW5kT3V0cHV0KHNlc3Npb24sIG91dHB1dClcbiAgfVxuXG4gIHJlYWQoc2Vzc2lvbklkOiBzdHJpbmcsIGN1cnNvcjogbnVtYmVyKTogVGVybWluYWxSZWFkUmVzdWx0IHtcbiAgICB0aGlzLnJlYXBFeHBpcmVkU2Vzc2lvbnMoKVxuICAgIGNvbnN0IHNlc3Npb24gPSB0aGlzLmdldFNlc3Npb24oc2Vzc2lvbklkKVxuICAgIHRoaXMuZHJhaW5Ecml2ZXJPdXRwdXQoc2Vzc2lvbklkLCBzZXNzaW9uKVxuICAgIGNvbnN0IGVmZmVjdGl2ZUN1cnNvciA9IE1hdGgubWF4KGN1cnNvciwgc2Vzc2lvbi5yZWNvcmQubG93ZXN0QXZhaWxhYmxlQ3Vyc29yKVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIGNodW5rczogc2Vzc2lvbi5vdXRwdXRDaHVua3NcbiAgICAgICAgLmZpbHRlcihjaHVuayA9PiBjaHVuay5lbmQgPiBlZmZlY3RpdmVDdXJzb3IpXG4gICAgICAgIC5tYXAoY2h1bmsgPT4ge1xuICAgICAgICAgIGlmIChjaHVuay5zdGFydCA+PSBlZmZlY3RpdmVDdXJzb3IpIHtcbiAgICAgICAgICAgIHJldHVybiB7IC4uLmNodW5rIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3Qgb2Zmc2V0ID0gZWZmZWN0aXZlQ3Vyc29yIC0gY2h1bmsuc3RhcnRcbiAgICAgICAgICBjb25zdCBidWZmZXIgPSBCdWZmZXIuZnJvbShjaHVuay50ZXh0LCAndXRmOCcpXG4gICAgICAgICAgY29uc3Qgc2xpY2VkID0gYnVmZmVyLnN1YmFycmF5KG9mZnNldClcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgLi4uY2h1bmssXG4gICAgICAgICAgICBzdGFydDogZWZmZWN0aXZlQ3Vyc29yLFxuICAgICAgICAgICAgdGV4dDogc2xpY2VkLnRvU3RyaW5nKCd1dGY4JyksXG4gICAgICAgICAgfVxuICAgICAgICB9KSxcbiAgICAgIGxvd2VzdEF2YWlsYWJsZUN1cnNvcjogc2Vzc2lvbi5yZWNvcmQubG93ZXN0QXZhaWxhYmxlQ3Vyc29yLFxuICAgICAgbmV4dEN1cnNvcjogc2Vzc2lvbi5yZWNvcmQubmV4dEN1cnNvcixcbiAgICAgIHRydW5jYXRlZEJlZm9yZUN1cnNvcjogY3Vyc29yIDwgc2Vzc2lvbi5yZWNvcmQubG93ZXN0QXZhaWxhYmxlQ3Vyc29yLFxuICAgIH1cbiAgfVxuXG4gIHN0YXR1cyhzZXNzaW9uSWQ6IHN0cmluZyk6IFRlcm1pbmFsU2Vzc2lvblJlY29yZCB7XG4gICAgdGhpcy5yZWFwRXhwaXJlZFNlc3Npb25zKClcbiAgICBjb25zdCBzZXNzaW9uID0gdGhpcy5nZXRTZXNzaW9uKHNlc3Npb25JZClcbiAgICB0aGlzLmRyYWluRHJpdmVyT3V0cHV0KHNlc3Npb25JZCwgc2Vzc2lvbilcbiAgICB0aGlzLmFwcGx5RHJpdmVyU3RhdHVzKHNlc3Npb24ucmVjb3JkLCB0aGlzLmRyaXZlci5zdGF0dXMoc2Vzc2lvbklkKSlcbiAgICByZXR1cm4gdGhpcy5jbG9uZVJlY29yZChzZXNzaW9uLnJlY29yZClcbiAgfVxuXG4gIGdldFJlbmRlcmVkUHJldmlldyhzZXNzaW9uSWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgdGhpcy5yZWFwRXhwaXJlZFNlc3Npb25zKClcbiAgICBjb25zdCBzZXNzaW9uID0gdGhpcy5nZXRTZXNzaW9uKHNlc3Npb25JZClcbiAgICB0aGlzLmRyYWluRHJpdmVyT3V0cHV0KHNlc3Npb25JZCwgc2Vzc2lvbilcbiAgICByZXR1cm4gcmVuZGVyZWRQcmV2aWV3KHNlc3Npb24ucmVuZGVyZXIpXG4gIH1cblxuICByZXNpemUoc2Vzc2lvbklkOiBzdHJpbmcsIGNvbHM6IG51bWJlciwgcm93czogbnVtYmVyKTogVGVybWluYWxTZXNzaW9uUmVjb3JkIHtcbiAgICB0aGlzLnJlYXBFeHBpcmVkU2Vzc2lvbnMoKVxuICAgIGNvbnN0IHNlc3Npb24gPSB0aGlzLmdldFdyaXRhYmxlU2Vzc2lvbihzZXNzaW9uSWQpXG4gICAgdGhpcy5kcml2ZXIucmVzaXplPy4oc2Vzc2lvbklkLCBjb2xzLCByb3dzKVxuICAgIHNlc3Npb24ucmVjb3JkLmNvbHMgPSBjb2xzXG4gICAgc2Vzc2lvbi5yZWNvcmQucm93cyA9IHJvd3NcbiAgICByZXNpemVUZXJtaW5hbFNjcmVlblJlbmRlcmVyKHNlc3Npb24ucmVuZGVyZXIsIGNvbHMsIHJvd3MpXG4gICAgc2Vzc2lvbi5yZWNvcmQubGFzdEFjdGl2aXR5QXQgPSBEYXRlLm5vdygpXG4gICAgcmV0dXJuIHRoaXMuY2xvbmVSZWNvcmQoc2Vzc2lvbi5yZWNvcmQpXG4gIH1cblxuICBzaWduYWwoc2Vzc2lvbklkOiBzdHJpbmcsIHNpZ25hbDogJ1NJR0lOVCcgfCAnU0lHVEVSTScpOiBUZXJtaW5hbFNlc3Npb25SZWNvcmQge1xuICAgIHRoaXMucmVhcEV4cGlyZWRTZXNzaW9ucygpXG4gICAgY29uc3Qgc2Vzc2lvbiA9IHRoaXMuZ2V0V3JpdGFibGVTZXNzaW9uKHNlc3Npb25JZClcbiAgICBzZXNzaW9uLnJlY29yZC5sYXN0QWN0aXZpdHlBdCA9IERhdGUubm93KClcbiAgICBpZiAoc2lnbmFsID09PSAnU0lHSU5UJykge1xuICAgICAgdGhpcy53cml0ZShzZXNzaW9uSWQsICdcdTAwMDMnKVxuICAgICAgcmV0dXJuIHRoaXMuc3RhdHVzKHNlc3Npb25JZClcbiAgICB9XG4gICAgY29uc3Qgc3RhdHVzID0gdGhpcy5kcml2ZXIua2lsbD8uKHNlc3Npb25JZCwgc2lnbmFsKSA/PyB0aGlzLmRyaXZlci5jbG9zZShzZXNzaW9uSWQpXG4gICAgdGhpcy5hcHBseURyaXZlclN0YXR1cyhzZXNzaW9uLnJlY29yZCwgc3RhdHVzKVxuICAgIHJldHVybiB0aGlzLmNsb25lUmVjb3JkKHNlc3Npb24ucmVjb3JkKVxuICB9XG5cbiAgY2xvc2Uoc2Vzc2lvbklkOiBzdHJpbmcsIF9mb3JjZSA9IGZhbHNlKTogVGVybWluYWxTZXNzaW9uUmVjb3JkIHtcbiAgICB0aGlzLnJlYXBFeHBpcmVkU2Vzc2lvbnMoKVxuICAgIGNvbnN0IHNlc3Npb24gPSB0aGlzLmdldFNlc3Npb24oc2Vzc2lvbklkKVxuICAgIHRoaXMuYXBwbHlEcml2ZXJTdGF0dXMoc2Vzc2lvbi5yZWNvcmQsIHRoaXMuZHJpdmVyLmNsb3NlKHNlc3Npb25JZCkpXG4gICAgc2Vzc2lvbi5yZWNvcmQubGFzdEFjdGl2aXR5QXQgPSBEYXRlLm5vdygpXG4gICAgcmV0dXJuIHRoaXMuY2xvbmVSZWNvcmQoc2Vzc2lvbi5yZWNvcmQpXG4gIH1cblxuICByZWFwRXhwaXJlZFNlc3Npb25zKG5vdyA9IERhdGUubm93KCkpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IFtzZXNzaW9uSWQsIHNlc3Npb25dIG9mIHRoaXMuc2Vzc2lvbnMpIHtcbiAgICAgIGlmIChzZXNzaW9uLnJlY29yZC5zdGF0ZSAhPT0gJ2Nsb3NlZCcgJiYgc2Vzc2lvbi5yZWNvcmQuc3RhdGUgIT09ICdleGl0ZWQnKSB7XG4gICAgICAgIGNvbnRpbnVlXG4gICAgICB9XG4gICAgICBpZiAobm93IC0gc2Vzc2lvbi5yZWNvcmQubGFzdEFjdGl2aXR5QXQgPj0gdGhpcy5leGl0ZWRTZXNzaW9uVHRsTXMpIHtcbiAgICAgICAgdGhpcy5zZXNzaW9ucy5kZWxldGUoc2Vzc2lvbklkKVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXBwZW5kT3V0cHV0KFxuICAgIHNlc3Npb246IE1hbmFnZWRTZXNzaW9uLFxuICAgIG91dHB1dDogT21pdDxUZXJtaW5hbE91dHB1dENodW5rLCAnc3RhcnQnIHwgJ2VuZCc+IHwgbnVsbCxcbiAgKTogdm9pZCB7XG4gICAgaWYgKCFvdXRwdXQpIHtcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIGNvbnN0IHN0YXJ0ID0gc2Vzc2lvbi5yZWNvcmQubmV4dEN1cnNvclxuICAgIGNvbnN0IGVuZCA9IHN0YXJ0ICsgQnVmZmVyLmJ5dGVMZW5ndGgob3V0cHV0LnRleHQsICd1dGY4JylcbiAgICBzZXNzaW9uLm91dHB1dENodW5rcy5wdXNoKHtcbiAgICAgIC4uLm91dHB1dCxcbiAgICAgIHN0YXJ0LFxuICAgICAgZW5kLFxuICAgIH0pXG4gICAgYXBwbHlUZXJtaW5hbE91dHB1dChzZXNzaW9uLnJlbmRlcmVyLCBvdXRwdXQudGV4dClcbiAgICBzZXNzaW9uLnJlY29yZC5uZXh0Q3Vyc29yID0gZW5kXG4gICAgc2Vzc2lvbi5yZWNvcmQubGFzdEFjdGl2aXR5QXQgPSBEYXRlLm5vdygpXG4gICAgdGhpcy50cmltQnVmZmVyKHNlc3Npb24pXG4gIH1cblxuICBwcml2YXRlIGRyYWluRHJpdmVyT3V0cHV0KHNlc3Npb25JZDogc3RyaW5nLCBzZXNzaW9uOiBNYW5hZ2VkU2Vzc2lvbik6IHZvaWQge1xuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICBjb25zdCBvdXRwdXQgPSB0aGlzLmRyaXZlci53cml0ZShzZXNzaW9uSWQsICcnKVxuICAgICAgaWYgKCFvdXRwdXQpIHtcbiAgICAgICAgYnJlYWtcbiAgICAgIH1cbiAgICAgIHRoaXMuYXBwZW5kT3V0cHV0KHNlc3Npb24sIG91dHB1dClcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHRyaW1CdWZmZXIoc2Vzc2lvbjogTWFuYWdlZFNlc3Npb24pOiB2b2lkIHtcbiAgICB3aGlsZSAoc2Vzc2lvbi5vdXRwdXRDaHVua3MubGVuZ3RoID4gdGhpcy5tYXhCdWZmZXJlZENodW5rcykge1xuICAgICAgY29uc3QgcmVtb3ZlZENodW5rID0gc2Vzc2lvbi5vdXRwdXRDaHVua3Muc2hpZnQoKVxuICAgICAgaWYgKCFyZW1vdmVkQ2h1bmspIHtcbiAgICAgICAgYnJlYWtcbiAgICAgIH1cblxuICAgICAgc2Vzc2lvbi5yZWNvcmQubG93ZXN0QXZhaWxhYmxlQ3Vyc29yID0gcmVtb3ZlZENodW5rLmVuZFxuICAgICAgc2Vzc2lvbi5yZWNvcmQudHJ1bmNhdGVkQmVmb3JlQ3Vyc29yID0gdHJ1ZVxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgZ2V0U2Vzc2lvbihzZXNzaW9uSWQ6IHN0cmluZyk6IE1hbmFnZWRTZXNzaW9uIHtcbiAgICBjb25zdCBzZXNzaW9uID0gdGhpcy5zZXNzaW9ucy5nZXQoc2Vzc2lvbklkKVxuICAgIGlmICghc2Vzc2lvbikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIFBUWSBzZXNzaW9uOiAke3Nlc3Npb25JZH1gKVxuICAgIH1cblxuICAgIHJldHVybiBzZXNzaW9uXG4gIH1cblxuICBwcml2YXRlIGdldFdyaXRhYmxlU2Vzc2lvbihzZXNzaW9uSWQ6IHN0cmluZyk6IE1hbmFnZWRTZXNzaW9uIHtcbiAgICBjb25zdCBzZXNzaW9uID0gdGhpcy5nZXRTZXNzaW9uKHNlc3Npb25JZClcbiAgICBpZiAoc2Vzc2lvbi5yZWNvcmQuc3RhdGUgPT09ICdjbG9zZWQnIHx8IHNlc3Npb24ucmVjb3JkLnN0YXRlID09PSAnZXhpdGVkJykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBTRVNTSU9OX0FMUkVBRFlfQ0xPU0VEOiAke3Nlc3Npb25JZH1gKVxuICAgIH1cbiAgICByZXR1cm4gc2Vzc2lvblxuICB9XG5cbiAgcHJpdmF0ZSBhcHBseURyaXZlclN0YXR1cyhcbiAgICByZWNvcmQ6IFRlcm1pbmFsU2Vzc2lvblJlY29yZCxcbiAgICBzdGF0dXM6IFJldHVyblR5cGU8UHR5RHJpdmVyWydzdGF0dXMnXT4sXG4gICk6IHZvaWQge1xuICAgIHJlY29yZC5zdGF0ZSA9IHN0YXR1cy5zdGF0ZVxuICAgIHJlY29yZC5leGl0Q29kZSA9IHN0YXR1cy5leGl0Q29kZVxuICAgIHJlY29yZC5leGl0ZWRBdCA9IHN0YXR1cy5leGl0ZWRBdFxuICAgIHJlY29yZC5waWQgPSBzdGF0dXMucGlkXG4gICAgcmVjb3JkLnNpZ25hbCA9IHN0YXR1cy5zaWduYWxcbiAgfVxuXG4gIHByaXZhdGUgY2xvbmVSZWNvcmQocmVjb3JkOiBUZXJtaW5hbFNlc3Npb25SZWNvcmQpOiBUZXJtaW5hbFNlc3Npb25SZWNvcmQge1xuICAgIHJldHVybiB7XG4gICAgICAuLi5yZWNvcmQsXG4gICAgfVxuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7QUFBQSxPQUFPLFlBQVk7QUFDbkIsT0FBTyxVQUFVOzs7QUNEakIsU0FBUyxZQUFZLGFBQWEsbUJBQW1CO0FBQ3JELFNBQVMsV0FBVyxZQUFZLFlBQVk7QUFDNUMsU0FBUyxxQkFBcUI7QUFFOUIsSUFBTUEsV0FBVSxjQUFjLFlBQVksR0FBRztBQU03QyxTQUFTLHdCQUE4QztBQUNyRCxNQUFJO0FBQ0YsV0FBT0EsU0FBUSx5QkFBeUIsRUFBRSxtQkFBbUI7QUFBQSxFQUMvRCxRQUFRO0FBQ04sUUFBSTtBQUNGLGFBQU9BLFNBQVEseUJBQXlCLEVBQUUsbUJBQW1CO0FBQUEsSUFDL0QsUUFBUTtBQUNOLGFBQU87QUFBQSxJQUNUO0FBQUEsRUFDRjtBQUNGO0FBV08sU0FBUyxzQkFBNkM7QUFDM0QsU0FBTyxzQkFBc0IsR0FBRyxnQkFBZ0I7QUFDbEQ7QUFFQSxTQUFTLG9CQUFvQixTQUEwQjtBQUNyRCxNQUFJLENBQUMsU0FBUztBQUNaLFdBQU87QUFBQSxFQUNUO0FBRUEsTUFBSTtBQUNGLFFBQUksV0FBVyxPQUFPLEdBQUc7QUFDdkIsaUJBQVcsU0FBUyxZQUFZLElBQUk7QUFDcEMsYUFBTztBQUFBLElBQ1Q7QUFFQSxVQUFNLGVBQWUsUUFBUSxJQUFJLFFBQVEsSUFBSSxNQUFN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QUM7QUFFRCxNQUFJLFNBQVM7QUFDYixTQUFPLE1BQU0sV0FBVyx3QkFBd0I7QUFFaEQsUUFBTSxRQUFRLE1BQU07QUFDbEIsVUFBTSxRQUFRLE9BQU8sTUFBTSxXQUFXLEVBQUU7QUFDeEMsUUFBSSxPQUFPLE1BQU07QUFDZixnQkFBVSxNQUFNO0FBQUEsSUFDbEI7QUFDQSxXQUFPLGtCQUFrQixLQUFLLE1BQU07QUFBQSxFQUN0QyxDQUFDO0FBRUQsU0FBTyxNQUFNLFFBQVEsaUJBQWlCO0FBRXRDLFFBQU0sU0FBUyxPQUFPLE1BQU0sU0FBUztBQUNyQyxTQUFPLE1BQU0sT0FBTyxPQUFPLFFBQVE7QUFDckMsQ0FBQztBQUVELEtBQUssdUVBQXVFLE1BQU07QUFDaEYsUUFBTSxTQUFTLG9CQUFvQjtBQUVuQyxTQUFPO0FBQUEsSUFDTCxNQUFNO0FBQ0osYUFBTyxLQUFLO0FBQUEsUUFDVixTQUFTO0FBQUEsUUFDVCxNQUFNLENBQUM7QUFBQSxRQUNQLEtBQUssUUFBUSxJQUFJO0FBQUEsUUFDakIsTUFBTTtBQUFBLFFBQ04sTUFBTTtBQUFBLFFBQ04sV0FBVztBQUFBLE1BQ2IsQ0FBQztBQUFBLElBQ0g7QUFBQSxJQUNBO0FBQUEsRUFDRjtBQUNGLENBQUM7QUFFRCxLQUFLLDJEQUEyRCxZQUFZO0FBQzFFLFFBQU0sU0FBUyxvQkFBb0I7QUFDbkMsUUFBTSxVQUFVLElBQUksa0JBQWtCO0FBQUEsSUFDcEM7QUFBQSxJQUNBLG1CQUFtQjtBQUFBLElBQ25CLG9CQUFvQjtBQUFBLEVBQ3RCLENBQUM7QUFFRCxRQUFNLFNBQVMsUUFBUSxLQUFLO0FBQUEsSUFDMUIsU0FBUyxrQ0FBa0M7QUFBQSxJQUMzQyxNQUFNLENBQUM7QUFBQSxJQUNQLEtBQUssUUFBUSxJQUFJO0FBQUEsSUFDakIsTUFBTTtBQUFBLElBQ04sTUFBTTtBQUFBLEVBQ1IsQ0FBQztBQUVELFVBQVEsTUFBTSxPQUFPLFdBQVcsV0FBVztBQUMzQyxRQUFNLFdBQVcsUUFBUSxPQUFPLE9BQU8sV0FBVyxRQUFRO0FBRTFELFNBQU8sTUFBTSxPQUFPLFNBQVMsT0FBTyxRQUFRO0FBRTVDLFFBQU0sU0FBUyxRQUFRLE1BQU0sT0FBTyxXQUFXLEtBQUs7QUFDcEQsU0FBTyxNQUFNLE9BQU8sT0FBTyxRQUFRO0FBQ3JDLENBQUM7IiwKICAibmFtZXMiOiBbInJlcXVpcmUiLCAiYWNjZXNzU3luYyIsICJmc0NvbnN0YW50cyIsICJjcmVhdGVSZXF1aXJlIiwgImRlbGltaXRlciIsICJpc0Fic29sdXRlIiwgImpvaW4iLCAiaXNBYnNvbHV0ZSIsICJhY2Nlc3NTeW5jIiwgImZzQ29uc3RhbnRzIiwgImRlbGltaXRlciIsICJqb2luIiwgInJlcXVpcmUiLCAiY3JlYXRlUmVxdWlyZSJdCn0K
