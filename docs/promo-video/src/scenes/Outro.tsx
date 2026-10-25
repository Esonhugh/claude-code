import {
  AbsoluteFill,
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { theme } from "../theme";

const lines = [
  { prompt: true, text: "bun add --global @esonhugh/claude-code" },
  { prompt: true, text: "claude --version" },
  { prompt: false, text: "2.1.294 (Claude Code)" },
];

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill
      name="Outro"
      style={{
        backgroundColor: theme.bg,
        fontFamily: theme.sans,
        color: theme.text,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div style={{ fontSize: 96, fontWeight: 900 }}>
        立即上手<span style={{ color: theme.accent }}>.</span>
      </div>
      <div
        style={{
          marginTop: 56,
          width: 1300,
          backgroundColor: theme.panel,
          border: `2px solid ${theme.border}`,
          borderRadius: 24,
          padding: "40px 56px",
          fontFamily: theme.mono,
          fontSize: 48,
        }}
      >
        {lines.map((l, i) => {
          const start = (0.4 + i * 0.7) * fps;
          const chars = Math.round(
            interpolate(frame, [start, start + (l.prompt ? 0.6 : 0.01) * fps], [0, l.text.length], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          );
          return (
            <div key={l.text} style={{ minHeight: 72, opacity: frame >= start ? 1 : 0 }}>
              {l.prompt ? <span style={{ color: theme.accent }}>$ </span> : null}
              <span style={{ color: l.prompt ? theme.text : theme.green }}>{l.text.slice(0, chars)}</span>
            </div>
          );
        })}
      </div>
      <Interactive.Div
        name="Repo"
        style={{
          marginTop: 56,
          fontFamily: theme.mono,
          fontSize: 52,
          color: theme.accent,
          opacity: interpolate(frame, [2.4 * fps, 3 * fps], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        github.com/Esonhugh/claude-code
      </Interactive.Div>
      <div style={{ marginTop: 32, fontSize: 32, color: theme.muted }}>
        非官方项目，未获 Anthropic 背书
      </div>
    </AbsoluteFill>
  );
};
