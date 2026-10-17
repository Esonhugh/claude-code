import { expect, test } from 'bun:test'
import { formatPluginNotice } from './uiNoticeText.js'

// Official 2.1.292: KJe → sle/Pi/gi, chunk-13a9y53q.js; executed against 20 inputs.
const cases = [
  ["notice-mod", "NOTICE_LINE", "notice-mod: NOTICE_LINE"],
  ["", "x", "unnamed: x"],
  ["notice-mod", "a\nb\r\u2028c\u2029d", "notice-mod: a\ufffdb\ufffd\ufffdc\ufffdd"],
  ["notice-mod", "a\tb", "notice-mod: a b"],
  ["notice-mod", "\u001b[31mred\u001b[0m", "notice-mod: \ufffd[31mred\ufffd[0m"],
  ["notice-mod", "\u0000\u007f\u009b\u009f", "notice-mod: \ufffd\ufffd\ufffd\ufffd"],
  ["notice-mod", "a\u200bb\u2060c", "notice-mod: a\ufffdb\ufffdc"],
  ["notice-mod", "a\u200cb\u200dc\u200ed\u200fe", "notice-mod: a\u200cb\u200dc\u200ed\u200fe"],
  ["notice-mod", "a\u202eb\u2066c", "notice-mod: a\ufffdb\ufffdc"],
  ["notice-mod", "\ud83d\udc4d\ufe0f a\ufe0f", "notice-mod: \ud83d\udc4d a"],
  ["notice-mod", "a" + "\u0301".repeat(16), "notice-mod: a\u0301\u0301\u0301\u0301\u0301\u0301\u0301\u0301\ufffd"],
  ["notice-mod", "a" + "\u200c".repeat(16), "notice-mod: a\u200c\u200c\u200c\u200c\u200c\u200c\u200c\u200c\ufffd"],
  ["notice-mod", "\ud801\udc00".repeat(1001), "notice-mod: " + "\ud801\udc00".repeat(1000) + "\u2026"],
  ["notice-mod", "x".repeat(2001), "notice-mod: " + "x".repeat(2000) + "\u2026"],
  ["notice-mod", "x".repeat(1999) + "\ud83d\ude00z", "notice-mod: " + "x".repeat(1999) + "\u2026"],
  ["notice-mod", "a\u2800b\u180bc", "notice-mod: a\u2800b\u180bc"],
  ["notice-mod", "\ud800\udc00\ud800x\udc00", "notice-mod: \ud800\udc00\ufffdx\ufffd"],
  ["\u77ed\u63d2\u4ef6", "\u4f60\u597d\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66", "\u77ed\u63d2\u4ef6: \u4f60\u597d\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66"],
  ["x\nrest", "ok", "x\u2026: ok"],
  ["\u200b", "ok", "\ufffd: ok"],
] as const

test.each(cases)('official 2.1.292 notice formatting case %#', (plugin, text, expected) => {
  expect(formatPluginNotice(plugin, text)).toBe(expected)
})
