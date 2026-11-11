# Context Ledger

给 DSH / dsh-TUI 的上下文可视化插件：**看清楚上下文被什么吃掉，以及每次压缩压掉了什么。**

在 TUI 里输入 `/ledger`，得到一块全屏面板：

```
Context Ledger — 上下文账本
上次调用用量 7.8k / 1048.6k  (0.7%)  ████░░░░░░░░░░░░░░░░░░░░

构成（文本估算）
system    826    ███░░░░░░░░░░░░░░░░░░░░░
tools     6.7k   ████████████████████████
messages  296    █░░░░░░░░░░░░░░░░░░░░░░░

Top 5 消耗项
# 10 other      826  You are an AI agent powered by DeepSeek …
# 12 message    189  Current runtime context. This snapshot s…
# 11 message      9  你是谁

压缩记录 2 次
#1 20:35:14 · 耗时 5.6s · 压掉 0 条 · 失败：summary is not smaller than the shadowed content (630 >= 272)
#2 20:36:53 · 耗时 6.1s · 压掉 25 条 · 12.8k → 8.1k（省 37%）
按 Esc 关闭
```

## 它解决什么问题

agent 的上下文是有上限的预算。聊久了会触发**压缩**（把前面若干轮换成一个摘要），
但用户通常既不知道预算是怎么被占满的，也不知道每次压缩到底扔掉了什么。

这个插件把三件事摊开：

1. **预算构成**：system prompt、工具定义、消息各占多少；
2. **Top 消耗项**：哪几条消息最占地方，可以直接定位到 `seq`；
3. **压缩时间线**：每次压缩的耗时、压掉多少条、压缩前后总量、失败原因。

## 安装

插件以组合包（bundle）形式安装进一个 profile：

```sh
dsh plugin --profile dsh-tui add /path/to/context-ledger
dsh --profile dsh-tui
```

然后在 TUI 里输入 `/ledger`。

> 命令叫 `/ledger` 而不是 `/context`，因为 dsh-TUI 内置了 `/context`（显示它自己的上下文详情），同名会被遮蔽。

## 开发

```sh
npm install          # 需要能解析 @deepseek-ai/cordis 与 @deepseek-harness-tui/dsh-tui
npm run typecheck    # tsc --noEmit
npm test             # node --test，纯函数与宿主逻辑，不依赖 TUI
npm run build        # 编译到 lib/
node scripts/smoke-tui.ts   # 不启动 TUI，验证场景/命令注册与卸载
```

### 结构

```
src/
├── types.ts     数据模型（LedgerSnapshot 等）
├── model.ts     纯函数：事件 + 计量 → 快照、Top N、压缩行格式化
├── host.ts      宿主插件：读 tokenMeter/sessions，提供 contextLedger 服务
├── tui.tsx      TUI 插件：/ledger 场景（不用 JSX，见下方说明）
└── __tests__/   model / host 的单元测试
```

### 两条实现约束（踩过坑）

1. **TUI 场景不要用 JSX**。TS 编译 JSX 会在文件顶部生成
   `import … from '@deepseek-harness-tui/dsh-tui/jsx-runtime'`，实测这一行会让
   dsh-TUI 启动卡死。这里统一用 `React.createElement`。
2. **调用 `tuiScenes.open()` 必须通过注入上下文**（`sceneCtx.tuiScenes.open`），
   不能用 `ctx.get('tuiScenes').open`——后者拿的是裸服务，会丢失调用者 fiber，
   报 `requires a live Cordis activation context`。

更多踩坑记录见 [docs/engineering-notes.md](./docs/engineering-notes.md)（18 节，每条都有"现象 / 定位 / 根因 / 解决"）。

## 数据口径（重要）

面板上两组数字**口径不同**，不要指望它们相等：

| 数字 | 来源 | 含义 |
|---|---|---|
| 上次调用用量 | provider 上报的 `usage`（input + cache + output） | 实际计费量，含输出 token 与格式开销 |
| 构成三项 | `contextBreakdown` 的文本估算 | 当前上下文里的文本量 |

差额会显式显示为「未归因 X（输出 token + 格式开销）」，而不是假装对得上。

## 已知限制

- **逐条归因只到 `seq` 级别**：`kind` 只有 message / tool-result / tool-call / other，没有更细的分类。
- **压缩前后的总量是"采样"来的**：事件本身不记录这两个数，我们在事件流上按序采样，取最接近压缩开始/结束的那一次。
- **没有点击跳转**：时间线只能看到 `seq`，还不能跳到对话里的对应位置。
- **未做指标实验**：仓库里还没有"10 个任务、A/B 配置对比"的真实数字，`scripts/measure.ts` 仍是空的。
- **只在 `deepseek-official` 路由 + dsh-TUI 上验证过**。

