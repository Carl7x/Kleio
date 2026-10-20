# 上下文与加载机制：源码核查

2026-10-17 · 研究范围限定为 standing、skills、上下文、工具与引擎交界。配套决策见 [工程方案](context-loading-plan-2026-10-17.md)。§1–7 记录初次只读核查；后续授权下的补充源码证据见 §8，分批实施与运行结果以工程方案 §12 为准。未访问 ECS。

## 1. 证据口径与版本

- **S：源码事实**，已经读到调用方、实现及其输入输出。静态可达不等于本次运行复现。
- **P：提示词/文档事实**，材料确实这样规定；不能据此证明私有服务端这样运行。
- **I：设计推断**，据事实提出的 Kleio 选择；是否授权、实现和验证以工程方案 §12 为准。
- **U：未知/未验证**，此次未获得实现或未运行验证。

| 对象 | 本轮固定版本 | 边界 |
| --- | --- | --- |
| Kleio | HEAD `040f30b3f4976e87f4a26a8d9de2757739083ed3` **加当前脏工作区** | L1 文件部分未提交，本文位置指当前工作区，不能用 HEAD 链接代表这些字节 |
| Codex | `2f05c0a71f59fb2f05800846351f3e9926c3e52b` | 本地 `reference/codex`，本轮追踪下述切片，不是全仓审计 |
| OpenClaw | `4a790aea80ae1b186051719a8044d19dd3294a26` | 本轮取得官方 `openclaw/openclaw` 源码，未安装/运行 |
| Hermes | `8dcf6d5b2174e18a7e81227a0df93f76f96204ee` | 本轮取得官方 `NousResearch/hermes-agent` 源码，未安装/运行 |
| DSH | 安装包 `@deepseek-ai/dsh` 及相关模块 `0.2.1-alpha.2` | 读本地发布包 JS、类型声明、composition；不是假设 npm 最新版本 |
| Muse | 2026-10-14 `muse-logic-pkg` 导出包 | 无服务端 Git 版本；文件哈希记录于证据清单，只有提示词、standing、skills 和产品文档 |

可复查清单：[研究开始时应用文件哈希](../../reference/kleio-design/evidence/context-loading-review/source-baseline.json)、[参考版本及已引用文件哈希](../../reference/kleio-design/evidence/context-loading-review/research-manifest.json)。`reference/` 被 Git 忽略，克隆与原始材料只在本地；这里的方案与核查文档可以随项目保存。

## 2. Kleio 当前真实路径

### 2.1 前台会话

`RuntimeHost.submit → enqueueConversation → enqueue 的延迟 input factory → Engine.execute → DshEngine.run → prepareHeadlessLaunch / createProductMcpBridge → ACP newSession / prompt → DSH loop → MCP tools/call → RuntimeHost.callTool`。

源码：[host.ts](../../packages/runtime/host.ts)、[contracts.ts](../../packages/runtime/contracts.ts)、[dsh.ts](../../packages/engines/dsh.ts)、[headless.ts](../../packages/harness-dsh/src/headless.ts)、[product-mcp.ts](../../packages/harness-dsh/src/product-mcp.ts)。

| 环节 | 具体实现 | 已有能力与实际缺口 |
| --- | --- | --- |
| standing | `standing.ts:95 ensureStanding`、`:110 loadStanding`；五个固定文件，每份 16 KiB | **部分实现**：补模板、不覆盖、执行开始重读、身份字段有效；内容是简短 Kleio 模板，不代表移植 Muse 行为；没有可追踪的集合版本/一致性快照 |
| 身份桥接 | `runtime/identity.ts:30 migrateStandingIdentity`、`:40 currentAgentIdentity`、`:57 saveAgentIdentity` | **已实现有限契约**：旧身份仅播种新建 IDENTITY，文件为 Name/Tone 权威，API 写同一文件；avatar 等仍为展示设置；并非完整 standing 管理器 |
| 产品规则 | `product-context/rules.ts:2 coreRules` | **部分实现**：业务长文已从 host 抽出，仍是一段综合字符串；不同执行类型的 JSON 要求另在 host 拼接，规则尚无类型、版本、覆盖追踪 |
| 技能选择 | `skills.ts:14 INTENTS`、`:137 selectSkills` | **场景实现**：三个 ID 的关键词匹配、排序、最多两个；索引只过滤匹配结果。新增第 4 个合法 skill，即使写进索引也没有被选择的入口 |
| 技能格式 | `skills.ts:164 parseSkillMarkdown`、`:195 parseIndex` | **部分实现**：仅两字段平面 frontmatter，非通用 YAML；`KNOWN_TOOLS` 另存静态清单，索引最多 32 条；绑定只变成 prompt 文本，不是通用注册器 |
| 技能加载 | `selectSkills → readBounded → loaded.push(body)`；`compile.ts:24` | **正文注入已实现，渐进加载未实现**：选中就读全文、直接拼进 prompt；无全目录元信息、无运行中正文读取、无关联资源读取、无加载状态/版本/cursor |
| 汇编 | `compileProductContext(): string` | **部分实现**：规则、五个 standing、能力文案、正文、边界说明连接；遗忘脱敏已有；替换分隔符不是强信任隔离，无整体 token 分配或装载清单 |
| 历史 | `host.ts:82–101 enqueueConversation` | 最近 20 个用户消息，对应完成答复组成对；总 48,000 字符，答复单条裁到 18,000 字符；没有语义摘要、缺失可读句柄或与其他上下文共享预算 |
| 记忆 | `host.ts:118 memoryContext`；`personal-memory/runtime.ts:252 search/:265 context` | 已有带来源/版本的词法召回与局部边界；召回正文先渲染成字符串再拼接，统一 compiler 看不到独立事实对象和预算成本 |
| 工作背景 | `host.ts:121 recentWork`、`:100` 拼接 JSON | 当前会话最近 6 项，单项摘要 1,200 字符；有真实任务状态；不是统一 ContextPart，也没有统一优先级和失效版本 |
| 工具 | `host.ts:98` 清单、`:186 callTool`；`product-mcp.ts:41/42` | **真实边界已存在**：本轮清单、schema 校验、服务端授权、MCP 凭证、执行取消；不能把现状说成“只靠 prompt 限权”。但定义、能力说明、skill 已知工具表多处重复 |
| 引擎输入 | `contracts.ts:9 ExecutionInput`；`dsh.ts:94–102` | `context:string + history[] + tools[]`，然后 context/history JSON 化放入一个 ACP 文本请求；工具 schema 单独经 MCP 注册。产品上下文没有结构化端口，角色/预算/压缩能力未协商 |

