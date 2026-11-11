/**
 * 宿主插件：把 DSH 的真实数据接进 model.ts。
 *
 * 它是整套东西里唯一"和外界打交道"的文件：
 *   1. 向 DSH 要两个服务：tokenMeter（称重机）和 sessions（会话仓库）；
 *   2. 每次会话有新事件，就称一次重、算一次账；
 *   3. 把账本挂到 ctx.contextLedger 上，供后面的 UI 调用；
 *   4. 卸载时把自己挂的东西全部清掉。
 *
 * 只 import 类型（import type），所以这个文件不依赖任何运行时包，
 * 测试里拿一个假 ctx 就能跑。
 */

import { appendFileSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'

import { buildSnapshot } from './model.ts'
import type { ContextBreakdown, LedgerSnapshot, SessionEventLike, TotalSample } from './types.ts'

/** 插件名，Cordis 用它标识这个插件。 */
export const name = 'context-ledger-host'

/**
 * 声明依赖：没有这两个服务，插件就不启动（Cordis 会等它们就绪）。
 * 这正是 ROADMAP 里"宿主和 TUI 分开"的原因——这里只依赖宿主侧的服务。
 */
export const inject = ['tokenMeter', 'sessions']

/** 提供给其它代码（尤其是 TUI 侧）的账本服务。 */
export interface ContextLedgerService {
  /** 取某个会话的最新账本；没算过就返回 undefined。 */
  snapshot(sessionId: string): LedgerSnapshot | undefined
  /** 订阅账本更新，返回取消订阅的函数。 */
  subscribe(listener: (snapshot: LedgerSnapshot) => void): () => void
}

/**
 * 给这个插件真正用到的那一小撮 DSH 能力补上类型声明。
 *
 * 真实项目里，这些声明由拥有该服务的包提供（tokenMeter 在 @deepseek-ai/dsh-llm-token-meter，
 * sessions 在 @deepseek-ai/dsh-session）。我们不想为此拉一长串依赖，只声明用到的那几个成员。
 * 只影响编辑器提示，运行时完全不存在。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    contextLedger: ContextLedgerService
    tokenMeter: {
      measure(session: unknown): {
        totalTokens: number
        nodes: readonly { seq: number; tokens: number }[]
      }
      contextPressure(session: unknown): { contextWindow?: number }
    }
    sessions: {
      list(): readonly unknown[]
    }
    sessionProjections?: {
      snapshot(session: unknown): { values: { contextBreakdown?: ContextBreakdown } }
    }
  }

  interface Events {
    'session/event'(session: unknown): void
  }
}

/**
 * 插件入口。Cordis 加载插件时调用它。
 * @param ctx - 带 tokenMeter / sessions 的上下文。
 */
export function apply(ctx: Context): void {
  const snapshots = new Map<string, LedgerSnapshot>()
  const listeners = new Set<(snapshot: LedgerSnapshot) => void>()
  // 每个会话一串"称重采样"，用来补压缩前后的总量（事件里没有这两个数）。
  const samplesBySession = new Map<string, TotalSample[]>()

  /** 存下账本，并通知所有盯着看的人（比如 TUI 面板）。 */
  function publish(snapshot: LedgerSnapshot): void {
    snapshots.set(snapshot.sessionId, snapshot)
    for (const listener of listeners) {
      // 一个订阅者出问题，不能连累其它订阅者，更不能拖垮会话。
      try {
        listener(snapshot)
      } catch {
        // 故意吞掉：账本插件不该成为 TUI 崩溃的原因。
      }
    }
  }

  /** 称一次重 + 算一次账。 */
  function refresh(session: SessionLike): void {
    try {
      const measurement = ctx.tokenMeter.measure(session as never)
      const pressure = ctx.tokenMeter.contextPressure(session as never)
      const events = session.snapshotEvents() as readonly SessionEventLike[]

      // 固定开销的构成（system / tools / messages）由 token-meter 的投影算好了，
      // 直接读；读不到就当没有，不能因为它让整次刷新失败。
      let breakdown: ContextBreakdown | undefined
      try {
        breakdown = ctx.get('sessionProjections')?.snapshot(session).values.contextBreakdown
      } catch {
        breakdown = undefined
      }

      const sessionId = String(session.id)

      // 记一条采样：第几个事件之后、总量是多少。
      // 只保留最近 200 条，长会话也不会无限涨。
      const samples = samplesBySession.get(sessionId) ?? []
      samples.push({
        seq: Number((measurement as { logRevision?: number }).logRevision ?? 0),
        totalTokens: measurement.totalTokens,
      })
      if (samples.length > 200) samples.splice(0, samples.length - 200)
      samplesBySession.set(sessionId, samples)

      const snapshot = buildSnapshot({
        sessionId,
        contextWindow: pressure.contextWindow ?? 0,
        measurement,
        events,
        breakdown,
        samples,
        now: Date.now(),
      })
      publish(snapshot)

      // 排查用的落地日志：设了 CONTEXT_LEDGER_DEBUG_FILE 就追加一行 JSON。
      // 走文件而不是 stderr——TUI 正占着终端，往 stderr 写会搅乱画面。
      const debugFile = process.env.CONTEXT_LEDGER_DEBUG_FILE
      if (debugFile !== undefined) {
        try {
          appendFileSync(debugFile, `${JSON.stringify({
            at: new Date().toISOString(),
            totalTokens: measurement.totalTokens,
            surfaceTokens: (measurement as { surfaceTokens?: number }).surfaceTokens,
            baseline: (measurement as { baseline?: unknown }).baseline,
            breakdown,
            itemsSum: snapshot.items.reduce((sum, item) => sum + item.tokens, 0),
            segments: snapshot.segments,
            usedTokens: snapshot.usedTokens,
            contextWindow: snapshot.contextWindow,
            compactions: snapshot.compactions.length,
            items: snapshot.items.length,
          })}\n`)
        } catch {
          // 记日志失败不能影响主流程
        }
      }

      // 第 0 周的真机验证用：设了 CONTEXT_LEDGER_DEBUG 才打印，平时安静。
      if (process.env.CONTEXT_LEDGER_DEBUG !== undefined) {
        console.error('[context-ledger]', JSON.stringify({
          sessionId: snapshot.sessionId,
          contextWindow: snapshot.contextWindow,
          usedTokens: snapshot.usedTokens,
          overheadTokens: snapshot.overheadTokens,
          segments: snapshot.segments,
          items: snapshot.items.slice(0, 5).map(item => ({
            seq: item.seq,
            kind: item.kind,
            title: item.title,
            tokens: item.tokens,
          })),
          nodeCount: snapshot.items.length,
          compactions: snapshot.compactions.length,
        }))
      }
    } catch (error) {
      if (process.env.CONTEXT_LEDGER_DEBUG !== undefined) {
        console.error('[context-ledger] refresh failed:', error)
      }
      // 会话可能正处在中间状态（比如正在压缩），这一次算不出来就跳过，
      // 等下一个事件再算。绝不抛出——抛出去会让整个 agent 轮次失败。
    }
  }

  const service: ContextLedgerService = {
    snapshot: sessionId => snapshots.get(sessionId),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)//退订，防止内存泄漏
      }
    },
  }

  ctx.provide('contextLedger', service)

  // 每次会话有新事件就重算。这是唯一的触发点。
  ctx.on('session/event', session => {
    refresh(session as SessionLike)
  })

  // 插件加载时，把已经存在的会话先算一遍（热重载后不至于一片空白）。
  for (const session of ctx.sessions.list()) {
    refresh(session as SessionLike)
  }

  // 卸载时清理：Cordis 会自动移除 ctx.on 的监听，这里补上我们自己的两个容器。
  ctx.effect(() => () => {
    listeners.clear()
    snapshots.clear()
    samplesBySession.clear()
  })
}

/**
 * 这个插件真正用到 Session 的部分。
 * 只声明用到的三个成员，测试时可以随手造一个假的。
 */
interface SessionLike {
  id: unknown
  snapshotEvents(): readonly unknown[]
}
