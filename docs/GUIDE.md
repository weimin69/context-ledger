# 新手复习手册

> 这份文档不讲"怎么用"，只讲**这个项目是怎么运转的、每个函数为什么存在**。
> 适合隔一段时间回来复习，也适合面试前过一遍。

---

## 一、一句话说清这个项目

> **给 AI 聊天装一个"上下文记账本"：告诉你预算被什么吃掉了、每次压缩扔了哪些、省了多少。**

三个类比，挑一个你顺手的记：

| 类比 | 对应 |
|---|---|
| 体检报告 | 总量 = 体重，构成 = 体脂/肌肉/水分 |
| 快递清单 | 总重 = 包裹重量，构成 = 每件物品；压缩 = 把几件合成一件 |
| 手机存储 | 已用 / 总量；Top 10 = 最占空间的 App；压缩 = 清缓存 |

---

## 二、整体框架：数据怎么流动

```
 ①  DSH 运行时
     ├── tokenMeter（称重机）：告诉我总共多少 token、每条消息多少
     ├── sessions（会话仓库）：全部历史事件
     └── sessionProjections：上下文构成（system / tools / messages）
             │
             ▼
 ②  host.ts（采集层）
     每次会话有新事件 → 称一次重 → 调 buildSnapshot() → 存进 snapshots 柜子
             │
             ▼
 ③  model.ts（计算层，纯函数）
     事件流 + 称重结果 + 构成 → 一页账本 LedgerSnapshot
             │
             ▼
 ④  tui.tsx（展示层）
     /ledger 打开全屏场景，从柜子里取最新账本，画成界面
```

**为什么要分三层？**

- 采集层会跟外部世界打交道（可能失败、可能没有数据）；
- 计算层不允许有副作用，所以**可以脱离 DSH 单独测试**（42 条测试就这么来的）；
- 展示层只管画，不关心数据从哪来。

**分层的实际好处**：改界面不用动数据，改数据不用动界面，测试不用启动整个 TUI。

---

## 三、四个文件的分工

| 文件 | 角色 | 一句话 |
|---|---|---|
| `src/types.ts` | **表格的列名** | 定义"一页账有哪些格子"，不含逻辑 |
| `src/model.ts` | **算账的公式** | 纯函数，输入数据、输出账本，可单测 |
| `src/host.ts` | **采购员** | 向 DSH 要数据、称重、存柜子、发通知 |
| `src/tui.tsx` | **画师** | 把账本画成全屏面板，处理按键 |

---

## 四、`types.ts`：只有"格子"，没有代码

| 类型 | 是什么 | 为什么要它 |
|---|---|---|
| `SegmentKind` | 分段种类：system / tools / messages / … | 限定取值，写错了编译器会报 |
| `ContextSegment` | 一个分段 + 它的 token 数 | 画"构成"那一栏 |
| `ContextItem` | 一条明细：seq、种类、标题、token、是否被压掉 | 画 Top N 列表 |
| `CompactionRecord` | 一次压缩：开始/结束时间、压掉哪些、前后总量、错误 | 画压缩时间线 |
| `LedgerSnapshot` | **一整页账**：上面这些装在一起 | 三层之间传递的唯一数据 |
| `SessionEventLike` | 事件的"最小形状" `{type, seq, time, data}` | 让 model 不依赖 DSH 的包 |
| `MeasurementLike` | 称重结果的子集 `{totalTokens, nodes}` | 同上 |
| `ContextBreakdown` | 固定开销的三项构成 | 画构成栏 |
| `TotalSample` | 一次"称重采样"：第几个事件之后总量多少 | 补压缩前后的总量 |
| `BuildInput` | 算账需要的全部原料 | `buildSnapshot` 的入参 |

> `Like` 后缀的意思是"大约长得像"。这是**结构兼容**：只要你有这几个字段，我就认，不管你具体是什么类。

---

## 五、`model.ts`：每个函数干什么、为什么

### 5.1 内部工具（不对外）

**`sampleAfter(samples, afterSeq)`**
- 干什么：在一串采样里找"第 afterSeq 个事件之后最近的一次称重"。
- 为什么：压缩事件本身不带"前后多少 token"，只能靠宿主不停采样，这里负责取最接近的那次。
- 坑：找不到就退回最后一次采样，不能返回 0（0 会被当成"真的没用量"）。

**`foldCompactions(events, samples)`**
- 干什么：把事件流折叠成"压缩记录列表 + 被压掉的 seq 集合"。
- 为什么：压缩是 start → summary → end 三个事件，必须配对成一条记录。
- 关键点：
  - 先按 `seq` 排序（事件可能乱序到达）；
  - `compaction/summary.shadowedSeqs` 才是"压掉了谁"；
  - `compaction/end.error` 表示失败，失败也要留在时间线里；
  - `compaction/prune` 没有 compactionId，只能挂到"当前打开的那次"。