具体影响：用户添加个人 playbook 不能自然发现；同义表达可能漏选；已选 skill 引用 `references/*.md` 时模型无法继续读取；个别部分各自没超限，组合后仍可能超过模型容量；用户配置、引用事实、技能指令的来源丢在字符串里，后续很难按来源撤回或重建。

### 2.2 后台与记忆关闭：初次发现及 G1 复核

初次审查时，`host.ts:363 tick → work.tick.runResearch` 在三个分支（`:372`、`:376`、`:381`）直接追加 `this.memory.context(request)`。前台才走检查 `memoryEnabled` 的 `memoryContext()`。`MemoryRuntime.context → search → visible` 内部只处理有效状态/时间等，不读取 runtime 的 `memoryEnabled` 设置。与此同时 `availableReadTools` 和 `memory_search` 调用入口会检查开关。

**S：在记忆关闭且仍有相关有效 claim 的条件下，初次版本的后台研究仍可召回该 claim。** 后续 G1 在真实 Host/Work 和临时数据库中已复现：三个入口的关闭、排队后关闭共 6 项失败，开启的 3 项通过。现已将三处改为 `memoryContext()`，9 项通过；详见工程方案 §12 与对应日志。review 使用 `scrubWorkInjection` 防遗忘回灌，但“已遗忘”与“关闭召回”也不是相同条件。

仍有独立差距：`runObserved` 使用静态 `researchTools`，记忆关闭时 schema 仍包含 `memory_search`；实际 handler 返回 `memory_disabled`，测试已验证拒绝。旧 interval 分支使用 `availableReadTools()`，目录中已无此工具。G1 修复正文注入，不冒充完成 G4 的能力目录归一。

后台 `research` / `review` 的 skill 选择一律为空；memory extraction 另有专用 prompt（`personal-memory/runtime.ts:423` 起）。因此现在并不是“所有执行类型都由同一个完整 compiler 管理”。统一所有权不等于给这些类型塞同样内容：review 的严格 JSON、memory 的抽取 schema 仍应是各自专用配置。

另一个边界：`host.ts:161–172` 直接转发前台 `onText` 并保存最终文本；现有遗忘过滤主要在召回、上下文编译和后台交接路径。不能声称已经有统一的前台输出过滤，或已让运行中模型忘掉之前见过的内容。

### 2.3 DSH 的隐式上下文行为

以下根目录记为 `D = packages/harness-dsh/.runtime/node_modules/@deepseek-ai/`。

- **S**：`headless.ts:33 disabledRows` 关闭原生 skill、文件/终端、多数本机能力；`product-guard.mjs:6 apply` 对工具清单做 guard 和 agent 创建时的清单校验。这是可保留的产品所有权边界。
- **S**：`D/dsh-base/cordis.patch.yml:343–347` 装载 token-meter 和 compaction-basic，`:420–425` 装载 tool-result-pruner（阈值 8,192 字符、保留头 4,096 / 尾 1,024）。Kleio 的 disabledRows 没关它们。
- **S**：`D/dsh-compaction-basic/lib/index.js:124 resolveCompactSpec` 计算上下文、输出预留和 headroom；`:839` 在 `agent/pre-step` 调用 `compactIfNeeded`；`:861` 处理供应商 context-overflow。正常压力下压缩失败会记录警告并继续，不是 Kleio 定义的严格预算终止语义。
- **S**：`D/dsh-agent-loop/lib/index.js:1175 prepareRequest/:1218 buildRequest` 组装实际 messages/tools；`D/dsh-llm/lib/types/index.d.ts:45` 暴露 `llm/stream` waterfall；`D/dsh-token-meter/lib/types/index.d.ts:46 measure` 可度量 session 与 envelope，包含工具成本并利用已报告用量。
- **U**：此前 7 轮真实测试没有证明压缩实际触发，也没有检查技能被裁剪后的完整性。不能从默认配置推断实际跑过这些分支。

