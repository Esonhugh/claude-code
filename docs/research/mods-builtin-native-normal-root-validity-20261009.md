# Builtin native 普通屏幕与归档验收有效性（2026-10-09）

原 sandbox-exec 会剥离外层 DYLD 设置。Builtin launcher 现在在进入既有 sandbox 后调用 owned native broker，再执行实际复制的编译二进制；五个 Python helper 的原字节在 ready 前核对，保留原 native argv、160×50、终端 flags 与插件来源。

普通屏幕不能用逻辑帧的高度或目标 cell 反推物理 root。新建私有 tmux pane 的无输出 wrapper 在 ready 前保持等待；采集实际 pane/server PID、cursor、buffer、history、origin/wrap/insert/cursor flags、scroll region、版本、空白 screen 和 pending parser 编码。Broker 在 Popen 前持有 origin SHA，关闭时发布原 receipt。独立 pinned xterm 按 frame rawStart 前的原始 prefix 和实际 resize 回放，再以物理 cursor row marker 定位 renderer/root epoch。ED/HOME 按实际 parser 处理；相对 cursor、宽字符延续、样式及缩短后 tail 均需匹配。缺 origin、不明模式或失效 marker 继续拒收。

当前起点证据限定 tmux 3.6b 新建 pane。初始化依据 [screen_init/reinit](https://github.com/tmux/tmux/blob/3.6b/screen.c)、[input_init/reset](https://github.com/tmux/tmux/blob/3.6b/input.c) 和 [format 模式字段](https://github.com/tmux/tmux/blob/3.6b/format.c)；[capture-pane 实现](https://github.com/tmux/tmux/blob/3.6b/cmd-capture-pane.c)会为 `-p` 输出添加 LF，因此 `-P -C` 的空 pending 表示必须精确为一个 LF，而非随意 trim 任意控制序列。失败前保存原读取字节，不把 formatter 换行当产品输出。

归档不重写原 JSON。已固定归档回执将 original run 与唯一 archive run 绑定，逐文件核对 sourceManifest 摘要；JS 原件校验、Python binary 读取、origin 和 geometry 使用同一映射。测试先正常关闭真实编译入口，再暂时移动 owned 原 cache，在原路径缺失时独立读取 archive；finally 恢复原目录。任意 fallback、映射越界、错误摘要或修改后的原件继续拒收。

APFS clone 复制保留独立 inode、完整逻辑字节、mode 与 mtime；负例可以修改副本而不改变 producer。此存储调整避免稀疏 native journal 的空槽被普通复制全部分配，不修改 decode、原断言、帧或通过条件。其他文件系统/平台保留 copy2 fallback，已存在的目标不覆盖。

真实 RED 与中间修复证据位于 `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/`：`builtin-native-launch-red3`（native 选择）、`builtin-native-launch-green1-real1`（10帧 origin 缺口）、`builtin-native-normal-root2-green1-real1`（原 pending LF）、`builtin-native-normal-root2-archive-red1`（实际归档读取失败）、`builtin-native-normal-root2-green3-real1`（正常入口及原路径缺失时归档回放）。ENOSPC 的 Green2 CLI/driver 结果保持失败，处置见 `builtin-native-normal-root2-green2-enospc-disposition.json`，不重建缺失的最终收据。

最终候选的回归、构建和完整默认动态矩阵分别保存新收据。此批仍不证明完整 termios 生命周期、实际输入 parser/owner、独立父通道登记、产品时序或所有 open/close/reopen/Client 行为；`productTimingEquivalent` 与 `fullNativeGatePassed` 保持 false，不形成完整发布通过结论。使用命令见 README 的 builtin 原生普通屏幕与归档回放小节。

Native57 原完整矩阵 30 项正常结束、27 通过/3 失败；canonical 106 帧与 interaction 92 帧物理回放通过，七侧 builtin 已为 native 且归档重验通过。原删除守卫却仍只读取 legacy EOF/FIFO，七个原件的 native 正常关闭检查独立通过而删除守卫拒绝；最小真实 RED 保留在 builtin-native-cache-closure-red2。新轮根据实际 launch/backend 校验 native producer、collector EOF 与 reap；旧 FIFO 合同保留，缺失、链接、错案、混合 backend 和未关闭继续拒收。旧矩阵 verdict 不改写，缓存删除不证明 full/input/timing。

Green6 的完整 CLI 文件真实14通过/1失败：成功 child read 中 DA 应答实际插入 /exit 与回车之间，连续子串 oracle 因而误拒收；记录、errno、完整输入与正常退出原件保留。新读取证明要求全部 child 字节与 broker input 完全相同，再由独立输出 parser 仅在真实已发查询后识别确切终端应答，并严格匹配完整预期命令。任意删改或额外字节、无对应查询、错误格式或超过对应查询数的应答仍拒收；不据此认证应答发送者、应用 tokenizer 或输入 owner。Green7 的完整 CLI 文件真实14通过/1失败：非 production 的直接 wrapper 没有 broker IO 文件，被新断言错误要求读取；原件保留。直接 wrapper 现严格核对 input.json 全部成功写入前缀与完整 child read，并保留原连续 /exit 与回车断言；该分支不声称覆盖查询应答因果顺序。
