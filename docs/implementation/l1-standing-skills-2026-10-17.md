# L1 standing 与技能循环

> 重新核查说明（2026-10-17）：本文是先前局部实现与有限验证记录，不是完整 L1 架构验收。三技能选择仍硬编码，未实现开放发现/正文与资源渐进读取/统一预算；standing 为短模板。当前功能扩展已暂停，以 [新工程方案](../engineering/context-loading-plan-2026-10-17.md) 和用户明确确认作为后续实施依据。既有测试证据不删除。

日期：2026-10-17。范围是本地单用户运行时。本轮没有访问 ECS，没有改多用户、数据库迁移、UI，也没有改 package engines。

## 行为与数据

产品数据目录（`KLEIO_DATA_DIR` / XDG，默认 `~/.local/share/kleio`）下新增：

- `standing/IDENTITY.md`、`SOUL.md`、`USER.md`、`TOOLS.md`、`AGENTS.md`
- `skills/<id>/SKILL.md` 与 `skills-index.json`

启动时补缺失的 standing 文件；首次会话编译时补缺失的内置 skill 与索引，后续读取时也补缺失文件，不覆盖已有内容。每次执行开始重新读取适用配置。悬空符号链接和把目录位做成普通文件的情况会拒绝并给出原因，不覆盖链接，也不写到链接外面。

身份优先级：

1. 已有且合法的 `standing/IDENTITY.md` Name / Tone 是提示词权威。
2. 仅当本次启动新建了 `IDENTITY.md`，且 `openmuse.identity` 里已有合法 name / tone 时，用该设置播种一次。
3. 文件存在之后，直接改文件在下一轮生效；读取身份接口时同步 SQLite 展示镜像。prompt 始终读取文件，镜像不是另一份配置权威。
4. 缺失、空白或非法的 name / tone 使用产品默认 Kleio / warm，并在上下文里说明原因。
5. avatar 与 `showChatUpdates` 仍只在 `openmuse.identity`。`POST /api/agent/identity` 写 name / tone 到文件并更新镜像。

对话轮按当前意图装载 0–2 个技能：`forget`、`self-awareness`、`wide-research`。研究与 review 轮不装载技能。进入上下文的用户可编辑内容，包括技能 description 等元数据，都经过遗忘脱敏。能力快照区分已实现、配置模式（`web_search` 为 `api-key` 或 `keyless`）和本轮是否可调用；没有密钥不等于宣称无法搜索。

## 修改文件

- `packages/product-context/`：文件边界、standing、核心规则、三个技能、能力快照、上下文汇编
- `packages/runtime/identity.ts`：身份 API 与文件权威
- `packages/runtime/host.ts`：执行开始时汇编产品上下文
- `packages/runtime/l1-standing.test.ts`
- `apps/runtime/openmuse.ts`：身份读写走 standing
- `scripts/verify-l1-live-model.ts`：显式 opt-in 脚本，本代理未对真实供应商执行
- `package.json`：增加 `verify:l1-live`
- `tsconfig.runtime.json`、`README.md`

## 验证

Node 为 engines 范围内的 24.19.0：`/var/folders/wk/jwx4crlj219bqt64v262s2g80000gn/T/kleio-validation-node-byp86c6e/node-v24.19.0-darwin-arm64/bin/node`。

Codex 独立证据：

- 真实本地 HTTP 后端 + pinned DSH + 既有模型配置 7 轮全部通过，见 `reference/kleio-design/evidence/cursor-l1/live-backend.json`。身份问句不含预期名字；同一会话先回答霁蓝，文件改名后回答杉舟。remember、correct、关闭召回后的 known-ID forget 有工具完成事件和数据库结果；未知 ID 有 `memory_forget` 的 `tool.failed` / `NOT_FOUND`，模型说明未成功。
- 关键 L1 + L0 共 12 项通过，见 `final-l1-l0-tests.log`。
- `final-typecheck.json`：Node 24.19.0，`tsc -p tsconfig.runtime.json --noEmit` 退出码 0。
- 扩展套件 98 项中 95 通过、3 失败。`git archive HEAD`（`040f30b3f4976e87f4a26a8d9de2757739083ed3`）的隔离副本用同一 Node 复现了同样三项，见 `head-baseline-history-review.log` / `head-baseline-history-review.json` 与 `REVIEW-2.md`。这三项不在本轮修复：`history.test.ts` 的 authenticated history endpoints，以及 `review.test.ts` 的 queued review 与 conversation excerpts。

本代理对 `scripts/verify-l1-live-model.ts` 做了单独 typecheck（`tsconfig.runtime.json` 不包含 `scripts/`），退出码 0。未带 `--confirm-live-model` 时脚本退出码 2，`liveModel` 为 false，没有调用模型。

## 脚本退出码

`scripts/verify-l1-live-model.ts` 的退出码 0 只表示自动结构与状态断言通过，不表示模型措辞已被判定为真。报告顶层有 `manualReviewRequired`：

- `capability-response-recorded` 只检查该轮 completed 且回答非空。邮件或 Computer 是否被编造，需要人工看回答。
- 遗忘回复的措辞不自动打分。助手是否与工具结果一致，需要人工看回答。

未知 ID 仍要求该轮 completed，以及实际的 `memory_forget` `tool.failed` 事件。

## 尚未由本代理验证

本代理没有运行真实模型。真实模型结论以上述 Codex 7 轮为准。脚本化 / fake Engine 只证明上下文进入执行输入。多用户、ECS 与前端联调不在本轮。
