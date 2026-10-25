import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

// Fonts are local subsets in public/fonts so rendering needs no network.
const fonts = [
  { family: "Noto Sans SC", file: "NotoSansSC-400.woff2", weight: "400" },
  { family: "Noto Sans SC", file: "NotoSansSC-700.woff2", weight: "700" },
  { family: "Noto Sans SC", file: "NotoSansSC-900.woff2", weight: "900" },
  { family: "JetBrains Mono", file: "JetBrainsMono-400.woff2", weight: "400" },
  { family: "JetBrains Mono", file: "JetBrainsMono-700.woff2", weight: "700" },
  { family: "Noto Sans Symbols 2", file: "NotoSansSymbols2.woff2", weight: "400" },
];

for (const f of fonts) {
  loadFont({ family: f.family, url: staticFile(`fonts/${f.file}`), weight: f.weight });
}

export const theme = {
  bg: "#141413",
  panel: "#1f1e1c",
  border: "#3a3833",
  text: "#f5f4ee",
  muted: "#a8a59b",
  accent: "#d97757",
  green: "#7fbf7f",
  sans: '"Noto Sans SC", "Noto Sans Symbols 2", sans-serif',
  mono: '"JetBrains Mono", "Noto Sans SC", "Noto Sans Symbols 2", monospace',
};
