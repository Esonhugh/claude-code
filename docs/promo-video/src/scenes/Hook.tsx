import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { Sfx } from "../Sfx";
import { clamp, theme } from "../theme";

const pains = ["想让 Claude Code 跑 GPT / Codex？", "不想默认上报使用数据？", "想读源码、自己改、自己编？"];

export const LINE_FRAMES = 40;
export const HOOK_FRAMES = pains.length * LINE_FRAMES + 45;

// Each pain point punches in, then gets struck through on the next beat.
export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const answerAt = pains.length * LINE_FRAMES;

  return (
    <AbsoluteFill name="Hook" style={{ justifyContent: "center", alignItems: "center", fontFamily: theme.sans, color: theme.text }}>
      {pains.map((p, i) => {
        const start = i * LINE_FRAMES;
        const local = frame - start;
        if (local < 0 || local >= LINE_FRAMES) return null;
        const jitter = local < 4 ? (4 - local) * 6 * (i % 2 === 0 ? 1 : -1) : 0;
        return (
          <AbsoluteFill key={p} style={{ justifyContent: "center", alignItems: "center" }}>
            <Sfx name="impact" volume={0.45} />
            <Sfx name="tick" at={22} />
            <Interactive.Div
              name={`Pain ${i + 1}`}
              style={{
                position: "relative",
                fontSize: 104,
                fontWeight: 900,
                translate: `${jitter}px 0px`,
                scale: interpolate(local, [0, 6], [1.25, 1], { ...clamp, output: "perceptual-scale" }),
                opacity: interpolate(local, [0, 3, LINE_FRAMES - 6, LINE_FRAMES], [0, 1, 1, 0], clamp),
                textShadow: `${jitter}px 0 0 rgba(111,211,230,0.8), ${-jitter}px 0 0 rgba(217,119,87,0.9)`,
              }}
            >
              {p}
              <div
                style={{
                  position: "absolute",
                  left: -20,
                  top: "52%",
                  height: 12,
                  borderRadius: 6,
                  backgroundColor: theme.accent,
                  boxShadow: `0 0 24px ${theme.accent}`,
                  width: `calc(${interpolate(local, [22, 30], [0, 100], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) })}% + 40px)`,
                  opacity: local >= 22 ? 1 : 0,
                }}
              />
            </Interactive.Div>
          </AbsoluteFill>
        );
      })}
      <Sfx name="riser" at={answerAt - 15} />
      <Interactive.Div
        name="Answer"
        style={{
          fontSize: 96,
          fontWeight: 900,
          color: theme.accent,
          textShadow: `0 0 40px ${theme.accent}`,
          opacity: interpolate(frame, [answerAt, answerAt + 8], [0, 1], clamp),
          letterSpacing: interpolate(frame, [answerAt, answerAt + 45], [4, 30], clamp),
        }}
      >
        那就换一个。
      </Interactive.Div>
    </AbsoluteFill>
  );
};
