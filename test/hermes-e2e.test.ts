// The whole Hermes path with the real CLI: a Tucano agent's tool call goes
// from the model, through the CLI's own gateway daemon, to the app's gateway
// (the MCP server the profile points at) and back. Only the model is faked —
// a local OpenAI-compatible endpoint scripted to ask for the tool once.
//
// Opt-in and slow (spawns the CLI, warms a fresh root, boots its daemon):
//   TUCANO_HERMES_E2E=1 npx vitest run test/hermes-e2e.test.ts
// Skipped unless the variable is set AND `hermes` is on the PATH — a Hermes
// install is not a CI given, and a 0.21 install cannot run it (no daemon).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hermesEngine, hermesHome } from '../src/core/engines/hermes'
import { Gateway, textResult, type ToolDef } from '../src/core/gateway'

const MCP_NAME = 'list_tasks'
// Hermes namespaces a server's tools for the model: `mcp__<server>__<tool>`.
// The call it makes back to the server uses the raw name.
const MODEL_NAME = `mcp__tucano__${MCP_NAME}`
const TOOL: ToolDef = { name: MCP_NAME, description: 'Lists the tasks', inputSchema: { type: 'object', properties: {} } }

function onPath(cmd: string): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    const p = join(dir, cmd)
    if (dir && existsSync(p)) return p
  }
  return undefined
}

const bin = process.env['TUCANO_HERMES_BIN'] || onPath('hermes')
const enabled = process.env['TUCANO_HERMES_E2E'] === '1' && !!bin

// A tool message's content is a string or a list of parts, depending on the provider.
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('')
  return ''
}

// A local OpenAI-compatible endpoint: the first completion asks for the tool,
// the one after the tool result answers with text. Streaming is what the CLI
// uses, so the reply is SSE.
function fakeModel(): Promise<{ url: string; close: () => void; calls: () => number }> {
  const state = { calls: 0 }
  const server: HttpServer = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { messages?: { role?: string; content?: unknown }[]; stream?: boolean }
      const toolMsgs = (parsed.messages ?? []).filter((m) => m.role === 'tool')
      const toolText = toolMsgs.length ? textOf(toolMsgs[toolMsgs.length - 1]!.content) : ''
      state.calls++
      const message = toolMsgs.length
        ? { role: 'assistant', content: `vi o resultado: ${toolText}` }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: MODEL_NAME, arguments: '{}' } }] }
      const finish = toolMsgs.length ? 'stop' : 'tool_calls'
      if (parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const chunk = { id: 'p', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: message, finish_reason: finish }] }
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
        return
      }
      const out = JSON.stringify({
        id: 'p', object: 'chat.completion', created: 1, model: 'fake-model',
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) })
      res.end(out)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close(), calls: () => state.calls })
    })
  })
}

function runCli(binPath: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    spawn(binPath, args, { env, stdio: 'ignore' }).on('exit', (code) => resolve(code ?? 1))
  })
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The pid the CLI recorded for the daemon serving this root (nothing else).
function daemonPid(root: string): number | undefined {
  try {
    return (JSON.parse(readFileSync(join(root, 'gateway.pid'), 'utf8')) as { pid?: number }).pid
  } catch {
    return undefined
  }
}

// Stop the daemon the way the app can: the CLI's own `gateway stop`, scoped to
// the home it runs in. SIGTERM is only a last resort so a probe never leaks one.
async function stopDaemon(binPath: string, root: string): Promise<void> {
  const pid = daemonPid(root)
  if (!pid) return
  await runCli(binPath, ['gateway', 'stop'], { ...process.env, HERMES_HOME: root })
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 200))
  if (alive(pid)) process.kill(pid, 'SIGTERM')
}

describe.skipIf(!enabled)('the Hermes engine end to end', () => {
  it('runs a tool the app gave it, through the CLI gateway and back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tucano-hermes-e2e-'))
    const userHome = mkdtempSync(join(tmpdir(), 'tucano-hermes-user-'))
    const model = await fakeModel()
    const gateway = new Gateway()
    await gateway.start()
    const called: string[] = []
    gateway.agentTurn('iris', { tools: [TOOL], call: async (name) => (called.push(name), textResult('2 tasks: coffee and bread')) })

    const previous = process.env['HERMES_HOME']
    process.env['HERMES_HOME'] = userHome
    try {
      // The person's own config: a provider pointed at the fake model.
      writeFileSync(join(userHome, 'config.yaml'), `providers:\n  probe:\n    base_url: ${model.url}\n    api_mode: chat_completions\n    api_key_env: PROBE_KEY\nmodel:\n  provider: probe\n`)

      // Nothing warms this root first: a cold root used to die on the CLI's own
      // imports ("No module named 'ruamel'"), so the engine has to prepare it.

      const home = hermesHome(root, { system: 'You are Iris, a Tucano agent.', mcpUrl: gateway.agentUrl('iris'), web: false, agentKey: 'iris' }, userHome)
      expect(home).toContain(join('profiles', 'iris'))

      const events = []
      for await (const ev of hermesEngine(() => bin, root).run({
        model: 'probe/probe-model', effort: 'low', system: 'You are Iris, a Tucano agent.',
        prompt: 'list my tasks', blocks: ['list my tasks'], images: [], cwd: userHome,
        agentKey: 'iris', signal: new AbortController().signal, mcpUrl: gateway.agentUrl('iris'), web: false
      })) {
        events.push(ev)
      }

      const done = events.find((e) => e.type === 'done')
      expect(events.find((e) => e.type === 'error')).toBeUndefined()
      expect(done).toBeDefined()
      // The model only says this after reading the tool result back, so the
      // app's payload made the whole round trip.
      expect((done as { text: string }).text).toContain('2 tasks: coffee and bread')
      // And the call really reached the app's gateway: the handler ran, under
      // the raw tool name (the namespaced one is the model's view).
      expect(called).toEqual([MCP_NAME])
      expect(model.calls()).toBeGreaterThanOrEqual(2)

      // A turn leaves the CLI's own gateway daemon behind, and in 0.22 there is
      // no switch to turn it off: every turn goes through that runtime and the
      // profiles layout is built on it. So what the app owes is that stopping it
      // leaves nothing behind — the process goes and its pid file goes with it.
      // The idle exit in the generated config (2 minutes) bounds the case where
      // nobody asks.
      const pid = daemonPid(root)
      expect(pid).toBeGreaterThan(0)
      expect(alive(pid!)).toBe(true)
      await stopDaemon(bin!, root)
      expect(alive(pid!)).toBe(false)
      expect(existsSync(join(root, 'gateway.pid'))).toBe(false)
    } finally {
      process.env['HERMES_HOME'] = previous
      await stopDaemon(bin!, root)
      await gateway.stop()
      model.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      rmSync(userHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }, 600_000)
})