**I**：引擎内部有压缩不等于产品已经拥有压缩策略。尤其接入按需 skill 正文后，默认结果裁剪可能截掉必要指令；应显式选择压缩/裁剪的所有权和失败策略，不能继续依赖隐式默认值。

### 2.4 旧验证证据的准确结论

已有记录是 12 个关键测试通过、runtime typecheck 通过、7 轮合成真实模型/API/数据库检查；扩展套件 98 项中 95 通过，3 个失败在旧 HEAD 隔离副本也复现。证据位于 [cursor-l1](../../reference/kleio-design/evidence/cursor-l1/)。

这些支持身份生效、特定技能注入、部分记忆操作/权限与 L0 回归场景。**不支持**开放技能发现、三级渐进加载、统一预算、全部后台开关一致性、多用户、引擎互换或完整 Muse 产品行为。旧证据保留；完成口径已改为“部分链路已验证，架构待整改”。

## 3. Muse：可以吸收行为，不能假装拿到了后端

根目录 `M = reference/调研/muse/muse-logic-pkg/`。

`M/README.md` 明说没有运行时/工具服务端、调度器、向量库、每轮动态 developer 消息/工具 schema/历史摘要。因此以下全部标 **P**，不是私有实现的源码结论。

| 材料与位置 | 可证实的行为规定 | 对 Kleio 的适配判断 |
| --- | --- | --- |
| `system_prompt.md:129–149` | 成功写入后确认；区分记忆与工作日志；人/群索引引导按需读具体记录 | 保留真实回执与相关性；不用 Markdown 改写替代现有 claim 服务；人/群扩展读取不在本轮扩大 |
| `system_prompt.md:181` 起 | 压缩可能丢细节，需从原记录恢复；主/侧对话混合需分清当前委托 | 历史要有来源 ID 和可再读取入口，摘要不等于事实真相；不由此新做侧聊 UI |
| `system_prompt.md:282` | deferred namespace 可再加载 schema | 证明其提示词有工具渐进装载概念；动态工具注册后端未获得。本轮工具少，固定本次允许的 schema 即可 |
| `system_prompt.md:345–351`、`standing/AGENTS.md`、`SOUL.md` | 常驻配置各司其职，文件修改与注入副本可能不同步；人格与工作约定分开 | Kleio 采用下一执行快照生效；从稳定行为中提炼默认规则，不复制 Kyle 的个人档案，也不宣称能自动进化 |
| `system_prompt.md:411` | 外部内容、skills、记忆不能代表用户授权或扩大任务 | 权限在产品服务执行；字符串标记只辅助模型理解 |
| `skills/self-awareness/SKILL.md`、`references/question_types.md` | 每次查真实状态；按问题读取最少资料；区分事实/推断；不自动追加连接建议 | 改为读 Kleio standing/能力快照与产品参考文档；剔除 shell、目录探测和未配置连接器 |
| `skills/forget/SKILL.md`、`references/artifact-inventory.md` | 多载体清理、计划/确认、派生失效、失败不宣称完成；列出具体资源与所有者 | 采用结果诚实、范围、失效意识；**不移植**其全产品永久删除和额外确认流程，保留 Kleio 已批准 memory_forget 语义 |
| `skills/wide-research/SKILL.md` | 独立输入、统一输出 schema、单一协调、覆盖率/失败项、选择性重试 | 采用研究方法与覆盖报告，绑定当前 work/search/写回；不能把一般“调研”都当并行宽研究，更不能虚构 manager/worker |

Muse 的这三个原始 SKILL.md 本身没有当前 Kleio 要求的两字段 frontmatter；它们附带的引用资源比当前短 playbook 具体得多。**短模板并非原罪，缺少行为清单、依赖分析和能力兑现才是问题。** 五份空模板也不该通过复制长段 Muse 文本来“补全”。

## 4. Codex：目录、选中内容与模型请求分层

根目录 `C = reference/codex/codex-rs/`，此版本已有 `skills` 与 `ext/skills` 拆分，不能沿用旧版 `core/src/skills/loader.rs` 路径。

### 4.1 已追踪的调用链（S）