## 指标脚本

```sh
# 1) 分析已有会话（不需要 API key）
node scripts/measure.ts --analyze <sessionId>

# 2) 跑实验（需要 DEEPSEEK_API_KEY，会产生真实调用）
DEEPSEEK_API_KEY=sk-... node scripts/measure.ts --run --profile ledger-demo
```

指标定义（写在脚本头部，口径只有一处）：

| 指标 | 含义 |
|---|---|
| `maxPromptTokens` | 所有调用中最大的一次 prompt 大小（input + cacheRead + cacheWrite） |
| `billedTokens` | 用量合计（含 output），即"花了多少" |
| `compactions` / `failedCompactions` | 成功/失败的压缩次数 |
| `turns` | 轮数 |

跑完会在当前目录写 `metrics.json`，并打印均值/中位数。

### 四组阈值对比实验（2026-11-11）

同一组任务（2 个"读多个源文件"的任务），只改压缩阈值，各跑一遍。
数据：[A](./metrics/2026-11-11-ab-a-default.json) · [B](./metrics/2026-11-11-ab-b-aggressive.json) ·
[C](./metrics/2026-11-11-ab-c-moderate.json) · [D](./metrics/2026-11-11-ab-d-moderate.json)

| 组 | thresholdRatio | 峰值均值 | 压缩次数 | 失败 | 总消耗均值 |
|---|---|---|---|---|---|
| A | 默认 0.8（80%） | 15,391 | 0 | 0 | 34,199 |
| B | 0.008（0.8%） | 11,907 | 8 | 4 | 46,511 |
| C | 0.015（1.5%） | 15,118 | 0 | 0 | 29,059 |
| D | 0.012（1.2%） | 13,971 | 2 | 2 | 49,631 |

**能读出来的三件事**：

1. **只有把阈值降到任务量级（B、D）才会真的触发压缩**；1.5%（C）已经够不到了，
   和 A 没有本质区别——两者的差异只是调用次数不同造成的噪音。
2. **压缩确实压低了峰值**（B 比 A 低 22.6%，D 低 9.2%），
   但**每一组真正触发压缩的配置，总消耗都上升 36%~45%**——因为压缩本身要调一次模型。
3. **失败是结构性的，不是参数没调好**。四次失败的报文都是
   `summary is not smaller than the shadowed content`，
   而且失败都发生在"压缩成功之后的第二次尝试"：
   可压范围只剩 997、115 这样的边角，摘要比它还大，后端直接放弃。

**结论**：在 1M 上下文窗口 + 短任务这个组合下，
"调低压缩阈值"不是一个有效杠杆——要么压不到，要么压了之后反复对边角料重试、把成本推高。
真正有效的方向是**按绝对 token 数触发**（或要求可压范围大于某个下限），
而不是按 1M 窗口的百分比触发。

**局限**（必须先说）：

- 每组只跑 1 次、2 个任务，样本量不足以做统计结论；
- 任务本身只有 1~2 次工具调用，撑不到大上下文；
- 以上是"短任务 + 超大窗口"这一种组合下的观察，不能外推到长会话。

### 第一次单组实验（2026-11-11）

3 个纯问答任务，结果见 [metrics/2026-11-11-single-group.json](./metrics/2026-11-11-single-group.json)：

| 指标 | 均值 | 中位数 |
|---|---|---|
| `maxPromptTokens` | 6039 | 6038 |
| `billedTokens` | 6304 | 6304 |
| 压缩次数 | 0 | — |

**读法**：三个任务的 prompt 分别是 6037 / 6042 / 6038，几乎一模一样——
说明这一档任务里**固定开销（system prompt + 工具定义）占了绝大部分**，任务正文只有几十 token。
也正因为任务太短，一次都没触发压缩（`compactions: 0`），所以这组数据**不适合做 A/B 压缩对比**。

要做压缩策略的 A/B，任务必须**多轮、能撑大上下文**（例如让 agent 读文件、多步改代码）。

实测示例（真实会话 `c30798bd`）：

```json
{ "turns": 3, "calls": 16, "maxPromptTokens": 15717,
  "billedTokens": 199269, "compactions": 2, "failedCompactions": 1 }
```

> 做 A/B 对比时，把 `--profile` 换成两套压缩配置的 profile，各跑一遍，比较 `maxPromptTokens` 的中位数。

## 测试

```
ℹ tests 42   pass 42   fail 0
```

覆盖：事件折叠（含乱序、失败压缩、prune）、快照构建、Top N 排序、标题提取与截断、
时间格式化、压缩行格式化、采样取值、宿主服务的订阅与清理。

## 路线

完整计划见 [ROADMAP.md](./ROADMAP.md)。
