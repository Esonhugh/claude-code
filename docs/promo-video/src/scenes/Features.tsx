import {
  AbsoluteFill,
  Easing,
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { theme } from "../theme";

const groups = [
  { title: "模型与 Provider", items: ["OpenAI / Codex", "网关模型自动发现", "重试与回退模型"] },
  { title: "Agent 与编排", items: ["子代理与后台任务", "Agent Teams", "Dynamic Workflow"] },
  { title: "权限与安全", items: ["Auto mode 分类器", "Hooks", "Bash 沙箱"] },
  { title: "工具", items: ["Terminal（PTY）", "Monitor", "Cron · /loop"] },
  { title: "上下文与记忆", items: ["auto memory", "SQLite FTS5 检索", "/autocompact"] },
  { title: "扩展", items: ["Mods（基线 2.1.303）", "Plugins · MCP", "Skills · Agent SDK"] },
];

export const Features: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill
      name="Features"
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
        核心功能<span style={{ color: theme.accent }}>.</span>
      </Interactive.Div>
      <div
        style={{
          marginTop: 44,
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 32,
        }}
      >
        {groups.map((g, i) => {
          const start = (0.5 + i * 0.35) * fps;
          return (
            <Interactive.Div
              key={g.title}
              name={`Card ${g.title}`}
              style={{
                backgroundColor: theme.panel,
                border: `2px solid ${theme.border}`,
                borderRadius: 24,
                padding: "32px 40px",
                opacity: interpolate(frame, [start, start + 0.5 * fps], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
                translate: interpolate(frame, [start, start + 0.7 * fps], ["0px 60px", "0px 0px"], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                  easing: Easing.bezier(0.16, 1, 0.3, 1),
                }),
              }}
            >
              <div style={{ fontSize: 46, fontWeight: 700, color: theme.accent }}>{g.title}</div>
              {g.items.map((item) => (
                <div key={item} style={{ fontSize: 40, marginTop: 16, color: theme.text }}>
                  <span style={{ color: theme.muted }}>› </span>
                  {item}
                </div>
              ))}
            </Interactive.Div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
