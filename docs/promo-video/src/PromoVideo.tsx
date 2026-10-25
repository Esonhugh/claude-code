import { Audio } from "@remotion/media";
import { AbsoluteFill, interpolate, Series, staticFile, useVideoConfig } from "remotion";
import { Background } from "./Background";
import { Chapter, chapterFrames, ChapterProps } from "./scenes/Chapter";
import { Diff, DIFF_FRAMES } from "./scenes/Diff";
import { Hook, HOOK_FRAMES } from "./scenes/Hook";
import { Intro } from "./scenes/Intro";
import { More, MORE_FRAMES } from "./scenes/More";
import { Outro } from "./scenes/Outro";
import { WikiWall } from "./scenes/WikiWall";

// Every section length is a multiple of 15 frames so hard cuts land on the 120 BPM beat.
const chapters: Omit<ChapterProps, "index">[] = [
  {
    question: "只能用 Claude 模型？",
    answer: "GPT、Codex、自建网关，都行。",
    shots: [
      { kind: "image", file: "openai-provider-model.png", width: 959, height: 374, focus: { x: 118, y: 30, w: 280, h: 26 }, label: "GPT 模型直接驱动", wiki: "Openai-Provider" },
      { kind: "image", file: "model-discovery-picker.png", width: 959, height: 465, focus: { x: 30, y: 340, w: 370, h: 40 }, label: "网关模型自动出现", wiki: "Model-Discovery" },
    ],
  },
  {
    question: "一个 Claude 不够用？",
    answer: "组队、编排、丢到后台。",
    shots: [
      {
        kind: "sim",
        footer: { text: "team-lead · @writer · @reviewer   shift + ↑/↓ to select", color: "suggestion" },
        steps: [
          { at: 4, type: "prompt", text: "组个 docs 团队：writer 写引言，reviewer 审稿" },
          { at: 20, type: "spinner", verb: "Orchestrating", until: 36 },
          { at: 36, type: "tool", name: "TeamCreate", args: "docs", color: "success" },
          { at: 46, type: "tool", name: "Agent", args: "writer · draft intro", color: "success" },
          { at: 54, type: "tool", name: "Agent", args: "reviewer · review intro", color: "success" },
          { at: 72, type: "line", text: "@writer❯ intro drafted", color: "suggestion" },
          { at: 84, type: "line", text: "@reviewer❯ looks good, 2 nits", color: "suggestion" },
          { at: 96, type: "done", verb: "Worked", seconds: 23 },
        ],
        labelAt: 60,
        label: "一句话组队，并行干活",
        wiki: "Agent-Teams",
      },
      { kind: "image", file: "workflows-panel.png", width: 1026, height: 319, focus: { x: 25, y: 195, w: 980, h: 80 }, label: "分阶段调度多个 Agent", wiki: "Workflows" },
      { kind: "image", file: "background-sessions-view.png", width: 959, height: 374, focus: { x: 10, y: 105, w: 930, h: 165 }, label: "谁在等你，一眼看到", wiki: "Background-Sessions" },
    ],
  },
  {
    question: "放手让它跑，安全吗？",
    answer: "分类器把关，沙箱兜底。",
    shots: [
      {
        kind: "sim",
        footer: { text: "⏵⏵ auto mode on (shift+tab to cycle)", color: "warning" },
        steps: [
          { at: 4, type: "prompt", text: "把这个分支直接推到 main" },
          { at: 20, type: "spinner", verb: "Considering", until: 34 },
          { at: 34, type: "tool", name: "Bash", args: "git log --oneline -1", color: "success" },
          { at: 40, type: "result", text: "74a2f53 init" },
          { at: 52, type: "tool", name: "Bash", args: "git push origin HEAD:main --force", color: "error" },
          { at: 62, type: "result", text: "Denied by auto mode classifier • /feedback if incorrect", color: "error", highlight: true },
          { at: 90, type: "done", verb: "Crunched", seconds: 4 },
        ],
        labelAt: 64,
        label: "危险操作，当场拦下",
        wiki: "Auto-Mode",
      },
      { kind: "image", file: "sandbox-run.png", width: 959, height: 574, focus: { x: 15, y: 180, w: 610, h: 55 }, label: "沙箱外写入直接失败", wiki: "Sandbox" },
    ],
  },
  {
    question: "想按自己的方式改？",
    answer: "一个文件，改造整个界面。",
    shots: [
      { kind: "image", file: "mods-hold-pane.png", width: 1380, height: 356, focus: { x: 762, y: 30, w: 600, h: 135 }, label: "Mod 接管危险命令确认", wiki: "Mods" },
      { kind: "image", file: "diff-view-session.png", width: 1380, height: 792, focus: { x: 762, y: 170, w: 600, h: 225 }, label: "/diff 面板，改动一目了然", wiki: "Diff-View" },
    ],
  },
  {
    question: "想换成自己的样子？",
    answer: "名字、Logo、状态栏，全都能换。",
    shots: [
      { kind: "image", file: "branding-default.png", after: "branding-custom.png", width: 959, height: 210, focus: { x: 15, y: 8, w: 340, h: 70 }, label: "名字和 Logo，一行配置就换", wiki: "Branding" },
      { kind: "image", file: "branding-custom.png", width: 959, height: 210, focus: { x: 30, y: 176, w: 240, h: 26 }, label: "状态栏跑你自己的脚本", wiki: "Branding" },
    ],
  },
];

const INTRO_FRAMES = 120;
const WIKI_FRAMES = 120;
const OUTRO_FRAMES = 180;

export const PROMO_DURATION =
  HOOK_FRAMES + INTRO_FRAMES + chapters.reduce((n, c) => n + chapterFrames(c.shots), 0) + MORE_FRAMES + DIFF_FRAMES + WIKI_FRAMES + OUTRO_FRAMES;

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
    <Series>
      <Series.Sequence name="Hook" durationInFrames={HOOK_FRAMES}>
        <Hook />
      </Series.Sequence>
      <Series.Sequence name="Intro" durationInFrames={INTRO_FRAMES}>
        <Intro />
      </Series.Sequence>
      {chapters.map((c, i) => (
        <Series.Sequence key={c.question} name={`Chapter ${i + 1}`} durationInFrames={chapterFrames(c.shots)}>
          <Chapter index={i + 1} {...c} />
        </Series.Sequence>
      ))}
      <Series.Sequence name="More" durationInFrames={MORE_FRAMES}>
        <More />
      </Series.Sequence>
      <Series.Sequence name="Diff" durationInFrames={DIFF_FRAMES}>
        <Diff />
      </Series.Sequence>
      <Series.Sequence name="Wiki" durationInFrames={WIKI_FRAMES}>
        <WikiWall />
      </Series.Sequence>
      <Series.Sequence name="Outro" durationInFrames={OUTRO_FRAMES}>
        <Outro />
      </Series.Sequence>
    </Series>
  </AbsoluteFill>
);
