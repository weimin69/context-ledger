/**
 * host.ts 的测试——**不启动 DSH**，用一个假 ctx 冒充宿主。
 *
 * 运行：npm test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../host.ts'
import type { ContextLedgerService } from '../host.ts'
import type { LedgerSnapshot, SessionEventLike } from '../types.ts'

/** 会话的假身：只需要 id 和 snapshotEvents。 */
const fakeSession = (id: string, nodes: { seq: number; tokens: number }[]) => ({
  id,
  snapshotEvents: (): SessionEventLike[] => [],
  nodes,
})

/** 造一个假 ctx，记下插件对它做的每一件事。 */
function createContext(sessions: ReturnType<typeof fakeSession>[] = []) {
  const provided = new Map<string, unknown>()
  const handlers: ((session: unknown) => void)[] = []
  const disposers: (() => void)[] = []
  let failMeasure = false

  const ctx = {
    tokenMeter: {
      measure: (session: { nodes: { seq: number; tokens: number }[] }) => {
        if (failMeasure) throw new Error('正在压缩，称不了重')
        return {
          totalTokens: session.nodes.reduce((total, node) => total + node.tokens, 0),
          nodes: session.nodes,
        }
      },
      contextPressure: () => ({ contextWindow: 200_000 }),
    },
    sessions: { list: () => sessions },
    provide: (name: string, value: unknown) => {
      provided.set(name, value)
    },
    on: (_event: string, handler: (session: unknown) => void) => {
      handlers.push(handler)
    },
    effect: (fn: () => () => void) => {
      disposers.push(fn())
    },
  }

  return {
    ctx,
    provided,
    /** 模拟"会话来了一个新事件"。 */
    emit: (session: unknown) => {
      for (const handler of handlers) handler(session)
    },
    /** 模拟"插件被卸载"。 */
    dispose: () => {
      for (const disposer of disposers) disposer()
    },
    set failMeasure(value: boolean) {
      failMeasure = value
    },
  }
}

const serviceOf = (provided: Map<string, unknown>): ContextLedgerService =>
  provided.get('contextLedger') as ContextLedgerService

describe('apply', () => {
  it('把 contextLedger 服务挂上去', () => {
    const env = createContext()
    apply(env.ctx as never)
    assert.ok(env.provided.has('contextLedger'))
  })

  it('会话来了新事件 → 账本被算出来', () => {
    const env = createContext()
    apply(env.ctx as never)

    env.emit(fakeSession('s1', [{ seq: 0, tokens: 30 }, { seq: 1, tokens: 12 }]))

    const snapshot = serviceOf(env.provided).snapshot('s1')
    assert.equal(snapshot?.usedTokens, 42)
    assert.equal(snapshot?.contextWindow, 200_000)
  })

  it('插件加载时，已经存在的会话先算一遍', () => {
    const env = createContext([fakeSession('old', [{ seq: 0, tokens: 7 }])])
    apply(env.ctx as never)
    assert.equal(serviceOf(env.provided).snapshot('old')?.usedTokens, 7)
  })

  it('没算过的会话返回 undefined，不抛错', () => {
    const env = createContext()
    apply(env.ctx as never)
    assert.equal(serviceOf(env.provided).snapshot('nobody'), undefined)
  })
})

describe('subscribe', () => {
  it('账本更新时通知订阅者，退订后不再通知', () => {
    const env = createContext()
    apply(env.ctx as never)
    const seen: LedgerSnapshot[] = []
    const unsubscribe = serviceOf(env.provided).subscribe(snapshot => seen.push(snapshot))

    env.emit(fakeSession('s1', [{ seq: 0, tokens: 5 }]))
    assert.equal(seen.length, 1)

    unsubscribe()
    env.emit(fakeSession('s1', [{ seq: 0, tokens: 6 }]))
    assert.equal(seen.length, 1)
  })

  it('一个订阅者抛错，不影响其它订阅者', () => {
    const env = createContext()
    apply(env.ctx as never)
    const service = serviceOf(env.provided)

    let healthyCalls = 0
    service.subscribe(() => {
      throw new Error('订阅者自己的 bug')
    })
    service.subscribe(() => {
      healthyCalls++
    })

    env.emit(fakeSession('s1', [{ seq: 0, tokens: 1 }]))
    assert.equal(healthyCalls, 1)
  })
})

describe('容错与清理', () => {
  it('称重时抛错 → 不崩，只是这次不更新', () => {
    const env = createContext()
    apply(env.ctx as never)
    env.failMeasure = true

    assert.doesNotThrow(() => env.emit(fakeSession('s1', [{ seq: 0, tokens: 9 }])))
    assert.equal(serviceOf(env.provided).snapshot('s1'), undefined)
  })

  it('卸载后账本被清空', () => {
    const env = createContext()
    apply(env.ctx as never)
    env.emit(fakeSession('s1', [{ seq: 0, tokens: 5 }]))
    const service = serviceOf(env.provided)

    assert.equal(service.snapshot('s1')?.usedTokens, 5)
    env.dispose()
    assert.equal(service.snapshot('s1'), undefined)
  })
})
