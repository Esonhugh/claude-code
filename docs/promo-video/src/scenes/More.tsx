import { AbsoluteFill, Img, interpolate, Series, staticFile, useCurrentFrame } from "remotion";
import { Sfx } from "../Sfx";
import { clamp, theme } from "../theme";

const items = [
  { name: "Terminal 工具", desc: "开 REPL、操作 TUI、按 Ctrl+C", shot: "terminal-tool-running.png" },
  { name: "Monitor", desc: "盯着日志，有新内容就叫醒它", shot: "monitor-tool-event.png" },
  { name: "定时任务", desc: "Cron、/loop 一句话设定", shot: "scheduled-tasks-fire.png" },
  { name: "会话互通", desc: "几个会话互相发现、互发消息", shot: "peer-messaging-receive.png" },
  { name: "SSH Remote", desc: "在远程机器干活，凭据不离开本机", shot: "ssh-remote-run.png" },
  { name: "Direct Connect", desc: "claude server + cc:// 远程连接", shot: "direct-connect-done.png" },
  { name: "Channels", desc: "Telegram / Discord 推消息进会话", shot: "channels-message.png" },
  { name: "自主 Goal", desc: "做到才算完，没达成就继续", shot: "goal-achieved.png" },
  { name: "Effort 档位", desc: "想多深，你说了算", shot: "effort-picker.png" },
  { name: "插件市场", desc: "一键装命令、skill、hook、MCP", shot: "plugins-marketplace-discover.png" },
  { name: "Skills", desc: "/skill-doctor 揪出没用过的 skill", shot: "skills-doctor.png" },
  { name: "MCP", desc: "配错一条只跳过那一条", shot: "mcp-panel.png" },
  { name: "Vim 模式", desc: "输入框里的选择与括号跳转", shot: "keybindings-vim-visual.png" },
  { name: "请求韧性", desc: "过载自动重试、切备用模型", shot: "request-resilience-fallback.png" },
];

export const MORE_HEADER_FRAMES = 30;
export const MORE_ITEM_FRAMES = 15;
export const MORE_FRAMES = MORE_HEADER_FRAMES + items.length * MORE_ITEM_FRAMES;

const Header: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", fontFamily: theme.sans, color: theme.text }}>
      <Sfx name="riser" volume={0.5} />
      <div style={{ fontSize: 150, fontWeight: 900, scale: interpolate(frame, [0, 30], [0.9, 1.15], clamp), opacity: interpolate(frame, [0, 4], [0, 1], clamp) }}>
        还有<span style={{ color: theme.accent, textShadow: `0 0 40px ${theme.accent}` }}>更多</span>。
      </div>
    </AbsoluteFill>
  );
};

// One feature per beat: a full-bleed screenshot drifting behind a slammed title.
const Item: React.FC<(typeof items)[number] & { index: number }> = ({ name, desc, shot, index }) => {
  const frame = useCurrentFrame();
  const split = interpolate(frame, [0, 6], [14, 0], clamp);
  return (
    <AbsoluteFill style={{ overflow: "hidden", fontFamily: theme.sans, color: theme.text, justifyContent: "center", alignItems: "center" }}>
      <Sfx name="tick" volume={0.7} />
      <Img
        src={staticFile(`shots/${shot}`)}
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: "top left",
          opacity: 0.4,
          scale: interpolate(frame, [0, MORE_ITEM_FRAMES], [1.5, 1.7], clamp),
          rotate: `${index % 2 === 0 ? -3 : 3}deg`,
          filter: "blur(1.5px)",
        }}
      />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, rgba(12,11,10,0.55), rgba(12,11,10,0.9) 70%)" }} />
      <div style={{ position: "absolute", top: 90, left: 120, fontFamily: theme.mono, fontSize: 48, color: theme.accent }}>
        +{String(index + 1).padStart(2, "0")}
      </div>
      <div
        style={{
          fontSize: 150,
          fontWeight: 900,
          scale: interpolate(frame, [0, 5], [1.35, 1], { ...clamp, output: "perceptual-scale" }),
          textShadow: `${split}px 0 0 rgba(111,211,230,0.8), ${-split}px 0 0 rgba(217,119,87,0.9), 0 8px 40px rgba(0,0,0,0.9)`,
        }}
      >
        {name}
      </div>
      <div style={{ marginTop: 20, fontSize: 52, color: theme.accent2, opacity: interpolate(frame, [3, 6], [0, 1], clamp) }}>{desc}</div>
    </AbsoluteFill>
  );
};

export const More: React.FC = () => (
  <Series>
    <Series.Sequence name="More header" durationInFrames={MORE_HEADER_FRAMES}>
      <Header />
    </Series.Sequence>
    {items.map((it, i) => (
      <Series.Sequence key={it.name} name={`More ${it.name}`} durationInFrames={MORE_ITEM_FRAMES}>
        <Item {...it} index={i} />
      </Series.Sequence>
    ))}
  </Series>
);