1. `core/src/session/turn_context.rs:1300–1330` 在构建 turn context 时通过 `skills_load_input_from_config` / `skills_service.snapshot_for_config` 获取 `HostSkillsSnapshot`。
2. `ext/skills/src/host_service.rs:351 build_skill_outcome` → `load_and_merge_host_skill_roots_with_request_snapshots`，解析配置禁用规则；`loader/host.rs:130 load_host_skill_root → :146 load_skills_under_root → discovery.rs:54 discover_skills`。
3. `loader/host.rs:346 parse_skill_file` 读 SKILL.md 并解析 frontmatter，返回 `skills/src/model.rs:8 SkillMetadata`：name、description、path、scope、policy、dependencies 等，**无正文域**。扫描阶段会读取文件，不等于正文被发给模型。
4. `ext/skills/src/render.rs:532 render_prepared_skill_catalogs` / `catalog_prompt.rs:114 render_available_skills_body` 将元信息和定位符变成可见目录；`catalog_prompt.rs` 规定从 SKILL.md 到 references 的渐进阅读。这里“模型会遵循”仍需行为验证，不能把提示词当强制执行器。
5. 显式提及路径：`core/src/session/turn.rs:1151 collect_explicit_skill_mentions → :1168 load_skill_prompts`；`ext/skills/src/host_prompt.rs:69` 仅读取所选技能并产生 `SkillInstructions`。插件 main prompt 有截断警告，这不是 Kleio 可无条件照抄的行为。
6. executor/cloud 资源路径：`ext/skills/src/tools/read.rs:75 handle` 校验定位、复用内容快照并分页；`:284 page_response` 返回 `next_cursor`，同一快照继续读取；host 文件型 skill 仍走相应文件访问。两条路径不能混称一个万能 reader。

### 4.2 工具与上下文（S）

- `core/src/session/turn.rs:1666 build_prompt` 构造 `Prompt { input: Vec<ResponseItem>, tools, base_instructions, output_schema, ... }`。模型工具定义来自 `step_context.tool_router.model_visible_specs()`，不是将 schema 写进说明文字。
- `codex-mcp/src/connection_manager.rs:374` 根据 `McpServerConfig` 创建过滤器、超时与环境；`codex-mcp/src/tools.rs:25 ToolInfo` 保留原始 server/tool 身份和模型可见名字；`:72 ToolFilter` 同时处理 enabled/disabled，防止名字适配与真正调用身份混淆。
- `core/src/context_manager/history.rs:652` 估算历史/基础指令；`:719 replace_compacted` 替换压缩视图；`core/src/session/context_window.rs:53` 同时计算上下文硬上限和 auto-compact 作用域。不是无限增长的一个历史字符串。

**I：采用**元信息/正文/资源分层、snapshot、定位与读取游标、消息/工具/规则分离；**不直接引入**整套 Rust core、账户/插件系统或 coding 工具。Kleio 不开放通用 shell 读文件，采用产品限定的 reader；Codex host discovery 中仍有权限绑定 TODO，也说明成熟系统不能不加判断地照搬。

## 5. OpenClaw：启动材料、技能资格和工具策略协调

根目录 `O = reference/openclaw/src/`。

### 5.1 已追踪的调用链（S）

`agents/embedded-agent-runner/run/attempt.ts:187 → prepareEmbeddedSkills`（`skill-runtime.ts:18`）→ `prepareRuntimeSkillEntries` → `skills/loading/workspace-skill-prompt.ts:19 buildSkillSnapshot` → `workspace-skill-loader.ts:394 resolveWorkspaceSkillPromptEntries` → 层级来源装载/过滤 → `projectSkillSnapshot` → `resolveSkillsPrompt`。

- `skills/loading/local-loader.ts:79 loadSingleSkillDirectory` 在根目录边界内打开 SKILL.md，解析 frontmatter、验证 name/description，维护解析缓存。允许的链接策略与 Kleio 当前拒绝 symlink 策略不同，不能直接移植默认值。
- `skills/loading/skill-contract.ts:98 formatSkillCatalog` 渲染 name/description/location；`:56 compactSkillsPromptForContext` 缩短说明，保留身份和位置的下限。此“目录压缩”不是正文摘要，也不是整个请求的严格预算。
- `skill-runtime.ts` 在不能执行 `read` 时不构建技能目录；从有效 snapshot 计算可读取资源，并管理环境覆盖的恢复。**可见 schema 不等于可执行权限**在代码分支中体现。
- `agents/bootstrap-files.ts:397 resolveBootstrapContextForRun` → `embedded-agent-helpers/bootstrap.ts:469 buildBootstrapContextForFiles`。单文件与总量分别限制（默认 20,000 / 60,000 字符）；缺失、截断有诊断，personal USER 超限有专门处理。
- `agents/system-prompt.ts:511` 根据实际可读能力决定 skills 区是否出现；`run/attempt-system-prompt-prepare.ts:207/324` 将有效 skills 传入系统 prompt 构建。
- `agents/tool-policy-pipeline.ts:136 applyToolPolicyPipeline` 顺序过滤 profile/global/provider/agent/group 等策略。`agents/compaction.ts:72 summarizeCompactionHistory` 先 sanitize 消息再调用有预算的摘要序列化/生成，显式排除 tool details 和 runtime-context 数据。

**I：采用**启动材料预算与诊断、资格过滤、配置快照、读取边界和工具策略交集；**不移植**其消息渠道矩阵、环境变量自动覆盖、完整 skill library/安装生态。Kleio 的密钥只由连接配置管理，不允许 skill 内容导出环境变量。本轮未追踪 OpenClaw 的所有 MCP 传输路径，不对此作完整实现结论。

## 6. Hermes：专用技能读取与压缩后的重新装载

根目录 `H = reference/hermes-agent/`。

### 6.1 已追踪的调用链（S）

`agent/system_prompt.py:730 build_system_prompt_parts → :301 _skills_prompt → agent/prompt_builder.py:1356 build_skills_system_prompt → :1502 _build_skills_system_prompt_inner → 扫描/manifest 缓存/多来源合并/可用工具资格过滤 → :1432 _render_skills_index`。

