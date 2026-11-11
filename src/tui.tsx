/**
 * TUI 插件：把账本画成一个全屏场景，用 `/ledger` 打开。
 *
 * 三件事（对应 TUI 接缝文档"三步接入"）：
 *   1. 注册一个场景（`tuiScenes.register`），id 叫 context-ledger；
 *   2. 注册一个命令 `/ledger`，负责把场景打开；
 *   3. 写场景组件：只读数据、自绘界面、Esc 关闭。
 *
 * 两条硬规矩：
 *   - 场景里所有 hook 必须用 **props 注入的 React**，不能 import 自己的副本；
 *   - **不要用 JSX**（<Box>…</Box>）。JSX 会在文件顶部生成
 *     `import … from '@deepseek-harness-tui/dsh-tui/jsx-runtime'`，
 *     实测这一行会让 TUI 启动卡死（插件被加载的时机太早）。
 *     所以这里统一用 `React.createElement` 手写元素——官方文档明确允许。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'

import type { ContextLedgerService } from './host.ts'
import { compactionLine, tokenText as tokens } from './model.ts'
import type { ContextItem, LedgerSnapshot } from './types.ts'
import { X509Certificate } from 'node:crypto'
import { error } from 'node:console'

/** 插件名，Cordis 用它标识这个插件。 */
export const name = 'context-ledger-tui'

/**
 * 等 commands 服务就绪再 apply。
 *
 * 之前用 ctx.get 探测"安静降级"，结果 apply 跑在 commands 挂载之前，
 * 拿到 undefined 就直接 return，命令根本没注册——用户按 / 看不到 ledger。
 */
export const inject = ['commands']

/** 宿主注入的 React 类型，用来给组件标返回类型。 */
type HostReact = TuiSceneProps['React']
type Element = ReturnType<HostReact['createElement']>

/**
 * 怎么拿到账本服务。
 *
 * 场景组件只拿得到 TuiSceneProps（React/ui/channel/close），拿不到 ctx，
 * 所以 apply 时把"取服务的方法"存到这个模块变量里，组件渲染时再调用。
 * 每次渲染现取，服务晚到也能跟上。
 */
let resolveLedger: () => ContextLedgerService | undefined = () => undefined

/** 场景 id，注册和打开都要用这个字符串，别写错两次。 */
const SCENE_ID = 'context-ledger'

/** 进度条用的两个字符：已用、未用。 */
const BAR_FULL = '█'
const BAR_EMPTY = '░'

/** 把 0~1 的比例画成一条指定宽度的条。 */
function bar(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(clamped * width)
  return BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(width - filled)
}

/** 一行明细：序号、种类、字数、标题。 */
function itemLine(item: ContextItem, width: number): string {
  const head = `#${String(item.seq).padStart(3)} ${item.kind.padEnd(10)} ${tokens(item.tokens).padStart(6)}`
  const room = Math.max(0, width - head.length - 2)
  const title = item.title === '' ? '(无标题)' : item.title
  const text = title.length > room ? `${title.slice(0, Math.max(0, room - 1))}…` : title
  return `${head}  ${text}${item.shadowed ? ' ×' : ''}`
}

/**
 * 场景组件本体。
 *
 * 数据来源：`ctx.contextLedger.snapshot(sessionId)`——宿主插件算好的那页账。
 * 刷新方式：订阅 channel（会话变了）和账本服务（账重算了），任一变化就重画。
 */
