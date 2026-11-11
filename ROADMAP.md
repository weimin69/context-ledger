# Context Ledger — 项目执行路线

> 目标读者：新手。每一步都写清楚“做什么、在哪做、做完怎么验收”。
> 原则：**先跑通一条最小链路，再加深。** 不要同时写宿主、UI、测试、评测。

---

## 0. 一句话说清这个项目

给 DSH / dsh-TUI 做一个插件：

> **实时显示上下文预算、Top 10 消耗项、每次压缩的前后变化，并能从压缩记录跳回对话位置。**

面试时可以这样讲：

> “agent 的上下文是有限预算。我做了一个工具，把预算的构成和压缩的历史可视化，帮助定位‘为什么这轮突然超上下文’。”

---

## 1. 最终你会做出什么

一个可以演示的完整闭环：

```text
TUI 里输入 /context
  ↓
打开一个全屏场景（或右侧面板）
  ↓
顶部：上下文预算条（已用 / 总量）
中部：Top 10 消耗项（消息 / 工具结果 / system / tools）
下部：压缩时间线（每次压缩前后 token、被压掉的消息数、摘要入口）
  ↓
点一条压缩记录 → 跳到转录里对应位置
```

配套交付物：

- GitHub 仓库（或至少一个干净的项目目录）
- README：问题、设计、截图/GIF、指标、限制
- 测试：单元 + 渲染 + 回放
- 一组真实数字：例如“10 个任务上平均上下文降低 X%”

---

## 2. 动手前先读什么（只读这 6 个地方）

不要读整个仓库。按顺序读：

1. `~/.dsh-tui` 是什么、profile 是什么：你之前已经会装 `hello-tui-plugin`，复用那套。
2. dsh-TUI 插件接缝文档：`dsh-tui/tui-profile/docs/plugin-admission-and-development.md`
   - 接缝八：全屏场景 `tuiScenes`
   - 接缝十一：状态行 `tuiStatus`
   - 侧栏 Panel（实验性，§18 / `tuiPanels`）
3. 一个现成的场景例子：`dsh-tui/src/screens/TrajectoryScene.tsx`
4. 一个现成的服务例子：`dsh-tui/src/dsh-adapter/status.ts`（看 `setField` 怎么校验、怎么存、怎么清理）
5. DSH 的 token 计量：`my-harness-form-DSH/packages/compaction/compaction-basic/src/index.ts` 的 `compactPressure`
6. 压缩事务：`my-harness-form-DSH/packages/compaction/compaction-basic/src/region.ts` 的 `selectCompactableRange` 和 `compactSurfaceRegion`

读的时候只回答三个问题：

- 数据从哪个服务拿？
- 注册的东西谁负责清理？
- 失败时会不会拖垮 TUI？

---

## 3. 目标目录结构

先按这个建，后面可以改：

```text
context-ledger/
├── package.json
├── tsconfig.json
├── cordis.patch.yml
├── src/
│   ├── host.ts          # 宿主插件：读 tokenMeter / sessions，提供 contextLedger 服务
│   ├── tui.tsx          # TUI 插件：注册场景/面板
│   ├── model.ts         # 纯函数：把事件折成 LedgerSnapshot
│   ├── types.ts         # 共享类型
│   └── __tests__/
│       ├── model.test.ts
│       ├── host.test.ts
│       └── render.test.tsx
├── fixtures/
│   ├── short-session.jsonl
│   └── compacted-session.jsonl
├── scripts/
│   ├── measure.ts       # 跑 10 个任务，记录 token
│   └── replay-check.ts  # 回放 fixture，校验快照
└── README.md
```

`package.json` 的关键点：

```json
{
  "name": "context-ledger",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    "./host": { "types": "./lib/host.d.ts", "default": "./lib/host.js" },
    "./tui":  { "types": "./lib/tui.d.ts",  "default": "./lib/tui.js" }
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" }
}
```

`cordis.patch.yml` 插两行，宿主和 TUI 分开：