目录只给名字与说明；`tools/skills_tool.py:709/741` 注册 `skills_list` 与 `skill_view` 的 schema/handler；模型调用通过 `model_tools.py:823 _execute_tool → registry.dispatch`，进入 `skills_tool.py:570 skill_view`。

- `skill_view` 解析名字、检查禁用/平台状态，返回 SKILL.md 正文和 `linked_files`；传 `file_path` 则进入 `skills_tool_plugin.py:68 _serve_skill_file`，拒绝 `..` 和根外路径，返回指定关联文件。
- `system_prompt.py:317 _auto_load_parts` 是额外的显式配置例外：一部分技能可在 agent 生命周期开始固定装入。不能说 Hermes “所有技能永远按需”，也不应给 Kleio 默认引入全量 auto_load。
- `system_prompt.py:730` 将 prompt 划为 stable/context/volatile；`:809 invalidate_system_prompt` 在压缩等边界重新加载。其缓存时机不等于 Kleio 承诺的“下一执行生效”，只借分层思想。
- `agent/context_compressor.py:3393 prune_tool_results_only` 先做确定性去重/裁剪；`:5526 compress` 保护头尾、摘要中间并清理工具配对。`conversation_compression.py:2294 _pruned_skill_reload_notice` 根据 `SKILL_PRUNED` 标记提醒重新 `skill_view`，避免摘要后误以为技能正文仍在。
- `tools/mcp_tool_discovery.py:603 discover_mcp_tools` 与 `mcp_tool_registration.py:353` 将连接得到的工具注册为 schema/handler；注册路径记录来源、作用域、名称冲突和策略。`registry.py` 持有运行时 handler，不由技能文件产生真实权限。

**特别不采用**：当前 `skill_view` 还可能预处理内联 shell、准备凭据并 `pm.ensure` 安装依赖。Kleio 本轮的“读取技能”必须为纯读取，不能因此运行脚本、安装包或建立连接。只移植其三级信息访问的机制，不复制整个函数。

## 7. 复用结论与未解决问题

| 机制 | 推荐来源 | 方式 | 不直接使用整套实现的具体原因 |
| --- | --- | --- | --- |
| Personal Agent 行为 | Muse 提示词/技能资料 | 按行为逐项适配 | 私有工具与产品面未具备，不能移植未兑现承诺 |
| metadata catalog、显式选中、版本快照 | Codex + OpenClaw | 移植机制，以 TS 领域接口实现 | Rust/大型 workspace/plugin 依赖不适合当前服务；主数据与权限仍属于 Kleio |
| 正文/资源读取 | Hermes + Codex `skills.read` | 适配专用只读工具、内容游标 | Hermes reader 有执行副作用；Codex host 路径假定通用文件能力 |
| 元信息解析 | 标准 YAML 解析器 + 项目 schema 校验 | 直接复用成熟解析库 | 不再用两字段行正则冒充 YAML；依赖版本和许可证在实施前固定 |
| 工具集合/权限 | 保留 Kleio bridge；借鉴 Codex/OpenClaw 过滤与身份映射 | 直接复用现有边界，归并 registry | 不为 skill reader 新引入另一个可绕过服务的 MCP 服务端 |
| 执行内计量 | pinned DSH token-meter 与 `llm/stream` hook | 适配现有计量/拦截点 | 不能把 DSH-specific hook 泄漏到产品 ContextPart；估计值不能冒充精确 token |
| 完整语义压缩 | Hermes/Codex 的恢复与重载机制 | 设计参考，建议本轮暂缓 | 需要保留来源、失效、工具配对与 checkpoint；当前字符串打包无法保证完整性 |

未解决项明确保留：Muse 私有装载/预算算法；参考仓库未运行的真实行为；不同模型的实际 tool-following 稳定性；同一次模型执行内已暴露信息的彻底失效与重新构建；长期历史摘要的产品效果。最后两项不能用“下一轮脱敏”冒充解决，方案将其列入边界与后续门槛。DSH hook 错误向 ACP 的映射已由后续 G0 实证为 -32603；可信产品映射的当前 G2 实现与验证见 §9 和方案 §14。

本次结论是：已有可靠局部契约值得保留，但 L1 应重新定义为尚待完成的上下文和技能架构整改，不能按已完成模块继续堆功能。

## 8. 续审：五个缺口的新增源码依据（2026-10-17）

本节为后续补充，前文“本次未实施”描述初次调研时点。仓库版本仍沿用 §1；本轮新的运行验证记录单列在 `reference/kleio-design/evidence/context-loading-batch1/`。

