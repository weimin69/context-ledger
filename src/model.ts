/**
 * 纯函数层：事件 + 计量 → LedgerSnapshot。
 *
 * 三条纪律（对应 ROADMAP 第 9 节）：
 * 1. 不读时钟、不读全局状态——时间从参数进来，同样输入必然同样输出；
 * 2. 拿不到的字段留空（''、[]、undefined），不要造数据；
 * 3. 输入可以是空的（新会话、还没 measure 过），不能崩。
 */

import type {
  BuildInput,
  CompactionRecord,
  ContextBreakdown,
  ContextItem,
  ContextSegment,
  LedgerSnapshot,
  SessionEventLike,
  TotalSample,
} from './types.ts'

/** `compaction/start` 的 payload（只取要用的字段）。 */
interface CompactionStartData {
  compactionId: string
  turn: number | null
}

/** `compaction/summary` 的 payload（只取要用的字段）。 */
interface CompactionSummaryData {
  compactionId: string
  shadowedSeqs: readonly number[]
  shadowedTokenCount: number
}

/** `compaction/end` 的 payload（只取要用的字段）。 */
interface CompactionEndData {
  compactionId: string
  error?: string
}

/** `compaction/prune` 的 payload（只取要用的字段）。 */
interface CompactionPruneData {
  shadowedSeqs: readonly number[]
}

/**
 * 把一条 session 事件流折成压缩记录 + 已影子集合。
 *
 * 关键事实（来自 @deepseek-ai/dsh-compaction 的事件定义）：
 * - `compaction/start` 拿锁，`compaction/end` 放锁，两者靠 compactionId 配对；
 * - 真正的“压掉了哪些消息”写在 `compaction/summary.shadowedSeqs`；
 * - 压缩失败时 `compaction/end` 带 `error`，这一条也必须留在时间线里；
 * - `beforeTokens` / `afterTokens` 事件里没有，先留空。
 */
/**
 * 在采样序列里找"最近的、发生在 afterSeq 之后的那一次称重"。
 * 找不到就退回最后一次采样（比如压缩还没结束）。
 */
function sampleAfter(samples: readonly TotalSample[], afterSeq: number): number | undefined {
  for (const sample of samples) {
    if (sample.seq >= afterSeq) return sample.totalTokens
  }
  return samples.at(-1)?.totalTokens
}

function foldCompactions(
  events: BuildInput['events'],
  samples: readonly TotalSample[],
): {
  compactions: CompactionRecord[]
  shadowed: Set<number>
} {
  const compactions: CompactionRecord[] = []
  const byId = new Map<string, CompactionRecord>()
  const shadowed = new Set<number>()
  let open: CompactionRecord | undefined

  const ordered = [...events].sort((a, b) => a.seq - b.seq) //排序

  for (const event of ordered) {
    switch (event.type) {
      case 'compaction/start': {
        const data = event.data as CompactionStartData
        const record: CompactionRecord = {
          id: data.compactionId,
          startedAt: event.time,
          shadowedSeqs: [],
          beforeTokens: sampleAfter(samples, event.seq),
        }
        compactions.push(record)
        byId.set(record.id, record)
        open = record
        break
      }

      case 'compaction/summary': {
        const data = event.data as CompactionSummaryData
        for (const seq of data.shadowedSeqs) shadowed.add(seq)
        const record = byId.get(data.compactionId)
        if (record !== undefined) {
          record.shadowedSeqs = [...data.shadowedSeqs]
        }
        break
      }

      case 'compaction/prune': {
        const data = event.data as CompactionPruneData
        for (const seq of data.shadowedSeqs) shadowed.add(seq)
        if (open !== undefined) {
          open.shadowedSeqs = [...open.shadowedSeqs, ...data.shadowedSeqs]
        }
        break
      }

      case 'compaction/end': {
        const data = event.data as CompactionEndData
        const record = byId.get(data.compactionId)
        if (record !== undefined) {
          record.endedAt = event.time
          record.afterTokens = sampleAfter(samples, event.seq)
          if (data.error !== undefined) record.error = data.error
        }
        if (open?.id === data.compactionId) open = undefined
        break
      }

      default:
        // 非压缩事件在这里不关心；逐条归因由 measurement.nodes 负责。
        break
    }
  }

  return { compactions, shadowed }
}

/** 一个事件对应哪一类明细。认不出来就归到 other，不猜。 */
function kindOf(type: string): ContextItem['kind'] {
  switch (type) {
    case 'user/message':
    case 'assistant/message':
      return 'message'
    case 'tool/result':
      return 'tool-result'
    case 'tool/call':
      return 'tool-call'
    default:
      return 'other'
  }
}

/**
 * 取出事件里的内容数组。
 * 真实数据里外壳不统一：user/message 的 data 就是消息本身，
 * 而 assistant/message、tool/result 把消息放在 data.message 里。
 */
function contentOf(event: SessionEventLike): readonly unknown[] {
  const data = event.data as { message?: { content?: unknown }; content?: unknown } | null
  const message = data?.message ?? data
  const content = message?.content
  return Array.isArray(content) ? content : []
}

/** 标题最长多少个字，超过就截断。 */
const TITLE_LIMIT = 40

/** 压成单行短标题。 */
function shorten(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length <= TITLE_LIMIT ? single : `${single.slice(0, TITLE_LIMIT)}…`
}

