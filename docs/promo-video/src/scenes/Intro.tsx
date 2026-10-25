import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Sfx } from "../Sfx";
import { clamp, theme } from "../theme";

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const slam = 15;
  const shake = frame >= slam && frame < slam + 10 ? Math.sin(frame * 3) * (slam + 10 - frame) * 2 : 0;
  const split = interpolate(frame, [slam, slam + 0.6 * fps], [18, 0], clamp);

  return (
    <AbsoluteFill
      name="Intro"
      style={{ justifyContent: "center", alignItems: "center", fontFamily: theme.sans, color: theme.text, translate: `${shake}px 0px` }}
    >
      <Sfx name="impact" at={slam} />
      <AbsoluteFill
        style={{
          backgroundColor: "white",
          opacity: interpolate(frame, [slam - 1, slam, slam + 6], [0, 0.8, 0], clamp),
        }}
      />
      <Interactive.Div
        name="Mark"
        style={{
          fontFamily: theme.symbols,
          fontSize: 180,
          lineHeight: 1,
          color: theme.accent,
          textShadow: `0 0 ${interpolate(frame, [0, slam, slam + 20], [10, 80, 30], clamp)}px ${theme.accent}`,
          scale: interpolate(frame, [0, slam], [0.2, 1], { ...clamp, easing: Easing.bezier(0.7, 0, 0.84, 0), output: "perceptual-scale" }),
          rotate: `${interpolate(frame, [0, slam], [0, 540], { ...clamp, easing: Easing.bezier(0.7, 0, 0.84, 0) }) + frame * 0.6}deg`,
        }}
      >
        ✻
      </Interactive.Div>
      <Interactive.Div
        name="Title"
        style={{
          marginTop: 30,
          fontSize: 150,
          fontWeight: 900,
          letterSpacing: -3,
          opacity: frame >= slam ? 1 : 0,
          scale: interpolate(frame, [slam, slam + 0.4 * fps], [2.6, 1], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1), output: "perceptual-scale" }),
          textShadow: `${split}px 0 0 rgba(111,211,230,0.8), ${-split}px 0 0 rgba(217,119,87,0.9), 0 0 40px rgba(217,119,87,0.4)`,
        }}
      >
        Claude Code
      </Interactive.Div>
      <Interactive.Div
        name="Stamp"
        style={{
          marginTop: -10,
          padding: "6px 28px",
          fontFamily: theme.mono,
          fontWeight: 700,
          fontSize: 54,
          letterSpacing: 14,
          color: theme.bg,
          backgroundColor: theme.accent,
          opacity: frame >= slam + 12 ? 1 : 0,
          rotate: "-4deg",
          scale: interpolate(frame, [slam + 12, slam + 20], [1.8, 1], { ...clamp, output: "perceptual-scale" }),
        }}
      >
        UNOFFICIAL
      </Interactive.Div>
      <Sfx name="tick" at={slam + 12} />
      <Interactive.Div
        name="Subtitle"
        style={{
          marginTop: 48,
          fontSize: 50,
          color: theme.muted,
          opacity: interpolate(frame, [slam + 30, slam + 48], [0, 1], clamp),
          translate: interpolate(frame, [slam + 30, slam + 48], ["0px 30px", "0px 0px"], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
        }}
      >
        可读源码 · 自行构建 · 自由二次开发
      </Interactive.Div>
    </AbsoluteFill>
  );
};