| 机制 | 新追踪的事实（S，除另注） | Kleio 的采用与差异（I） |
| --- | --- | --- |
| 最终请求门槛 | `D/dsh-agent-loop/lib/index.js:1044 step` 在 prepare/build 后调用 preparedCall.stream；`D/dsh-llm/lib/index.js:2374 streamWithRegistration` 进入 llm/stream waterfall。`D/dsh-session-checkpoint-policy/lib/index.js:25 afterCheckpoint/:61 apply` 通过 async generator 等待 flush 后才调用 next，证明现有官方插件也使用发送前的异步门槛。 | 复用该机制，不改 loop 或 node_modules。必须运行真实进程证明拒绝时没有 HTTP；生产实现再接产品预算和权限检查。 |
| 失败不是成功结束 | `D/dsh-agent-loop/lib/index.js:1000` 周边 catch 写 turn/error，`D/dsh-acp/lib/index.js:1058–1064` 将 agentError/end.error 转为 internal RPC error；`packages/engines/dsh.ts:128` 把提示开始后的 DshAcpError 统一归类 UNKNOWN。 | 不依靠错误文案识别预算停止。产品控制端记录可信拒绝回执，适配器仅在确认终止、工具收敛后映射；传输断开仍保持 unknown。实际门槛验证为 G0。 |
| 分页快照 | `C/ext/skills/src/tools/read.rs:154` 起缓存执行器读取结果；注释明确 cache hit 不检测文件编辑，续读可能返回旧内容；`:284 page_response` 把完整 JSON 响应大小和 Unicode 边界算入页预算。 | 采用执行期不可变快照。改为每执行受控容量的包快照，普通编辑下一执行生效；不用“同一执行自动刷新半套技能”。连 envelope 与 cursor 一起计量，不只裁正文。 |
| 去重与失忆 | `H/agent/context_compressor.py:3164 _dedupe_tool_results` 保留较新的相同工具结果，将旧副本替换为引用；`H/agent/conversation_compression.py:2294 _pruned_skill_reload_notice` 扫描 SKILL_PRUNED 并要求重新读取。 | 本轮关闭压缩，不照搬历史原地改写。已送达页再次读取返回引用；必须由实际请求中的回执验证保留情况，不能只用应用 loaded 布尔值。任何不可解释丢失停止执行，不声称技能仍完整。 |
| 快照和当前授权分开 | `C/core/src/session/step_context.rs:24 StepContext` 固定该次请求的 settings/tools/MCP；`:64 environments` 取 originating turn 的当前 grants。 | 配置快照稳定，不代表授权永远有效；工具执行和每次请求仍检查产品当前 policyEpoch。 |
| 中止及结束权 | `O/agents/embedded-agent-runner/runs.ts:828 abortEmbeddedAgentRun` 调用 handle.abort 并 revokeCompletionClaim；`run/attempt-finalize.ts:411 createEmbeddedAttemptExternalAbortController` 先标记终态，再触发运行和会话取消。 | 借用“先撤销完成/输出资格，再取消”的机制；不声称 OpenClaw 已实现 Kleio 的记忆遗忘语义。Kleio 的 epoch、记忆事务和停止后的确定性回执是产品自有设计。 |
| 实际计量接口 | `D/dsh-token-meter/lib/types/estimate.d.ts` 导出 estimateMessage/estimateToolsTokens；`types.d.ts` 的 TokenMeasurement 区分 estimated/usage baseline。 | 最终 envelope 的消息与工具均须计量；estimate 要保留标签。不把固定比例、token heuristic 或供应商 usage 当绝对无误的 token 事实。 |

Muse 三份技能及 self-awareness 的 `references/question_types.md` 重新逐项核对，仍属于 P：可证明其方法和行为规定，不能据此声称掌握私有 runtime。具体适配与正反例统一在工程方案 §13；本轮没有将 Muse 文件直接安装为开发者 skill 或 Kleio 产品技能。


## 9. G2 请求控制链复核（2026-10-19）

