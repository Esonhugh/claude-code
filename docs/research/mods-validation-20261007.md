# Mods 逐文件验证记录：2026-10-07

本批提交仅修复 REPL.submit 测试夹具和文档；生产源码、类型及运行时行为没有变更。基准 HEAD 为 95007b580cf91c40363c2d38436b0f8488903d18。其他功能的工作区变更没有折入本批。

证据根：`/private/tmp/mods-gate-recheck-20261007-zfzgjhq1`。每场保存 argv、环境、开始时间、完整日志、逐文件源码哈希及结果。运行环境没有继承 API key／OAuth token，独立 HOME／配置／TMP 使用真实路径，Bun 禁止自动加载 .env。需要认证的测试自行设置占位值。

修复前独立 HEAD 的 REPL.submit 为 108 pass／9 fail；补齐隔离、native diff closure 依赖以及 restoreSessionCosts 后为 117／0。中间夹具遗漏 diffOwned 的 116／1 失败记录保留。ROOT 原整份为 122／3，修复后为 125／0；三条恢复测试断言所选 log 只传递一次，成本恢复返回 false 时仍执行原有 diff 与上下文断言。ROOT 中另外八条已有 WIP 测试没有折入提交。

三份相邻测试（REPL.submit、diff controller、cost summary 生命周期）独立候选 152／0、ROOT 160／0。两侧 make release-check 和私有输出 make build 均 exit 0。最终逐文件执行147个Git未提交测试文件，全部 exit 0，保留10个原有skip；不是全部官方夹具均已覆盖。

最终 ROOT 测试／检查／构建的源码清单 SHA256（含 CHANGELOG）：`0003eff731d21c8df15f4991240a07ee81411151137babc6f348f2af9572ae04`；独立候选：`3d4dcb0b7647f267f535c6f43c585809bc71f9c189a3de3bd621d1630f32e276`。最终147场全部绑定同一 ROOT 清单，源码未被验证命令改写，所属进程组无遗留。原 ROOT built-claude 不被覆盖。

下表为每文件最后一组 Bun pass/fail/skip 统计；隔离子进程的内层断言见各场完整日志，不将 wrapper 和 child 数量相加。0/0/0 的模块级脚本仍执行 node:assert，以成功完成标记及退出码验收。