```yaml
- insert:
    - id: context-ledger-host
      name: 'context-ledger/host'
    - id: context-ledger-tui
      name: 'context-ledger/tui'
```

为什么分开：宿主侧依赖 `tokenMeter` / `sessions`，TUI 侧依赖 `tuiScenes` / `tuiPanels`。分开后，Web 或 headless 组合不会因为缺少 TUI 服务而卡住。

---

## 4. 分阶段路线（按周）

### 第 0 周：调研 + 最小 spike（2–3 天）

**目标**：确认数据拿得到，不要先写 UI。

任务：

- [ ] 用 `/context` 或临时命令打印 `channel.contextSegments`、`channel.contextBreakdown`、`channel.lastUsage`，看 TUI 已经暴露了什么。
- [ ] 写一个临时宿主插件，注入 `tokenMeter` 和 `sessions`，在 `session/event` 时调用 `tokenMeter.measure(session)`，把 `totalTokens` 和 `nodes` 打到日志。
- [ ] 确认 `measure` 返回的 `nodes` 是否带 `seq` / `tokens`；如果没有，退一步只做分段统计。
- [ ] 记录一次真实会话的 `compaction/start`、`compaction/end` 事件长什么样。

产出：一页笔记，写清“能拿到什么、拿不到什么”。

验收：日志里能看到“当前会话 totalTokens + 每个节点的 tokens”。

卡住时：先只做分段统计（system / prompt / assistant / tools），不要死磕逐消息归因。

---

### 第 1 周：宿主服务 + 纯函数模型

**目标**：有一个稳定的 `contextLedger` 服务，UI 还没开始。

任务：

- [ ] 定义数据结构（见第 5 节）。
- [ ] 写 `model.ts` 的纯函数：
  - `buildSnapshot(events, measurement)`：事件 + 计量 → 快照；
  - `topConsumers(snapshot, n)`：排序；
  - `compactionTimeline(snapshot)`：压缩记录。
- [ ] 写 `host.ts`：
  - `export const inject = ['tokenMeter', 'sessions']`
  - 注册服务 `ctx.provide('contextLedger', ...)` 或用类式 `Service`；
  - 订阅 `session/event`，增量更新；
  - 提供 `snapshot(sessionId)` 和 `subscribe(listener)`。
- [ ] 清理：`ctx.effect(() => () => unsubscribe())`。

验收：

- 单元测试里构造 20 条假事件，`buildSnapshot` 的 total 和 `topConsumers` 顺序正确；
- 插件卸载后不再监听事件（测试里断言 listener 被移除）。

不要做：不要在这里写 React。

---

### 第 2 周：TUI 面板 / 场景

**目标**：能在 TUI 里看到 Top 10。

任务：

- [ ] 先做**只读面板**（`tuiPanels`）或一个最小场景（`tuiScenes`）。
- [ ] 组件 props 用注入的 `React` / `ui`，不要自己 import React。
- [ ] 布局：
  - 预算条：已用 / 总量；
  - 列表：`#seq 类型 标题 tokens`；
  - 底部：提示“按 Esc 关闭”。
- [ ] 注册 `/context` 命令打开场景（或面板的 open）。
- [ ] 处理服务缺失：`ctx.get('contextLedger', false)` 为 `undefined` 时显示“宿主插件未加载”，不要崩。
- [ ] 终端宽度：80 列和 120 列都能看；`useTerminalSize()` 自适应。

验收：

- TUI 里 `/context` 能打开、Esc 能关；
- 宽窄终端都不溢出；
- 卸载插件后不留面板/场景。

---

### 第 3 周：压缩时间线 + 跳转

**目标**：把“压缩”这件事讲清楚。

任务：

- [ ] 从事件里收集 `compaction/start` / `compaction/end`；
- [ ] 显示：开始时间、前后 token、shadowed 条数、摘要入口；
- [ ] 点击一条记录 → 跳到转录对应位置（如果 TUI 没有公开跳转接缝，就先复制 seq / 显示摘要，不要硬改内部状态）；
- [ ] 失败压缩也要显示（`compaction/end` 带 `error`）。

