import {
  AbsoluteFill,
  Easing,
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { theme } from "../theme";

const rows = [
  { topic: "模型 Provider", official: "Anthropic API 与云平台", fork: "另支持 OpenAI / Codex" },
  { topic: "自建网关", official: "手动填写模型名", fork: "自动把网关模型列进 /model" },
  { topic: "遥测", official: "默认上报使用统计与错误", fork: "默认全部关闭，需要时再打开" },
  { topic: "/usage", official: "仅订阅用户可用", fork: "API key、网关用户同样可用" },
  { topic: "记忆", official: "受服务端开关控制", fork: "默认开启，可选 SQLite FTS5 检索" },
  { topic: "源码", official: "只发布编译产物", fork: "可读 TS/TSX 源码，自行构建" },
];

const columns = "320px 560px 1fr";

export const Diff: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill
      name="Diff"
      style={{
        backgroundColor: theme.bg,
        fontFamily: theme.sans,
        color: theme.text,
        padding: "90px 120px",
      }}
    >
      <Interactive.Div
        name="Heading"
        style={{
          fontSize: 84,
          fontWeight: 900,
          opacity: interpolate(frame, [0, 0.6 * fps], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        与官方的差异<span style={{ color: theme.accent }}>.</span>
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
        const start = (0.8 + i * 0.9) * fps;
        return (
          <Interactive.Div
            key={r.topic}
            name={`Row ${r.topic}`}
            style={{
              display: "grid",
              gridTemplateColumns: columns,
              alignItems: "center",
              padding: "20px 0",
              borderBottom: `2px solid ${theme.border}`,
              fontSize: 40,
              opacity: interpolate(frame, [start, start + 0.5 * fps], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
              translate: interpolate(frame, [start, start + 0.6 * fps], ["-60px 0px", "0px 0px"], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              }),
            }}
          >
            <div style={{ fontWeight: 700 }}>{r.topic}</div>
            <div style={{ color: theme.muted }}>{r.official}</div>
            <div style={{ color: theme.green }}>
              <span style={{ fontFamily: "\"Noto Sans Symbols 2\"" }}>✓</span> {r.fork}
            </div>
          </Interactive.Div>
        );
      })}
    </AbsoluteFill>
  );
};