本节是对当前未提交工作区的源码核验（S）和本地执行证据（运行测试），不是只依据 Cursor 的完成报告。基线 HEAD 为 `040f30b3f4976e87f4a26a8d9de2757739083ed3`；基线文件哈希和 pinned runtime 源码哈希保存于 [G2 证据目录](../../reference/kleio-design/evidence/context-loading-G2/)。最终验收状态统一看 [方案 §14](context-loading-plan-2026-10-17.md#14-g2-单项执行规格与进度后续用户明确授权)。

| 真实调用链 / 数据 | 源码已证实的机制与边界 |
| --- | --- |
| `ExecutionContext.requestAdmission?` → `DshEngine.run` → `resolveAdmission` | 可选宿主控制器，不在模型 ExecutionInput 中；存在控制器时要求显式且一致的模型容量。RuntimeHost 尚未默认提供控制器。审查发现缺少实际 execution ID 对照；Cursor 已补启动前守卫，独立错绑探针确认 HTTP=0/ENGINE_ADMISSION_CONFIG。 |
| `createRequestAdmission` → `parseCheck` → `readPolicyEpoch` → `overCapacity` | 产品侧冻结 execution/scope/generation/profile；严格序号与字段；政策版本失效和预算超限生成宿主持有的拒绝回执；任何非空资源回执均拒绝，因为 G6 尚未实现。 |
| `prepareHeadlessLaunch` → 私有 patch → `request-admission.mjs.apply` | 仅受控 profile 安装发送前插件，同时禁用 compaction-basic/tool-result-pruner，保留 token-meter；未配置控制器时保持旧 profile。私有配置不进入模型 prompt/tool schema。 |
| `llm/stream` → `priceRequest` → pinned estimator → 私有 HTTP → `yield* next()` | 计量真实请求里的 system/messages/tools、工具调用和返回值；图片/未知 block 停止。每个请求检查一次，无自动控制重试。网络/坏返回导致下游不执行。 |
| `createProductMcpBridge` 同一 server 的 `/control/request-check` | 复用认证、Origin 限制、body 上限；不列入模型工具。独立审查发现 body 期间取消及断开两个缺口；Cursor 已补 body 后校验及请求边界异常处理，原始探针均通过，见方案 §14。 |
| `classifyEngineSettlement` | typed budget 依赖宿主拒绝、数字 ACP -32603、确认关闭和工具收敛；没有从供应商/模型错误文字授予预算结果。关闭失败优先级遗漏已由 Cursor 修正，独立探针确认派发后关闭未确认优先 unknown；整批 77 项独立测试与四个原始探针均已通过。 |

`packages/harness-dsh/src/index.ts:206 DshAcpClient.close()` 等待 session/close 结果，随后关闭 stdin 并等待子进程 exit，必要时升级终止信号；G2 的 closeConfirmed 不是“发出取消消息”。bridge 的 close 还需单独等待在途工具收敛；两者不能互相替代。

计量复用的精确版本为 DSH `0.2.1-alpha.2`；`@deepseek-ai/dsh-token-meter/lib/types/estimate.js` 的 `estimateMessage` 调用 `estimateContent` / `estimateSystemMessage`，`estimateToolsTokens` 估算工具 schema。当前底层是 **每四字符约一 token 加 framing 的启发式**，不是供应商 tokenizer；本轮只验证计量位置、覆盖对象和准入行为，不能据此保证中文、不同供应商和实际模型窗口永不溢出。实际使用前仍需可信模型容量和产品余量策略。

运行证据区分：真实 pinned DSH 子进程 + 真实 MCP/HTTP + 本地脚本模型可证明链路；纯 settlement 故障矩阵证明分类函数；Host/领域临时数据库测试证明现有产品契约。它们均不替代真实供应商模型行为或 ECS 验证。四个独立复现缺陷说明“原有 34 测试通过”不足以验收；修正后 41 项 G2/适配器测试、36 项既有契约测试、runtime typecheck 以及四个原始探针均通过；前后记录都保留，能力边界见方案 §14.6。

## 10. G3 standing 快照与中立类型补充核查（2026-10-19）

以下 Kleio 事实记录 G3 开工前基线，不代表修改后的当前状态；实际交付及验证见主方案 §15.7。本轮重新读当前工作区 `product-context/standing.ts/files.ts/compile.ts`、`runtime/identity.ts/host.ts/contracts.ts` 及原 standing 测试。G2 的变更已纳入新基线。精确缺口、参考调用链、采用/不采用机制与任务白名单统一维护在[主方案 §15](context-loading-plan-2026-10-17.md#15-g3上下文类型与-standing-快照2026-10-19)，这里不并列维护第二套规范。

- **S**：Host 的延迟 makeInput 已提供执行时机，但 compile 隐式重读，五文件结果可变且无版本；受限 IO 尚无严格 UTF-8 和读取后稳定复核；模板检查后 rename 存在覆盖窗口。源码可达不等于已发生数据损失。
- **S**：Codex `agents_md_manager.rs::refresh` 在 request preparation 中串行验证并发布 `Arc<LoadedAgentsMd>`，provider 刷新与 repository 按环境/信任缓存须区分。`StepContext` 的不可变设置与当前 grant 分离。不能简化成“Codex 每轮重新读取所有 AGENTS 文件”。
- **S**：OpenClaw `attempt → prepareEmbeddedAttemptBootstrap → resolveBootstrapFilesForRun → getOrLoadBootstrapFiles → loadWorkspaceBootstrapFiles` 按边界加载；cache 每次比较内容及源身份，个人配置与共享缓存分开。后续 `buildBootstrapContextForFiles` 可按字符裁剪。它没有提供 Kleio 所需的跨五文件原子事务。
- **P**：Muse 只能确认导出提示词中的常驻文件职责/副本生效提示，私有加载服务未知。没有读取或外传个人 standing 正文。
- **I**：Kleio 采用执行级固定、两遍有界集合复核、深冻结、文件状态诊断与结构化来源；保持 API/默认值，不采用默认截断或引擎依赖。集合复核仅为稳定观测，不宣称外部批量编辑有事务语义。
- **U**：本次未运行参考系统；未验证真实产品模型、UI、ECS。G3 功能是否完成以主方案 §15.7 的后续验证为准。

[参考版本/切片哈希](../../reference/kleio-design/evidence/context-loading-G3/research-manifest.json) · [Kleio 当前源码基线](../../reference/kleio-design/evidence/context-loading-G3/source-baseline.json)。

## 11. G4 工具注册与执行权限核查（2026-10-19）

本节记录 G4 修改前工作区，不替代主方案。具体调用链、选型、接口和验收集中维护在[主方案 §16](context-loading-plan-2026-10-17.md#16-g4工具注册有效集合与调用复核2026-10-19)。[参考版本/文件哈希](../../reference/kleio-design/evidence/context-loading-G4/research-manifest.json)；[功能基线](../../reference/kleio-design/evidence/context-loading-G4/source-baseline.json)。

- **S / Kleio**：Host 独立定义 schema/执行入口清单/名称 dispatch；product-context 又维护 capabilities 和 KNOWN_TOOLS。observed research 仍使用未按 memoryEnabled 过滤的静态清单。引擎 input.tools 被直接作为 membership 依据；MCP bridge 的 list 使用原数组、catalog 共享 schema 引用。父级已用合成 Host/临时 SQLite 与真实 loopback MCP 分别复现 EngineInput 改写越过初始范围、MCP 输入对象后改影响 list/validation；证据在 G4 目录的 before 探针结果。并非线上事故，也不是普通模型文字直接改写宿主对象。
- **S / Codex**：ToolRegistry 保存 spec/exposure/runtime；模型投影从注册项生成。MCP prepare_call 经刷新后的 runtime/catalog 重查 filter、身份、可见性和 client；不是单靠初始工具 schema 授权。payload matches_kind 不能误解成执行任务类别。
- **S / OpenClaw**：policy pipeline 逐层过滤并保留来源；skill dispatch 使用实际工具和政策；MCP list/call 从同一 tool 对象派生。捕获数组的 MCP handler 本身不证明即时撤销。路径为 `src/skills/runtime/tool-dispatch.ts`，不是 agents 子目录。
- **S / Hermes**：ToolEntry 绑定 schema/handler/check，get_definitions 过滤 availability，但 dispatch 不重新检查允许集合/check_fn。TTL/last-good 可服务可用性探测，不能当严格授权撤销机制。
- **I**：Kleio 采用纯元信息目录 + 严格一对一 handler 绑定、私有执行快照、初始范围与当前政策交集；projection 不授权。保留领域原文授权、事件、参数校验、API 和引擎旧形状；不引入其他系统整套框架。
- **U / 范围**：未执行参考项目、未获得 Muse 私有服务端实现。G4 验证将分别注明 Fake Engine/临时 SQLite/真实本地 MCP/pinned DSH 脚本模型；不借此宣称真实产品模型、UI 或 ECS 已验证。


## 12. G5/G6 新一轮调用链核实（2026-10-19）

范围仅通用技能、上下文协调/预算/失效。当前工作区 hash 与修改前副本见 `reference/kleio-design/evidence/context-loading-G5-G6/source-baseline.json`；完整路径/函数/版本/采用判断集中在主方案 §17.2，避免第二份规范漂移。两位只读研究者分别核实 Codex/OpenClaw/Hermes skill loader/catalog/read/去重与 Kleio G2/Host/DSH 实际请求 gate。均未运行参考产品，也未推断 Muse 私有 runtime。

开工前已确认缺口（交付后不再作为当前现状）：Host 默认 admission、非空资源 receipt 支持、整体 ContextBundle 与容量配置、forget/correct 的输出 epoch、API correct 统一入口。S1–S6 分项交付以主方案 §17 及本轮 ledger 为准，研究结论不作已实现证明。

G5/G6最终实现、独立审查和父级验证统一见主方案 §17.11；247项目标测试与真实供应商合成闭环已通过，扩展3个既有失败仍保留。本核查各历史章节描述各自开工时点，不应继续引用其“尚未实现”作为当前结论。


## 13. history/review 修复源码核实（2026-10-19）

本轮新增证据、真实调用链及参考源码见[主方案 §18](context-loading-plan-2026-10-17.md)。真实 one-shot 经 web_search 证据校验后仍走 review；旧 fixture 在 UNSOURCED_RESULT 先失败。review 当前相关记忆已加载，但 history=[] 且 payload 排队前生成。history API 500是测试缺 MemoryRuntime，不得删除生产脱敏。源码事实、探针事实、旧推断修正均在同一主方案列明，不另维护冲突方案。

本轮最终状态以主方案§18.8为准：当前工作区已修复上述基线缺口。追加源码核实 `insertAssistantMessage → API → LocalAgent.hydrate/rebuild` 确认独立交付因仅遍历user被遗漏；适配同版OpenClaw逐消息展示投影机制，H4已独立审查与真实浏览器验证。此处基线事实不再表示当前未实现。


## 14. 原会话后台交付实时更新（2026-10-19）

当前源码调用链、参考仓库版本/函数、采用判断及任务集中维护在[主方案§19](context-loading-plan-2026-10-17.md)。基线为`kr_messages.sequence`可恢复，但仅有execution级终态关闭流；LocalAgent缺空闲会话观察，且并发hydrate与detach后的event写入存在源码可达竞态。OpenClaw服务端session scoped广播/持久恢复和UI ownership/coalesced reload机制为适配依据，未搬入其整套runtime。本轮独立R2探针复现UTF-8中间EOF被误判，已修复并保留证据；最终产品验收另见§19结算，研究记录不作已完成证明。

§19.6已完成本轮验收结算：持久水位流、客户端恢复与页面观察已接通，285项相关回归/33项前端补充/真实HTTP与4个浏览器场景通过。上段缺口仅表示开工基线；最新证据以主方案为准。
