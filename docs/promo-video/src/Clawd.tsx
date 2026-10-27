import { theme } from "./theme";

// Poses and animations ported from src/components/LogoV2/Clawd.tsx and AnimatedClawd.tsx.
// Each terminal block character is drawn as its 2×2 quadrant cells so the mascot stays crisp at any size.
export type ClawdPose = "default" | "arms-up" | "look-left" | "look-right";

type Segments = { r1L: string; r1E: string; r1R: string; r2L: string; r2R: string };
const POSES: Record<ClawdPose, Segments> = {
  default: { r1L: " ▐", r1E: "▛███▜", r1R: "▌", r2L: "▝▜", r2R: "▛▘" },
  "look-left": { r1L: " ▐", r1E: "▟███▟", r1R: "▌", r2L: "▝▜", r2R: "▛▘" },
  "look-right": { r1L: " ▐", r1E: "▙███▙", r1R: "▌", r2L: "▝▜", r2R: "▛▘" },
  "arms-up": { r1L: "▗▟", r1E: "▛███▜", r1R: "▙▖", r2L: " ▜", r2R: "▛ " },
};

// Quadrant bits: top-left, top-right, bottom-left, bottom-right.
const QUADRANTS: Record<string, [number, number, number, number]> = {
  " ": [0, 0, 0, 0],
  "█": [1, 1, 1, 1],
  "▐": [0, 1, 0, 1],
  "▌": [1, 0, 1, 0],
  "▛": [1, 1, 1, 0],
  "▜": [1, 1, 0, 1],
  "▙": [1, 0, 1, 1],
  "▟": [0, 1, 1, 1],
  "▝": [0, 1, 0, 0],
  "▘": [1, 0, 0, 0],
  "▗": [0, 0, 0, 1],
  "▖": [0, 0, 1, 0],
};

type Run = { text: string; bg: boolean };
const rows = (p: Segments): Run[][] => [
  [{ text: p.r1L, bg: false }, { text: p.r1E, bg: true }, { text: p.r1R, bg: false }],
  [{ text: p.r2L, bg: false }, { text: "█████", bg: true }, { text: p.r2R, bg: false }],
  [{ text: "  ▘▘ ▝▝  ", bg: false }],
];

type Frame = { pose: ClawdPose; offset: number };
const hold = (pose: ClawdPose, offset: number, frames: number): Frame[] => Array.from({ length: frames }, () => ({ pose, offset }));

export const JUMP_WAVE: Frame[] = [
  ...hold("default", 1, 2),
  ...hold("arms-up", 0, 3),
  ...hold("default", 0, 1),
  ...hold("default", 1, 2),
  ...hold("arms-up", 0, 3),
  ...hold("default", 0, 1),
];
export const LOOK_AROUND: Frame[] = [...hold("look-right", 0, 5), ...hold("look-left", 0, 5), ...hold("default", 0, 1)];

const FRAME_MS = 60;

/** Plays an AnimatedClawd sequence starting at `start` (video frame), at the original 60 ms per pose frame. */
export const clawdFrame = (frame: number, fps: number, start: number, seq: Frame[]): Frame => {
  const i = Math.floor(((frame - start) * 1000) / fps / FRAME_MS);
  return i >= 0 && i < seq.length ? seq[i] : { pose: "default", offset: 0 };
};

export const Clawd: React.FC<{ pose?: ClawdPose; cell: number; offset?: number }> = ({ pose = "default", cell, offset = 0 }) => {
  const w = cell;
  const h = cell * 2;
  return (
    <div style={{ height: h * 3, overflow: "hidden" }}>
      <div style={{ marginTop: offset * h, filter: `drop-shadow(0 0 ${cell}px rgba(215,119,87,0.6))` }}>
        {rows(POSES[pose]).map((runs, r) => (
          <div key={r} style={{ display: "flex", height: h }}>
            {runs.flatMap((run, k) =>
              [...run.text].map((ch, c) => (
                <div key={`${k}-${c}`} style={{ width: w, height: h, display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", backgroundColor: run.bg ? "rgb(0,0,0)" : undefined }}>
                  {QUADRANTS[ch].map((on, q) => (
                    <div key={q} style={{ backgroundColor: on ? theme.accent : undefined }} />
                  ))}
                </div>
              )),
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
