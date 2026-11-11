/**
 * TUI 插件的冒烟测试：不启动真 TUI，只验证"注册动作发生了"。
 *
 * 检查三件事：
 *   1. apply 之后，场景以 id `context-ledger` 注册过；
 *   2. 命令以 `/context` 注册过；
 *   3. 场景被卸载时（dispose），注册也跟着撤销。
 *
 * 运行：node scripts/smoke-tui.ts
 * 注意：这个脚本依赖 @deepseek-harness-tui/dsh-tui 能被解析（插件目录里的 link），
 * 所以它不进 `npm test`，属于手动检查。
 */

import assert from 'node:assert/strict'

import { apply } from '../lib/tui.js'

interface RegisteredScene {
  id: string
  title?: string
  component: unknown
}

interface RegisteredCommand {
  name: string
  description: string
  handler: () => { kind: 'success' } | { kind: 'error'; text: string }
}

const scenes: RegisteredScene[] = []
const commands: RegisteredCommand[] = []
const effects: (() => void)[] = []

const scenesService = {
  register: (scene: RegisteredScene) => {
    scenes.push(scene)
    return () => {
      scenes.splice(scenes.indexOf(scene), 1)
    }
  },
  open: () => true,
}

const fakeCtx = {
  // 场景服务：记录注册，open 返回 true（假装打开成功）
  inject: (_names: string[], callback: (ctx: unknown) => void) => {
    callback({ tuiScenes: scenesService })
  },
  get: (service: string) => {
    if (service === 'commands') {
      return {
        register: (command: RegisteredCommand) => {
          commands.push(command)
          return () => {
            commands.splice(commands.indexOf(command), 1)
          }
        },
      }
    }
    if (service === 'tuiScenes') return scenesService
    return undefined
  },
  effect: (fn: () => () => void) => effects.push(fn()),
}

apply(fakeCtx as never)

assert.equal(scenes.length, 1, '应当注册 1 个场景')
assert.equal(scenes[0]?.id, 'context-ledger')
assert.equal(commands.length, 1, '应当注册 1 个命令')
assert.equal(commands[0]?.name, 'ledger')

// 命令的 handler 能调通 open，并返回静默 success
const result = commands[0]?.handler()
assert.deepEqual(result, { kind: 'success' })

// 卸载：两个注册都应撤销
for (const effect of effects) effect()
assert.equal(scenes.length, 0, '卸载后场景应被撤销')
assert.equal(commands.length, 0, '卸载后命令应被撤销')

console.log('tui smoke ok: 1 scene (context-ledger) + 1 command (/ledger)，卸载干净')
