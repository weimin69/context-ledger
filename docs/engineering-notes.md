# Context Ledger — 工程问题记录（简历素材库）

> 目的：把开发过程中真实踩过的坑，按「现象 → 定位 → 根因 → 解决 → 简历可写的一句话」分块记下来。
> 原则：**只记真发生过的。** 数字全部来自实际运行输出，能复现。

更新时间：2026-11-10
当前进度：数据采集 + 纯函数模型完成（真机验证通过），UI 未开始

---

## 速查表

| # | 问题 | 一句话根因 | 影响 |
|---|---|---|---|
| 1 | `ls .` 报 `Operation not permitted` | macOS 沙箱拒绝，不是文件权限 | 环境 |
| 2 | `node --test` 报 `ERR_INVALID_PACKAGE_CONFIG` | 空的 `package.json` 不是合法 JSON | 环境 |
| 3 | 总数 5988，逐项只有 927 | `totalTokens` 含不在 surface 节点的固定成本 | **数据模型** |
| 4 | system prompt 到底算不算"开销" | 假设错误，被真机数据推翻 | **数据模型** |
| 5 | 90% 的条目标题取不到 | 事件 `data` 外壳不统一 | **解析** |
| 6 | 压缩前后 token 拿不到 | 事件里没这个字段 | 数据模型 |
| 7 | `compaction/prune` 无法配对 | 事件缺 `compactionId` | 解析 |
| 8 | 事件可能乱序到达 | 不能假设 append 顺序 | 健壮性 |
| 9 | 一次称重失败拖垮整轮对话 | 插件没有隔离异常 | **健壮性** |
| 10 | 热重载后监听叠加 | 自建容器没清理 | 资源泄漏 |

---

## 1. `ls` / `touch` 报 `Operation not permitted` 之谜

**现象**

在 `~/dsh-plugin/context-ledger` 里执行 `eza`、`ls`、`touch`，全部失败：

```
Permission denied: . - code: 13
ls: .: Operation not permitted
```

但目录权限是 `drwxr-xr-x alax staff`，属主就是当前用户，没有 ACL、没有 `uchg` flag。

**定位**

1. 先排除文件系统：`ls -ldeO` 看 ACL 和 flag，干净；
2. 再排除身份：`id` 确认是 `alax:staff`，与目录属主一致；
3. 关键线索：同一时刻我在 DSH 的终端工具里执行 `mkdir ~/.dsh/profiles/xxx`，报的是**一模一样的错**：

```
Error: EPERM: operation not permitted, mkdir '/Users/alax/.dsh/profiles/ledger-demo'
```

**根因**

不是权限，是 **macOS Seatbelt 沙箱**。DSH 的终端工具默认只在工作区（`/Users/alax/dsh-plugin`）内可写，越界操作被内核直接拒绝，返回 `EPERM` 而不是 `EACCES`。

**怎么区分这两类错误**（值得记住的排障信号）：

| 错误码 | 含义 | 典型场景 |
|---|---|---|
| `EACCES` / `Permission denied` | 权限位不允许 | 文件属主、组、`chmod` |
| `EPERM` / `Operation not permitted` | 系统策略不允许 | 沙箱、SIP、内核扩展、受保护目录 |

**解决**

- 用户侧：换一个不受沙箱限制的终端；
- 工具侧：对需要的操作显式申请更高权限（本项目里安装插件时就走了一次审批）。

**简历可写**

> 通过 `EPERM` 与 `EACCES` 的差异定位到 macOS Seatbelt 沙箱限制，而非文件权限问题。

**教训**：报错信息里的错误码比文案可靠。`Operation not permitted` 和 `Permission denied` 在中文里几乎同义，在系统调用层面是两回事。

---

## 2. 空的 `package.json` 让测试直接崩

**现象**

骨架建好后执行 `node --test src/__tests__/model.test.ts`：

```
Error: Invalid package config /Users/alax/dsh-plugin/context-ledger/package.json
code: 'ERR_INVALID_PACKAGE_CONFIG'
```

**根因**

"搭骨架"时用 `touch` 创建了 0 字节的 `package.json`。Node 会把它当模块配置读，空文件不是合法 JSON。

**解决**

补上最小可用配置（`type: module`、`test` 脚本、`exports`、`dsh.bundle`）。

**简历可写**（这条太琐碎，不建议写，仅作开发日记）

**教训**：占位文件和"空但合法"是两回事。`touch` 出来的 `package.json` / `tsconfig.json` 会让工具链在很靠前的位置就失败，报错信息还指向别处。