**`kindOf(type)`**
- 干什么：事件名 → 明细种类（message / tool-result / tool-call / other）。
- 为什么：界面要显示"这条是你说的话还是工具结果"。
- 坑：认不出来一律 `other`，不猜。

**`contentOf(event)`**
- 干什么：从事件里取出"内容数组"。
- 为什么：**真实数据的外壳不统一**——`user/message` 的内容直接挂在 `data`，`assistant/message` 和 `tool/result` 挂在 `data.message`。
- 写法：`data?.message ?? data`（有壳就拆壳，没壳就直接用）。

**`shorten(text)` / `titleOf(event)`**
- 干什么：把消息压成一行、最多 40 字的标题。
- 为什么：面板一行放不下长文，标题必须单行且截断。
- 坑：
  - 换行要压成空格（不然界面会被撑爆）；
  - 超过 40 字截断加 `…`；
  - 找不到文字块就返回空字符串，不编。

### 5.2 对外核心

**`segmentsFrom(breakdown)`**
- 干什么：把"system / tools / messages"三个数变成分段列表。
- 为什么：界面按段画进度条。
- 坑：值为 0 的分段过滤掉（避免"工具 0 token"这种噪音）。

**`buildSnapshot(input)` —— 整个项目的核心**
- 干什么：把「事件流 + 称重 + 构成 + 采样 + 时间」算成一页完整账本。
- 为什么：UI 需要的数据一次性算好，界面层只管画。
- 内部步骤：
  1. 折叠压缩事件 → 压缩记录 + 被压集合；
  2. 建"序号 → 事件"的字典（取标题要用）；
  3. 每条 node 变成一条 `ContextItem`，补上 kind/title/shadowed；
  4. 算 `overheadTokens` = 总量 − 各条之和；
  5. 算 segments。
- 为什么是纯函数：同样的输入必然同样的输出，测试才能钉死行为，回放才能一致。

**`topConsumers(snapshot, n)`**
- 干什么：按 token 降序取前 N 条。
- 为什么：用户只关心"谁最占地方"。
- 坑：**同分按 seq 升序**，否则排序不稳定，测试会偶发失败。

**`compactionTimeline(snapshot)`**
- 干什么：压缩记录按开始时间排序。
- 为什么：时间线要按时间读。

**`sumItemTokens(items)`**
- 干什么：把各条 token 加起来。
- 为什么：用来验证"总量 = 各条之和 + 固定开销"。

### 5.3 格式化（给界面用的纯函数）

**`durationText(ms)`**
- 干什么：毫秒 → 人话。`320 → 320ms`、`1250 → 1.3s`、`61000 → 1m1s`、`3720000 → 1h2m`。
- 为什么：时间线要显示"这次压缩花了多久"。

**`tokenText(n)`**
- 干什么：`12800 → 12.8k`。
- 为什么：窄终端放不下长数字。

**`compactionDelta(record)`（内部）**
- 干什么：拼 `12.8k → 8.1k（省 37%）`。
- 为什么：这是整个项目最有说服力的数字。
- 坑：任一前后值缺失就返回空字符串；`before` 为 0 要防除零。

**`compactionLine(record, index)`**
- 干什么：一条压缩记录 → 一行文字。
- 为什么：时间线的每一行。
- 结构：`#序号 时间 · 耗时 · 压掉 N 条 · 前后总量 · 失败原因`。

---

## 六、`host.ts`：唯一跟外部打交道的文件

**`apply(ctx)`（插件入口）**
- 干什么：DSH 加载插件时调用它。里面做四件事：
  1. `resolveLedger` 注册（让界面能拿到服务）；
  2. 监听 `session/event`；
  3. 启动时把已有会话先算一遍；
  4. `ctx.effect` 注册卸载清理。
- 为什么需要 `inject = ['tokenMeter', 'sessions']`：没这两个服务，插件没法工作，框架会自动等它们就绪。

**`refresh(session)`（内部）**
- 干什么：称重 → 取构成 → 记采样 → 算账本 → 发布。
- 为什么包一层 `try/catch`：**会话可能正在压缩，称重会失败。观测插件绝不能让主流程崩。**
- 关键：每次刷新都往 `samplesBySession` 里塞一条 `{seq, totalTokens}`，只留最近 200 条（滑动窗口）。

**`publish(snapshot)`（内部）**
- 干什么：存进 `snapshots` 柜子，并逐个通知订阅者。
- 为什么每个订阅者单独 `try/catch`：一个界面炸了，不能连累其它订阅者。

**`ContextLedgerService`（对外的两个方法）**
- `snapshot(sessionId)`：查柜子，拿最新账本；
- `subscribe(listener)`：订阅更新，返回退订函数（不退订会内存泄漏）。

