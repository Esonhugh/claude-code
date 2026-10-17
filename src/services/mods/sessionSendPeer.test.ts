import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtemp,
  realpath,
  rm,
  mkdir,
  writeFile,
  chmod,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  formatPeerAddress,
  formatPeerMessage,
  parsePeerMessage,
} from "../../utils/peerProtocol.js";
import {
  startUdsMessaging,
  stopUdsMessaging,
} from "../../utils/udsMessaging.js";
import { sendPeerFrame, sendToUdsSocket } from "../../utils/udsClient.js";
import { setInboundMessageReceiver } from "../../utils/inboundMessageQueue.js";
import {
  dequeueAll,
  getCommandQueue,
} from "../../utils/messageQueueManager.js";
import { resetSettingsCache } from "../../utils/settings/settingsCache.js";

let root: string;
let server: Server | undefined;
let clear: (() => void) | undefined;
const keys = [
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
];
let saved: (string | undefined)[];
beforeEach(async () => {
  saved = keys.map((k) => process.env[k]);
  root = await realpath(await mkdtemp(join(tmpdir(), "claude-test-sp-")));
  process.env.HOME = root;
  process.env.CLAUDE_CONFIG_DIR = join(root, "config");
  process.env.ANTHROPIC_API_KEY = "sk-send-peer-placeholder";
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  delete process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  await mkdir(join(root, "config"), { mode: 0o700 });
  await writeFile(
    join(root, "config/settings.json"),
    JSON.stringify({ crossSessionInbound: "accept" }),
  );
  resetSettingsCache();
  dequeueAll();
});
afterEach(async () => {
  clear?.();
  clear = undefined;
  await stopUdsMessaging();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  dequeueAll();
  resetSettingsCache();
  keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key];
    else process.env[key] = saved[i];
  });
  await rm(root, { recursive: true, force: true });
});

test("plugin peer envelope uses official attribute order and round trips the sender claim", () => {
  // Official 2.1.292 _st / V: from-plugin follows from-mode and is never an authorization key.
  const text =
    '<cross-session-message from="uds:/private/tmp/peer.sock" from-name="worker" from-mode="prompting" from-plugin="sender">\nhello\n</cross-session-message>';
  const metadata = {
    from: "uds:/private/tmp/peer.sock",
    fromName: "worker",
    fromMode: "prompting" as const,
    fromPlugin: "sender",
  };
  expect(formatPeerMessage("hello", metadata)).toBe(text);
  expect(parsePeerMessage(text)).toEqual({ ...metadata, body: "hello" });
});

test("real peer ingress preserves plugin origin through receive and prompt enqueue", async () => {
  const path = join(root, "self.sock");
  await startUdsMessaging(path, { permissionMode: "default" });
  const received = Promise.withResolvers<unknown>();
  clear = setInboundMessageReceiver(async (input, admit) => {
    const result = await admit(input);
    received.resolve(input);
    return result || { text: input.text };
  });
  const from = formatPeerAddress(join(root, "sender.sock"));
  await sendPeerFrame(path, {
    msgV: 1,
    msg_id: randomUUID(),
    type: "user",
    from,
    from_plugin: "sender",
    message: {
      role: "user",
      content: `<cross-session-message from="${from}" from-mode="prompting">\nbody\n</cross-session-message>`,
    },
  });
  expect(await received.promise).toMatchObject({
    origin: { kind: "peer", plugin: "sender" },
  });
  expect(getCommandQueue()[0]?.promptSubmitMetadata?.origin).toEqual({
    kind: "peer",
    plugin: "sender",
  });
  expect(getCommandQueue()[0]?.origin).toMatchObject({
    kind: "peer",
    plugin: "sender",
  });
});

test("real peer sender stamps the calling plugin outside the body", async () => {
  await startUdsMessaging(join(root, "self.sock"), {
    permissionMode: "default",
  });
  const frame = Promise.withResolvers<Record<string, unknown>>();
  server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      if (buffer.includes("\n")) frame.resolve(JSON.parse(buffer.trim()));
    });
  });
  const peer = join(root, "peer.sock");
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(peer, () => resolve());
  });
  await chmod(peer, 0o600);
  await sendToUdsSocket(peer, "body", {
    fromName: "worker",
    fromMode: "prompting",
    fromPlugin: "sender",
  } as Parameters<typeof sendToUdsSocket>[2]);
  const sent = await frame.promise;
  expect(sent.from_plugin).toBe("sender");
  expect(
    parsePeerMessage((sent.message as { content: string }).content),
  ).toMatchObject({ body: "body" });
  expect((sent.message as { content: string }).content).not.toContain(
    "from-plugin",
  );
});
