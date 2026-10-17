// Cleans prompt-fill text with contextual Unicode rules and maps decoration offsets in UTF-16.
// The caller controls the feature gate; normalization does not use NFKC or blanket Cf removal.
import type { PromptFillInput } from './promptAdapter.js'
type Ring = {
    ring: number[];
    next: number;
    size: number;
    lastWasHidden: boolean;
    keptConditional: number;
};
type ScriptPair = {
    base: RegExp;
    mark: RegExp;
};
type RemovedByClass = {
    tags: number;
    bidi: number;
    zeroWidth: number;
    selectors: number;
    other: number;
};
function toWellFormed(text: string): string {
    return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}
function buildCleaner($u: (text: string) => string) {
    const ae = /[^\t\n\x20-\x7e]/;
    const O = /^\p{L}$/u;
    const _ = /^\p{M}$/u;
    const fe = /^\p{White_Space}$/u;
    const ue = /^[\p{Emoji}\p{Extended_Pictographic}]$/u;
    const W = /^\p{Extended_Pictographic}$/u;
    const ce = /^\p{Sm}$/u;
    function G(e: string, n: string) { const r = n.split(" ").map((i) => `\\p{${e}=${i}}`).join(""); return new RegExp(`^[${r}]$`, "u"); }
    function z(e: string) { return { base: G("Script", e), mark: G("Script_Extensions", e) }; }
    function B(e: RegExp) { return { base: e, mark: e }; }
    const ee = /^[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Yezidi}]$/u;
    const le = /^[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Hanifi_Rohingya}]$/u;
    const D = /^\p{Nd}$/u;
    const X = z("Arabic Syriac Nko Mongolian Devanagari Bengali Gurmukhi Gujarati Oriya Tamil Telugu Kannada Malayalam Sinhala Myanmar Khmer Tibetan");
    const pe = z("Devanagari Bengali Gurmukhi Gujarati Oriya Tamil Telugu Kannada Malayalam Sinhala Myanmar Khmer Tibetan Arabic Syriac Tifinagh");
    const xe = z("Arabic Syriac Mongolian Nko");
    const ne = /^[\p{Script=Khmer}\p{Script=Thai}\p{Script=Lao}\p{Script=Myanmar}]$/u;
    const de = B(ne);
    const Z = /^[0-9]$/;
    const V = B(/^\p{Script=Mongolian}$/u);
    const be = B(/^\p{Script=Khmer}$/u);
    const H = B(/^\p{Script=Egyptian_Hieroglyphs}$/u);
    const Y = B(/^\p{Script=Duployan}$/u);
    const J = /^\p{Script=Brahmi}$/u;
    const me = /^[\p{Script=Myanmar}\p{Script=Phags_Pa}\p{Script=Manichaean}]$/u;
    function k(e: number | undefined) { if (e === undefined)
        return false; if (e < 160)
        return e < 32 && e !== 9 && e !== 10 || e >= 127; if (e < 8192)
        return e === 173 || e === 847 || e === 1564 || e === 4447 || e === 4448 || e === 6068 || e === 6069 || e >= 6155 && e <= 6159; if (e < 65536)
        return e >= 8203 && e <= 8207 || e >= 8232 && e <= 8238 || e >= 8288 && e <= 8303 || e === 12644 || e >= 65024 && e <= 65039 || e === 65279 || e === 65440 || e >= 65520 && e <= 65531; return e === 69759 || e >= 78896 && e <= 78911 || e === 94180 || e >= 113824 && e <= 113827 || e >= 119155 && e <= 119162 || e >= 917504 && e <= 921599; }
    const ge = ["gbeng", "gbsct", "gbwls"];
    const re = 5;
    function K(e: string[], n: number) { let r = ""; const i = n + re + 1; for (let t = n + 1; t <= i && t < e.length; t++) {
        const f = e[t].codePointAt(0)! ?? 0;
        if (f === 917631)
            return ge.includes(r) ? t : -1;
        if (f < 917601 || f > 917626)
            return -1;
        r += String.fromCharCode(f - 917504);
    } return -1; }
    function Cpe(e: string) {
        const n = { tags: 0, bidi: 0, zeroWidth: 0, selectors: 0, other: 0 };
        if (!ae.test(e))
            return { text: e, removedTotal: 0, removedByClass: n, keptConditional: 0 };
        const r = $u(e), i: string[] = []; let t = 0, f = r === e ? 0 : Ee(e);
        n.other += f;
        const s: Ring = { ring: Array(I).fill(0), next: 0, size: 0, lastWasHidden: false, keptConditional: 0 }; let g = 0, m: boolean | undefined, C: boolean | undefined;
        for (let d = 0; d < r.length;) {
            const u = r.codePointAt(d)!, b = d + (u > 65535 ? 2 : 1);
            if (!k(u)) {
                if (u === 10) {
                    g = b;
                    m = void 0;
                    C = void 0;
                }
                else if (u === 127988) {
                    const A = Array.from(r.slice(d, d + 2 * (re + 2))), x = K(A, 0);
                    if (x !== -1) {
                        {
                            R(s, u, !1);
                            d = b;
                        }
                        for (let N = 1; N <= x; N++) {
                            R(s, A[N].codePointAt(0)!, !0);
                            d += A[N].length;
                        }
                        continue;
                    }
                }
                {
                    R(s, u, !1);
                    d = b;
                }
                continue;
            }
            if (v(u)) {
                const A = u === 13 && r.charCodeAt(b) === 10;
                if (d > t)
                    i.push(r.slice(t, d));
                if (t = b, !A) {
                    i.push(`
`);
                    f++;
                    n.other++;
                    R(s, 10, !1);
                    g = b;
                    m = void 0;
                    C = void 0;
                }
                d = b;
                continue;
            }
            const p = b < r.length ? r.codePointAt(b)! : void 0, c = T(s, 0), { lastWasHidden: E } = s; let l = false;
            switch (u) {
                case 8204:
                case 8205: {
                    if (l = y(s, u === 8204 ? X : pe), !l && u === 8205) {
                        let x = c;
                        if (x !== void 0 && (x === 65039 || P(x))) {
                            if (x = T(s, 1), x !== void 0 && (x === 65039 || P(x)))
                                x = T(s, 2);
                        }
                        l = c !== void 0 && c !== 8205 && o(W, x) && F(p, W);
                    }
                    if (!l && c !== void 0 && !E)
                        l = u === 8204 ? L(p, X) && !o(fe, c) && !o(_, c) : L(p, xe) && !o(O, c) && !o(D, c) && !o(_, c);
                    break;
                }
                case 8203: {
                    const A = te(s, de, !0), x = F(p, ne) && !o(_, p);
                    l = A && (x || F(p, Z)) || x && M(s, Z);
                    break;
                }
                case 65038:
                case 65039:
                    l = c !== void 0 && !E && (c >= 169 && o(ue, c) || Ce(c) && p === 8419);
                    break;
                case 65024:
                case 65025:
                case 65026:
                    l = c !== void 0 && !E && (o(H.base, c) || u === 65024 && (c >= 8704 && c <= 11007 && o(ce, c) || o(me, c)));
                    break;
                case 8206:
                case 8207:
                case 1564:
                    if (u === 1564) {
                        if (C === void 0)
                            C = U(le, r, g);
                        l = C;
                    }
                    else {
                        if (m === void 0)
                            m = U(ee, r, g);
                        l = m;
                    }
                    l = l && !E && (p === void 0 || v(p) || !k(p) && !o(_, p)) && !Se(s, p);
                    break;
                case 847:
                    l = M(s, _) || !E && F(p, _);
                    break;
                case 6068:
                case 6069:
                    l = y(s, be);
                    break;
                case 6155:
                case 6156:
                case 6157:
                case 6158:
                case 6159:
                    l = y(s, V) || !E && L(p, V);
                    break;
                case 69759:
                    l = M(s, J) && F(p, J);
                    break;
                default: if (u >= 78896 && u <= 78911)
                    l = y(s, H) || !E && L(p, H);
                else if (u >= 113824 && u <= 113827)
                    l = y(s, Y) || !E && L(p, Y);
            }
            if (l)
                R(s, u, !0);
            else {
                if (d > t)
                    i.push(r.slice(t, d));
                {
                    t = b;
                    f++;
                    n[Ae(u)]++;
                }
            }
            d = b;
        }
        const { keptConditional: h } = s;
        if (t === 0)
            return { text: r, removedTotal: f, removedByClass: n, keptConditional: h };
        return i.push(r.slice(t)), { text: i.join(""), removedTotal: f, removedByClass: n, keptConditional: h };
    }
    function o(e: RegExp, n: number | undefined) { return n !== void 0 && e.test(String.fromCodePoint(n)); }
    function j(e: RegExp, n: number | undefined) { return o(O, n) && o(e, n); }
    function U(e: RegExp, n: string, r: number) { for (let i = r; i < n.length;) {
        const t = n.codePointAt(i)!;
        if (v(t))
            return !1;
        if ((t >= 1424 && t <= 2303 || t >= 64285 && t <= 65023 || t >= 65136 && t <= 65279 || t >= 67584 && t <= 69631 || t >= 124928 && t <= 126975) && j(e, t))
            return !0;
        i += t > 65535 ? 2 : 1;
    } return !1; }
    function Q(e: number | undefined) { return e === 1600 || o(ee, e); }
    function Se(e: Ring, n: number | undefined) { const r = o(O, n); if (!r && !o(D, n))
        return !1; for (let i = 0; i < e.size; i++) {
        const t = T(e, i);
        if (k(t))
            return !0;
        if (o(_, t))
            continue;
        return r ? o(O, t) && Q(t) === Q(n) : o(D, t);
    } return e.size >= I; }
    function v(e: number | undefined) { return e === 10 || e === 11 || e === 12 || e === 13 || e === 133 || e === 8232 || e === 8233; }
    const I = 16;
    function R(e: Ring, n: number, r: boolean) { if (e.ring[e.next] = n, e.next = (e.next + 1) % I, e.size < I)
        e.size++; if (e.lastWasHidden = r, r)
        e.keptConditional++; }
    function T(e: Ring, n: number) { if (n >= e.size)
        return; return e.ring[(e.next - 1 - n + 2 * I) % I]; }
    function M(e: Ring, n: RegExp) { return e.size > 0 && !e.lastWasHidden && o(n, T(e, 0)); }
    function y(e: Ring, n: ScriptPair) { return te(e, n, !1); }
    function te(e: Ring, n: ScriptPair, r: boolean) { if (e.lastWasHidden)
        return !1; for (let i = 0; i < e.size; i++) {
        const t = T(e, i);
        if (o(_, t)) {
            if (!o(n.mark, t))
                return !1;
            continue;
        }
        return r ? o(n.base, t) : j(n.base, t);
    } return !1; }
    function F(e: number | undefined, n: RegExp) { return e !== void 0 && !k(e) && o(n, e); }
    function L(e: number | undefined, n: ScriptPair) { return e !== void 0 && !k(e) && j(n.base, e); }
    function P(e: number | undefined) { if (e === undefined)
        return false; return e >= 127995 && e <= 127999; }
    function Ce(e: number | undefined) { if (e === undefined)
        return false; return e >= 48 && e <= 57 || e === 35 || e === 42; }
    function Ee(e: string) { let n = 0; for (let r = 0; r < e.length; r++) {
        const i = e.charCodeAt(r);
        if (i >= 55296 && i <= 56319) {
            const t = e.charCodeAt(r + 1);
            if (t >= 56320 && t <= 57343)
                r++;
            else
                n++;
        }
        else if (i >= 56320 && i <= 57343)
            n++;
    } return n; }
    function Ae(e: number): keyof RemovedByClass { if (e >= 917504 && e <= 917631)
        return "tags"; if (e === 1564 || e === 8206 || e === 8207 || e >= 8234 && e <= 8238 || e >= 8294 && e <= 8297)
        return "bidi"; if (e >= 8203 && e <= 8205 || e === 8288 || e === 65279)
        return "zeroWidth"; if (e >= 65024 && e <= 65039 || e >= 917760 && e <= 917999 || e >= 6155 && e <= 6157 || e === 6159)
        return "selectors"; return "other"; }
    return { Cpe };
}
const { Cpe } = buildCleaner(toWellFormed);
const newlineCharacters = '\r\v\f\x85\u2028\u2029';
export function promptFillUTF16Map(before: string, after: string): Uint32Array {
    const map = new Uint32Array(before.length + 1);
    let source = 0, target = 0;
    for (const point of before) {
        const next = String.fromCodePoint(after.codePointAt(target) ?? 0);
        const kept = target < after.length && (point === next || (next === '\n' && newlineCharacters.includes(point)) || (next === '\uFFFD' && /^[\uD800-\uDFFF]$/.test(point)));
        for (let part = 0; part < point.length; part++)
            map[source + part] = kept ? target + part : target;
        source += point.length;
        target += kept ? next.length : 0;
    }
    map[before.length] = target;
    return map;
}
export function sanitizePromptFillInput<T extends Pick<PromptFillInput, 'text' | 'decorations'>>(
    input: T,
    enabled = true,
): Omit<T, 'text' | 'decorations'> & Pick<PromptFillInput, 'text' | 'decorations'> {
    if (!enabled)
        return input;
    const text = Cpe(input.text).text;
    if (text === input.text)
        return input;
    if (input.decorations === undefined)
        return { ...input, text };
    const map = promptFillUTF16Map(input.text, text), index = (position: number) => map[Math.max(0, Math.min(position, input.text.length))] ?? text.length;
    return { ...input, text, decorations: input.decorations.map(run => ({ ...run, start: index(run.start), end: index(run.end) })) };
}
