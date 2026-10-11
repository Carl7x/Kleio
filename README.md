# Kleio

一个基于 **DeepSeek Harness** 的开源个人助理。先把内核和个人助理体验做好，后续通过插件扩展场景。

使用官方 Harness Web 界面与插件体系，默认模型 `deepseek-flash`。助理可以改名；中文记忆保存在自己的主机上，不依赖第三方 MCP Memory 服务。

## 现在能做什么

- 原生对话、工具执行、权限确认、取消和会话恢复。
- 个人资料与助理称呼；可编辑的 `SOUL.md`。
- 精选记忆、人物/群体索引、每日变更记录、主题正文；会话开局注入小摘要。
- 每轮按当前话题调用 `memory_search`，检索文件及历史用户/助理对话；`memory_get` 按路径读取。当前是全文检索，**没有向量语义检索**。
- 显式保存、更正、可撤销移除、来源与版本；自动提炼仅生成待确认候选。
- 原生后台任务、定时任务和可检查的成果文件。

## 本机启动

Node.js **24.21.0**，pnpm **11.25.0**。

```sh
pnpm install --frozen-lockfile
pnpm setup:native
pnpm build
cp .env.example .env
# 编辑 .env，填入自己的模型 API Key
pnpm dev
```

Windows 可复制 `.env.example` 为 `.env`，配置后打开 `启动 Kleio.cmd`。模型 Key 只保存在环境变量或被 Git 忽略的 `.env` 中。启动器生成的认证入口也属于私密信息，不要分享或提交。

默认仅本机监听。云端使用 HTTPS 反向代理与原生认证；部署模板见 `config/deployment`。通过 SSH 配置自己的 `kleio-cloud` 后，可以使用 `启动云端 Kleio.cmd`，公网部署则使用 `启动公网 Kleio.cmd`。保持主机在线才能执行后台任务。

## 记忆与界面

默认数据目录是 `.data/dsh-native/kleio/`；与源代码隔离。

```text
memory/
  SOUL.md                 助理人格
  MEMORY.md               精选常驻资料，目标少于100行
  YYYY-MM-DD.md           追加的变更记录
  people/INDEX.md          人物索引
  groups/INDEX.md          群体索引
  topics/                 按需读取的主题页
  topics/facts/<id>.md     已审核事实的可读当前版本
memory.sqlite             已审核事实的版本/恢复日志
application.sqlite        资料、候选、任务与可重建对话索引
```

在官方界面的“资料”里改助理名字，在“记忆 → 文件”里编辑精选笔记和 SOUL。事实页由正式记忆工具同步，修改这类事实请用“已记住 → 更正”，避免文件与版本记录产生两个真相。私人文件不进入仓库。

架构、参考项目的具体取舍与已知边界见 [记忆设计](docs/memory-architecture.md) 和 [产品架构](docs/architecture.md)。

## 验证

```sh
pnpm test
pnpm typecheck
pnpm verify:plugin
pnpm verify:application
```

这些检查覆盖持久化、纠错、跨话题召回、历史来源、原生工具调度、鉴权和后台任务；使用隔离资料和脚本模型，不需要 API Key。真实模型验证使用 `pnpm verify:memory-provider`，需要自己的凭据。已用 `deepseek-flash` 完成 8 轮隔离验证，涵盖独立话题、跨会话历史、保存和纠错；保存与纠错检查了数据库回执。[验证记录](docs/validation-memory-provider.json)列明范围与限制。有限样本不代表每轮都能遵守检索纪律，也不等同于语义检索。

## 阶段

当前是 **M1/M2**：文件分层、开局注入、每轮检索。已有候选审核和版本审计，但尚未实现完整的 M3 会话结束 `distill` / claim supersede 模型，也没有 M4 向量检索、定期 `reconcile` 与后台准备—审核—通知链。当前版本不宣称达到 Muse/Grok Bot 的全部功能。

`apps/*`、`packages/core` 和 ACP 适配器保留早期原型，入口均带 `legacy:`，不进入正式 `pnpm dev` 路径。正式运行只使用原生 Web Host 和 `personal-*` 应用插件。

Apache-2.0。上游 Harness 与其他依赖保留各自许可。