---

## 3. 真机数据：总和 5988，逐项只有 927（最重要的一条）

**现象**

单元测试里"总数 = 各条之和"是通过的，真机一跑就露馅：

```json
{ "usedTokens": 5988, "nodes": [727, 11, 189] }
```

`727 + 11 + 189 = 927`，**差了 5061**。

**定位**

1. 确认不是称重错误：`measure()` 的 `totalTokens` 与 `surfaceTokens` 是两套口径；
2. 读源码发现 `totalTokens = baseline + surfaceDeltaTokens`，而 `baseline` 里含有 `estimateToolsTokens(header)`——**工具定义的开销，根本不进 nodes**；
3. 用 `contextBreakdown` 投影交叉验证：`toolsTokens = 5061`，与差值完全一致。

**根因**

`nodes` 描述的是"当前 surface 上的消息节点"，而一次请求还要带上 system prompt、工具 schema 等**不在 surface 里的固定成本**。两者本来就不是一个集合。

**解决**

1. `LedgerSnapshot` 增加 `overheadTokens = totalTokens − Σ(nodes)`；
2. 把这个关系写成测试（用真实数字 5988 / 927 / 5061）；
3. 修正原测试里那条错误的断言——原来的"总数等于逐项之和"只在没有固定开销时成立。

**简历可写**

> 真机验证发现计量口径差异（总量 5988 vs 节点合计 927），推导出"固定开销 = 总量 − 节点和"的关系并补入数据模型，避免了面板数字与列表对不上。

**教训**（这条最值钱）：**单元测试通过 ≠ 数据模型正确**。假数据是我自己造的，它天然符合我的假设；只有真机能证伪。

---

## 4. 假设被推翻：system prompt 其实是"节点"，不是"开销"

**现象**

第 3 条之后，我把 `overheadTokens` 注释成"system prompt + 工具定义"。真机拆解后发现不对：

```
system   = 727
tools    = 5061
messages = 200
合计     = 5988
```

而 seq 7 那条节点的标题就是 `"You are an AI agent powered by DeepSeek …"`，token 正好 727。

**根因**

system prompt 在 DSH 里**是一条普通的 surface 节点**，已经算进 `items` 了。所以"不在 items 里的"只剩工具定义那 5061。`overheadTokens` 恰好等于 `toolsTokens`，纯属当前会话的巧合，不是定义。

**解决**

1. 改注释，明确 `overheadTokens` 是"不进 surface 节点的固定成本"，不是"系统提示词"；
2. UI 的正确数据源是 `segments`（system / tools / messages 三段），不是 `overheadTokens`；
3. 把"为什么不是 overhead"写进注释，防止三个月后自己再踩一次。

**简历可写**

> 用真实会话数据推翻了"系统提示词属于固定开销"的初始假设，改为按 `contextBreakdown` 三分类建模（system / tools / messages）。

**教训**：一个数**恰好**等于另一个数，不代表它们是同一个东西。必须去看它是怎么算出来的。

---

## 5. 事件 `data` 外壳不统一，标题会大面积取不到

**现象**

写标题提取前先查类型清单，发现不同事件的内容位置不一样：按直觉写 `event.data.content`
会让 assistant / tool 的标题全部为空。**（注意：这一条是在写代码前从类型定义 + 真实调用点
推断出来的，不是真机跑出来才发现的；真机只用来确认修完之后确实有标题。）**

**根因**

真实事件的外壳不一致：

| 事件类型 | 内容位置 |
|---|---|
| `user/message` | `data` 本身就是消息 → `data.content` |
| `assistant/message` | `data.message.content` |
| `tool/result` | `data.message.content` |

**解决**

```ts
const message = data?.message ?? data
const content = message?.content
```

一行兼容两种外壳，并且对 `content` 不是数组的情况返回空数组，不抛错。

**简历可写**

> 兼容 DSH 会话事件不一致的 payload 结构（消息体直挂 vs 嵌套在 `message` 字段），统一为可提取的标题模型。

**教训**：类型文档写的是"这个字段叫什么"，**不保证所有事件长得一样**。这类不一致只有跑一遍全量真实数据才会暴露。

---

## 6. 压缩前后的 token 拿不到（已知缺口，主动留空）

**现象**

`CompactionRecord` 设计了 `beforeTokens` / `afterTokens`，但三个压缩事件里都没有这两个字段。

**根因**

