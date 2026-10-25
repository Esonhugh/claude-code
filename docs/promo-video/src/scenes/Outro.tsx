import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Clawd, clawdFrame, JUMP_WAVE, LOOK_AROUND } from "../Clawd";
import { Sfx } from "../Sfx";
import { clamp, theme } from "../theme";

const lines = [
  { prompt: true, text: "bun add --global @esonhugh/claude-code" },
  { prompt: true, text: "claude --version" },
  { prompt: false, text: "2.1.294 (Claude Code)" },
];

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const repoAt = Math.round(3 * fps);

  return (
    <AbsoluteFill name="Outro" style={{ fontFamily: theme.sans, color: theme.text, justifyContent: "center", alignItems: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 48 }}>
        <Clawd cell={14} {...(frame >= repoAt ? clawdFrame(frame, fps, repoAt, JUMP_WAVE) : clawdFrame(frame, fps, 30, LOOK_AROUND))} />
        <div style={{ fontSize: 96, fontWeight: 900 }}>
          立即上手<span style={{ color: theme.accent }}>.</span>
        </div>
      </div>
      <div
        style={{
          marginTop: 48,
          width: 1300,
          backgroundColor: theme.panel,
          border: `2px solid ${theme.border}`,
          borderRadius: 24,
          padding: "40px 56px",
          fontFamily: theme.mono,
          fontSize: 48,
          boxShadow: "0 0 60px rgba(217,119,87,0.25)",
        }}
      >
        {lines.map((l, i) => {
          const start = Math.round((0.4 + i * 0.8) * fps);
          const typeFrames = l.prompt ? Math.round(0.7 * fps) : 1;
          const chars = Math.round(interpolate(frame, [start, start + typeFrames], [0, l.text.length], clamp));
          const cursor = chars < l.text.length || (i === lines.length - 1 && Math.floor(frame / 15) % 2 === 0);
          return (
            <div key={l.text} style={{ minHeight: 72, opacity: frame >= start ? 1 : 0 }}>
              {l.prompt
                ? Array.from({ length: Math.ceil(typeFrames / 3) }, (_, k) => <Sfx key={k} name="tick" at={start + k * 3} volume={0.35} />)
                : null}
              {l.prompt ? <span style={{ color: theme.accent }}>$ </span> : null}
              <span style={{ color: l.prompt ? theme.text : theme.green }}>{l.text.slice(0, chars)}</span>
              {cursor && frame >= start ? <span style={{ color: theme.accent }}>▋</span> : null}
            </div>
          );
        })}
      </div>
      <Sfx name="ding" at={repoAt} />
      <Interactive.Div
        name="Repo"
        style={{
          marginTop: 56,
          fontFamily: theme.mono,
          fontSize: 56,
          fontWeight: 700,
          color: theme.accent,
          textShadow: `0 0 30px ${theme.accent}`,
          opacity: interpolate(frame, [repoAt, repoAt + 10], [0, 1], clamp),
          scale: interpolate(frame, [repoAt, repoAt + 0.5 * fps], [1.3, 1], { ...clamp, easing: Easing.spring({ damping: 12 }), output: "perceptual-scale" }),
        }}
      >
        github.com/Esonhugh/claude-code
      </Interactive.Div>
      <div style={{ marginTop: 32, fontSize: 32, color: theme.muted, opacity: interpolate(frame, [repoAt + 10, repoAt + 25], [0, 1], clamp) }}>
        非官方项目，未获 Anthropic 背书
      </div>
    </AbsoluteFill>
  );
};
