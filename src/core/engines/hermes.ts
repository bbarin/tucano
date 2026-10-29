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
          text = whole || text.replace(/\n\n/g, '')
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
