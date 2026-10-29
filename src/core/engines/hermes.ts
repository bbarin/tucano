import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { GATEWAY_NAME } from './claude'
import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import type { Effort } from '../../shared/types'
import type { Engine, EngineEvent, Turn } from './types'
import { L } from '../../shared/lang'

// Hermes is the agent CLI the app itself runs on. It reads AGENTS.md, SOUL.md,
// skills, plugins, MCP servers and sessions from its home, and keeps every
// session in a database there. So the app runs it with a home of its own
// (HERMES_HOME, see hermesHome), and brings in only the person's providers
// (the `providers` block of their config.yaml) and their logins (.env and
// auth.json, linked so a refreshed login stays theirs). The app's gateway,
// when given, is the only MCP server: its tools are what the agent gets.

// One JSON event per line: system/init, text deltas, tool_use/tool_result, and
// one terminal result with the whole turn's tokens (or an error). The answer
// comes whole in the result; the deltas before it are only for streaming.
export function hermesParser(): Parser {
  let text = ''
  let usage: { inputTokens: number; cacheReadTokens: number; outputTokens: number } | undefined
  let failed = false
  let error = ''

  return {
    line(line) {
      const ev = parseJson(line)
      if (!ev) return []
      const out: EngineEvent[] = []
      if (ev['type'] === 'text' && typeof ev['text'] === 'string' && ev['text']) {
        text += ev['text']
        out.push({ type: 'text', delta: ev['text'] })
      } else if (ev['type'] === 'tool_use') {
        const input = (ev['input'] ?? {}) as Record<string, unknown>
        if (ev['name'] === 'web_search') out.push({ type: 'web', action: 'search', detail: String(input['query'] ?? '') })
        else if (ev['name'] === 'web_extract')
          out.push({ type: 'web', action: 'fetch', detail: String(Array.isArray(input['urls']) ? (input['urls'] as unknown[])[0] ?? '' : '') })
      } else if (ev['type'] === 'result') {
        if (typeof ev['error'] === 'string' && ev['error']) {
          failed = true
          error = ev['error']
        } else {
          // `total` counts input, cache read and write, and output together;
          // `input` alone misses the cached part, which also left the machine.
          const t = (ev['tokens'] ?? {}) as Record<string, unknown>
          usage = { inputTokens: num(t['input']) + num(t['cache_read']) + num(t['cache_write']), cacheReadTokens: num(t['cache_read']), outputTokens: num(t['output']) }
          const whole = typeof ev['text'] === 'string' ? ev['text'] : ''
          text = whole || text
        }
      }
      return out
    },
    end(code, stderr) {
      if (failed) return [{ type: 'error', message: error }]
      if (usage) return [{ type: 'done', text, usage }]
      const detail = lastLines(stderr)
      return [{ type: 'error', message: L(`O Hermes saiu sem resposta (código ${code ?? '?'}).`, `Hermes exited without a reply (code ${code ?? '?'}).`) + (detail ? `\n${detail}` : '') }]
    }
  }
}

const REASONING: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' }

// One-shot JSONL on stdout; the query comes from stdin ('-'). No AGENTS.md,
// SOUL.md, memory or preloaded skills. The provider is named explicitly (a
// bare model id otherwise falls back to a provider the person never picked);
// the system prompt rides in HERMES_ENVIRONMENT_HINT (the home's config has
// no prompt mechanism that reaches a one-shot run). The CLI's --image takes
// one path (repeating it keeps the last), so the newest image rides along.
export function hermesArgs(turn: Pick<Turn, 'model' | 'effort' | 'images'>, provider?: string): string[] {
  const image = [...(turn.images ?? [])].reverse().find((i) => existsSync(i.path))
  return [
    'chat',
    '--format', 'stream-json',
    '--query-file', '-',
    '--ignore-rules',
    '--reasoning', REASONING[turn.effort],
    '-m', turn.model,
    ...(provider ? ['--provider', provider] : []),
    ...(image ? ['--image', image.path] : [])
  ]
}

const userHomeOf = (): string => process.env['HERMES_HOME'] || join(homedir(), '.hermes')

// The user's provider config, from their ~/.hermes/config.yaml: the `providers`
// block (a company gateway, a custom endpoint) and which one their model
// section routes through. The rest (their MCP servers, toolsets, approvals)
// stays out.
export function userHermesProviders(userHome = userHomeOf()): Record<string, unknown> {
  const c = userHermesConfig(userHome)
  const out: Record<string, unknown> = {}
  if (c['providers'] && typeof c['providers'] === 'object') out['providers'] = c['providers']
  const model = c['model']
  if (model && typeof model === 'object' && typeof (model as Record<string, unknown>)['provider'] === 'string')
    out['model'] = { provider: (model as Record<string, unknown>)['provider'] }
  return out
}

function userHermesConfig(userHome: string): Record<string, unknown> {
  try {
    const v: unknown = parseYaml(readFileSync(join(userHome, 'config.yaml'), 'utf8'))
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {} // not there, or not readable
  }
}

// The app's own Hermes home: a fresh config every turn (the gateway URL changes
// with it), the person's logins linked so a refreshed login stays theirs.
// JSON is valid YAML, so the config is written with JSON.stringify.
export function hermesHome(appDir: string, turn: Pick<Turn, 'system' | 'mcpUrl' | 'web'>, userHome = userHomeOf()): string {
  const home = join(appDir, 'home')
  mkdirSync(home, { recursive: true })
  const auth = join(home, 'auth.json')
  if (!existsSync(auth) && existsSync(join(userHome, 'auth.json'))) symlinkSync(join(userHome, 'auth.json'), auth)
  const dotenv = join(home, '.env')
  if (!existsSync(dotenv) && existsSync(join(userHome, '.env'))) symlinkSync(join(userHome, '.env'), dotenv)
  const config: Record<string, unknown> = {
    approvals: { mode: 'off' }, // the gateway decides what runs
    // No built-in tools (shell, files); web search and page reading only when
    // the agent has the web. The app's gateway is the only MCP server.
    platform_toolsets: { cli: turn.web ? ['web'] : [] },
    ...(turn.mcpUrl ? { mcp_servers: { [GATEWAY_NAME]: { url: turn.mcpUrl } } } : {}),
    ...userHermesProviders(userHome)
  }
  writeFileSync(join(home, 'config.yaml'), JSON.stringify(config, null, 2))
  return home
}

// The model is "<provider>/<model>", or a bare id routed by the user's config.
export function hermesEngine(bin: () => string | undefined, appDir: string, shellEnv: () => Promise<NodeJS.ProcessEnv> = async () => ({})): Engine {
  return {
    id: 'hermes',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: L('O Hermes não está instalado. Veja em Configurações.', "Hermes isn't installed. See Settings.") }
        return
      }
      const user = userHermesProviders()
      const provider = turn.model.includes('/') ? turn.model.split('/')[0]! : ((user['model'] as Record<string, unknown> | undefined)?.['provider'] as string | undefined)
      const home = hermesHome(appDir, turn)
      // Provider keys may live in the user's shell (a key_cmd like tompero),
      // which an app opened from Finder doesn't get.
      const env = { ...process.env, ...(await shellEnv()), HERMES_HOME: home, HERMES_ENVIRONMENT_HINT: turn.system }
      yield* runCli({ bin: path, args: hermesArgs(turn, provider), stdin: turn.prompt, cwd: turn.cwd, signal: turn.signal, parser: hermesParser(), env })
    }
  }
}
