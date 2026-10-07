# SDK remote scroll parity — official 2.1.292 / 2026-10-08

## Scope and result

Connect finite `ui_scroll` requests and `system/ui_scroll` messages. SDK navigation and headless author `$.ui.scroll` share one remote view per component/instance, independent of the drawing lease. Preserve the existing terminal scroll host. Add layout-client attach roster catch-up, found during the native adjacent-control comparison.

Parent: `6b1369525ae72b306a2bcab94d0656e965f02d10`. Candidate contains only this increment over that parent. The workspace freeze contains the existing unrelated WIP plus this increment; its result is recorded separately. This is a local signed commit batch, without push. Full Mods/UI/diff/G5 parity and the old WIP release gate remain open.

## Source-confirmed and binary-observed contract

- Official registry latest rechecked 2026-10-08: **2.1.292**, package shasum `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`. [Package metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest). The [public Mods reference](https://code.claude.com/docs/en/plugins/mods/reference) still describes 2.1.290 and gives precedence to installed declarations. Local read-only declaration baseline: `/private/tmp/mods-declarations-292-tawjepgs/official-292.d.ts`.
- Read-only official source: `/private/tmp/mods-declarations-292-tawjepgs/re-extract-292/all/chunk-jjy8yg8v.js`, `Au/rw/sw/Qo/Lv/Xv/Qv/hf`, with author `UKn/LAe/lpt/vht/upt` in `chunk-pwkr374y.js`. No extracted source or modified binary is published in this commit.
- Only registered, placed Pane IDs and AbovePrompt `above-prompt` are valid. An attached client's first report may establish a view before drawing and starts from cached zero. Once a view exists, reported `offset` does not replace the cached position. Render props initialize an empty view; later render scroll props update its body height. A later rendering client becomes the push recipient.
- Scroll hooks receive component/requestId, target offset, delta, body/content rows, person/plugin origin and optional pointer. All except offset are readonly; omitted facts are restored. Invalid rewrites and ordinary throws fall back to the unchanged event; hook denial retains the earlier position. Moves clamp to the current window range.
- One report runs at a time per view; pending reports sum deltas and retain the last report's metrics. Pending callers share the aggregate result. `control_cancel_request` does not remove scroll receipts. Author moves during person work supersede it with `the window moved meanwhile`; end following grows with content and upward movement stops following.
- Author start/end and owner-filtered key positioning use the same view. Key alignment supports nearest/start/center/end, and AbovePrompt author access requires that plugin's AbovePrompt render registration. Plugin moves produce position pushes, including unchanged positions; end following produces an additional `follow_end:true` notification. Person reports do not produce these pushes.
- Native comparison exposed an adjacent missing layout attach notification. Official `ui_attach` acknowledges, then publishes the current pane roster when no placement publication occurred. `Wkn` in `chunk-96mvg299.js` identifies a layout client by `viewport.isFullscreen !== undefined`, so false also qualifies. A per-runtime publication counter now implements the same ordering and avoids duplication when placement already published.
- `[ModsUIRemote] ui.scroll` logs component, instance, client, delta, resulting position, origin and denial. SDK message typing/schema and print history exclusion include `system/ui_scroll`. No render props body is added to the new debug logs.

## Verification

The driver uses isolated HOME/config/TMP/XDG/cwd, a private tmux socket/session, dummy credentials and a localhost HTTP fixture. Native runs are serial; each reaches normal exit0 and removes its owned pane/server process group before the next. The test sandbox denies real credential/config access and external networking. Shared repository binaries and user Claude processes are not used as test instances.

| Evidence | Result |
| --- | --- |
| First red suite | 0 pass / 8 fail, unsupported scroll entry; original output retained |
| Final candidate focused suite, 14 files | 475 pass / 3 skip / 0 fail, 1725 expectations |
| Final workspace focused suite, same 14 files | 492 pass / 3 skip / 0 fail, 1777 expectations |
| release-check and fresh builds, both snapshots | exit0; identical source manifest across each side's final three gates |
| Native SDK official/candidate/workspace | 187 receipts, 155 observed events, 25 pane notifications and 4 scroll notifications on each side |
| Required native SDK comparisons | **690/690 passed**; exact receipt payloads (except initialize metadata), scroll facts/order, queue reply order, pane notices/order, actual inputs, callback lease attribution, final cleanup and binary identity |
| Adjacent native terminal lifecycle | **45/45 required checks passed**; 9 events per side, normal exit and cleanup |
| Adjacent terminal mouse focus | 4 pre-existing differences retained: G1/G2 button press has official isFocused=false versus local=true, candidate and workspace separately |

Three optional loader tests skip because the full official diff/sec-default/agents-md declaration fixtures are unavailable to the isolated focused suite. They are not counted as completed diff coverage. The new scroll file has 11 tests: cached position; readonly/throw/deny; author supersession and following; queued cancellation; AbovePrompt/client routing; pane close/reopen generation isolation; key alignment/latest client; malformed reports; AbovePrompt author ownership; layout attach catch-up; normal session-end cleanup before observer hooks. The lifecycle red probe retained `moved:true,offset:9` after end; its final regression requires a denied move both inside detach observation and after end.

Native labels: SDK official `o3`, candidate `c3`, workspace `w2`; terminal official `o1`, candidate `c2`, workspace `w2`. Pair comparison also passed 459 checks. `native-comparison-c1-failed.json` retains the first missing attach catch-up failure. Earlier official focus probe (`o1`) is research only and does not count as this scroll batch's coverage. Its fixture failed to draw the intended owner focus tree, so it is not a positive owner-focus oracle.

Evidence root: `/private/tmp/mods-view-controls-292-20261008-niudg5_d`. `native-comparison.json`, `pane-list-comparison.json` and each native `evidence/result.json` retain exact inputs, control receipts, events, captures, logs, process ownership and side effects. Comparisons replace generated callback IDs only by the exact plugin/first drawing lease/type/key; multiple generations are not collapsed. Private session/cwd fields and UUID/session envelopes are normalized, with envelope validity separately checked. Other payloads and per-operation order remain exact.

## Reproduction and source identity

Focused commands are stored verbatim in each gate's `result.json`. For the new cases:

```bash
bun test --no-env-file ./src/services/mods/remoteUiScroll.test.ts
make release-check
make build CLAUDE_CODE_BUILD_DIR=/private/tmp/your-owned-build
```

The private batch drivers are `run.py`, `native-control.py`, `native-pane-list.py`, `compare-scroll.py` and `compare-pane-list.py`. They refer to this batch's owned evidence/binaries; do not replay them against a shared user tmux pane.

| Gate | Source SHA-256 | Result |
| --- | --- | --- |
| candidate-focused5 | `28bb9ac03d6ef92b1589373bd169f1f95eb2fc0f1c6c8ae76d647dd2cbeb5d1d` | exit0 / 31.956s |
| candidate-check6 | `28bb9ac03d6ef92b1589373bd169f1f95eb2fc0f1c6c8ae76d647dd2cbeb5d1d` | exit0 / 48.988s |
| candidate-build3 | `28bb9ac03d6ef92b1589373bd169f1f95eb2fc0f1c6c8ae76d647dd2cbeb5d1d` | exit0 / 3.645s |
| workspace-focused3 | `015af0847afce4cd82c97c7d570880a3c2cbe9e9cb7322aabb9b48114b706d0f` | exit0 / 31.562s |
| workspace-check3 | `015af0847afce4cd82c97c7d570880a3c2cbe9e9cb7322aabb9b48114b706d0f` | exit0 / 49.765s |
| workspace-build3 | `015af0847afce4cd82c97c7d570880a3c2cbe9e9cb7322aabb9b48114b706d0f` | exit0 / 4.545s |

| Binary | Path | Bytes | SHA-256 |
| --- | --- | --- | --- |
| official | `/private/tmp/mods-fork-routing-20261007-2afwted_/official/official-claude-2.1.292` | 235017328 | `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f` |
| candidate | `/private/tmp/mods-view-controls-292-20261008-niudg5_d/candidate-build3-output/built-claude` | 102150242 | `dc7ee7a2cc732df0b0e472c044bf8c3edb85efe9af1263218e837a60c2a54ef4` |
| workspace | `/private/tmp/mods-view-controls-292-20261008-niudg5_d/workspace-build3-output/built-claude` | 102249314 | `0f8d0ac33bdc157c39739670f3b38a90033485ef4d0b5f1b55d993e76d50a264` |

## Remaining work

Current client controls: **15/18**. `ui_focus`, `ui_prompt_edit`, `ui_prompt_autocomplete`, five responders, other system pushes, browser Client execution, complete diff viewer/frame/input parity and G5 remain separately scoped. Remote focus and terminal/remote focus-holder unification are not implemented by this batch. Mixed terminal/remote scrolling is not unified here: author calls in terminal sessions retain the terminal host, while headless author calls use the remote view. Real GUI/terminal pixel comparisons and all workflow/model/API context combinations are not covered by this finite SDK batch. The session-end capability-state assertion is automated coverage; native end evidence proves normal exit and cleanup, not every author call from an end hook. The known trusted nested stream callback abort-reason baseline failure and the whole dirty-tree suite are not declared fixed.

`response.md`, `fix-instructions.md` and `improvment.md` remain historical review evidence; this report does not overwrite them or turn their old 146/155 results into a current full pass. Commit proof records the exact selected blobs, valid GPG signature, empty index afterward, unowned file hashes/mtime checks and protected process identities. All unrelated WIP is preserved.
