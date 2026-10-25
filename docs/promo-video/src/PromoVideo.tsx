import { Audio } from "@remotion/media";
import { linearTiming, springTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import { Fragment } from "react";
import { AbsoluteFill, interpolate, staticFile, useVideoConfig } from "remotion";
import { Background } from "./Background";
import { Diff } from "./scenes/Diff";
import { Intro } from "./scenes/Intro";
import { Outro } from "./scenes/Outro";
import { SectionTitle } from "./scenes/SectionTitle";
import { Showcase, ShowcaseItem } from "./scenes/Showcase";
import { Stats } from "./scenes/Stats";
import { WikiWall } from "./scenes/WikiWall";

const showcase: Omit<ShowcaseItem, "index">[] = [
  { title: "OpenAI / Codex", desc: "ChatGPT 账号或 API key 登录，工具、界面、命令照常使用", shot: "openai-provider-model.png", wiki: "Openai-Provider" },
  { title: "Agent Teams", desc: "一个负责人带几个队友并行干活，互发消息、共享任务清单", shot: "agent-teams-lead.png", wiki: "Agent-Teams" },
  { title: "Dynamic Workflow", desc: "一段脚本编排多个子 Agent 分阶段并行，/workflows 看进度", shot: "workflows-panel.png", wiki: "Workflows" },
  { title: "背景会话", desc: "任务丢到后台跑，claude agents 一屏看谁在等你", shot: "background-sessions-view.png", wiki: "Background-Sessions" },
  { title: "Auto mode", desc: "分类器逐个判断操作：安全的直接做，危险的拦下", shot: "auto-mode-run.png", wiki: "Auto-Mode" },
  { title: "Bash 沙箱", desc: "命令只能写项目目录、只能连你允许的域名", shot: "sandbox-run.png", wiki: "Sandbox" },
  { title: "/diff 视图", desc: "全屏右侧 diff 面板，按轮次回看每一处改动", shot: "diff-view-session.png", wiki: "Diff-View" },
  { title: "记忆检索", desc: "跨会话记住约定，SQLite FTS5 全文检索按需召回", shot: "memory-search.png", wiki: "Memory" },
  { title: "Mods", desc: "一个 JS/TS 文件改造 Claude：命令、钩子、侧边面板", shot: "mods-hold-pane.png", wiki: "Mods" },
];

export const SHOWCASE_FRAMES = 84;
const T = 12;
const directions = ["from-right", "from-bottom", "from-left", "from-top"] as const;

export const PROMO_DURATION = 180 + 110 + 60 + showcase.length * SHOWCASE_FRAMES + 150 + 60 + 300 + 210 - (6 + showcase.length) * T;

const Music: React.FC = () => {
  const { durationInFrames } = useVideoConfig();
  return (
    <Audio
      src={staticFile("audio/music.wav")}
      volume={(f) => interpolate(f, [0, durationInFrames - 60, durationInFrames], [0.55, 0.55, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
    />
  );
};

export const PromoVideo: React.FC = () => (
  <AbsoluteFill>
    <Background />
    <Music />
    <TransitionSeries>
      <TransitionSeries.Sequence name="Intro" durationInFrames={180}>
        <Intro />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
      <TransitionSeries.Sequence name="Stats" durationInFrames={110}>
        <Stats />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={wipe({ direction: "from-left" })} timing={linearTiming({ durationInFrames: T })} />
      <TransitionSeries.Sequence name="Showcase title" durationInFrames={60}>
        <SectionTitle title="核心功能" subtitle="画面均来自 tmux 实测（docs/features）" />
      </TransitionSeries.Sequence>
      {showcase.map((item, i) => (
        <Fragment key={item.title}>
          <TransitionSeries.Transition
            presentation={slide({ direction: directions[i % directions.length] })}
            timing={springTiming({ config: { damping: 200 }, durationInFrames: T })}
          />
          <TransitionSeries.Sequence name={`Showcase ${item.title}`} durationInFrames={SHOWCASE_FRAMES}>
            <Showcase index={i + 1} {...item} />
          </TransitionSeries.Sequence>
        </Fragment>
      ))}
      <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
      <TransitionSeries.Sequence name="Wiki" durationInFrames={150}>
        <WikiWall />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={wipe({ direction: "from-right" })} timing={linearTiming({ durationInFrames: T })} />
      <TransitionSeries.Sequence name="Diff title" durationInFrames={60}>
        <SectionTitle title="与官方的差异" subtitle="同一套体验，多一些选择" />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
      <TransitionSeries.Sequence name="Diff" durationInFrames={300}>
        <Diff />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={slide({ direction: "from-bottom" })} timing={springTiming({ config: { damping: 200 }, durationInFrames: T })} />
      <TransitionSeries.Sequence name="Outro" durationInFrames={210}>
        <Outro />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
);