| 测试文件 | pass/fail/skip | exit | 日志场 |
| --- | --- | --- | --- |
| [src/cli/handlers/plugins.validate.test.ts](../../src/cli/handlers/plugins.validate.test.ts) | 22/0/0 | 0 | `workspace-final-gate-1/log.txt` |
| [src/cli/print.peer.test.ts](../../src/cli/print.peer.test.ts) | 1/0/0 | 0 | `workspace-final-gate-2/log.txt` |
| [src/commands/diff/diff.test.tsx](../../src/commands/diff/diff.test.tsx) | 11/0/0 | 0 | `workspace-final-gate-3/log.txt` |
| [src/components/ModsAbovePrompt.band289.test.tsx](../../src/components/ModsAbovePrompt.band289.test.tsx) | 10/0/0 | 0 | `workspace-final-gate-4/log.txt` |
| [src/components/ModsAbovePrompt.test.tsx](../../src/components/ModsAbovePrompt.test.tsx) | 9/0/0 | 0 | `workspace-final-gate-5/log.txt` |
| [src/components/ModsFocusChord.test.tsx](../../src/components/ModsFocusChord.test.tsx) | 25/0/0 | 0 | `workspace-final-gate-6/log.txt` |
| [src/components/ModsPane.autofocusHost.test.tsx](../../src/components/ModsPane.autofocusHost.test.tsx) | 8/0/0 | 0 | `workspace-final-gate-7/log.txt` |
| [src/components/ModsPane.focusOwner.test.tsx](../../src/components/ModsPane.focusOwner.test.tsx) | 3/0/0 | 0 | `workspace-final-gate-8/log.txt` |
| [src/components/ModsPane.test.tsx](../../src/components/ModsPane.test.tsx) | 180/0/0 | 0 | `workspace-final-gate-9/log.txt` |
| [src/components/PromptInput/Notifications.test.tsx](../../src/components/PromptInput/Notifications.test.tsx) | 3/0/0 | 0 | `workspace-final-gate-10/log.txt` |
| [src/components/PromptInput/PromptDecorations.test.tsx](../../src/components/PromptInput/PromptDecorations.test.tsx) | 2/0/0 | 0 | `workspace-final-gate-11/log.txt` |
| [src/components/PromptInput/PromptInput.modsEdit.test.tsx](../../src/components/PromptInput/PromptInput.modsEdit.test.tsx) | 17/0/0 | 0 | `workspace-final-gate-12/log.txt` |
| [src/components/PromptInput/PromptInput.modsKeyBatch.test.tsx](../../src/components/PromptInput/PromptInput.modsKeyBatch.test.tsx) | 4/0/0 | 0 | `workspace-final-gate-13/log.txt` |
| [src/components/PromptInput/PromptInput.modsKeyWorkerBatch.test.tsx](../../src/components/PromptInput/PromptInput.modsKeyWorkerBatch.test.tsx) | 4/0/0 | 0 | `workspace-final-gate-14/log.txt` |
| [src/components/PromptInput/PromptInput.modsLiveDraft.test.tsx](../../src/components/PromptInput/PromptInput.modsLiveDraft.test.tsx) | 11/0/0 | 0 | `workspace-final-gate-15/log.txt` |
| [src/components/ScrollKeybindingHandler.test.tsx](../../src/components/ScrollKeybindingHandler.test.tsx) | 10/0/0 | 0 | `workspace-final-gate-16/log.txt` |
| [src/components/TextInput.modsEdit.test.tsx](../../src/components/TextInput.modsEdit.test.tsx) | 3/0/0 | 0 | `workspace-final-gate-17/log.txt` |
| [src/components/VimTextInput.modsFlow.test.tsx](../../src/components/VimTextInput.modsFlow.test.tsx) | 17/0/0 | 0 | `workspace-final-gate-18/log.txt` |
| [src/components/terminalClientCache.test.ts](../../src/components/terminalClientCache.test.ts) | 14/0/0 | 0 | `workspace-final-gate-19/log.txt` |
| [src/hooks/useTextInput.modsEdit.test.tsx](../../src/hooks/useTextInput.modsEdit.test.tsx) | 3/0/0 | 0 | `workspace-final-gate-20/log.txt` |
| [src/hooks/useTextInput.test.tsx](../../src/hooks/useTextInput.test.tsx) | 17/0/0 | 0 | `workspace-final-gate-21/log.txt` |
| [src/ink/components/App.semanticInput.test.tsx](../../src/ink/components/App.semanticInput.test.tsx) | 10/0/0 | 0 | `workspace-final-gate-22/log.txt` |
| [src/ink/selectionFollow289.test.tsx](../../src/ink/selectionFollow289.test.tsx) | 7/0/0 | 0 | `workspace-final-gate-23/log.txt` |
| [src/ink/selectionInputFollow289.test.tsx](../../src/ink/selectionInputFollow289.test.tsx) | 9/0/0 | 0 | `workspace-final-gate-24/log.txt` |
| [src/ink/selectionScope289.test.tsx](../../src/ink/selectionScope289.test.tsx) | 4/0/0 | 0 | `workspace-final-gate-25/log.txt` |
| [src/query.mods.test.ts](../../src/query.mods.test.ts) | 125/0/0 | 0 | `workspace-final-gate-26/log.txt` |
| [src/query.promptCompose.test.ts](../../src/query.promptCompose.test.ts) | 6/0/0 | 0 | `workspace-final-gate-27/log.txt` |
| [src/screens/REPL.submit.test.ts](../../src/screens/REPL.submit.test.ts) | 125/0/0 | 0 | `workspace-final-gate-28/log.txt` |
| [src/services/api/claude-model-contract.test.ts](../../src/services/api/claude-model-contract.test.ts) | 1/0/0 | 0 | `workspace-final-gate-29/log.txt` |
| [src/services/api/openai-compat.test.ts](../../src/services/api/openai-compat.test.ts) | 0/0/0 | 0 | `workspace-final-gate-30/log.txt` |
| [src/services/compact/sessionCompact.mods.test.ts](../../src/services/compact/sessionCompact.mods.test.ts) | 30/0/0 | 0 | `workspace-final-gate-31/log.txt` |
| [src/services/mods/agents.test.ts](../../src/services/mods/agents.test.ts) | 8/0/0 | 0 | `workspace-final-gate-32/log.txt` |
| [src/services/mods/agentsParity.test.ts](../../src/services/mods/agentsParity.test.ts) | 8/0/0 | 0 | `workspace-final-gate-33/log.txt` |
| [src/services/mods/callerChain.queue.test.ts](../../src/services/mods/callerChain.queue.test.ts) | 3/0/0 | 0 | `workspace-final-gate-34/log.txt` |
| [src/services/mods/callerChain.test.ts](../../src/services/mods/callerChain.test.ts) | 12/0/0 | 0 | `workspace-final-gate-35/log.txt` |
| [src/services/mods/client.test.ts](../../src/services/mods/client.test.ts) | 10/0/0 | 0 | `workspace-final-gate-36/log.txt` |
| [src/services/mods/clientDetachedRejection.test.ts](../../src/services/mods/clientDetachedRejection.test.ts) | 1/0/0 | 0 | `workspace-final-gate-37/log.txt` |
| [src/services/mods/clientFaultPhase.test.ts](../../src/services/mods/clientFaultPhase.test.ts) | 4/0/0 | 0 | `workspace-final-gate-38/log.txt` |
| [src/services/mods/clientHeldCallbacks289.test.ts](../../src/services/mods/clientHeldCallbacks289.test.ts) | 6/0/0 | 0 | `workspace-final-gate-39/log.txt` |
| [src/services/mods/clientRealm.test.ts](../../src/services/mods/clientRealm.test.ts) | 8/0/0 | 0 | `workspace-final-gate-40/log.txt` |
| [src/services/mods/clientReturned.test.ts](../../src/services/mods/clientReturned.test.ts) | 28/0/0 | 0 | `workspace-final-gate-41/log.txt` |
| [src/services/mods/clientReturnedRuntime.test.ts](../../src/services/mods/clientReturnedRuntime.test.ts) | 4/0/0 | 0 | `workspace-final-gate-42/log.txt` |
| [src/services/mods/commands.test.ts](../../src/services/mods/commands.test.ts) | 26/0/0 | 0 | `workspace-final-gate-43/log.txt` |
| [src/services/mods/customCallSettlement289.test.ts](../../src/services/mods/customCallSettlement289.test.ts) | 2/0/0 | 0 | `workspace-final-gate-44/log.txt` |
| [src/services/mods/declarations.test.ts](../../src/services/mods/declarations.test.ts) | 46/0/0 | 0 | `workspace-final-gate-45/log.txt` |
| [src/services/mods/declarationsAgent.test.ts](../../src/services/mods/declarationsAgent.test.ts) | 1/0/0 | 0 | `workspace-final-gate-46/log.txt` |
| [src/services/mods/declarationsCaught.test.ts](../../src/services/mods/declarationsCaught.test.ts) | 1/0/0 | 0 | `workspace-final-gate-47/log.txt` |
| [src/services/mods/declarationsEventCalls.test.ts](../../src/services/mods/declarationsEventCalls.test.ts) | 7/0/0 | 0 | `workspace-final-gate-48/log.txt` |
| [src/services/mods/declarationsFault.test.ts](../../src/services/mods/declarationsFault.test.ts) | 1/0/0 | 0 | `workspace-final-gate-49/log.txt` |
| [src/services/mods/declarationsPromptEdit.test.ts](../../src/services/mods/declarationsPromptEdit.test.ts) | 1/0/0 | 0 | `workspace-final-gate-50/log.txt` |
| [src/services/mods/declarationsSelection.test.ts](../../src/services/mods/declarationsSelection.test.ts) | 1/0/0 | 0 | `workspace-final-gate-51/log.txt` |
| [src/services/mods/declarationsSessionEvents.test.ts](../../src/services/mods/declarationsSessionEvents.test.ts) | 4/0/0 | 0 | `workspace-final-gate-52/log.txt` |
| [src/services/mods/declarationsTestingCalls.test.ts](../../src/services/mods/declarationsTestingCalls.test.ts) | 5/0/0 | 0 | `workspace-final-gate-53/log.txt` |
| [src/services/mods/environment.test.ts](../../src/services/mods/environment.test.ts) | 63/0/0 | 0 | `workspace-final-gate-54/log.txt` |
| [src/services/mods/environmentUnload289.test.ts](../../src/services/mods/environmentUnload289.test.ts) | 2/0/0 | 0 | `workspace-final-gate-55/log.txt` |
| [src/services/mods/hostContracts.test.ts](../../src/services/mods/hostContracts.test.ts) | 6/0/0 | 0 | `workspace-final-gate-56/log.txt` |
| [src/services/mods/hostOperations.test.ts](../../src/services/mods/hostOperations.test.ts) | 88/0/0 | 0 | `workspace-final-gate-57/log.txt` |
| [src/services/mods/modelAdapter.test.ts](../../src/services/mods/modelAdapter.test.ts) | 10/0/0 | 0 | `workspace-final-gate-58/log.txt` |
| [src/services/mods/modelCancellation.test.ts](../../src/services/mods/modelCancellation.test.ts) | 9/0/0 | 0 | `workspace-final-gate-59/log.txt` |
| [src/services/mods/modelOptions.test.ts](../../src/services/mods/modelOptions.test.ts) | 21/0/0 | 0 | `workspace-final-gate-60/log.txt` |
| [src/services/mods/modelResults.test.ts](../../src/services/mods/modelResults.test.ts) | 16/0/0 | 0 | `workspace-final-gate-61/log.txt` |
| [src/services/mods/modelRuntime.test.ts](../../src/services/mods/modelRuntime.test.ts) | 8/0/0 | 0 | `workspace-final-gate-62/log.txt` |
| [src/services/mods/native.test.ts](../../src/services/mods/native.test.ts) | 5/0/1 | 0 | `workspace-final-gate-63/log.txt` |
| [src/services/mods/pluginPrompt.test.ts](../../src/services/mods/pluginPrompt.test.ts) | 3/0/0 | 0 | `workspace-final-gate-64/log.txt` |
| [src/services/mods/plugins.test.ts](../../src/services/mods/plugins.test.ts) | 38/0/0 | 0 | `workspace-final-gate-65/log.txt` |
| [src/services/mods/promptAdapter.test.ts](../../src/services/mods/promptAdapter.test.ts) | 33/0/0 | 0 | `workspace-final-gate-66/log.txt` |
| [src/services/mods/promptAsUser.test.ts](../../src/services/mods/promptAsUser.test.ts) | 7/0/0 | 0 | `workspace-final-gate-67/log.txt` |
| [src/services/mods/promptDecorations.test.ts](../../src/services/mods/promptDecorations.test.ts) | 4/0/0 | 0 | `workspace-final-gate-68/log.txt` |
| [src/services/mods/promptEditQueue.test.ts](../../src/services/mods/promptEditQueue.test.ts) | 5/0/0 | 0 | `workspace-final-gate-69/log.txt` |
| [src/services/mods/promptEditRuntime.test.ts](../../src/services/mods/promptEditRuntime.test.ts) | 8/0/0 | 0 | `workspace-final-gate-70/log.txt` |
| [src/services/mods/promptFillUnicode.test.ts](../../src/services/mods/promptFillUnicode.test.ts) | 3/0/0 | 0 | `workspace-final-gate-71/log.txt` |
| [src/services/mods/promptFillUnicode.types.test.ts](../../src/services/mods/promptFillUnicode.types.test.ts) | 1/0/0 | 0 | `workspace-final-gate-72/log.txt` |
| [src/services/mods/promptFillUnicodeFlags.test.ts](../../src/services/mods/promptFillUnicodeFlags.test.ts) | 1/0/0 | 0 | `workspace-final-gate-73/log.txt` |
| [src/services/mods/promptFillUnicodePipeline.test.ts](../../src/services/mods/promptFillUnicodePipeline.test.ts) | 7/0/0 | 0 | `workspace-final-gate-74/log.txt` |
| [src/services/mods/publicConfigOrigin.test.ts](../../src/services/mods/publicConfigOrigin.test.ts) | 2/0/0 | 0 | `workspace-final-gate-75/log.txt` |
| [src/services/mods/registrationMultiplicity289.test.ts](../../src/services/mods/registrationMultiplicity289.test.ts) | 34/0/0 | 0 | `workspace-final-gate-76/log.txt` |
| [src/services/mods/render.test.ts](../../src/services/mods/render.test.ts) | 28/0/0 | 0 | `workspace-final-gate-77/log.txt` |
| [src/services/mods/runtime.test.ts](../../src/services/mods/runtime.test.ts) | 92/0/1 | 0 | `workspace-final-gate-78/log.txt` |
| [src/services/mods/runtimeHost.test.ts](../../src/services/mods/runtimeHost.test.ts) | 105/0/3 | 0 | `workspace-final-gate-79/log.txt` |
| [src/services/mods/runtimeHostHooks.test.ts](../../src/services/mods/runtimeHostHooks.test.ts) | 26/0/0 | 0 | `workspace-final-gate-80/log.txt` |
| [src/services/mods/runtimeTools.test.ts](../../src/services/mods/runtimeTools.test.ts) | 26/0/1 | 0 | `workspace-final-gate-81/log.txt` |
| [src/services/mods/runtimeUi.test.ts](../../src/services/mods/runtimeUi.test.ts) | 39/0/0 | 0 | `workspace-final-gate-82/log.txt` |
| [src/services/mods/session.test.ts](../../src/services/mods/session.test.ts) | 62/0/0 | 0 | `workspace-final-gate-83/log.txt` |
| [src/services/mods/sessionMeasure.test.ts](../../src/services/mods/sessionMeasure.test.ts) | 7/0/0 | 0 | `workspace-final-gate-84/log.txt` |
| [src/services/mods/sessionMessages.test.ts](../../src/services/mods/sessionMessages.test.ts) | 11/0/0 | 0 | `workspace-final-gate-85/log.txt` |
| [src/services/mods/sessionOptions.test.ts](../../src/services/mods/sessionOptions.test.ts) | 14/0/0 | 0 | `workspace-final-gate-86/log.txt` |
| [src/services/mods/sessionTranscript.test.ts](../../src/services/mods/sessionTranscript.test.ts) | 15/0/0 | 0 | `workspace-final-gate-87/log.txt` |
| [src/services/mods/sessionUsage.test.ts](../../src/services/mods/sessionUsage.test.ts) | 6/0/0 | 0 | `workspace-final-gate-88/log.txt` |
| [src/services/mods/sessionWorkerRecovery289.test.ts](../../src/services/mods/sessionWorkerRecovery289.test.ts) | 3/0/0 | 0 | `workspace-final-gate-89/log.txt` |
| [src/services/mods/terminalClient.test.ts](../../src/services/mods/terminalClient.test.ts) | 3/0/0 | 0 | `workspace-final-gate-90/log.txt` |
| [src/services/mods/terminalClientRuntime.test.ts](../../src/services/mods/terminalClientRuntime.test.ts) | 20/0/0 | 0 | `workspace-final-gate-91/log.txt` |
| [src/services/mods/testLab.test.ts](../../src/services/mods/testLab.test.ts) | 1/0/1 | 0 | `workspace-final-gate-92/log.txt` |
| [src/services/mods/testing/runner.contract.test.ts](../../src/services/mods/testing/runner.contract.test.ts) | 22/0/0 | 0 | `workspace-final-gate-93/log.txt` |
| [src/services/mods/testing/runner.integration.test.ts](../../src/services/mods/testing/runner.integration.test.ts) | 59/0/0 | 0 | `workspace-final-gate-94/log.txt` |
| [src/services/mods/testing/runner.safety.test.ts](../../src/services/mods/testing/runner.safety.test.ts) | 18/0/0 | 0 | `workspace-final-gate-95/log.txt` |
| [src/services/mods/toolAdapter.test.ts](../../src/services/mods/toolAdapter.test.ts) | 50/0/0 | 0 | `workspace-final-gate-96/log.txt` |
| [src/services/mods/toolCatalog.test.ts](../../src/services/mods/toolCatalog.test.ts) | 22/0/2 | 0 | `workspace-final-gate-97/log.txt` |
| [src/services/mods/toolHost.test.ts](../../src/services/mods/toolHost.test.ts) | 26/0/0 | 0 | `workspace-final-gate-98/log.txt` |
| [src/services/mods/turnRegistry.test.ts](../../src/services/mods/turnRegistry.test.ts) | 6/0/0 | 0 | `workspace-final-gate-99/log.txt` |
| [src/services/mods/turnStep.test.ts](../../src/services/mods/turnStep.test.ts) | 36/0/0 | 0 | `workspace-final-gate-100/log.txt` |
| [src/services/mods/ui.test.ts](../../src/services/mods/ui.test.ts) | 94/0/0 | 0 | `workspace-final-gate-101/log.txt` |
| [src/services/mods/uiCopy.test.ts](../../src/services/mods/uiCopy.test.ts) | 9/0/0 | 0 | `workspace-final-gate-102/log.txt` |
| [src/services/mods/uiCopy.types.test.ts](../../src/services/mods/uiCopy.types.test.ts) | 2/0/0 | 0 | `workspace-final-gate-103/log.txt` |
| [src/services/mods/uiCopyTerminal.test.ts](../../src/services/mods/uiCopyTerminal.test.ts) | 2/0/0 | 0 | `workspace-final-gate-104/log.txt` |
| [src/services/mods/uiEnvironment.test.ts](../../src/services/mods/uiEnvironment.test.ts) | 17/0/0 | 0 | `workspace-final-gate-105/log.txt` |
| [src/services/mods/uiFault.test.ts](../../src/services/mods/uiFault.test.ts) | 8/0/0 | 0 | `workspace-final-gate-106/log.txt` |
| [src/services/mods/uiFaultLifecycle.test.ts](../../src/services/mods/uiFaultLifecycle.test.ts) | 2/0/0 | 0 | `workspace-final-gate-107/log.txt` |
| [src/services/mods/uiFaultTransport.test.ts](../../src/services/mods/uiFaultTransport.test.ts) | 1/0/0 | 0 | `workspace-final-gate-108/log.txt` |
| [src/services/mods/uiInvalidate289.test.ts](../../src/services/mods/uiInvalidate289.test.ts) | 17/0/0 | 0 | `workspace-final-gate-109/log.txt` |
| [src/services/mods/uiInvalidate289.types.test.ts](../../src/services/mods/uiInvalidate289.types.test.ts) | 2/0/0 | 0 | `workspace-final-gate-110/log.txt` |
| [src/services/mods/uiInvalidateEventTypes289.test.ts](../../src/services/mods/uiInvalidateEventTypes289.test.ts) | 3/0/0 | 0 | `workspace-final-gate-111/log.txt` |
| [src/services/mods/uiPanes.test.ts](../../src/services/mods/uiPanes.test.ts) | 7/0/0 | 0 | `workspace-final-gate-112/log.txt` |
| [src/services/mods/uiPanes.types.test.ts](../../src/services/mods/uiPanes.types.test.ts) | 3/0/0 | 0 | `workspace-final-gate-113/log.txt` |
| [src/services/mods/uiRealm.test.ts](../../src/services/mods/uiRealm.test.ts) | 9/0/0 | 0 | `workspace-final-gate-114/log.txt` |
| [src/services/mods/uiSelection.test.tsx](../../src/services/mods/uiSelection.test.tsx) | 5/0/0 | 0 | `workspace-final-gate-115/log.txt` |
| [src/services/mods/uiSelectionFollow289.test.tsx](../../src/services/mods/uiSelectionFollow289.test.tsx) | 1/0/0 | 0 | `workspace-final-gate-116/log.txt` |
| [src/services/mods/uiSelectionLifecycle.test.tsx](../../src/services/mods/uiSelectionLifecycle.test.tsx) | 3/0/0 | 0 | `workspace-final-gate-117/log.txt` |
| [src/services/mods/uiSelectionRun.test.ts](../../src/services/mods/uiSelectionRun.test.ts) | 2/0/0 | 0 | `workspace-final-gate-118/log.txt` |
| [src/services/mods/uiVoid289.types.test.ts](../../src/services/mods/uiVoid289.types.test.ts) | 2/0/0 | 0 | `workspace-final-gate-119/log.txt` |
| [src/services/mods/validateDescriptions.test.ts](../../src/services/mods/validateDescriptions.test.ts) | 7/0/0 | 0 | `workspace-final-gate-120/log.txt` |
| [src/services/mods/workerAbortOverrun.test.ts](../../src/services/mods/workerAbortOverrun.test.ts) | 3/0/0 | 0 | `workspace-final-gate-121/log.txt` |
| [src/services/mods/workerCallerStack.test.ts](../../src/services/mods/workerCallerStack.test.ts) | 9/0/0 | 0 | `workspace-final-gate-122/log.txt` |
| [src/services/mods/workerFaultAttribution.test.ts](../../src/services/mods/workerFaultAttribution.test.ts) | 2/0/0 | 0 | `workspace-final-gate-123/log.txt` |
| [src/services/mods/workerFaultSession.test.ts](../../src/services/mods/workerFaultSession.test.ts) | 2/0/0 | 0 | `workspace-final-gate-124/log.txt` |
| [src/services/mods/workerHeartbeat.test.ts](../../src/services/mods/workerHeartbeat.test.ts) | 4/0/0 | 0 | `workspace-final-gate-125/log.txt` |
| [src/services/mods/workerReload289.test.ts](../../src/services/mods/workerReload289.test.ts) | 27/0/0 | 0 | `workspace-final-gate-126/log.txt` |
| [src/services/mods/workerRenderRecovery289.test.ts](../../src/services/mods/workerRenderRecovery289.test.ts) | 2/0/0 | 0 | `workspace-final-gate-127/log.txt` |
| [src/services/tools/toolHooks.test.ts](../../src/services/tools/toolHooks.test.ts) | 59/0/1 | 0 | `workspace-final-gate-128/log.txt` |
| [src/tools/AgentTool/AgentTool.nesting.test.ts](../../src/tools/AgentTool/AgentTool.nesting.test.ts) | 6/0/0 | 0 | `workspace-final-gate-129/log.txt` |
| [src/tools/AgentTool/runAgent.modsTurn.test.ts](../../src/tools/AgentTool/runAgent.modsTurn.test.ts) | 1/0/0 | 0 | `workspace-final-gate-130/log.txt` |
| [src/tools/SendMessageTool/SendMessageTool.test.ts](../../src/tools/SendMessageTool/SendMessageTool.test.ts) | 1/0/0 | 0 | `workspace-final-gate-131/log.txt` |
| [src/tools/WorkflowTool/workflowNotifications.test.ts](../../src/tools/WorkflowTool/workflowNotifications.test.ts) | 8/0/0 | 0 | `workspace-final-gate-132/log.txt` |
| [src/tools/shared/spawnMultiAgent.test.ts](../../src/tools/shared/spawnMultiAgent.test.ts) | 1/0/0 | 0 | `workspace-final-gate-133/log.txt` |
| [src/utils/messages.promptModes.test.ts](../../src/utils/messages.promptModes.test.ts) | 22/0/0 | 0 | `workspace-final-gate-134/log.txt` |
| [src/utils/plugins/cacheUtils.gc.test.ts](../../src/utils/plugins/cacheUtils.gc.test.ts) | 20/0/0 | 0 | `workspace-final-gate-135/log.txt` |
| [src/utils/plugins/managedPlugins.test.ts](../../src/utils/plugins/managedPlugins.test.ts) | 1/0/0 | 0 | `workspace-final-gate-136/log.txt` |
| [src/utils/plugins/pluginDirectories.env.test.ts](../../src/utils/plugins/pluginDirectories.env.test.ts) | 1/0/0 | 0 | `workspace-final-gate-137/log.txt` |
| [src/utils/plugins/pluginLoader.contract.test.ts](../../src/utils/plugins/pluginLoader.contract.test.ts) | 1/0/0 | 0 | `workspace-final-gate-138/log.txt` |
| [src/utils/processUserInput/processUserInput.mods.test.ts](../../src/utils/processUserInput/processUserInput.mods.test.ts) | 88/0/0 | 0 | `workspace-final-gate-139/log.txt` |
| [src/utils/swarm/inProcessRetention.test.ts](../../src/utils/swarm/inProcessRetention.test.ts) | 2/0/0 | 0 | `workspace-final-gate-140/log.txt` |
| [src/utils/swarm/teammate.modsTurn.test.ts](../../src/utils/swarm/teammate.modsTurn.test.ts) | 1/0/0 | 0 | `workspace-final-gate-141/log.txt` |
| [src/utils/swarm/teammateIdentity.test.ts](../../src/utils/swarm/teammateIdentity.test.ts) | 4/0/0 | 0 | `workspace-final-gate-142/log.txt` |
| [src/utils/swarm/teammateMetadata.test.ts](../../src/utils/swarm/teammateMetadata.test.ts) | 1/0/0 | 0 | `workspace-final-gate-143/log.txt` |
| [src/utils/swarm/teammateResume.test.ts](../../src/utils/swarm/teammateResume.test.ts) | 1/0/0 | 0 | `workspace-final-gate-144/log.txt` |
| [src/utils/teammateMailbox.ack.test.ts](../../src/utils/teammateMailbox.ack.test.ts) | 1/0/0 | 0 | `workspace-final-gate-145/log.txt` |
| [src/utils/textHighlighting.modsDecorations.test.ts](../../src/utils/textHighlighting.modsDecorations.test.ts) | 5/0/0 | 0 | `workspace-final-gate-146/log.txt` |
| [src/utils/uuid.test.ts](../../src/utils/uuid.test.ts) | 1/0/0 | 0 | `workspace-final-gate-147/log.txt` |

