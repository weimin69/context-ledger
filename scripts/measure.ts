/**
 * 指标脚本：跑任务、读会话日志、算出上下文指标。
 *
 * 两种模式：
 *
 *   1) 分析已有会话（不需要 API key，先验证逻辑对不对）：
 *      node scripts/measure.ts --analyze c30798bd-9c45-4f50-bf73-7615344553d5
 *
 *   2) 跑实验（需要 DEEPSEEK_API_KEY，会产生真实调用费用）：
 *      node scripts/measure.ts --run --profile ledger-demo
 *
 * 指标定义：
 *   - maxPromptTokens：所有模型调用里最大的一次 prompt 大小（input + cacheRead + cacheWrite）
 *     —— 这就是"上下文撑到多大"
 *   - billedTokens：所有调用的用量合计（含 output），是"花了多少"
 *   - compactions：压缩次数
 *   - turns：轮数
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── 实验任务清单：改这里就行 ───────────────────────────────────────────────
// 任务要"会长大"：多次读文件、多步操作，上下文才涨得起来，才可能触发压缩。
const TASKS = [
  {
    id: 'survey-src',
    task: '依次读取 src/types.ts、src/model.ts、src/host.ts、src/tui.tsx 这四个文件，'
      + '把每个文件里导出的函数名和类型名列出来（只要名字，不要贴代码），最后按文件汇总。',
  },
  {
    id: 'explain-flow',
    task: '读取 src/host.ts 和 src/model.ts，用要点说明"一次会话事件从进来到变成账本快照"的完整流程，'
      + '每个要点注明对应的函数名。',
  },
]

const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

/** 在 ~/.dsh/sessions 下找到某个会话的日志文件。 */
function findSessionFile(sessionId: string): string | undefined {
  for (const workspace of readdirSync(SESSIONS_ROOT)) {
    const candidate = join(SESSIONS_ROOT, workspace, sessionId, 'session.v4.jsonl.zstd')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** 用 zstd 命令行解压（会话日志是多帧拼接，Node 的 zstd 只解第一帧）。 */
function readSessionEvents(file: string): any[] {
  const text = execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

interface SessionMetrics {
  sessionId: string
  turns: number
  calls: number
  maxPromptTokens: number
  billedTokens: number
  compactions: number
  failedCompactions: number
}

/** 从事件流里算指标。口径写在这里，别在别处猜。 */
function analyze(events: any[], sessionId: string): SessionMetrics {
  let turns = 0
  let calls = 0
  let maxPromptTokens = 0
  let billedTokens = 0
  let compactions = 0
  let failedCompactions = 0

  for (const event of events) {
    if (event.type === 'turn/start') turns += 1

    if (event.type === 'assistant/message' && event.data?.usage) {
      const usage = event.data.usage
      calls += 1
      const prompt = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      const billed = prompt + (usage.outputTokens ?? 0)
      maxPromptTokens = Math.max(maxPromptTokens, prompt)
      billedTokens += billed
    }

    if (event.type === 'compaction/end') {
      if (event.data?.error === undefined) compactions += 1
      else failedCompactions += 1
    }
  }

  return { sessionId, turns, calls, maxPromptTokens, billedTokens, compactions, failedCompactions }
}

/** 额外传给 dsh 的参数（例如 --patch 覆盖压缩配置）。 */
const extraArgs: string[] = []

/**
 * 把 API key 里常见的粘贴事故清掉：首尾空白、包裹的引号。
 * 这些字符会让 provider 报 "contains characters no HTTP header can carry"。
 */
function sanitizeKey(raw: string | undefined): { key: string | undefined; note?: string } {
  if (raw === undefined) return { key: undefined }
  let key = raw.trim()
  const quoted = (key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))
  if (quoted && key.length >= 2) key = key.slice(1, -1).trim()

  const notes: string[] = []
  if (key !== raw) notes.push('已自动去掉首尾空白/引号')
  if (/[^\x21-\x7E]/.test(key)) notes.push('仍含非 ASCII 或内部空白字符，请重新复制 key')
  return { key, note: notes.length === 0 ? undefined : notes.join('；') }
}

/** 跑一个任务，返回它的 sessionId；跑失败会抛错（别把失败当成功记）。 */
function runTask(profile: string, task: string): string {
  // 注意：不要多写一个 "headless"——profile 已经决定了用的是哪个 app，
  // 多出来的词会被当成任务正文。
  const stdout = execFileSync('dsh', ['--profile', profile, ...extraArgs, '--json', task], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  let sessionId: string | undefined
  let failure: string | undefined
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const event = JSON.parse(line)
    if (event.type === 'session') sessionId = event.sessionId as string
    if (event.type === 'final' && event.reason?.kind === 'error') {
      failure = String(event.reason.error?.message ?? 'unknown error')
    }
  }
  if (failure !== undefined) throw new Error(failure)
  if (sessionId === undefined) throw new Error('headless 没有返回 sessionId')
  return sessionId
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : Math.round(values.reduce((a, b) => a + b, 0) / values.length)
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!
}

// ── 入口 ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const analyzeIndex = args.indexOf('--analyze')

if (analyzeIndex >= 0) {
  const sessionId = args[analyzeIndex + 1]
  if (sessionId === undefined) {
    console.error('用法：node scripts/measure.ts --analyze <sessionId>')
    process.exit(1)
  }
  const file = findSessionFile(sessionId)
  if (file === undefined) {
    console.error(`找不到会话 ${sessionId} 的日志`)
    process.exit(1)
  }
  const events = readSessionEvents(file)
  console.log(JSON.stringify(analyze(events, sessionId), null, 2))
  process.exit(0)
}

// --patch 可以重复，原样转给 dsh（用来切换压缩配置做 A/B）
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--patch' && args[i + 1] !== undefined) {
    const patch = args[i + 1]!
    // 先检查文件在不在，避免 dsh 抛一大坨堆栈才看出来是路径写错。
    if (!existsSync(patch)) {
      console.error(`[measure] 找不到 patch 文件：${patch}`)
      process.exit(1)
    }
    extraArgs.push('--patch', patch)
  }
}

