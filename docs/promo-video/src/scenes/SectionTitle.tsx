import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Sfx } from "../Sfx";
import { clamp, theme } from "../theme";

export const SectionTitle: React.FC<{ title: string; subtitle: string }> = ({ title, subtitle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill name="Section" style={{ justifyContent: "center", alignItems: "center", fontFamily: theme.sans, color: theme.text }}>
      <Sfx name="impact" volume={0.6} />
      <Interactive.Div
        name="Bar"
        style={{
          height: 8,
          backgroundColor: theme.accent,
          boxShadow: `0 0 30px ${theme.accent}`,
          width: interpolate(frame, [0, 0.5 * fps], [0, 600], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
        }}
      />
      <Interactive.Div
        name="Title"
        style={{
          marginTop: 36,
          fontSize: 130,
          fontWeight: 900,
          letterSpacing: interpolate(frame, [0, 0.6 * fps], [40, 4], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
          opacity: interpolate(frame, [0, 8], [0, 1], clamp),
        }}
      >
        {title}
      </Interactive.Div>
      <div style={{ marginTop: 24, fontSize: 46, color: theme.muted, opacity: interpolate(frame, [0.4 * fps, 0.8 * fps], [0, 1], clamp) }}>
        {subtitle}
      </div>
    </AbsoluteFill>
  );
};
