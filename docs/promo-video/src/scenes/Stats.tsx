import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Sfx } from "../Sfx";
import { clamp, theme } from "../theme";

const stats = [
  { value: 40, label: "个功能 Wiki 页" },
  { value: 119, label: "张实测截图" },
  { value: 4, label: "个平台二进制" },
];

export const Stats: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill name="Stats" style={{ justifyContent: "center", alignItems: "center", fontFamily: theme.sans, color: theme.text }}>
      <div style={{ display: "flex", gap: 120 }}>
        {stats.map((s, i) => {
          const start = (0.2 + i * 0.45) * fps;
          return (
            <Interactive.Div
              key={s.label}
              name={`Stat ${s.label}`}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                opacity: interpolate(frame, [start, start + 6], [0, 1], clamp),
                scale: interpolate(frame, [start, start + 0.5 * fps], [0.6, 1], { ...clamp, easing: Easing.spring({ damping: 10 }), output: "perceptual-scale" }),
              }}
            >
              <Sfx name="tick" at={start} />
              <div
                style={{
                  fontFamily: theme.mono,
                  fontWeight: 700,
                  fontSize: 220,
                  lineHeight: 1,
                  color: theme.accent,
                  textShadow: `0 0 50px rgba(217,119,87,0.6)`,
                }}
              >
                {Math.round(interpolate(frame, [start, start + 0.8 * fps], [0, s.value], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) }))}
              </div>
              <div style={{ marginTop: 20, fontSize: 52, fontWeight: 700 }}>{s.label}</div>
            </Interactive.Div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
