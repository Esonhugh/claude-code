import { AbsoluteFill, Easing, Interactive, interpolate, Series, useCurrentFrame } from "remotion";
import { Sfx } from "../Sfx";
import { clamp, theme } from "../theme";

const rows = [
  { topic: "模型", official: "Anthropic API 与云平台", fork: "另支持 OpenAI / Codex" },
  { topic: "自建网关", official: "手动填写模型名", fork: "模型自动列进 /model" },
  { topic: "遥测", official: "默认上报使用数据", fork: "默认全部关闭" },
  { topic: "/usage", official: "仅订阅用户可用", fork: "API key、网关用户也能用" },
  { topic: "记忆", official: "受服务端开关控制", fork: "默认开启 + SQLite FTS5 检索" },
  { topic: "源码", official: "只发布编译产物", fork: "可读 TS/TSX 源码，自行构建" },
];

export const HEADING_FRAMES = 30;
export const ROW_FRAMES = 30;
export const DIFF_FRAMES = HEADING_FRAMES + rows.length * ROW_FRAMES;

const settle = { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) };

const Heading: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", fontFamily: theme.sans, color: theme.text }}>
      <Sfx name="impact" volume={0.6} />
      <div style={{ display: "flex", alignItems: "center", gap: 48, fontSize: 150, fontWeight: 900 }}>
        <span style={{ color: theme.muted, translate: interpolate(frame, [0, 10], ["-300px 0px", "0px 0px"], settle) }}>官方</span>
        <span style={{ fontFamily: theme.mono, fontSize: 90, color: theme.accent, scale: interpolate(frame, [4, 12], [3, 1], { ...settle, output: "perceptual-scale" }) }}>VS</span>
        <span style={{ color: theme.accent, textShadow: `0 0 50px ${theme.accent}`, translate: interpolate(frame, [0, 10], ["300px 0px", "0px 0px"], settle) }}>本 fork</span>
      </div>
    </AbsoluteFill>
  );
};

// One difference per beat pair: the official answer gets struck out and the fork answer slams in.
const Row: React.FC<(typeof rows)[number] & { index: number }> = ({ topic, official, fork, index }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", fontFamily: theme.sans, color: theme.text }}>
      <Sfx name="tick" />
      <Sfx name="whoosh" at={10} volume={0.4} />
      <div style={{ fontFamily: theme.mono, fontSize: 36, color: theme.accent, letterSpacing: 8 }}>
        {String(index + 1).padStart(2, "0")} / {String(rows.length).padStart(2, "0")}
      </div>
      <div style={{ marginTop: 8, fontSize: 64, fontWeight: 700 }}>{topic}</div>
      <div style={{ position: "relative", marginTop: 36, fontSize: 56, color: theme.muted, opacity: interpolate(frame, [8, 14], [1, 0.35], clamp) }}>
        官方：{official}
        <div
          style={{
            position: "absolute",
            left: -10,
            top: "52%",
            height: 6,
            backgroundColor: theme.muted,
            width: `calc(${interpolate(frame, [4, 10], [0, 100], clamp)}% + 20px)`,
          }}
        />
      </div>
      <Interactive.Div
        name="Fork"
        style={{
          marginTop: 28,
          fontSize: 96,
          fontWeight: 900,
          color: theme.green,
          textShadow: `0 0 40px rgba(143,214,148,0.6)`,
          opacity: frame >= 10 ? 1 : 0,
          scale: interpolate(frame, [10, 17], [1.5, 1], { ...settle, output: "perceptual-scale" }),
        }}
      >
        <span style={{ fontFamily: theme.symbols }}>✓</span> {fork}
      </Interactive.Div>
    </AbsoluteFill>
  );
};

export const Diff: React.FC = () => (
  <Series>
    <Series.Sequence name="VS" durationInFrames={HEADING_FRAMES}>
      <Heading />
    </Series.Sequence>
    {rows.map((r, i) => (
      <Series.Sequence key={r.topic} name={`Row ${r.topic}`} durationInFrames={ROW_FRAMES}>
        <Row {...r} index={i} />
      </Series.Sequence>
    ))}
  </Series>
);