/** 从一条消息里找出可读文本，做成标题；找不到就返回空字符串。 */
function titleOf(event: SessionEventLike): string {
  for (const block of contentOf(event)) {
    const item = block as { type?: unknown; text?: unknown; name?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') {
      return shorten(item.text)
    }
    if (item.type === 'tool-call' && typeof item.name === 'string') {
      return shorten(`调用 ${item.name}`)
    }
  }
  return ''
}

/**
 * 把 tokenMeter 的 contextBreakdown 变成分段列表。
 * 拿不到就返回空数组——宁可空着，也不猜。
 */
export function segmentsFrom(breakdown: ContextBreakdown | undefined): ContextSegment[] {
  if (breakdown === undefined) return []
  const all: ContextSegment[] = [
    { kind: 'system', tokens: breakdown.systemTokens },
    { kind: 'tools', tokens: breakdown.toolsTokens },
    { kind: 'messages', tokens: breakdown.messageTokens },
  ]
  return all.filter(segment => segment.tokens > 0)
}

/**
 * 用一次计量结果 + 事件流，构建完整快照。
 *
 * `items` 来自 measurement.nodes——那是"当前真正进入请求的 surface 节点"，
 * 顺序即 head→tail。每条的 kind / title 从同 seq 的事件里取。
 */
export function buildSnapshot(input: BuildInput): LedgerSnapshot {
  const { sessionId, contextWindow, measurement, events, breakdown, samples = [], now } = input
  const { compactions, shadowed } = foldCompactions(events, samples)

  // 序号 → 事件，用来给每条 node 补上它是什么、说了什么。
  const bySeq = new Map<number, SessionEventLike>()
  for (const event of events) bySeq.set(event.seq, event)

  const items: ContextItem[] = measurement.nodes.map(node => {
    const event = bySeq.get(node.seq)
    return {
      seq: node.seq,
      kind: event === undefined ? 'other' : kindOf(event.type),
      title: event === undefined ? '' : titleOf(event),
      tokens: node.tokens,
      shadowed: shadowed.has(node.seq),
    }
  })

  const overheadTokens = Math.max(0,measurement.totalTokens - sumItemTokens(items))

  return {
    sessionId,
    contextWindow,
    usedTokens: measurement.totalTokens,
    overheadTokens,
    segments: segmentsFrom(breakdown),
    items,
    compactions,
    updatedAt: now,
  }
}

/**
 * 按 token 降序取前 n 项；token 相同时按 seq 升序，保证顺序稳定可断言。
 */
export function topConsumers(snapshot: LedgerSnapshot, n = 10): ContextItem[] {
  return [...snapshot.items]
    .sort((a, b) => (b.tokens - a.tokens) || (a.seq - b.seq))
    .slice(0, Math.max(0, n))
}

/** 压缩时间线：按开始时间升序，一次压缩一条。 */
export function compactionTimeline(snapshot: LedgerSnapshot): CompactionRecord[] {
  return [...snapshot.compactions].sort((a, b) => a.startedAt - b.startedAt)
}

/** 快照里的 token 总量是否与逐项之和一致（给测试和调试用）。 */
export function sumItemTokens(items: readonly ContextItem[]): number {
  return items.reduce((total, item) => total + item.tokens, 0)
}

const MAX_ms_for_m = 1000
const MAX_ms_for_h = 3600

/** 导出时间 */
export function durationText(ms: number): string {

  if (ms <= 0) {
    return `0ms`;
  }
  if (ms < MAX_ms_for_m) {
    return `${ms}ms`;
  }

  if (ms < 60 * MAX_ms_for_m) {
    const second = Number((ms / MAX_ms_for_m).toFixed(1));
    return `${second}s`;
  }

  const totalSeconds = Math.floor(ms / MAX_ms_for_m);
  const h = Math.floor(totalSeconds / MAX_ms_for_h);
  const m = Math.floor((totalSeconds % MAX_ms_for_h) / 60);
  const s = totalSeconds % 60;


  if (ms < 60 * 60 * 1000) {
    return `${m}m${s}s`;
  }

  return `${h}h${m}m`;
}

/** 把 token 数变成「1.2k」这种短形式，窄终端放得下。 */
export function tokenText(value: number): string {
  if (value < 1000) return String(value)
  return `${(value / 1000).toFixed(1)}k`
}

/** 压缩前后总量的那一段文字；缺任意一边就不显示。 */
function compactionDelta(record: CompactionRecord): string {
  const before = record.beforeTokens
  const after = record.afterTokens
  if (before === undefined || after === undefined) return ''
  const saved = before > 0 ? Math.round((1 - after / before) * 100) : 0
  const tail = saved > 0 ? `（省 ${saved}%）` : saved < 0 ? `（增 ${Math.abs(saved)}%）` : ''
  return ` · ${tokenText(before)} → ${tokenText(after)}${tail}`
}

export function compactionLine(record: CompactionRecord, index: number): string {
  const startTime = new Date(record.startedAt).toLocaleTimeString()

  if (record.endedAt === undefined) {
    return `#${index + 1} ${startTime} · 进行中 · 压掉 ${record.shadowedSeqs.length} 条`
  }

  const time = durationText(record.endedAt - record.startedAt)
  const failure = record.error === undefined ? '' : ` · 失败：${record.error}`
  return `#${index + 1} ${startTime} · 耗时 ${time} · 压掉 ${record.shadowedSeqs.length} 条`
    + `${compactionDelta(record)}${failure}`
}