function LedgerScene(props: TuiSceneProps): Element {
  const { React, ui, channel, close } = props
  const { Box, Text, useInput, useTerminalSize } = ui
  const { columns } = useTerminalSize()

  // h 就是"造元素"的函数：h(组件, 属性, 子元素…)。
  // 用它代替 JSX，避免顶部那行 jsx-runtime import。
  const h = React.createElement

  // 用一个计数器当"刷新开关"：数据不是响应式的，靠手动加一来触发重渲染。
  const [, force] = React.useReducer((n: number) => n + 1, 0)

  React.useEffect(() => {
    const stopChannel = channel.subscribe(() => force())
    const ledger = resolveLedger()
    const stopLedger = ledger?.subscribe(() => force())
    return () => {
      stopChannel()
      stopLedger?.()
    }
  }, [channel])

  // Esc 或 q 关闭；场景期间独占键盘，关闭约定要自己实现。
  useInput((input: string, key: { escape?: boolean }) => {
    if (key.escape === true || input === 'q') close()
  })

  const ledger = resolveLedger()
  const snapshot: LedgerSnapshot | undefined = ledger?.snapshot(channel.sessionId)

  // 没数据时的降级界面：宁可说"没加载"，也不能白屏或报错。
  if (snapshot === undefined) {
    return h(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      h(Text, { bold: true, key: 'title' }, 'Context Ledger'),
      h(Text, { key: 'hint' }, '宿主插件未加载，或该会话还没算过账。'),
      h(Text, { dimColor: true, key: 'esc' }, '按 Esc 关闭'),
    )
  }

  const ratio = snapshot.contextWindow > 0 ? snapshot.usedTokens / snapshot.contextWindow : 0

  // 窄终端要节约空间：宽度不够时把进度条缩短，再窄就整个不画。
  // 80 列给 24 格，100 列以上给 40 格，60 列以下只留数字。
  const barWidth = columns >= 100 ? 40 : columns >= 80 ? 24 : columns >= 60 ? 12 : 0
  const showBar = barWidth > 0 ? `  ${bar(ratio, barWidth)}` : ''
  const showSegmentBar = (part: number): string =>
    barWidth > 0 ? `  ${bar(part, barWidth)}` : ''

  const segmentRows = snapshot.segments.length === 0
    ? [h(Text, { dimColor: true, key: 'none' }, '（暂无分段数据）')]
    : snapshot.segments.map(segment => h(
      Text,
      { key: segment.kind },
      `${segment.kind.padEnd(9)} ${tokens(segment.tokens).padStart(6)}${
        showSegmentBar(snapshot.usedTokens > 0 ? segment.tokens / snapshot.usedTokens : 0)}`,
    ))

  // 两个数字口径不同：
  //   usedTokens  = 上一次模型调用上报的用量（含输出 token 和格式开销）
  //   segments 之和 = 对当前上下文文本的估算
  // 差值不是 bug，界面上要显式说出来，否则看起来像算错了。
  const breakdownSum = snapshot.segments.reduce((sum, segment) => sum + segment.tokens, 0)
  const unattributed = Math.max(0, snapshot.usedTokens - breakdownSum)

  const topItems = snapshot.items
    .slice()
    .sort((a, b) => (b.tokens - a.tokens) || (a.seq - b.seq))
    .slice(0, 10)

  const itemRows = topItems.length === 0
    ? [h(Text, { dimColor: true, key: 'none' }, '（还没有消息）')]
    : topItems.map(item => h(Text, { key: item.seq }, itemLine(item, columns - 2)))

  return h(
    Box,
    { flexDirection: 'column', width: '100%', height: '100%', paddingX: 1 },
    h(Text, { bold: true, key: 'title' }, 'Context Ledger — 上下文账本'),
    h(
      Text,
      { key: 'budget' },
      `上次调用用量 ${tokens(snapshot.usedTokens)} / ${tokens(snapshot.contextWindow)}  `
      + `(${(ratio * 100).toFixed(1)}%)${showBar}`,
    ),
    h(
      Box,
      { marginTop: 1, flexDirection: 'column', key: 'segments' },
      h(Text, { bold: true, key: 'head' }, '构成（文本估算）'),
      ...segmentRows,
      snapshot.segments.length > 0 && unattributed > 0
        ? h(Text, { dimColor: true, key: 'unattributed' },
          `未归因 ${tokens(unattributed)}（输出 token + 格式开销）`)
        : null,
    ),
    h(
      Box,
      { marginTop: 1, flexDirection: 'column', key: 'items' },
      h(Text, { bold: true, key: 'head' }, `Top ${topItems.length} 消耗项`),
      ...itemRows,
    ),
    h(
      Box,
      { marginTop: 1, flexDirection: 'column', key: 'compactions' },
      h(Text, { bold: true, key: 'head' }, `压缩记录 ${snapshot.compactions.length} 次`),
      ...snapshot.compactions.map((record, index) =>
        h(Text, { key: record.id }, compactionLine(record, index))),
      h(Text, { dimColor: true, key: 'esc' }, '按 Esc 关闭'),
    ),
  )
}




/**
 * 插件入口。
 * @param ctx - TUI 侧上下文。
 */
export function apply(ctx: Context): void {
  resolveLedger = () => ctx.get('contextLedger')

  // 场景服务和命令都在这里注册。
  // 关键：handler 里必须通过 `sceneCtx.tuiScenes` 调用，而不是 `ctx.get('tuiScenes')`。
  // 因为 tuiScenes 的方法要检查"调用者的 fiber"，而 ctx.get 拿到的是裸服务，
  // 绕过了代理，就会报 "requires a live Cordis activation context"。
  ctx.inject(['tuiScenes'], (sceneCtx) => {
    const scenes = sceneCtx.tuiScenes
    if (scenes === undefined) return

    const disposeScene = scenes.register({
      id: SCENE_ID,
      title: 'Context Ledger',
      component: LedgerScene as (props: TuiSceneProps) => Element,
    })
    ctx.effect(() => () => disposeScene())

    const commands = ctx.get('commands')
    if (commands === undefined) return

    ctx.effect(() => commands.register({
      name: 'ledger',
      description: '打开上下文账本：预算、Top 10、压缩记录',
      handler: () => {
        const opened = sceneCtx.tuiScenes?.open(SCENE_ID) === true
        return opened
          ? { kind: 'success' as const }
          : { kind: 'error' as const, text: 'context-ledger 场景未注册' }
      },
    }))
  })
}

/** 给编辑器补上这个插件用到的 TUI 服务类型（运行时不存在）。 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    commands?: {
      register(descriptor: {
        name: string
        description: string
        handler: () => { kind: 'success' } | { kind: 'error'; text: string }
      }): () => void
    }
    tuiScenes?: {
      register(descriptor: {
        id: string
        title?: string
        component: (props: TuiSceneProps) => Element
      }): () => void
      open(id: string): boolean
    }
  }
}
