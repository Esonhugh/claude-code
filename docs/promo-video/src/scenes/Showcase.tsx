import { AbsoluteFill, Easing, Img, Interactive, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Sfx } from "../Sfx";
import { clamp, theme } from "../theme";

export type ShowcaseItem = {
  index: number;
  title: string;
  desc: string;
  shot: string;
  wiki: string;
};

export const Showcase: React.FC<ShowcaseItem> = ({ index, title, desc, shot, wiki }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  return (
    <AbsoluteFill name={`Showcase ${title}`} style={{ fontFamily: theme.sans, color: theme.text, flexDirection: "row", alignItems: "center", padding: "0 90px" }}>
      <Sfx name="whoosh" volume={0.7} />
      <div style={{ width: 600, flexShrink: 0 }}>
        <Interactive.Div
          name="Index"
          style={{
            fontFamily: theme.mono,
            fontSize: 140,
            fontWeight: 700,
            lineHeight: 1,
            color: "transparent",
            WebkitTextStroke: `3px ${theme.accent}`,
            opacity: interpolate(frame, [0, 10], [0, 1], clamp),
            translate: interpolate(frame, [0, 0.6 * fps], ["-80px 0px", "0px 0px"], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
          }}
        >
          {String(index).padStart(2, "0")}
        </Interactive.Div>
        <Interactive.Div
          name="Title"
          style={{
            marginTop: 16,
            fontSize: 76,
            fontWeight: 900,
            lineHeight: 1.15,
            opacity: interpolate(frame, [4, 14], [0, 1], clamp),
            translate: interpolate(frame, [4, 4 + 0.6 * fps], ["-60px 0px", "0px 0px"], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
          }}
        >
          {title}
        </Interactive.Div>
        <Interactive.Div
          name="Desc"
          style={{
            marginTop: 28,
            fontSize: 44,
            lineHeight: 1.45,
            color: theme.muted,
            opacity: interpolate(frame, [10, 22], [0, 1], clamp),
          }}
        >
          {desc}
        </Interactive.Div>
        <Interactive.Div
          name="Wiki"
          style={{
            marginTop: 40,
            display: "inline-block",
            padding: "10px 24px",
            borderRadius: 999,
            border: `2px solid ${theme.cyan}`,
            color: theme.cyan,
            fontFamily: theme.mono,
            fontSize: 34,
            opacity: interpolate(frame, [16, 28], [0, 1], clamp),
          }}
        >
          Wiki → {wiki}
        </Interactive.Div>
      </div>
      <div style={{ flex: 1, display: "flex", justifyContent: "center", perspective: 1600 }}>
        <Interactive.Div
          name="Window"
          style={{
            width: 1140,
            borderRadius: 18,
            overflow: "hidden",
            backgroundColor: "#1a1a1a",
            border: `2px solid ${theme.border}`,
            boxShadow: "0 40px 120px rgba(0,0,0,0.7), 0 0 60px rgba(217,119,87,0.25)",
            transform: `rotateY(${interpolate(frame, [0, durationInFrames], [-12, -4], clamp)}deg) rotateX(4deg)`,
            translate: interpolate(frame, [0, 0.7 * fps], ["200px 0px", "0px 0px"], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
            opacity: interpolate(frame, [0, 10], [0, 1], clamp),
          }}
        >
          <div style={{ height: 44, display: "flex", alignItems: "center", gap: 12, padding: "0 18px", backgroundColor: "#262523" }}>
            {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
              <div key={c} style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: c }} />
            ))}
          </div>
          <div style={{ overflow: "hidden", maxHeight: 760 }}>
            <Img
              src={staticFile(`shots/${shot}`)}
              style={{
                width: "100%",
                display: "block",
                scale: interpolate(frame, [0, durationInFrames], [1.02, 1.12], clamp),
                transformOrigin: "30% 30%",
              }}
            />
          </div>
        </Interactive.Div>
      </div>
    </AbsoluteFill>
  );
};
