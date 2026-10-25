import { AbsoluteFill, Easing, Img, Interactive, interpolate, Series, staticFile, useCurrentFrame } from "remotion";
import { Sfx } from "../Sfx";
import { SimStep, TerminalSim, TuiColor } from "../TerminalSim";
import { clamp, theme } from "../theme";

export type Focus = { x: number; y: number; w: number; h: number };
type ImageShot = { kind: "image"; file: string; width: number; height: number; focus: Focus; label: string; wiki: string };
type SimShot = { kind: "sim"; steps: SimStep[]; footer: { text: string; color: TuiColor }; labelAt: number; label: string; wiki: string };
export type ChapterShot = ImageShot | SimShot;
export type ChapterProps = { index: number; question: string; answer: string; shots: ChapterShot[] };

export const QUESTION_FRAMES = 45;
export const SHOT_FRAMES = 60;
export const SIM_FRAMES = 120;
const shotFrames = (s: ChapterShot) => (s.kind === "sim" ? SIM_FRAMES : SHOT_FRAMES);
export const chapterFrames = (shots: ChapterShot[]) => QUESTION_FRAMES + shots.reduce((n, s) => n + shotFrames(s), 0);

const W = 1920;
const H = 1080;
const settle = { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) };

const Question: React.FC<{ index: number; question: string; answer: string }> = ({ index, question, answer }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", fontFamily: theme.sans, color: theme.text }}>
      <Sfx name="impact" volume={0.5} />
      <Sfx name="tick" at={15} />
      <div style={{ fontFamily: theme.mono, fontSize: 40, letterSpacing: 10, color: theme.accent }}>CHAPTER {String(index).padStart(2, "0")}</div>
      <Interactive.Div
        name="Question"
        style={{
          marginTop: 16,
          fontSize: 136,
          fontWeight: 900,
          scale: interpolate(frame, [0, 8], [1.5, 1], { ...settle, output: "perceptual-scale" }),
          opacity: interpolate(frame, [0, 3], [0, 1], clamp),
        }}
      >
        {question}
      </Interactive.Div>
      <Interactive.Div
        name="Answer"
        style={{
          marginTop: 20,
          padding: "8px 36px",
          fontSize: 76,
          fontWeight: 900,
          color: theme.bg,
          backgroundColor: theme.accent,
          boxShadow: `0 0 50px ${theme.accent}`,
          rotate: "-2deg",
          opacity: frame >= 15 ? 1 : 0,
          scale: interpolate(frame, [15, 22], [1.6, 1], { ...settle, output: "perceptual-scale" }),
        }}
      >
        {answer}
      </Interactive.Div>
    </AbsoluteFill>
  );
};

// The camera starts on the whole screenshot, pushes in on the part that matters and spotlights it.
const Shot: React.FC<ImageShot> = ({ file, width, height, focus, label, wiki }) => {
  const frame = useCurrentFrame();
  const push = interpolate(frame, [10, 26], [0, 1], { ...clamp, easing: Easing.bezier(0.65, 0, 0.35, 1) });
  const k0 = Math.min(1760 / width, 900 / height);
  const k1 = Math.min(1500 / focus.w, 560 / focus.h, 3);
  const drift = interpolate(frame, [26, SHOT_FRAMES], [1, 1.06], clamp);
  const enter = interpolate(frame, [0, 8], [1.25, 1], settle);
  const k = (k0 + (k1 - k0) * push) * drift * enter;
  const cx = width / 2 + (focus.x + focus.w / 2 - width / 2) * push;
  const cy = height / 2 + (focus.y + focus.h / 2 - height / 2) * push;
  const left = W / 2 - cx * k;
  const top = H * 0.44 - cy * k;
  const lock = interpolate(frame, [24, 30], [0, 1], clamp);
  const pad = 14;
  const exit = interpolate(frame, [SHOT_FRAMES - 6, SHOT_FRAMES], [0, 1], clamp);

  return (
    <AbsoluteFill style={{ overflow: "hidden", fontFamily: theme.sans, color: theme.text, filter: `blur(${interpolate(frame, [0, 6], [14, 0], clamp) + exit * 16}px)`, opacity: 1 - exit * 0.6 }}>
      <Sfx name="whoosh" volume={0.5} />
      <Sfx name="impact" at={24} volume={0.45} />
      <Img
        src={staticFile(`shots/${file}`)}
        style={{
          position: "absolute",
          left,
          top,
          width: width * k,
          height: height * k,
          borderRadius: 12,
          boxShadow: "0 40px 140px rgba(0,0,0,0.8)",
          imageRendering: k > 2 ? "pixelated" : "auto",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: left + (focus.x - pad) * k,
          top: top + (focus.y - pad) * k,
          width: (focus.w + pad * 2) * k,
          height: (focus.h + pad * 2) * k,
          borderRadius: 14,
          border: `5px solid ${theme.accent}`,
          boxShadow: `0 0 0 4000px rgba(0,0,0,${0.62 * lock}), 0 0 ${40 + 20 * Math.sin(frame / 3)}px ${theme.accent}`,
          opacity: lock,
        }}
      />
      <Caption label={label} wiki={wiki} at={24} />
    </AbsoluteFill>
  );
};

const Caption: React.FC<{ label: string; wiki: string; at: number }> = ({ label, wiki, at }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        padding: "120px 0 80px",
        background: "linear-gradient(transparent, rgba(8,8,8,0.92) 55%)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: 32,
        opacity: interpolate(frame, [at, at + 6], [0, 1], clamp),
      }}
    >
      <Interactive.Div
        name="Label"
        style={{
          fontSize: 84,
          fontWeight: 900,
          textShadow: "0 6px 30px rgba(0,0,0,0.9)",
          scale: interpolate(frame, [at, at + 8], [1.4, 1], { ...settle, output: "perceptual-scale" }),
        }}
      >
        {label}
      </Interactive.Div>
      <div
        style={{
          padding: "8px 24px",
          borderRadius: 999,
          border: `2px solid ${theme.cyan}`,
          backgroundColor: "rgba(12,11,10,0.8)",
          color: theme.cyan,
          fontFamily: theme.mono,
          fontSize: 32,
        }}
      >
        Wiki → {wiki}
      </div>
    </div>
  );
};

// A scripted terminal session that replays the real interaction instead of a still screenshot.
const Sim: React.FC<SimShot> = ({ steps, footer, labelAt, label, wiki }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ fontFamily: theme.sans, color: theme.text, top: -70, scale: interpolate(frame, [0, SIM_FRAMES], [1, 1.06], clamp) }}>
      <Sfx name="whoosh" volume={0.5} />
      <TerminalSim steps={steps} footer={footer} />
      <AbsoluteFill style={{ top: 70 }}>
        <Caption label={label} wiki={wiki} at={labelAt} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const Chapter: React.FC<ChapterProps> = ({ index, question, answer, shots }) => (
  <Series>
    <Series.Sequence name="Question" durationInFrames={QUESTION_FRAMES}>
      <Question index={index} question={question} answer={answer} />
    </Series.Sequence>
    {shots.map((s) => (
      <Series.Sequence key={s.label} name={`Shot ${s.label}`} durationInFrames={shotFrames(s)}>
        {s.kind === "sim" ? <Sim {...s} /> : <Shot {...s} />}
      </Series.Sequence>
    ))}
  </Series>
);