原 response.md 的9项已逐一复跑，8项包含在上述表中；未修改的 scripts/build-isolated.test.mjs 另以 workspace-build-fixture-final 运行，模块级断言完成并 exit 0。旧报告的155文件清单属于此前冻结版本，不用其结果拼接本轮147文件结果。

原有跳过项如下，仍列为未覆盖，未新增skip或削弱断言：

- `src/services/mods/native.test.ts`：official sec-default uses production native seating and the real accepted policy provider
- `src/services/mods/runtime.test.ts`：Mods lifecycle > flushes the official agents-md startup row through official telemetry
- `src/services/mods/runtimeHost.test.ts`：official diff silently yields to the built-in command
- `src/services/mods/runtimeHost.test.ts`：official diff still logs unexpected command registration errors
- `src/services/mods/runtimeHost.test.ts`：an author plugin compiles against the complete target declarations and runs unchanged in a Worker
- `src/services/mods/runtimeTools.test.ts`：official native policy blocks Worker author registration before publication
- `src/services/mods/testLab.test.ts`：actual sample typechecks against the complete external author declarations
- `src/services/mods/toolCatalog.test.ts`：official native seating preserves ordinary tool.describe changes in the production schema helper
- `src/services/mods/toolCatalog.test.ts`：official native list restores org MCP and retains user order/description without replacing Tool/schema/call
- `src/services/tools/toolHooks.test.ts`：classic events at existing tool hook boundaries > official native policy protects both schedulers with repeatable next, ref and child result omission