`compaction/start` 只带 `compactionId / turn`，`compaction/summary` 带 `shadowedSeqs / shadowedTokenCount`，`compaction/end` 只带 `error`。**没有任何事件记录压缩瞬间的总量。**

**解决（当前）**

两个字段留 `undefined`，不编造。测试里明确断言"拿不到就留空"。

**解决（计划）**

在 `refresh` 里维护"上一次称重结果"，收到 `compaction/start` 时快照一次总量作为 `beforeTokens`，收到 `compaction/end` 时再快照一次作为 `afterTokens`。

**简历可写**

> 识别到压缩事务缺少前后计量事件，采用"在事务边界快照计量结果"的方案补齐时间线数据，而非伪造字段。

---

## 7. `compaction/prune` 没有 `compactionId`，无法配对

**现象**

`compaction/prune`（轻量清理）只带 `shadowedSeqs`，没有归属的压缩编号。

**根因**

它复用了"影子定价协议"，设计上依附于**紧邻的前一个**计量事件，本身不携带事务身份。

**解决**

维护一个 `open` 指针：`compaction/start` 时指向当前记录，`compaction/end` 时清空；`prune` 事件直接挂到 `open` 上。找不到 `open` 就只登记被清理的 seq，不强行归属。

**简历可写**

> 处理了 `compaction/prune` 缺少事务标识的边界情况，用"当前打开事务"指针完成归因，并保留无归属时的降级路径。

---

## 8. 事件乱序到达

**现象**

真实环境里事件可能乱序（网络、回放、合并都可能改变顺序）。直接顺序折叠会把"结束"当成没有"开始"的记录。

**解决**

进入折叠循环前先 `sort((a, b) => a.seq - b.seq)`，复制一份数组再排（不改调用方数据）。测试里专门喂 `[end, start, summary]` 的顺序，断言结果依然是完整的一条记录。

**简历可写**

> 折叠逻辑对输入顺序不敏感：先按 seq 稳定排序再构建，配合纯函数保证同一输入多次回放结果一致。

---

## 9. 一次称重失败会拖垮整轮对话

**现象**（设计阶段就预判到）

`measure()` 在会话处于中间状态（例如压缩进行中）时可能抛异常。如果异常穿透插件的监听器，会一路冒到 agent 循环，**用户看到的是一次失败的对话**。

**解决**

1. `refresh()` 整体包 `try / catch`，失败就跳过这次刷新，等下一个事件；
2. `publish()` 在通知每个订阅者时单独 `try / catch`，一个订阅者炸了不影响其它订阅者；
3. 调试输出只有在 `CONTEXT_LEDGER_DEBUG` 存在时才打印，避免污染正常日志。

**简历可写**

> 为观测类插件设计失败隔离：单个会话/订阅者的异常不会传播到 agent 循环，保证插件对主链路零影响。

**教训**：**观测工具绝不能有让主流程失败的能力。** 空 `catch` 在别处是坏味道，在这里是刻意的设计决策——注释里必须写清理由。

---

## 10. 热重载后监听叠加

**现象**（设计阶段）

插件卸载后，`Map` / `Set` 里还留着旧数据，反复热重载会让内存只涨不降。

**解决**

- `ctx.on('session/event', ...)` 注册的监听由 Cordis 随 fiber 自动释放；
- 自建的 `snapshots` / `listeners` 通过 `ctx.effect(() => () => { ... })` 清理：外层是注册，返回的函数是卸载钩子。

**简历可写**

> 按 Cordis 的生命周期约定管理插件资源，卸载时释放自建容器，避免热重载导致的监听与内存泄漏。

---

## 11. 本地开发时类型解析不到 `@deepseek-ai/cordis`

**现象**

`tsc` 报 `Cannot find module '@deepseek-ai/cordis'`，随后连带出现一串 `implicitly has an 'any' type`。

**根因**

插件通过 `peerDependencies` 声明 cordis，运行时由宿主提供；但本地目录没有 `node_modules`，类型检查找不到它。

**解决（开发期临时）**

在插件目录建符号链接指向宿主 checkout 里的 vendored 包：

```
node_modules/@deepseek-ai/cordis → <harness>/vendor/cordis
node_modules/@types             → <harness>/node_modules/@types
```

同时补上 `"types": ["node"]`。

**注意**：这是**本机临时手段**，不应提交；正式做法是走 `dsh plugin add` 让 profile 提供 peer，或写进 `devDependencies`。

**简历可写**：不建议写，属于环境适配。

