// src/cli.ts
// 拼装层 —— 把 llm / agent / tui / tools 粘起来, 是唯一入口。
// session 持久化: 每轮结束把 context.messages append 到 ~/.nanopi/session.jsonl。

import { runAgent } from './agent.js'
import { Tui } from './tui.js'
import { builtinTools } from './tools.js'
import type { Model, Context, Message } from './llm.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

/** 固定 system prompt */
const SYSTEM_PROMPT = '你是一个编码助手。用提供的工具读写文件和执行命令来完成任务。先阅读再修改，修改后可运行命令验证。'

/** session 文件：~/.nanopi/session.jsonl */
const SESSION_FILE = path.join(os.homedir(), '.nanopi', 'session.jsonl')

async function main() {

  const apiKey = process.env.NANOPI_API_KEY
  if (!apiKey) {
    console.error('请设置 NANOPI_API_KEY 环境变量')
    process.exit(1)
  }

  const model: Model = {
    apiKey,
    model: process.env.NANOPI_MODEL ?? 'glm-5.2',
    baseUrl: process.env.NANOPI_BASE_URL ?? 'https://api.openai.com/v1',
    maxTokens: 4096,
  }

  // 初始化 context: system prompt 用专用字段， messages 从 session 文件加载
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    message: await loadSession(),
  }

  const tools = builtinTools()
  const tui = new Tui()

  // 每轮: 用户输入 → runAgent → 事件转发到 TUI → 持久化

  tui.onPrompt(async (text) => {
    try {
      context.message.push({ role: 'user', content: text })

      tui.setBusy(true)
      const ctrl = new AbortController()
      tui.onAbort(() => ctrl.abort())  // 每轮新建 AbortController, 需重新注册回调指向新的 controller

      for await (const ev of runAgent(model, context, tools, ctrl.signal)) {
        switch (ev.type) {
          case 'assistant_text': tui.printText(ev.delta); break
          case 'tool_call': tui.printToolCall(ev.name, ev.args); break
          case 'tool_result': tui.printToolResult(ev.name, ev.result); break
          case 'turn_end':
            if (ev.stopReason === 'max_tokens') tui.printText('\n[output truncated by max_tokens]')
            if (ev.stopReason === 'error') tui.printText('\n[error occurred]')
            tui.printTurnEnd()
            break
        }
      }

      await persistSession(context.message)
    } catch (e) {
      console.error(`\n[error] ${(e as Error).message}`)
    } finally {
      tui.setBusy(false)
    }
  })

  tui.start()

}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

/** session 持久化：读取 ~/.nanopi/session.jsonl，文件不存在或损坏则从空会话开始 */
async function loadSession(): Promise<Message[]> {
  try {
    const text = await fs.promises.readFile(SESSION_FILE, 'utf-8')
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Message)
  } catch {
    return []
  }
}

/** session 持久化：把全部消息写入 session.jsonl */
async function persistSession(messages: Message[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(SESSION_FILE), { recursive: true })
  const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
  await fs.promises.writeFile(SESSION_FILE, lines, 'utf-8')
}
