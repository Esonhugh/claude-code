#!/usr/bin/env bash
# Downloads font subsets that cover every non-ASCII character used in src/, so rendering needs no network.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/public/fonts"
mkdir -p "$out"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"

fetch() { # family-query text-file output
  local css url
  css=$(curl -fsS -A "$UA" "https://fonts.googleapis.com/css2?family=$1&text=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(open(sys.argv[1]).read()))' "$2")")
  url=$(grep -o 'https://[^)]*' <<<"$css" | head -1)
  curl -fsS -o "$3" "$url"
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
ascii=$(python3 -c 'print("".join(chr(i) for i in range(32,127)), end="")')
python3 - "$root/src" "$tmp" "$ascii" <<'PY'
import pathlib, sys
src, tmp, ascii = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
text = "".join(p.read_text() for p in src.rglob("*.tsx"))
wide = "".join(sorted({c for c in text if ord(c) > 127}))
(tmp / "sans.txt").write_text(ascii + wide)
(tmp / "mono.txt").write_text(ascii + "▋")
(tmp / "symbols.txt").write_text("✻✓")
PY
for w in 400 700 900; do fetch "Noto+Sans+SC:wght@$w" "$tmp/sans.txt" "$out/NotoSansSC-$w.woff2"; done
for w in 400 700; do fetch "JetBrains+Mono:wght@$w" "$tmp/mono.txt" "$out/JetBrainsMono-$w.woff2"; done
fetch "Noto+Sans+Symbols+2" "$tmp/symbols.txt" "$out/NotoSansSymbols2.woff2"
ls -la "$out"
