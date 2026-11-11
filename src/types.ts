/**
 * context-ledger 的共享类型。
 *
 * 上半部分（ContextSegment ~ LedgerSnapshot）是 ROADMAP 第 5 节定下的对外数据结构。
 * 下半部分（SessionEventLike / MeasurementLike / BuildInput）是 model.ts 的输入，
 * 刻意做成“结构兼容”的窄接口：不 import DSH 内部包，纯函数才好在测试里跑。
 */

/**
 * 上下文被哪些东西占用——粗粒度分段。
 *
 * 注意 `messages`：真实数据（tokenMeter 的 contextBreakdown）只把消息总量
 * 作为一个整体给出，不区分 user / assistant。与其硬塞进 `prompt` 撒谎，
 * 不如单独列一类。
 */
export type SegmentKind = 'system' | 'prompt' | 'assistant' | 'thinking' | 'tools' | 'messages'

/** 一个分段及其 token 数。 */
export interface ContextSegment {
  kind: SegmentKind
  tokens: number
}

/**
 * tokenMeter 的 `contextBreakdown` 投影给出的固定开销构成。
 * 这三项加起来通常就约等于 overheadTokens（system + tools + 消息）。
 */
export interface ContextBreakdown {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

/** 一条可归因的上下文消耗项（通常对应一个 surface 事件）。 */
export interface ContextItem {
  /** 对应的 session 事件序号。 */
  seq: number
  kind: 'message' | 'tool-result' | 'tool-call' | 'other'
  /** 截断后的可读标题；拿不到就留空字符串，不要造。 */
  title: string
  tokens: number
  /** 是否已被压缩替换掉。 */
  shadowed: boolean
}

/** 一次压缩事务的时间线记录。 */
export interface CompactionRecord {
  id: string
  startedAt: number
  endedAt?: number
  beforeTokens?: number
  afterTokens?: number //dsh里没有给出实际的token的消耗量，先空着，得自己算
  shadowedSeqs: number[]
  summarySeq?: number
  error?: string
}

/** 给 UI 的完整快照——一次压缩完成后由纯函数整体重建。 */
export interface LedgerSnapshot {
  sessionId: string
  contextWindow: number
  usedTokens: number

  overheadTokens:number
  segments: ContextSegment[]
  items: ContextItem[]
  compactions: CompactionRecord[]
  updatedAt: number
}

/**
 * session 事件的最小形状，与 `@deepseek-ai/dsh-session` 的 SessionEvent 结构一致：
 * `{ type, seq, time, data }`，time 是 Unix epoch 毫秒。
 * 接收从外部来的数据
 */
export interface SessionEventLike {
  type: string
  seq: number
  time: number
  data: unknown
}

/**
 * `tokenMeter.measure(session)` 返回值的子集。
 * 真实的 TokenMeasurement 还有 baseline / surfaceDeltaTokens / surfaceTokens，
 * 这里只声明我们真正要用的字段。
 */
export interface MeasurementLike {
  totalTokens: number
  nodes: readonly { seq: number; tokens: number }[]
}

/**
 * 一次"称重采样"：在第 seq 个事件之后，总量是多少。
 *
 * 压缩事件本身不带前后总量，只能靠宿主在事件流上不断采样，
 * 再由 model 从采样序列里取"开始前"和"结束后"的值。
 */
export interface TotalSample {
  seq: number
  totalTokens: number
}

/** buildSnapshot 的全部输入。now 传进来而不是读时钟，快照才是纯函数。 */
export interface BuildInput {
  sessionId: string
  contextWindow: number
  measurement: MeasurementLike
  events: readonly SessionEventLike[]
  /** 固定开销的构成；拿不到就不传，segments 会保持为空。 */
  breakdown?: ContextBreakdown
  /** 按事件序号排列的称重采样，用来补压缩前后的总量。 */
  samples?: readonly TotalSample[]
  now: number
}
