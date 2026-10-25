import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Sfx } from "../Sfx";
import { clamp, theme } from "../theme";

const rows = [
  { topic: "模型 Provider", official: "Anthropic API 与云平台", fork: "另支持 OpenAI / Codex" },
  { topic: "自建网关", official: "手动填写模型名", fork: "自动把网关模型列进 /model" },
  { topic: "遥测", official: "默认上报使用统计与错误", fork: "默认全部关闭，需要时再打开" },
  { topic: "/usage", official: "仅订阅用户可用", fork: "API key、网关用户同样可用" },
  { topic: "记忆", official: "受服务端开关控制", fork: "默认开启，可选 SQLite FTS5 检索" },
  { topic: "源码", official: "只发布编译产物", fork: "可读 TS/TSX 源码，自行构建" },
];

const columns = "320px 540px 1fr";

export const Diff: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill name="Diff" style={{ fontFamily: theme.sans, color: theme.text, padding: "90px 120px" }}>
      <Interactive.Div
        name="Heading"
        style={{
          fontSize: 84,
          fontWeight: 900,
          opacity: interpolate(frame, [0, 0.5 * fps], [0, 1], clamp),
          translate: interpolate(frame, [0, 0.5 * fps], ["0px -40px", "0px 0px"], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
        }}
      >
        官方 <span style={{ color: theme.muted }}>vs</span> <span style={{ color: theme.accent, textShadow: `0 0 30px ${theme.accent}` }}>本 fork</span>
      </Interactive.Div>
      <div
        style={{
          marginTop: 40,
          display: "grid",
          gridTemplateColumns: columns,
          fontSize: 40,
          fontWeight: 700,
          color: theme.muted,
          paddingBottom: 16,
          borderBottom: `2px solid ${theme.border}`,
        }}
      >
        <div />
        <div>官方 Claude Code</div>
        <div style={{ color: theme.accent }}>本 fork</div>
      </div>
      {rows.map((r, i) => {
        const start = Math.round((0.7 + i * 0.75) * fps);
        const glow = interpolate(frame, [start + 6, start + 20], [1, 0], clamp);
        return (
          <Interactive.Div
            key={r.topic}
            name={`Row ${r.topic}`}
            style={{
              display: "grid",
              gridTemplateColumns: columns,
              alignItems: "center",
              padding: "20px 0",
              borderBottom: `2px solid rgba(255,255,255,0.08)`,
              fontSize: 40,
              backgroundColor: `rgba(217,119,87,${0.18 * glow})`,
              opacity: interpolate(frame, [start, start + 8], [0, 1], clamp),
              translate: interpolate(frame, [start, start + 0.5 * fps], ["-80px 0px", "0px 0px"], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
            }}
          >
            <Sfx name="tick" at={start} />
            <div style={{ fontWeight: 700 }}>{r.topic}</div>
            <div style={{ color: "rgba(168,165,155,0.7)" }}>{r.official}</div>
            <div style={{ color: theme.green, textShadow: `0 0 ${20 * glow}px ${theme.green}` }}>
              <span style={{ fontFamily: theme.symbols }}>✓</span> {r.fork}
            </div>
          </Interactive.Div>
        );
      })}
    </AbsoluteFill>
  );
};
