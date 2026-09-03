import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const binary = path.resolve(process.argv[2] ?? './built-claude');
const fixture = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAACDQAAAABCAIAAACkbvvnAAAAHUlEQVR4nO3BMQEAAADCoPVPbQsvoAAAAAAAAI4GGJ0AATXO+8IAAAAASUVORK5CYII=',
  'base64',
);
const root = mkdtempSync(path.join(tmpdir(), 'claude-image-runtime-'));
const home = path.join(root, 'home');
const config = path.join(root, 'config');
const fixturePath = path.join(root, 'fixture.png');
mkdirSync(path.join(home, '.codex'), { recursive: true, mode: 0o700 });
mkdirSync(config, { recursive: true, mode: 0o700 });
writeFileSync(fixturePath, fixture);
writeFileSync(
  path.join(home, '.codex', 'auth.json'),
  JSON.stringify({ OPENAI_API_KEY: 'release-validation-dummy-key' }),
  { mode: 0o600 },
);
writeFileSync(
  path.join(config, 'settings.json'),
  JSON.stringify({ skipDangerousModePermissionPrompt: true }),
);
writeFileSync(
  path.join(config, '.claude.json'),
  JSON.stringify({
    numStartups: 1,
    installMethod: 'local',
    hasCompletedOnboarding: true,
    projects: {
      [process.cwd()]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    },
  }),
);

const requests = [];
const isTitleRequest = item =>
  String(item.instructions ?? '').includes(
    'Generate a concise, sentence-case title',
  );
const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'gpt-release-image' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const mainRequests = requests.filter(item => !isTitleRequest(item));
    const events =
      mainRequests.length === 1
        ? [
            {
              type: 'response.output_item.added',
              item: {
                type: 'function_call',
                id: 'fc_release_read_image',
                call_id: 'fc_release_read_image',
                name: 'Read',
              },
            },
            {
              type: 'response.function_call_arguments.done',
              item_id: 'fc_release_read_image',
              call_id: 'fc_release_read_image',
              name: 'Read',
              arguments: JSON.stringify({ file_path: fixturePath }),
            },
          ]
        : [{ type: 'response.output_text.delta', delta: 'RELEASE_IMAGE_RUNTIME_OK' }];
    events.push({
      type: 'response.completed',
      response: { usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const payload = events
      .map(event => `data: ${JSON.stringify(event)}\n\n`)
      .join('');
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Content-Length': Buffer.byteLength(payload),
      Connection: 'close',
    });
    response.end(payload);
  });
});

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const child = spawn(
    binary,
    [
      '--print',
      '--output-format',
      'text',
      '--permission-mode',
      'dontAsk',
      '--tools=Read',
      '--allowed-tools=Read',
      'Read the release validation image and report the completion marker.',
    ],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        USERPROFILE: home,
        TMPDIR: root,
        TMP: root,
        TEMP: root,
        SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '',
        ComSpec: process.env.ComSpec ?? process.env.COMSPEC ?? '',
        PATHEXT: process.env.PATHEXT ?? '',
        CLAUDE_CONFIG_DIR: config,
        XDG_CACHE_HOME: path.join(home, '.cache'),
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_DATA_HOME: path.join(home, '.local', 'share'),
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_API_KEY: 'release-validation-dummy-key',
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}`,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const timeout = setTimeout(() => child.kill('SIGTERM'), 60_000);
  const [exitCode, signal] = await once(child, 'exit');
  clearTimeout(timeout);
  const output = Buffer.concat(stdout).toString();
  assert.equal(signal, null, Buffer.concat(stderr).toString());
  assert.equal(exitCode, 0, Buffer.concat(stderr).toString());
  assert.match(output, /RELEASE_IMAGE_RUNTIME_OK/);

  const mainRequests = requests.filter(item => !isTitleRequest(item));
  assert.equal(mainRequests.length, 2);
  assert(Array.isArray(mainRequests[1].input));
  const outputs = mainRequests[1].input.filter(
    item => item?.type === 'function_call_output',
  );
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].call_id, 'fc_release_read_image');
  assert(Array.isArray(outputs[0].output));
  assert.equal(outputs[0].output.length, 1);
  const image = outputs[0].output[0];
  assert.equal(image.type, 'input_image');
  assert.equal(image.detail, 'high');
  assert.match(image.image_url, /^data:image\/png;base64,/);
  const processed = Buffer.from(
    image.image_url.replace(/^data:image\/png;base64,/, ''),
    'base64',
  );
  assert.equal(readFileSync(fixturePath).equals(processed), false);
  assert.deepEqual(
    [processed.readUInt32BE(16), processed.readUInt32BE(20)],
    [2000, 1],
  );
  process.stdout.write(`bundled image runtime verified: ${binary}\n`);
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}
