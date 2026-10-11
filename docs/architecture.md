# Kleio 应用架构

Kleio 自建 Personal Agent 应用层，使用发布版 `@deepseek-ai/dsh@0.2.1-alpha.2` 的官方 Web profile。现阶段统一 Node.js 24 / TypeScript / ESM JavaScript；前端采用官方 React 插件体系。没有 Python 产品运行时。

```text
官方 Harness Web UI
  ├─ 原生对话、工具、权限、设置、文件预览
  └─ Kleio 插件：记忆 / 资料 / 任务 / 成果
          │ 同一原生认证与同源边界
原生 Web Host + Kleio HTTP / Tools
  ├─ DSH Agent / Session / LLM / Sandbox / Schedule / Jobs
  └─ 自有文件记忆 / 事实审计 / 历史索引 / 用户资料 / 任务状态 / 成果目录
          │
用户自己的模型 API、工作目录与私人数据
```

## 保留 Harness 的能力

原生模型路由、Agent 循环、会话事件与持久化、工具 schema 与调度、权限确认、取消、沙箱、定时任务、原生文件展示。Kleio 不复制这套执行内核。

## Kleio 负责的能力

- 行为纪律与 SOUL、助理称呼、语言/时区设置。
- 记忆分层、搜索流程、文件编辑、事实审核与版本来源。
- 历史文本索引；只返回能追溯到原生事件的对话。
- 任务目标、状态、重试条件、完成回执与原生成果核验。
- 官方客户端 slots 中的个人助理面板。

代码入口：`scripts/native-web.mjs` → `config/personal-agent.patch.yml` → `packages/personal-agent/plugin.mjs`。独立产品逻辑在 `personal-memory`、`personal-tasks`，原生适配集中在 plugin/adapter。

## 数据与部署

源码目录、私人 DSH_HOME、任务工作区和凭据文件分离。启动时必须已有真实模型路由；没有 Key 就不能把静态页面当成可用助理。

公网入口使用 HTTPS 反向代理；Harness 和控制端口继续仅绑定回环。官方 token 交换成签名 cookie；应用接口复用 Host/Origin 和认证检查，不单独开一个无认证端口。公开仓库里的 nginx / systemd 文件是模板，需要替换域名和本机路径。

从旧名字迁移时可以使用 `KLEIO_STORAGE_SUBDIR` 继续读取原数据目录；只升级旧的默认助理名，保留用户自己的名称。已有 TLS、私人工作区和会话不必随产品名重建。

当前单主机单用户，不宣称多人租户隔离、手机推送、跨设备同步、无限长记忆或与闭源产品能力完全等价。