验收：

- 回放一个带压缩的 fixture，时间线条数和日志一致；
- 压缩失败的 fixture 显示错误而不是消失。

---

### 第 4 周：动作 + 指标 + 文档

**目标**：从“能看”变成“能证明有用”。

任务（选一个动作即可）：

- [ ] “如果压掉这条，能省多少 token”的模拟；
- [ ] 或“按指定保留比例压缩一次”，记录前后；
- [ ] 写 `scripts/measure.ts`：跑 10 个固定任务，记录每轮 `usedTokens`；
- [ ] 对比默认压缩 vs 调整后的压缩，输出 JSON + 均值/中位数；
- [ ] README 写：问题、设计图、GIF、指标、限制；
- [ ] 录一个 30–60 秒 GIF。

验收：

- 指标能复现（同一命令、同一 fixture/模型）；
- README 里的数字和 JSON 对得上；
- 面试时能在 2 分钟内讲完“为什么做、怎么做、结果如何”。

---

## 5. 数据结构（先定这个，再写代码）

```ts
export type SegmentKind = 'system' | 'prompt' | 'assistant' | 'thinking' | 'tools'

export interface ContextSegment {
  kind: SegmentKind
  tokens: number
}

export interface ContextItem {
  seq: number
  kind: 'message' | 'tool-result' | 'tool-call' | 'other'
  title: string          // 截断后的可读标题
  tokens: number
  shadowed: boolean      // 是否已被压缩替换
}

export interface CompactionRecord {
  id: string
  startedAt: number
  endedAt?: number
  beforeTokens?: number
  afterTokens?: number
  shadowedSeqs: number[]
  summarySeq?: number
  error?: string
}

export interface LedgerSnapshot {
  sessionId: string
  contextWindow: number
  usedTokens: number
  segments: ContextSegment[]
  items: ContextItem[]
  compactions: CompactionRecord[]
  updatedAt: number
}
```

先写这个，再写“怎么填”。填不出来的字段先留空，不要造数据。

---

## 6. 测试与验证（重点）

测试分四层，从便宜到贵：

### 6.1 单元测试（必须）

测 `model.ts`：

- 空事件 → 空快照，不崩；
- 10 条消息 → total 等于各节点之和；
- Top 10 排序稳定（token 相同按 seq）；
- 压缩事件 → `shadowed` 标记正确；
- 失败压缩 → 记录 `error`。

工具：Vitest 或 Node 的 `node:test` 都行。命令示例：

```sh
pnpm vitest run src/__tests__/model.test.ts
```

### 6.2 宿主服务测试（必须）

用假 `ctx`：

```ts
const ctx = {
  tokenMeter: { measure: () => ({ totalTokens: 100, nodes: [...] }) },
  sessions: { ... },
  effect: (fn) => { const d = fn(); return d },
  provide: () => {},
  on: () => () => {},
}
```

断言：

- `snapshot()` 返回正确；
- 卸载后 listener 数量归零。

### 6.3 TUI 渲染测试（必须）

两种做法，选你熟悉的：

- 用仓库现有 `scripts/verify-*.tsx` 的“partial channel 字面量”方式，渲染 `StatusLine` / 场景，断言输出文本；
- 或用 `react-test-renderer` / `ink-testing-library` 渲染组件，断言包含 `Top 10`、`tokens` 等字样。

关键：**不要断言颜色**，只断言文本和结构；主题会变。

### 6.4 回放测试（强烈建议）

准备两个 fixture：

- `short-session.jsonl`：无压缩；
- `compacted-session.jsonl`：有一次压缩。

测试流程：

1. 读 fixture → 构造 session 事件流；
2. 跑 `buildSnapshot`；
3. 断言 `usedTokens`、`compactions.length`、`shadowed` 数量；
4. 再跑一次，结果必须一致（纯函数、无时钟依赖）。