const runIndex = args.indexOf('--run')
const profileIndex = args.indexOf('--profile')
const profile = profileIndex >= 0 ? args[profileIndex + 1] : 'headless'

if (runIndex < 0 || profile === undefined) {
  console.error('用法：')
  console.error('  node scripts/measure.ts --analyze <sessionId>')
  console.error('  node scripts/measure.ts --run --profile <profile>')
  process.exit(1)
}

// 先把 key 洗干净，再开始跑；洗不干净就直接停，别浪费调用。
const sanitized = sanitizeKey(process.env.DEEPSEEK_API_KEY)
if (sanitized.note !== undefined) console.error(`[measure] ${sanitized.note}`)
if (sanitized.key !== undefined && /[^\x21-\x7E]/.test(sanitized.key)) {
  console.error('[measure] DEEPSEEK_API_KEY 仍不合法，请重新复制（不要带换行/空格/引号）')
  process.exit(1)
}
// 洗干净的值写回环境变量，子进程（dsh）直接继承，不用再单独传 env。
if (sanitized.key !== undefined) process.env.DEEPSEEK_API_KEY = sanitized.key

const rows: SessionMetrics[] = []
for (const item of TASKS) {
  console.error(`[measure] 跑任务 ${item.id} …`)
  let sessionId: string
  try {
    sessionId = runTask(profile, item.task)
  } catch (error) {
    console.error(`[measure] 任务 ${item.id} 失败：${(error as Error).message}`)
    process.exitCode = 1
    continue
  }
  const file = findSessionFile(sessionId)
  if (file === undefined) {
    console.error(`[measure] 找不到 ${sessionId} 的日志，跳过`)
    continue
  }
  rows.push(analyze(readSessionEvents(file), sessionId))
}

const summary = {
  profile,
  tasks: rows.length,
  maxPromptTokens: { mean: mean(rows.map(r => r.maxPromptTokens)), median: median(rows.map(r => r.maxPromptTokens)) },
  billedTokens: { mean: mean(rows.map(r => r.billedTokens)), median: median(rows.map(r => r.billedTokens)) },
  compactions: rows.reduce((sum, r) => sum + r.compactions, 0),
  rows,
}
const outIndex = args.indexOf('--out')
const outFile = outIndex >= 0 ? args[outIndex + 1] ?? 'metrics.json' : 'metrics.json'
writeFileSync(outFile, JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