---

## 12. 测试不能启动真 DSH，于是造了个假宿主

**问题**

`host.ts` 依赖 `tokenMeter` / `sessions`，测试里没有真环境，也不想为了跑单测启动整个 harness。

**解决**

1. 把所有 DSH 依赖收窄成一个本地接口 `SessionLike { id; snapshotEvents() }`，只声明用到的成员；
2. 只 `import type` 外部包，编译后这些 import 全部消失，运行时零依赖；
3. 测试里造一个假 `ctx`，记录 `provide` / `on` / `effect` 被调用的情况，用 `emit(session)` 模拟事件。

**简历可写**

> 通过"结构兼容的窄接口 + 只导入类型"让插件宿主层可脱离框架单测，测试无需启动完整运行时。

**教训**：能靠结构兼容（structural typing）就别依赖具体类。这一招让 28 条测试跑完只要 70ms。

---

## 13. `ContextItem.kind` 没有 `system` 这一类

**现象**

system prompt 那条节点在明细里只能标成 `other`。

**决策**

**故意不加**。因为：
- 系统开销已经通过 `segments` 单独展示；
- 明细列表是"消息级归因"，混进 system 会让 Top 10 失真；
- 加一个只有一两项会命中的类别，收益低于成本。

**简历可写**（面试聊设计取舍时用）

> 在明细粒度与分段粒度之间划清边界：system 仅作为分段统计，不进消息级 Top N，避免排行榜被固定开销污染。

---

## 14. TUI 启动卡死：JSX 生成的 jsx-runtime import

**现象**

装好插件启动 TUI，只打出 `model listing ... loaded 2 model(s)` 一行，界面再也不出现（进入不了全屏）。
整屏只有一个光标，用户只能 Ctrl-C 退出。

**定位（对照实验）**

| 实验 | 结果 |
|---|---|
| 不带插件启动 | 正常进全屏 |
| 只装宿主插件 | 正常 |
| 装上 TUI 插件（真实构建） | 卡死 |
| `lib/tui.js` 换成空文件 | 正常 |
| 只保留 `import … from '@deepseek-harness-tui/dsh-tui/jsx-runtime'` | 卡死 |
| 改成 `import 'react/jsx-runtime'` | 正常 |
| 改成用绝对路径 import 同一个 shim 文件 | 正常 |

**根因**

卡顿由"插件用**包名 + 子路径**去 import 宿主的 jsx-runtime"触发；同一文件用绝对路径 import 又正常。
说明问题出在宿主模块解析/加载链上（`export * from 'react/jsx-runtime'` 的 shim 在启动早期被拉起），
不是我们插件逻辑的问题。JSX 编译时 TS 会自动加上这行 import，所以**用了 JSX 就会中招**。

**解决**

整个 `tui.tsx` 不用 JSX，统一用 `React.createElement`（官方文档明确允许）。
编译产物里因此**没有任何 import**，启动恢复正常。

**简历可写**

> 通过 6 组控制变量实验定位到"插件在启动期导入宿主 JSX 运行时导致 TUI 死锁"，改用 `React.createElement`
> 消除该导入路径，修复启动卡死。

**教训**：症状（卡死）和原因（一行 import）差得很远；只有做"每次只改一个变量"的对照实验才收敛得了。

---

## 15. `/context` 命令名与 TUI 内置命令撞车

**现象**

命令注册成功了，但用户输入 `/context` 看到的是 TUI 自带的"上下文详情"（系统提示词 · 15 段），
不是我们的账本面板。

**根因**

`dsh-tui/src/commands.ts:82` 已内置 `{ name: 'context' }`。同名注册被内置命令遮蔽。

**解决**

命令改名为 `/ledger`；用 `/` 打开命令面板可见且只有我们这一项（`共1项`）。

**简历可写**

> 命令命名冲突排查：识别宿主内置 `/context` 的占用并改用独立命名空间，避免插件能力被遮蔽。

---

## 16. `tuiScenes.open` 报 "requires a live Cordis activation context"

**现象**

`/ledger` 执行后转录里出现：

```
dsh-tui: tuiScenes.open requires a live Cordis activation context
```

**根因**

`tuiScenes` 的方法会校验"调用者属于哪个插件 fiber"。用 `ctx.get('tuiScenes')` 取到的是**裸服务**，
绕过了带激活信息的代理，于是校验失败。文档里那句"服务方法看不到调用者的 fiber"就是这个意思。

**解决**