### 6.5 指标实验（简历数字来源）

写 `scripts/measure.ts`：

```ts
// 伪代码
for (const task of TASKS) {
  const result = await runHeadless(task)     // 用 DSH SDK 或 headless
  log({
    task: task.id,
    turns: result.turns,
    usedTokens: result.usedTokens,
    compactions: result.compactions,
  })
}
writeFileSync('metrics.json', JSON.stringify(rows, null, 2))
```

跑两遍：

- A：默认压缩配置；
- B：你调整后的保留比例/阈值。

报告：

```text
mean usedTokens: A=..., B=...（降低 X%）
median: ...
compaction 次数: ...
```

注意：LLM 有随机性，每个任务至少跑 3 次，报告均值/中位数，不要只挑一次最好看的。

### 6.6 CI（可选但加分）

GitHub Actions 跑：

```sh
pnpm install
pnpm typecheck
pnpm test          # 单元 + 渲染 + 回放
```

真实模型实验不要进 CI，单独手动跑。

---

## 7. 验收标准（Definition of Done）

- [ ] `/context` 在 TUI 里能打开、关闭；
- [ ] Top 10 的数字与 `tokenMeter.measure` 总量误差 ≤ 1%；
- [ ] 压缩时间线与 session log 的 `compaction/start`、`compaction/end` 一一对应；
- [ ] 80 / 120 列终端都不崩；
- [ ] 服务缺失时有降级文案；
- [ ] 单元 + 渲染 + 回放测试全绿；
- [ ] README 有 GIF、指标、限制；
- [ ] 至少一组真实任务的前后对比。

---

## 8. 简历写法（数字要真）

```text
Context Ledger — DSH/TUI 上下文可视化插件（个人项目）
· 基于 tokenMeter 与 session 事件实现逐节点 token 归因，定位 Top 10 上下文消耗项
· 还原 compaction 事务（start/end、shadow 范围、前后 token），支持回放与点击定位
· 在 10 个编码任务上把平均上下文占用从 A 降到 B（X%），并记录压缩次数
· TypeScript / Cordis 插件 / React + Ink / 单元 + 渲染 + 回放测试
```

不要写：

- “负责 UI 设计”（除非你真的是设计师）；
- “精通 agent 架构”（面试官会追问）；
- 没有测过的数字。

---

## 9. 常见坑

1. **先写 UI**：没有数据模型，UI 会反复推翻。先 `model.ts`。
2. **把日志当真相**：压缩后 `surface` 变了，但 log 不删。你的“当前上下文”要读 surface / measurement，不是数日志条数。
3. **React 副本**：场景里必须用注入的 `React`，JSX 走宿主的 `jsx-runtime`。
4. **服务缺失就崩**：所有 `ctx.get` 都要有 `undefined` 分支。
5. **不清理**：`ctx.effect` 里返回清理函数；否则热更新会叠监听。
6. **只测 happy path**：空会话、压缩失败、超宽文本、窄终端都要测。
7. **数字造假**：面试官会问“怎么测的”，答不上来比没数字更糟。

---

## 10. 参考位置

- TUI 插件接缝：`dsh-tui/tui-profile/docs/plugin-admission-and-development.md`
- 场景示例：`dsh-tui/src/screens/TrajectoryScene.tsx`
- 服务示例：`dsh-tui/src/dsh-adapter/status.ts`
- 压缩实现：`my-harness-form-DSH/packages/compaction/compaction-basic/src/index.ts`
- 压缩事务：`my-harness-form-DSH/packages/compaction/compaction-basic/src/region.ts`
- token 计量：`my-harness-form-DSH/packages/compaction/compaction-basic/src/index.ts` 的 `compactPressure`
- 你自己的第一个插件：`hello-tui-plugin`（照它的 `package.json` / `cordis.patch.yml` / `apply` 起步）
