import { AbsoluteFill, Easing, Img, Interactive, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Sfx } from "../Sfx";
import { clamp, theme } from "../theme";

const shots = [
  "agents-view.png", "auto-mode-rules.png", "background-sessions-reply.png", "branding-custom.png", "channels-message.png",
  "compaction-dialog.png", "diff-view-branch.png", "direct-connect-done.png", "effort-picker.png", "goal-achieved.png",
  "hooks-menu.png", "keybindings-vim-visual.png", "mcp-panel.png", "memory-menu.png", "monitor-tool-event.png",
  "peer-messaging-peers.png", "permissions-dialog.png", "plugins-marketplace-discover.png", "sandbox-network.png", "scheduled-tasks-fire.png",
  "session-commands-cd.png", "skills-list.png", "ssh-remote-run.png", "terminal-tool-sendkeys.png", "usage-and-cost-usage.png",
];

export const WikiWall: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  return (
    <AbsoluteFill name="WikiWall" style={{ fontFamily: theme.sans, color: theme.text, overflow: "hidden" }}>
      <Sfx name="whoosh" />
      <AbsoluteFill style={{ perspective: 1800, justifyContent: "center", alignItems: "center" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, 560px)",
            gap: 24,
            transform: `rotateX(28deg) rotateZ(-10deg) scale(${interpolate(frame, [0, durationInFrames], [1.5, 0.95], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) })})`,
            translate: `${interpolate(frame, [0, durationInFrames], [200, -100], clamp)}px 0px`,
          }}
        >
          {shots.map((s, i) => (
            <Img
              key={s}
              src={staticFile(`shots/${s}`)}
              style={{
                width: 560,
                height: 340,
                objectFit: "cover",
                objectPosition: "top left",
                borderRadius: 12,
                border: `2px solid ${theme.border}`,
                opacity: interpolate(frame, [i * 1.2, i * 1.2 + 10], [0, 0.55], clamp),
              }}
            />
          ))}
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <Interactive.Div
          name="Card"
          style={{
            padding: "56px 80px",
            borderRadius: 32,
            backgroundColor: "rgba(12,11,10,0.86)",
            border: `2px solid ${theme.accent}`,
            boxShadow: `0 0 80px rgba(217,119,87,0.45)`,
            textAlign: "center",
            opacity: interpolate(frame, [0.6 * fps, 1 * fps], [0, 1], clamp),
            scale: interpolate(frame, [0.6 * fps, 1.1 * fps], [0.8, 1], { ...clamp, easing: Easing.spring({ damping: 12 }), output: "perceptual-scale" }),
          }}
        >
          <Sfx name="impact" at={Math.round(0.6 * fps)} volume={0.5} />
          <div style={{ fontSize: 92, fontWeight: 900 }}>
            每个功能一页 <span style={{ color: theme.accent }}>Wiki</span>
          </div>
          <div style={{ marginTop: 20, fontSize: 46, color: theme.muted }}>40 个功能页 · 119 张实测截图 · 白话分步说明</div>
          <div style={{ marginTop: 32, fontFamily: theme.mono, fontSize: 44, color: theme.cyan }}>github.com/Esonhugh/claude-code/wiki</div>
        </Interactive.Div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