在 `ctx.inject(['tuiScenes'], sceneCtx => …)` 的回调里注册命令，并在 handler 中始终用
`sceneCtx.tuiScenes.open(id)` 调用（而不是 `ctx.get('tuiScenes').open`）。

**简历可写**

> 按宿主的能力授权模型修正服务调用方式：改为通过注入上下文调用 `tuiScenes.open`，
> 解决 Cordis activation context 校验失败问题。

---

## 17. 新会话打开面板显示 0 / 0

**现象**

场景能打开，但显示 `已用 0 / 0 (0.0%)`、`Top 0 消耗项`。

**根因**

新建会话还没有任何消息事件，`measure()` 自然是 0；`contextPressure` 的窗口值也要等第一次请求头写入。

**解决**

不是 bug。发一条消息后再打开 `/ledger` 即有数据（上一轮真机已验证 5988 / 727 / 5061 / 200）。
后续可考虑在界面上加一句"本会话还没有数据"，减少误解。

**简历可写**（不必写）

---

## 18. 面板上「已用」和「构成」加起来对不上（3.6k 差额）

**现象**

压缩过的会话里：`已用 12.8k`，但构成三项只有 `system 826 + tools 6.7k + messages 1.6k ≈ 9.2k`，差 3.6k。

**定位**

把会话日志解压（zstd 多帧，`zstd -dc`）后直接读原始事件：

- 每次 `assistant/message` 都带 provider 上报的 `usage`，例如 `seq 87: input 179 + cacheRead 12032 + output 153 = 12364`；
- `compaction/summary` 记录了 `shadowedSeqs: 25 条`、`shadowedTokenCount: 3867`。

两相比较：`usedTokens` 来自**上一次模型调用上报的用量**（含 output token 与 provider 侧格式开销），
而 `segments` 来自 `contextBreakdown` 的**文本估算**。两者计量口径不同，本来就不会相等；
只有在"还没发生过调用、基线是估算值"的会话里，两者才恰好一致（实测 `7808 = 826 + 6686 + 296`，gap 为 0）。

**解决**

不改数据来源，改表达：

- 标题从「已用」改为「上次调用用量」；
- 分段标题加注「（文本估算）」；
- 当存在差额时多显示一行「未归因 X（输出 token + 格式开销）」，差额为 0 时不显示。

**简历可写**

> 定位到面板两处数字口径不一致（计费用量 vs 文本估算），用"显式标注未归因差额"的方式表达差异，
> 避免把统计口径差异误判为计算错误。

**教训**：两个数字对不上时，先问"它们是不是在量同一件事"。这次不是 bug，是**术语没写清楚**。

---

## 数字速查（简历里能用的真实数字）

| 指标 | 数值 | 来源 |
|---|---|---|
| 单元测试条数 | 28 | `npm test` |
| 测试耗时 | ~70ms | 同上 |
| 真机会话上下文窗口 | 1,048,576 | `contextPressure()` |
| 典型一轮使用量 | 5,988 | `measure().totalTokens` |
| 其中固定开销 | 5,061（工具定义） | `contextBreakdown.toolsTokens` |
| 系统提示词 | 727 | 同上 |
| 消息合计 | 200 | 11 + 189 |
| 类型检查错误 | 0 | `tsc --noEmit` |

---

## 不要写进简历的（诚实清单）

1. **"支持压缩时间线"** —— 数据结构有了，`beforeTokens` / `afterTokens` 还没填，UI 没有。现在只能说"压缩事件已正确折叠"。
2. **"Top 10 可视化"** —— 排序函数有测试，但面板一行都没写。
3. **"性能优化"** —— 每来一个事件就全量 `measure()` + 重建 Map，几百条以内够用，但没做过压测，别说优化过。
4. **"多模型适配"** —— 只在 `deepseek-official` 这条路由上真跑过。
5. **任何"降低了 X% 上下文"的数字** —— 第 4 周的对照实验还没做。

---

## 附：可复现的验证命令

```sh
# 1. 单元测试（不需要 DSH）
cd ~/dsh-plugin/context-ledger && npm test

# 2. 类型检查
<harness>/node_modules/.bin/tsc -p tsconfig.json

# 3. 真机数据（临时 profile，需已安装本插件）
CONTEXT_LEDGER_DEBUG=1 dsh --profile ledger-demo "只回复两个字：收到"

# 4. 查看插件是否被正确插入
dsh --profile ledger-demo --dump-config | grep -A2 context-ledger
```
