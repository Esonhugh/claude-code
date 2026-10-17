# Mods Select 展开、选择与回执（2026-10-07）

本批从 `aca8c7c8c5a90456b99ed5172ffaf989cf5a896e` 的独立候选出发，只提交 Select 呈现、控制器与宿主 working 传递。工作区仍含其他 WIP，两侧分开验证。证据根 `/private/tmp/mods-select-ome72dwx`。

## 官方来源与结论

本轮核对 [npm latest 元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) 仍为 **2.1.292**，shasum `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`。官方 native `/private/tmp/mods-fork-routing-20261007-2afwted_/official/official-claude-2.1.292`，235017328 bytes，SHA-256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`。原始解包模块在同目录的 `extract-292/all`；以下偏移为解码 JavaScript 字符偏移：

- `chunk-hx89w1md.js:36096`：Ajn/tr，八项窗口从 `max(0, highlight-7)` 开始；末尾显示尚未展示数量。已选值与高亮独立；只有收起且持焦点时反显已选值，持焦点 label 加粗，未知/省略值显示 none，箭头为 ▴/▾。模块 SHA-256 `106552c2ce33318eda853913f7cddef73b29a777ad906e37e70c8f8a2d93dce9`。
- `chunk-8q7p93rh.js:435057`：GV，获得焦点展开；方向键在已展开时循环移动，收起时只展开；Enter 在展开时选择并收起，收起时只展开；单个字符循环匹配 label/value 前缀。Space 作为字符，不确认。选择先乐观发布，成功回执可改写 value，但不覆盖较新选择。
- 同模块 `:432283`：dF，仅绘制 value 变化时清除编辑缓存，不因新 drawing 号重置。模块 SHA-256 `62fa248db070e465f3aeb727884b114d1da3b25ab79540ca573dbb152e57cb84`。
- `chunk-8jczcb92.js:422197` 的 b9r/S9r host 校验仍拒绝重复选项，且不要求 value 匹配现有 option。模块 SHA-256 `c33e22314db1f993ccbff6c473c6c4301c596814ccb5079f55ea39a897cb1748`。

有界源码分别保存为 `official-select-{render,controller,cache,host,validator}-window.txt`。构造函数可以产生重复 options，并不代表 host 接受；官方真实 `afduplicates` 报 values are unique 并绘制空白 fallback，本地保持拒绝。初始推断已用这个证据纠正，未移除重复值校验。

作者类型对照仍是仓库 `assets/mods-2.1.290.d.ts.txt`：SelectProps :10159、UiSelectResult :14068（element/value 必需 string）。本批新增的是 React host 内部 isWorking/onReleaseFocus，不是更新 2.1.292 公共 Mods 声明；最新作者类型整体仍待同步。

## 实现及回归

ModSelect 保存独立 picked、highlight、open，复用 Ink Text/Box/主题，不拼接固定 ANSI 布局。鼠标只取得焦点，不调用旧的 onClick=select；真实焦点、连续输入与当前 drawing callback 继续由既有 DOM/host 处理。

有效回执只在仍挂载、当前 owner 且 picked 尚未变化时落入缓存；拒绝/未送达保留乐观选择。未知 value 显示 none，highlight 仍从首项开始；options 缩短会截住 highlight，不把高亮错误地变成已选值。

Ctrl+C 在空闲时先收起，第二次把 Pane 的 ring 交回 body；同值 redraw 保留该释放状态，下一次协商焦点清除释放记录。AbovePrompt 使用宿主显式释放回调；isWorking 从 REPL 的真实 isLoading 和 Band 传入，working 时该控制器不吞 Ctrl+C。当前 working 分支及 REPL 传递有单测，模型运行中的真实取消/完整 Band/Client 二进制矩阵继续验收，不能据此关闭。

新增 14 案包括标签/箭头/八项数量、高亮与已选值分离、收起后 Enter/方向键、大小写前缀/Space/Button hotkey、窗口与缩短选项、乐观选择/拒绝、回执改写/迟到回执、等值/新值 redraw、unknown value、duplicate host 校验、working 和第二次 Ctrl+C/body redraw。真实 Ink DOM/input，独立 realpath HOME/config、占位 key，结束恢复 env/chalk；新观察使用有界状态屏障，不加固定 sleep。

旧用例保持数量与意图：Space 的确认夹具按官方改成 Enter，Space 无提交由新增案单独覆盖；click 之后仍须 Enter；原 cache/clamp/Client/焦点/同次 stdin 副作用断言保留。观察虚拟 Text span 和实际 tabIndex Box，而不是旧的 `value ↑↓` 整块 Text。REPL AST 夹具补真实 isLoading scope，并新增 false/true 传递断言，没有改生产认证逻辑。

## 最终源码与门禁

仅使用 final2 与 isolated-final 的结果。源码清单覆盖 src/types/vendor/scripts/assets 和 CHANGELOG；之后 README/台账/报告追加不改变源清单：

- candidate `75666c4b8cacbd08b0ec644c6537b2b1203fe21460f68901ec644f8e687709a5`。
- workspace `cc733d96b4d36c9d685f751218b40de541f48bb1cfdc3521b1e9a4a463be4413`。

`run.py` 的每项都是独立无开发者凭据 HOME/config/cache，120s 硬截止与 owned process group。完整 command/env/日志/source-before/result 在相应证据目录；最终 sourceUnchanged=true、processGroupExistsAfter=false。

| 最终检查 | candidate | workspace |
| --- | --- | --- |
| 13 文件 suite | 415/0/2358 expect，62.513s | 437/0/2448 expect，63.151s |
| Select 单独 | 14/0/104，2.090s | 14/0/104，2.001s |
| ModsPane 单独 | 176/0/1078，49.722s | 180/0/1098，49.875s |
| automaticFocus 单独 | 10/0/122，3.296s | 10/0/122，3.320s |
| runtimeUi 单独 | 38/0/185，4.270s | 39/0/189，4.365s |
| make release-check | exit 0，42.213s | exit 0，44.684s |
| make build | exit 0，5.104s | exit 0，5.387s |

Suite 文件：Select presentation、Input presentation、automaticFocus、ModsPane、keyboardCapture、hostGeometry、ModsAbovePrompt、uiRealm、ui、runtimeUi、uiEnvironment、diffTakeover、shippedDiffStartup。不是全部 WIP/全项目门禁。

| 最终制品 | SHA-256 | bytes / mtime ns |
| --- | --- | --- |
| candidate-final2-build-output/built-claude | `a6649eba4ccd4a80ba09bd6fd1b2d9d7b06fbc8e09755bb7ea93d80452c260fb` | 102117218 / 1791347377574036765 |
| workspace-final2-build-output/built-claude | `4607fc4b31ef953a9c4d8e6394259d3fe541235db22a0643012d009fd4cf317f` | 102001634 / 1791347377868603955 |

## 最终真实终端对照

最终官方/候选/ROOT 的同一脚本 cohort 全部 observed、正常 exit 0，制品 SHA 不变，owned tmux 清理完成；耗时分别 **48.309s / 51.240s / 52.667s**。

`candidate-final2-comparison.json`、`workspace-final2-comparison.json` 都是 **51/51 完整面板矩形完全相同，0 差异单元格，comparator exit 0**。keyboard inputs、resizes、fixture、driver、九案作者参数和新增 Select 作者参数分别全部相同。原35帧矩阵里的 Input/Select差异在本轮归零；新增16帧覆盖丰富 Select状态与拒绝画面。

命令为 `python3 native-select.py official final2`、`candidate final2`、`workspace final2`（在上述证据根、使用新建目录）；比较为 `node compare-select.mjs <证据根> candidate-final2 <输出JSON>` / `workspace-final2`。每侧完整 argv/env/binary/input/观察/退出/清理取其 `evidence/result.json`。不以旧 diagnostic 或缺失帧支撑正式结论。


同一个 `native-select.py`，SHA-256 `fff57e45a978dbdafeb7c5060b0227051ad1fb584284985e111fe942dc4683af`，官方/候选/ROOT **串行**使用独立 fixture/HOME/config/PTY/tmux/socket。dummy key、禁网络/Keychain/用户配置沙箱；总90s、单屏障最多15s、ANSI cells稳定400ms且最多5s，未延长截止。

矩阵保留原九个焦点/隐藏/重复key/Input/Select动作、官方内置 diff resize/open-close/reopen/grip 回归；增加12选项的收起/再展开、同stdin方向+Enter、前缀循环/大写/Space、八项窗口、ui.select 将 v10 改写为 v11、Ctrl+C body release、unknown 值与重复 options 拒绝。原始 input hex/raw PTY/ANSI/capture/debug/result 都保存；正式比较脚本严格比较面板矩形的绝对位置、字符与全部样式。

这是 dark 主题下的稳定 **完整面板矩形**，不是全终端和每一 stdout transaction 的独立 logical/physical replay；banner/log格式、working 模型取消、完整 Band/Client、多主题、drag/全帧、所有 diff 使用模式不据此推导通过。完整 comparator 保留 `completeParity=false` 表示全目标尚未完成，51项受测矩形的结论由各项 exactPanelCellsEqual 和 exit 0 给出。

重复 options 的 final2 屏障曾使用通用 `unique` 日志片段，单靠该片段不足以区分启动日志。因此另用 `verify-rejection.py` 对三侧原始制品做严格复核：必须找到对应 Select 的具体校验警告，时间早于稳定抓屏；fallback 不包含测试控件，实际 duplicate callback 为零。`strict-rejection-audit.json` 三侧全部通过。该审计不修改最终 driver/输入/制品，也不将通用启动日志当作拒绝证据；可在证据根运行 `python3 verify-rejection.py` 重现。

## RED、诊断与保护

- `red-select` 0/12：呈现与控制器 RED，也包含初始错误的 duplicate 接受假设；后者由官方 red1 拒绝证据纠正。不是将12项全归为产品 bug。
- 原提交制品 `native-candidate-red2` 在 rich 收起后 Enter 再次触发回调，屏障 enter-opens-count 失败且正常退出；官方不会产生第二次 pick。
- 初始 green 9/3：dim 需要检查主题 inactive color，Select 还缺 currentPane 传递；二次修正后14案通过。body release/redraw 新案另复现旧落点重新获取焦点，新增小范围释放记录。
- 原夹具多处编码全值 ↑↓ 和 Space 提交，逐项改按官方。clamp 夹具重开屏障漏了 ink-virtual-text；修正 DOM 投影，不放宽三次 callback/值/focus 断言。REPL AST 未提供新增 isLoading 导致 ReferenceError，补 scope 而不是回退产品传递。
- 早期 check 暴露旧候选没有 WIP chrome、useRef 需要 explicit undefined，以及 Color 的断言类型；代码/夹具按实际两侧结构修正，最终完整类型通过。首个迁入脚本只在内存反向核对失败，未写生产文件；随后按 offset 核对可逆变换迁入，保留 WIP。
- diagnostic1 已保存50/50但 duplicate 屏障失败，完整比较不通过；屏障此前依赖官方 transcript 提示，本地正确拒绝在 debug。修正为真实拒绝日志与空白画面，正式 final2 全程重跑，不把缺失帧补造为通过。
- final 的 suite 413/2、435/2 以及旧阶段所有失败日志保留；只引用最后 final2 的同源结果，不拼接旧制品。

此次十一路径由 clean HEAD 候选生成 patch 暂存；ROOT 的其他 WIP、原 Client autoFocus 与 Band 宿主实现保留，仅迁入对应变换。3139冻结路径逐字节核对；原 response.md/fix-instructions.md/improvment.md 和共享 binaries 不覆盖。其他 Claude PID 94223/70780 只读验证，不发输入/信号，不 push。

完整 API、上下文、最新作者声明、动态 matcher 扫描、Band/Client、working 取消、全 UI/官方 diff/G5 和所有 WIP 门禁继续，目标未标记完成。
