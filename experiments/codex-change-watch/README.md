# 周期跟进变化判定器 · Codex 独立探索

为 L0 C「无变化安静，失败或无法判断必须说明」提供可检查的比较结果。
比较同一公开来源、同一关注区域的两次完整文本观察；保留变化前后原文。
这是独立原型，尚未接入 Kleio，也没有通知发送或后台监测功能。

## 立即运行

无需安装依赖。在仓库根目录运行：

```sh
node --test experiments/codex-change-watch/watch.test.mjs
node experiments/codex-change-watch/cli.mjs
node experiments/codex-change-watch/build-demo.mjs
```

直接用浏览器打开同目录 `demo.html`。页面内有八个虚构场景，也可改文本比较，
用「沿用本次记录，再检查一次」体验变化之后不重复提醒。无需启动服务器。

CLI 也接受一个 JSON 文件：`node experiments/codex-change-watch/cli.mjs input.json`。
输入结构为 `{ "watch": ..., "state": null, "observation": ... }`；结果只写标准输出，
不会抓取网址或修改数据库。`scenarios.mjs` 有完整输入样例。

## 与另一队的边界

2026-10-15 重新检查了主目录和 `i01-memory`、`i02-research`、`merge/i01-i02`。
主目录仍为 `e985a0e` 加已有未提交改动；合并候选为 `fb00ecc`。
可见任务记录只包含 I01/I02；没有据此假定 I03 或 I04 空闲。
当前主目录和合并候选均主要通过模型 review 的 `notify/silent` 判断是否变化，
未发现独立的观察差异模块。

本探索只新增 `experiments/codex-change-watch/`。不修改 `host.ts`、任务运行时、
Kleio API、客户端页面、锁文件或根 workspace；不接管 I03 调度或 I04 UI。
未来即使两者另有负责人，也可独立评估是否采用这个无依赖模块。
双方未就该接入作出约定；没有联系其他机器人。

## 模块契约

```js
import { evaluateObservation } from './watch.mjs';
const output = evaluateObservation(watch, savedState, observation);
```

- `watch`：`id`、递增的 `revision`、`active`、`sourceUrl`、稳定的 `region`，
  以及显式的 `ignoreRelativeMetadata`。来源、区域或比较策略改变时必须递增版本。
- `observation`：唯一且不可复用的 `id`、`watchId`、`revision`、同一版本内递增的
  `sequence`、带时区的 `capturedAt`、同一 `sourceUrl/region`、读取 `status`、
  `complete` 和提取的 `text`。状态只能表达实际读取结果，不能由文本猜成成功。
- `emptyConfirmed: true` 仅在提取器确认区域确实为空时使用，否则空读取为不确定。
- `nextState`：可序列化的观察游标和最后完整基线；失败不会替换完整基线。
- `decision`：`baseline / unchanged / changed / attention / ignored`。
- `diff`：新增、移除、带 before/after 的修改，以及明确忽略的时间元信息。
- `evidence`：来源、区域、前后观察 ID／序号／时间／原文。
- `shouldNotify`：首次观察、变化和不确定建议说明；无变化和被忽略结果安静。
  这是原型策略，不代表已发出通知。首次观察是否在正式产品中显示可由接入方调整。
- `eventKey`：用于调用方交付 outbox 的幂等提示，不是送达回执或 exactly-once 保证。

本模块拒绝静默截断，超过 120,000 字符、2,000 行或单行 2,000 字符会返回不确定。
保留重复行的数量；空白和行顺序不参与变化判断。

## 推荐接入点（本次未接入）

```text
I03 触发器 → 公开来源读取器 → 完整性/区域提取校验
                                  ↓
                       evaluateObservation
                                  ↓
                    当前条件和状态的事务检查
                       ↙                 ↘
           unchanged：保存检查记录     changed / attention：复核与原会话交付
```

调用方负责 source/region 提取；搜索结果排名或限量搜索响应不应冒充某页面的完整内容。
本模块不为页面存在性、来源真实性或 HTML 提取质量作保证。

持久化时，必须在同一事务中：

1. 重新核对事项仍 active、revision 未变，以及之前观察的 sequence。
2. 用 CAS 写入 `nextState`，并按 `eventKey` 建立交付意图；不得只保存基线后再尝试通知。
3. 事务成功后由现有 review/交付机制写入来源会话；投递失败重试既有意图，不能重跑来源检查来冒充送达。

两个进程同时用旧状态计算仍可能产生相同结果，因此调用方的 CAS 与 outbox 是必要接缝。
修改条件、暂停和停止后的在途检查，还需在提交时复核，不能只依赖计算前的检查。
对无变化的判断仅在“读取完整且所选区域内容一致”的范围成立；不能描述为整个网站没有变化。

## 参考采用与差异

`page-diff.mjs` 从上游提交 `1ac68f3909f2` 的
`apps/server/src/engine/page-diff.ts` 适配行配对算法，保留 MIT 许可于 `LICENSE.upstream`。
与上游的差异：

- 比较数据不裁剪，超界返回不确定，避免行尾改动被吃掉。
- 数字变化分组为修改，同时保留 before/after；数字从不被视作无变化。
- 相对时间过滤默认关闭；开启后仅匹配独立、带“更新时间”等标签的元信息行。
  不隐藏正文内的开课时间、截止日期或价格；增加中文元信息识别。
- 保留重复行多重性，避免两个相同条目变成一个时漏报。
- 新增事项版本、暂停、观察序号、失败／部分结果、完整基线和纯函数接口。

行为依据：`reference/对齐审计-2026-10-14/产品方向.md`、T01 场景 C，
及 Muse `docs/chat/scheduling-and-watching.md` 的“无变化安静、失败说明、交付单独核对”。
没有移植 Muse 服务、上游调度器或引入新模型循环。

## 剩余限制

- 文本差异不是语义重要性判断。改写、广告变化仍可能触发变化，需要选定稳定区域并交给复核。
- 不适合排序本身有含义的榜单或结构化表格；行序不参与比较。
- `ignoreRelativeMetadata` 是显式策略，若更新时间本身是关注对象就应关闭。
- 不处理网页抓取、登录、cron、持久化、分布式并发或真实送达；未接入产品接口。
- 观察 ID／序号须由可信调用方产生。同一 ID 对应的输入必须不可变；不存储全部历史回执。
- 默认首次完整观察建议说明；持续失败的聚合和节流属于上层交付策略。
- 演示只用虚构公开来源 `example.org`，未使用个人数据、模型凭证或外部服务。

运行和隔离检查的实际结果见 `VALIDATION.md`。
