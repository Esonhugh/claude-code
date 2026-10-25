import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "./theme";

// Slow drifting glow blobs over a scrolling perspective grid.
export const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / 30;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at ${50 + 30 * Math.sin(t * 0.4)}% ${40 + 20 * Math.cos(t * 0.3)}%, rgba(217,119,87,0.32), transparent 45%),
            radial-gradient(circle at ${50 + 35 * Math.cos(t * 0.25)}% ${60 + 25 * Math.sin(t * 0.35)}%, rgba(111,211,230,0.16), transparent 45%),
            radial-gradient(circle at ${20 + 10 * Math.sin(t * 0.5)}% ${80}%, rgba(140,90,220,0.18), transparent 40%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "-50%",
          width: "200%",
          top: "45%",
          height: "120%",
          transformOrigin: "50% 0%",
          transform: "perspective(600px) rotateX(62deg)",
          backgroundImage:
            "linear-gradient(rgba(217,119,87,0.22) 2px, transparent 2px), linear-gradient(90deg, rgba(217,119,87,0.22) 2px, transparent 2px)",
          backgroundSize: "120px 120px",
          backgroundPosition: `0px ${interpolate(frame, [0, 60], [0, 120]) % 120}px`,
          maskImage: "linear-gradient(to bottom, transparent, black 30%, black 60%, transparent)",
        }}
      />
      <AbsoluteFill
        style={{ background: "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.75) 100%)" }}
      />
    </AbsoluteFill>
  );
};
