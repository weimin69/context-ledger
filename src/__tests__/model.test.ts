/**
 * model.ts 的单元测试——最便宜的一层，先写它。
 *
 * 运行：node --test src/__tests__/model.test.ts
 * 断言原则：只断言数字和结构，不断言颜色、不断言文案排版。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSnapshot,
  compactionLine,
  compactionTimeline,
  durationText,
  sumItemTokens,
  tokenText,
  topConsumers,
} from '../model.ts'
import type { MeasurementLike, SessionEventLike } from '../types.ts'

const measure = (
  nodes: { seq: number; tokens: number }[],
  totalTokens = nodes.reduce((total, node) => total + node.tokens, 0),
): MeasurementLike => ({ totalTokens, nodes })

const build = (
  nodes: { seq: number; tokens: number }[],
  events: SessionEventLike[] = [],
  totalTokens?: number,
) => buildSnapshot({
  sessionId: 'session-test',
  contextWindow: 200_000,
  measurement: measure(nodes, totalTokens),
  events,
  now: 1_700_000_000_000,
})

describe('buildSnapshot', () => {
  it('空事件 → 空快照，不崩', () => {
    const snapshot = build([])
    assert.equal(snapshot.usedTokens, 0)
    assert.equal(snapshot.overheadTokens, 0)
    assert.deepEqual(snapshot.items, [])
    assert.deepEqual(snapshot.compactions, [])
  })

  it('没有固定开销时，总数等于逐项之和', () => {
    const nodes = Array.from({ length: 10 }, (_, index) => ({
      seq: index,
      tokens: (index + 1) * 10,
    }))
    const snapshot = build(nodes)
    assert.equal(snapshot.usedTokens, 550)
    assert.equal(snapshot.overheadTokens, 0)
    assert.equal(sumItemTokens(snapshot.items), 550)
    assert.equal(snapshot.items.length, 10)
  })

  it('真实数据：总数 = 固定开销 + 逐项之和', () => {
    // 真机跑出来的一组：total 5988，三条 node 是 727 / 11 / 189
    const snapshot = build(
      [
        { seq: 7, tokens: 727 },
        { seq: 8, tokens: 11 },
        { seq: 9, tokens: 189 },
      ],
      [],
      5988,
    )
    assert.equal(sumItemTokens(snapshot.items), 927)
    assert.equal(snapshot.overheadTokens, 5061)
    assert.equal(
      snapshot.overheadTokens + sumItemTokens(snapshot.items),
      snapshot.usedTokens,
    )
  })

  it('拿不到的字段留空，不造数据', () => {
    const snapshot = build([{ seq: 0, tokens: 42 }])
    assert.deepEqual(snapshot.segments, [])
    assert.equal(snapshot.items[0]?.title, '')
    assert.equal(snapshot.items[0]?.kind, 'other')
  })
})

describe('topConsumers', () => {
  it('降序且 token 相同按 seq 升序（稳定）', () => {
    const snapshot = build([
      { seq: 0, tokens: 5 },
      { seq: 1, tokens: 50 },
      { seq: 2, tokens: 5 },
      { seq: 3, tokens: 50 },
    ])
    assert.deepEqual(topConsumers(snapshot, 3).map(item => item.seq), [1, 3, 0])
  })

  it('n 大于条目数时返回全部', () => {
    const snapshot = build([{ seq: 0, tokens: 1 }])
    assert.equal(topConsumers(snapshot, 10).length, 1)
  })
})

describe('压缩事件', () => {
  const startEvent: SessionEventLike = {
    type: 'compaction/start',
    seq: 10,
    time: 1_000,
    data: { compactionId: 'c1', turn: 2 },
  }
  const summaryEvent: SessionEventLike = {
    type: 'compaction/summary',
    seq: 11,
    time: 1_100,
    data: { compactionId: 'c1', shadowedSeqs: [1, 2], shadowedTokenCount: 80 },
  }
  const endEvent: SessionEventLike = {
    type: 'compaction/end',
    seq: 12,
    time: 1_200,
    data: { compactionId: 'c1', turn: 2 },
  }

  it('summary 的 shadowedSeqs 标记到对应 item 上', () => {
    const snapshot = build(
      [
        { seq: 1, tokens: 40 },
        { seq: 2, tokens: 40 },
        { seq: 3, tokens: 10 },
      ],
      [startEvent, summaryEvent, endEvent],
    )
    assert.deepEqual(
      snapshot.items.map(item => item.shadowed),
      [true, true, false],
    )
  })

  it('start → end 配对成一条记录，带开始/结束时间', () => {
    const snapshot = build([], [startEvent, summaryEvent, endEvent])
    assert.equal(snapshot.compactions.length, 1)
    const [record] = compactionTimeline(snapshot)
    assert.equal(record?.id, 'c1')
    assert.equal(record?.startedAt, 1_000)
    assert.equal(record?.endedAt, 1_200)
    assert.deepEqual(record?.shadowedSeqs, [1, 2])
    assert.equal(record?.error, undefined)
  })

  it('失败的压缩保留在时间线里并记录 error', () => {
    const failed: SessionEventLike = {
      type: 'compaction/end',
      seq: 12,
      time: 1_200,
      data: { compactionId: 'c1', turn: 2, error: 'context window exceeded' },
    }
    const snapshot = build([], [startEvent, failed])
    assert.equal(snapshot.compactions[0]?.error, 'context window exceeded')
  })

  it('事件乱序输入 → 仍按 seq 折叠', () => {
    const snapshot = build([], [endEvent, startEvent, summaryEvent])
    assert.equal(snapshot.compactions.length, 1)
    assert.equal(snapshot.compactions[0]?.endedAt, 1_200)
  })
})


describe('分段（breakdown）', () => {
  it('system / tools / messages 三项都列出来', () => {
    const snapshot = buildSnapshot({
      sessionId: 's',
      contextWindow: 100,
      measurement: measure([], 60),
      events: [],
      breakdown: { systemTokens: 20, toolsTokens: 30, messageTokens: 10 },
      now: 0,
    })
    assert.deepEqual(snapshot.segments, [
      { kind: 'system', tokens: 20 },
      { kind: 'tools', tokens: 30 },
      { kind: 'messages', tokens: 10 },
    ])
  })

  it('为 0 的分段不列出来', () => {
    const snapshot = buildSnapshot({
      sessionId: 's',
      contextWindow: 100,
      measurement: measure([], 20),
      events: [],
      breakdown: { systemTokens: 20, toolsTokens: 0, messageTokens: 0 },
      now: 0,
    })
    assert.deepEqual(snapshot.segments, [{ kind: 'system', tokens: 20 }])
  })

  it('拿不到 breakdown 就是空数组，不猜', () => {
    assert.deepEqual(build([]).segments, [])
  })
})

describe('明细的 kind 和 title', () => {
  const userMessage: SessionEventLike = {
    type: 'user/message',
    seq: 1,
    time: 0,
    // user/message 的 data 就是消息本身
    data: { content: [{ type: 'text', text: '帮我看看\n这个 bug' }] },
  }
  const assistantMessage: SessionEventLike = {
    type: 'assistant/message',
    seq: 2,
    time: 0,
    // assistant/message 把消息放在 data.message 里
    data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: '好的，我看下' }] } },
  }
  const toolResult: SessionEventLike = {
    type: 'tool/result',
    seq: 3,
    time: 0,
    data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: '文件已读取' }] } },
  }

  it('用户消息 → message + 单行标题', () => {
    const snapshot = build([{ seq: 1, tokens: 10 }], [userMessage])
    assert.equal(snapshot.items[0]?.kind, 'message')
    assert.equal(snapshot.items[0]?.title, '帮我看看 这个 bug')
  })

  it('助手消息 → message，从 data.message 里取文本', () => {
    const snapshot = build([{ seq: 2, tokens: 10 }], [assistantMessage])
    assert.equal(snapshot.items[0]?.kind, 'message')
    assert.equal(snapshot.items[0]?.title, '好的，我看下')
  })

  it('工具结果 → tool-result', () => {
    const snapshot = build([{ seq: 3, tokens: 10 }], [toolResult])
    assert.equal(snapshot.items[0]?.kind, 'tool-result')
    assert.equal(snapshot.items[0]?.title, '文件已读取')
  })

  it('认不出来的事件 → other + 空标题', () => {
    const unknown: SessionEventLike = { type: 'request/header', seq: 9, time: 0, data: {} }
    const snapshot = build([{ seq: 9, tokens: 5 }], [unknown])
    assert.equal(snapshot.items[0]?.kind, 'other')
    assert.equal(snapshot.items[0]?.title, '')
  })

  it('没有对应事件时也不崩', () => {
    const snapshot = build([{ seq: 999, tokens: 5 }])
    assert.equal(snapshot.items[0]?.kind, 'other')
    assert.equal(snapshot.items[0]?.title, '')
  })

  it('太长的标题截断并加省略号', () => {
    const long = { type: 'user/message', seq: 4, time: 0, data: { content: [{ type: 'text', text: '一'.repeat(100) }] } }
    const snapshot = build([{ seq: 4, tokens: 5 }], [long])
    const title = snapshot.items[0]?.title ?? ''
    assert.equal(title.length, 41)
    assert.ok(title.endsWith('…'))
  })
})

describe('纯函数性', () => {
  it('同样输入跑两次结果完全一致', () => {
    const nodes = [{ seq: 0, tokens: 3 }, { seq: 1, tokens: 7 }]
    assert.deepEqual(build(nodes), build(nodes))
  })
})

describe('durationText', () => {
  it('0 和负数都返回 0ms', () => {
    assert.equal(durationText(0), '0ms')
    assert.equal(durationText(-5), '0ms')
  })

  it('不到 1 秒给毫秒', () => {
    assert.equal(durationText(320), '320ms')
    assert.equal(durationText(999), '999ms')
  })

  it('1 秒以上给秒，保留一位小数', () => {
    assert.equal(durationText(1000), '1s')
    assert.equal(durationText(1250), '1.3s')
  })

  it('1 分钟以上给「分m秒s」', () => {
    assert.equal(durationText(61000), '1m1s')
    assert.equal(durationText(3599999), '59m59s')
  })

  it('1 小时以上给「时h分m」', () => {
    assert.equal(durationText(3600000), '1h0m')
    assert.equal(durationText(3720000), '1h2m')
  })
})

describe('compactionLine', () => {
  const base = { id: 'c1', startedAt: 1_700_000_000_000, shadowedSeqs: [1, 2, 3] }

  it('正常结束：序号从 1 开始，带耗时和条数', () => {
    const line = compactionLine({ ...base, endedAt: base.startedAt + 2400 }, 0)
    assert.ok(line.startsWith('#1 '))
    assert.ok(line.includes('耗时 2.4s'))
    assert.ok(line.includes('压掉 3 条'))
    assert.ok(!line.includes('失败'))
  })

  it('还没结束：显示「进行中」，不显示耗时', () => {
    const line = compactionLine(base, 1)
    assert.ok(line.startsWith('#2 '))
    assert.ok(line.includes('进行中'))
    assert.ok(!line.includes('耗时'))
  })

  it('失败：带失败原因，但仍然显示耗时', () => {
    const line = compactionLine({ ...base, endedAt: base.startedAt + 1500, error: 'context window exceeded' }, 2)
    assert.ok(line.startsWith('#3 '))
    assert.ok(line.includes('耗时 1.5s'))
    assert.ok(line.includes('失败：context window exceeded'))
  })

  it('序号是 index + 1，不是 index', () => {
    assert.ok(compactionLine(base, 4).startsWith('#5 '))
  })
})

describe('tokenText', () => {
  it('小于 1000 原样输出，大于等于 1000 用 k', () => {
    assert.equal(tokenText(999), '999')
    assert.equal(tokenText(1200), '1.2k')
    assert.equal(tokenText(12800), '12.8k')
  })
})

describe('压缩前后的总量（samples）', () => {
  const startEvent: SessionEventLike = {
    type: 'compaction/start', seq: 10, time: 1_000, data: { compactionId: 'c1', turn: null },
  }
  const endEvent: SessionEventLike = {
    type: 'compaction/end', seq: 12, time: 4_000, data: { compactionId: 'c1', turn: null },
  }

  it('从采样序列里补出 before / after', () => {
    const snapshot = buildSnapshot({
      sessionId: 's',
      contextWindow: 100_000,
      measurement: measure([], 8_100),
      events: [startEvent, endEvent],
      samples: [
        { seq: 8, totalTokens: 12_000 },   // 压缩开始前
        { seq: 11, totalTokens: 12_800 },  // start 之后、end 之前
        { seq: 13, totalTokens: 8_100 },   // end 之后
      ],
      now: 0,
    })
    const record = snapshot.compactions[0]
    assert.equal(record?.beforeTokens, 12_800)
    assert.equal(record?.afterTokens, 8_100)
  })

  it('没有采样时两个字段都是 undefined，不瞎猜', () => {
    const snapshot = buildSnapshot({
      sessionId: 's',
      contextWindow: 100_000,
      measurement: measure([], 0),
      events: [startEvent, endEvent],
      now: 0,
    })
    assert.equal(snapshot.compactions[0]?.beforeTokens, undefined)
    assert.equal(snapshot.compactions[0]?.afterTokens, undefined)
  })

  it('时间线把前后总量和省下的百分比拼进去', () => {
    const line = compactionLine(
      { id: 'c1', startedAt: 1_000, endedAt: 4_000, shadowedSeqs: [1], beforeTokens: 12_800, afterTokens: 8_100 },
      0,
    )
    assert.ok(line.includes('12.8k → 8.1k'))
    assert.ok(line.includes('省 37%'))
  })

  it('只有 before 时不出箭头', () => {
    const line = compactionLine(
      { id: 'c1', startedAt: 1_000, endedAt: 4_000, shadowedSeqs: [], beforeTokens: 12_800 },
      0,
    )
    assert.ok(!line.includes('→'))
  })
})