---

## 七、`tui.tsx`：把账本画出来

**`bar(ratio, width)`**
- 干什么：画 `████░░░░` 进度条。
- 坑：比例要夹在 0~1，否则会画出负数长度直接崩。

**`itemLine(item, width)`**
- 干什么：一条明细 → 一行文字，超宽截断。
- 为什么手动算宽度：终端不会自动排版。

**`LedgerScene(props)`（场景组件）**
- 干什么：画四块内容——预算条 / 构成 / Top N / 压缩时间线。
- 三个必须知道的点：
  1. **hook 必须用 props 里的 `React`**，不能 import 自己的副本（否则 invalid hook call）；
  2. **不用 JSX**，改用 `React.createElement`（JSX 会生成 jsx-runtime 的 import，实测会让 TUI 启动卡死）；
  3. 数据缺失时要有降级界面（"宿主插件未加载"），不能白屏。
- 刷新机制：订 `channel`（会话变化）和 `ledger`（账重算），任一变化就把计数器加一触发重画。

**`apply(ctx)`（插件入口）**
- 干什么：注册场景 + 注册 `/ledger` 命令。
- 两个坑：
  1. 命令不能叫 `/context`——TUI 内置了同名命令，会被遮蔽；
  2. 调用 `tuiScenes.open()` 必须用 `sceneCtx.tuiScenes`，用 `ctx.get('tuiScenes')` 会报缺少 activation context。

---

## 八、一次请求的完整旅程（把这个记住，面试能用）

```
1. 用户在 TUI 里说了一句话
        ↓
2. DSH 往 session 里 append 一个 user/message 事件
        ↓
3. 触发 'session/event' → host.ts 的 refresh(session)
        ↓
4. 调 tokenMeter.measure(session)  ← 称重
   调 contextPressure(session)      ← 上下文窗口
   调 sessionProjections.snapshot   ← 构成
   记一条采样 {seq, totalTokens}
        ↓
5. buildSnapshot(...)               ← 纯函数算账
        ↓
6. publish(snapshot)                ← 存柜子 + 通知订阅者
        ↓
7. LedgerScene 的订阅回调触发重渲染
        ↓
8. 用户打开 /ledger，看到最新的预算、构成、Top N、时间线
```

---

## 九、五个关键设计决策（为什么这么做）

| 决策 | 原因 | 代价 |
|---|---|---|
| 计算层做成纯函数 | 可单测、可回放、结果稳定 | 拿不到的数据必须由上层传进来 |
| 拿不到就留空，不猜 | 假数据比没数据更糟 | 界面上会出现"（暂无）" |
| 观测插件绝不抛错 | 它坏了不能拖垮 agent | 出错时静默跳过，排查要靠调试日志 |
| 不用 JSX | JSX 的 import 会让 TUI 启动卡死 | 代码更啰嗦 |
| 前后总量靠采样 | 事件里没有这两个数 | 采样时机不精确，可能有偏差 |

---

## 十、怎么跑、怎么验证

```sh
npm test              # 42 条单元测试，不需要 DSH
npm run typecheck     # 类型检查
npm run build         # 编译到 lib/
node scripts/smoke-tui.ts   # 场景/命令注册与卸载
```

真机验证：

```sh
dsh plugin --profile dsh-tui add /Users/alax/dsh-plugin/context-ledger
dsh --profile dsh-tui
# 在 TUI 里输入 /ledger
```

实验：

```sh
node scripts/measure.ts --analyze <sessionId>                 # 分析已有会话
DEEPSEEK_API_KEY=... node scripts/measure.ts --run --profile ledger-demo --out metrics/x.json
```

---

## 十一、新手最常问的几个问题

**Q：为什么命令叫 `/ledger` 不叫 `/context`？**
A：TUI 内置了 `/context`，同名会被遮蔽。

**Q：为什么面板上"已用"和"构成"加起来对不上？**
A：两个数口径不同。"已用"是 provider 上报的计费用量（含输出 token），"构成"是文本估算。差额会显示成"未归因"。

**Q：为什么压缩记录是 0 次？**
A：压缩要等上下文超过阈值。默认阈值是 1M 窗口的 80%，普通对话根本到不了。

**Q：`overheadTokens` 是什么？**
A：不在明细列表里的那部分（主要是工具定义）。注意它**不等于**系统提示词——系统提示词本身就是一条明细。

**Q：改代码后 TUI 没变化？**
A：先 `npm run build`，再重启 `dsh`。插件是 link 安装的，但 Node 已经加载的模块不会热更新。

---

## 十二、下一步可以做什么

- 按绝对 token 数触发压缩（现在的触发是窗口百分比，1M 窗口下不合理）；
- 压缩记录点击跳转；
- 更多任务的指标实验（现在的样本只有 2 个任务、1 次）。