## 同进程全量诊断及逐文件对照

clean HEAD 和 ROOT 分别执行 bun test --no-env-file src scripts，均已观察到失败，并在既定120秒上限终止（exit -15）；两侧源码不变、自有进程组均已清理。这些不是完整suite结果，不能比较失败行数量来判断回归，也不能声明G5通过。原始记录分别为 head-control-suite1 和 workspace-suite1。

将 ROOT 本场已观察到失败的12个文件逐一在实际仓库路径和clean HEAD单独复跑。下表只覆盖这12个文件，不代表全部可能失败文件；其中没有 HEAD 单独通过、ROOT 单独失败的项。既有失败仍需后续处理。

| 文件 | clean HEAD pass/fail/skip | ROOT pass/fail/skip | 判定 |
| --- | --- | --- | --- |
| [scripts/mods-test-lab.test.mjs](../../scripts/mods-test-lab.test.mjs) | 24/3/0 | 24/3/0 | 既有失败仍复现 |
| [src/components/CoordinatorAgentStatus.layout.test.tsx](../../src/components/CoordinatorAgentStatus.layout.test.tsx) | 11/0/0 | 11/0/0 | 两侧独立通过 |
| [src/components/ModsAbovePrompt.band289.test.tsx](../../src/components/ModsAbovePrompt.band289.test.tsx) | 不存在 | 10/0/0 | 新测试，HEAD无此文件 |
| [src/components/ModsAbovePrompt.test.tsx](../../src/components/ModsAbovePrompt.test.tsx) | 9/0/0 | 9/0/0 | 两侧独立通过 |
| [src/components/ModsPane.test.tsx](../../src/components/ModsPane.test.tsx) | 151/4/0 | 180/0/0 | ROOT独立通过，HEAD失败 |
| [src/components/Stats.openai.test.tsx](../../src/components/Stats.openai.test.tsx) | 3/0/0 | 3/0/0 | 两侧独立通过 |
| [src/query.test.ts](../../src/query.test.ts) | 10/1/0 | 10/1/0 | 既有失败仍复现 |
| [src/screens/REPL.goalResume.characterization.test.ts](../../src/screens/REPL.goalResume.characterization.test.ts) | 0/1/0 | 0/1/0 | 既有失败仍复现 |
| [src/screens/REPL.retainedTeammates.render.test.ts](../../src/screens/REPL.retainedTeammates.render.test.ts) | 2/1/0 | 2/1/0 | 既有失败仍复现 |
| [src/utils/systemPrompt.customPrompt.test.ts](../../src/utils/systemPrompt.customPrompt.test.ts) | 2/1/0 | 2/1/0 | 既有失败仍复现 |
| [src/utils/systemPromptType.test.ts](../../src/utils/systemPromptType.test.ts) | 3/2/0 | 3/2/0 | 既有失败仍复现 |
| [src/utils/udsMessaging.test.ts](../../src/utils/udsMessaging.test.ts) | 2/16/0 | 2/16/0 | 既有失败仍复现 |

这些记录不完成同进程全量／G5、实际provider、官方Mods API／类型／上下文／UI／diff矩阵。spawn并发限额及observer生命周期、title helper请求路由等仍需继续对齐。本批没有生产改动，因此没有将历史CLI证据当成本轮新行为验收。
