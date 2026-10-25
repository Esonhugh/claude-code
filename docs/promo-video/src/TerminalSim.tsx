import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { TURN_COMPLETION_VERBS } from "../../../src/constants/turnCompletionVerbs";
import { Sfx } from "./Sfx";
import { clamp, theme } from "./theme";

// Dark theme colors from src/utils/theme.ts and spinner glyphs from src/components/Spinner/utils.ts.
const tui = {
  claude: "rgb(215,119,87)",
  claudeShimmer: "rgb(235,159,127)",
  text: "rgb(255,255,255)",
  inactive: "rgb(153,153,153)",
  subtle: "rgb(80,80,80)",
  success: "rgb(78,186,101)",
  error: "rgb(255,107,128)",
  warning: "rgb(255,193,7)",
  suggestion: "rgb(177,185,249)",
  userMessageBackground: "rgb(55,55,55)",
};
const SPINNER = ["·", "✢", "*", "✶", "✻", "✽"];
const SPINNER_CYCLE = [...SPINNER, ...[...SPINNER].reverse()];

export type TuiColor = keyof typeof tui;
export type SimStep =
  | { at: number; type: "prompt"; text: string }
  | { at: number; type: "spinner"; verb: string; until: number }
  | { at: number; type: "tool"; name: string; args: string; color: TuiColor }
  | { at: number; type: "result"; text: string; color?: TuiColor; highlight?: boolean }
  | { at: number; type: "line"; text: string; color?: TuiColor }
  | { at: number; type: "done"; verb: (typeof TURN_COMPLETION_VERBS)[number]; seconds: number };

export const TerminalSim: React.FC<{ steps: SimStep[]; footer: { text: string; color: TuiColor } }> = ({ steps, footer }) => {
  const frame = useCurrentFrame();
  const visible = steps.filter((s) => frame >= s.at && !(s.type === "spinner" && frame >= s.until));
  const lines = visible.length;

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      {steps.map((s, i) =>
        s.type === "prompt" ? (
          <Sfx key={i} name="tick" at={s.at} volume={0.4} />
        ) : s.type === "result" && s.highlight ? (
          <Sfx key={i} name="impact" at={s.at} volume={0.7} />
        ) : s.type === "tool" ? (
          <Sfx key={i} name="tick" at={s.at} volume={0.5} />
        ) : null,
      )}
      <div
        style={{
          width: 1560,
          borderRadius: 20,
          overflow: "hidden",
          backgroundColor: "rgba(24,24,24,0.96)",
          border: `2px solid ${theme.border}`,
          boxShadow: "0 50px 160px rgba(0,0,0,0.8), 0 0 60px rgba(217,119,87,0.25)",
          fontFamily: theme.mono,
          fontSize: 36,
          lineHeight: 1.5,
          color: tui.text,
          rotate: `${interpolate(frame, [0, 90], [-1.5, 0], clamp)}deg`,
          scale: interpolate(frame, [0, 12], [0.9, 1], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
          translate: `0px ${-Math.max(0, lines - 5) * 18}px`,
        }}
      >
        <div style={{ height: 46, display: "flex", alignItems: "center", gap: 12, padding: "0 20px", backgroundColor: "#262523" }}>
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <div key={c} style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: c }} />
          ))}
          <span style={{ marginLeft: 16, fontSize: 24, color: tui.inactive }}>claude — ~/work</span>
        </div>
        <div style={{ padding: "28px 40px", minHeight: 520 }}>
          {visible.map((s, i) => (
            <SimLine key={i} step={s} frame={frame} />
          ))}
        </div>
        <div style={{ borderTop: `2px solid ${tui.subtle}`, padding: "10px 40px" }}>
          <span style={{ color: tui.inactive }}>❯ </span>
          <span style={{ color: tui.text, opacity: Math.floor(frame / 15) % 2 === 0 ? 1 : 0 }}>▋</span>
        </div>
        <div style={{ borderTop: `2px solid ${tui.subtle}`, padding: "6px 52px 16px", fontSize: 28, color: tui[footer.color] }}>{footer.text}</div>
      </div>
    </AbsoluteFill>
  );
};

const SimLine: React.FC<{ step: SimStep; frame: number }> = ({ step, frame }) => {
  const local = frame - step.at;
  const appear = { opacity: interpolate(local, [0, 4], [0, 1], clamp), translate: `${interpolate(local, [0, 6], [-24, 0], clamp)}px 0px` };

  switch (step.type) {
    case "prompt": {
      const shown = step.text.slice(0, Math.round(interpolate(local, [0, 14], [0, step.text.length], clamp)));
      return (
        <div style={{ margin: "6px 0 14px", padding: "2px 12px", backgroundColor: tui.userMessageBackground, display: "inline-block" }}>
          <span style={{ color: tui.inactive }}>❯ </span>
          {shown}
        </div>
      );
    }
    case "spinner": {
      const glyph = SPINNER_CYCLE[Math.floor(frame / 3) % SPINNER_CYCLE.length];
      const sweep = (frame * 0.6) % (step.verb.length + 6);
      return (
        <div style={{ color: tui.claude }}>
          {glyph}{" "}
          {[...`${step.verb}…`].map((c, i) => (
            <span key={i} style={{ color: Math.abs(i - sweep) < 2 ? tui.claudeShimmer : tui.claude }}>
              {c}
            </span>
          ))}
          <span style={{ color: tui.inactive }}> ({Math.floor(local / 30) + 1}s · esc to interrupt)</span>
        </div>
      );
    }
    case "tool":
      return (
        <div style={{ ...appear, marginTop: 10 }}>
          <span style={{ color: tui[step.color] }}>● </span>
          <b>{step.name}</b>({step.args})
        </div>
      );
    case "result": {
      const glow = step.highlight ? interpolate(local, [0, 4, 30], [0, 1, 0.5], clamp) : 0;
      return (
        <div style={{ ...appear, paddingLeft: 36, color: tui[step.color ?? "inactive"] }}>
          ⎿{"  "}
          <span
            style={{
              padding: "0 8px",
              borderRadius: 6,
              backgroundColor: `rgba(255,107,128,${0.25 * glow})`,
              boxShadow: glow ? `0 0 ${30 * glow}px rgba(255,107,128,${glow})` : undefined,
            }}
          >
            {step.text}
          </span>
        </div>
      );
    }
    case "line":
      return <div style={{ ...appear, marginTop: 10, color: tui[step.color ?? "text"] }}>{step.text}</div>;
    case "done":
      return (
        <div style={{ ...appear, marginTop: 10, color: tui.inactive }}>
          ✻ {step.verb} for {step.seconds}s
        </div>
      );
  }
};
