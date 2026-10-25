import {
  AbsoluteFill,
  Easing,
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { theme } from "../theme";

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill
      name="Intro"
      style={{
        backgroundColor: theme.bg,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: theme.sans,
        color: theme.text,
      }}
    >
      <Interactive.Div
        name="Mark"
        style={{
          fontSize: 160,
          color: theme.accent,
          lineHeight: 1,
          scale: interpolate(frame, [0, 0.8 * fps], [0.4, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.spring({ damping: 12 }),
            output: "perceptual-scale",
          }),
          rotate: interpolate(frame, [0, 5 * fps], ["-90deg", "60deg"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        ✻
      </Interactive.Div>
      <Interactive.Div
        name="Title"
        style={{
          marginTop: 40,
          fontSize: 120,
          fontWeight: 900,
          letterSpacing: -2,
          opacity: interpolate(frame, [0.3 * fps, 1.1 * fps], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          translate: interpolate(frame, [0.3 * fps, 1.1 * fps], ["0px 40px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        Unofficial Claude Code
      </Interactive.Div>
      <Interactive.Div
        name="Subtitle"
        style={{
          marginTop: 28,
          fontSize: 52,
          color: theme.muted,
          opacity: interpolate(frame, [1 * fps, 1.8 * fps], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        可读源码 · 可自行构建 · 可二次开发的 Claude Code CLI
      </Interactive.Div>
      <Interactive.Div
        name="Version"
        style={{
          marginTop: 56,
          fontFamily: theme.mono,
          fontSize: 44,
          padding: "12px 32px",
          borderRadius: 999,
          border: `2px solid ${theme.accent}`,
          color: theme.accent,
          opacity: interpolate(frame, [1.6 * fps, 2.3 * fps], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        v2.1.294 · @esonhugh/claude-code
      </Interactive.Div>
    </AbsoluteFill>
  );
};
