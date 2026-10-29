import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import { hermesArgs, hermesHome, hermesParser, userHermesProviders } from '../src/core/engines/hermes'
import { parseHermesModels } from '../src/core/engines/detect'

// Fixture is real CLI output (`hermes chat --format stream-json`, Hermes 2026-10-29), trimmed.
const lines = readFileSync(join(import.meta.dirname, 'fixtures', 'hermes-stream.jsonl'), 'utf8').split('\n').filter((l) => l.trim())

describe('hermes', () => {
  it('turns its events into the engine events', () => {
    const p = hermesParser()
    const events = lines.flatMap((l) => p.line(l))
    expect(events).toContainEqual({ type: 'web', action: 'search', detail: 'Pi coding agent official site' })
    const end = p.end(0, '')
    expect(end).toEqual([
      {
        type: 'done',
        text: 'O endereço oficial do Pi coding agent é https://pi.dev (repo: https://github.com/earendil-works/pi).',
        // total = input + cache_read + output, so `input` alone misses the cache read.
        usage: { inputTokens: 5278 + 2048, cacheReadTokens: 2048, outputTokens: 28 }
      }
    ])
  })

  it('uses the final text, not the deltas', () => {
    const p = hermesParser()
    lines.flatMap((l) => p.line(l))
    expect(p.end(0, '')[0]).toMatchObject({ type: 'done', text: expect.stringContaining('https://pi.dev') })
  })

  it('reports an error result', () => {
    const p = hermesParser()
    p.line('{"type":"result","session_id":"x","exit_code":1,"text":"","tokens":{"input":0,"output":0,"total":0,"cache_read":0,"cache_write":0},"error":"No provider for genplat"}')
    expect(p.end(0, '')).toEqual([{ type: 'error', message: 'No provider for genplat' }])
  })

  it('reports an error when the process exits without a result', () => {
    const p = hermesParser()
    const end = p.end(1, 'boom\nsomething failed')
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({ type: 'error' })
    expect((end[0] as { message: string }).message).toContain('something failed')
  })

  it('ignores lines that are not JSON or not known', () => {
    const p = hermesParser()
    expect(p.line('not json')).toEqual([])
    expect(p.line('{"type":"tool_result","name":"web_search","output":"..."}')).toEqual([])
  })
})

describe('hermes setup', () => {
  it('runs the oneshot protocol with the model, effort and stdin query', () => {
    expect(hermesArgs({ model: 'genplat/deepseek-v4-flash-official', effort: 'high', images: [] })).toEqual([
      'chat',
      '--format',
      'stream-json',
      '--query-file',
      '-',
      '--ignore-rules',
      '--reasoning',
      'high',
      '-m',
      'genplat/deepseek-v4-flash-official'
    ])
  })

  it('names the provider of a bare model id from the user config, and attaches existing images only', () => {
    const args = hermesArgs({ model: 'deepseek-v4-flash-official', effort: 'low', images: [{ block: 0, path: '/tmp/inexistente.png', mime: 'image/png' }] }, 'genplat')
    expect(args).toEqual(['chat', '--format', 'stream-json', '--query-file', '-', '--ignore-rules', '--reasoning', 'low', '-m', 'deepseek-v4-flash-official', '--provider', 'genplat'])
  })

  it('builds an isolated home with the gateway, the web when allowed, and the user providers', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'hu-'))
    writeFileSync(join(userHome, 'config.yaml'), 'providers:\n  genplat:\n    base_url: https://llm.acme.com/v1\n    api_mode: chat_completions\nmcp_servers:\n  atlassian:\n    command: uvx\nmodel:\n  provider: genplat\n')
    writeFileSync(join(userHome, 'auth.json'), '{}')
    writeFileSync(join(userHome, '.env'), 'CUSTOM_API_KEY=x')
    const appDir = mkdtempSync(join(tmpdir(), 'hh-'))
    const home = hermesHome(appDir, { system: 'Você é a Iris.', mcpUrl: 'http://127.0.0.1:1/mcp/x', web: false }, userHome)
    expect(lstatSync(join(home, 'auth.json')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(home, '.env')).isSymbolicLink()).toBe(true)
    const c = parseYaml(readFileSync(join(home, 'config.yaml'), 'utf8')) as Record<string, unknown>
    expect(c['approvals']).toEqual({ mode: 'off' })
    expect(c['platform_toolsets']).toEqual({ cli: [] }) // no built-in tools, no web
    expect(c['mcp_servers']).toEqual({ tucano: { url: 'http://127.0.0.1:1/mcp/x' } })
    expect(c['providers']).toEqual({ genplat: { base_url: 'https://llm.acme.com/v1', api_mode: 'chat_completions' } })
    expect(c['model']).toEqual({ provider: 'genplat' })
    expect(Object.keys(c['mcp_servers'] as object)).not.toContain('atlassian')
  })

  it('turns the web on as the only built-in toolset', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'hw-'))
    const home = hermesHome(appDir, { system: 's', mcpUrl: undefined, web: true }, mkdtempSync(join(tmpdir(), 'hu2-')))
    const c = parseYaml(readFileSync(join(home, 'config.yaml'), 'utf8')) as Record<string, unknown>
    expect(c['platform_toolsets']).toEqual({ cli: ['web'] })
    expect(c['mcp_servers']).toBeUndefined()
  })

  it("takes only the providers from the user's config.yaml", () => {
    const userHome = mkdtempSync(join(tmpdir(), 'hu3-'))
    writeFileSync(join(userHome, 'config.yaml'), 'providers:\n  genplat:\n    base_url: https://x/v1\napprovals:\n  mode: manual\n')
    expect(userHermesProviders(userHome)).toEqual({ providers: { genplat: { base_url: 'https://x/v1' } } })
    expect(userHermesProviders(join(tmpdir(), 'vazio-'))).toEqual({})
  })

  it('rewrites the home every turn (the gateway changes with it)', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'he-'))
    hermesHome(appDir, { system: 's1', mcpUrl: 'http://127.0.0.1:1/mcp/a', web: false })
    const home = hermesHome(appDir, { system: 's2', mcpUrl: undefined, web: false })
    const c = parseYaml(readFileSync(join(home, 'config.yaml'), 'utf8')) as Record<string, unknown>
    expect(existsSync(join(home, 'config.yaml'))).toBe(true)
    expect(c['mcp_servers']).toBeUndefined() // the last turn's gateway is gone
  })

  it('reads the model ids from the provider cache', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-'))
    // Shape of the real cache: one entry per credential, models per entry.
    writeFileSync(
      join(dir, 'provider_models_cache.json'),
      JSON.stringify({
        copilot: { fp: 'x', at: 1, models: ['gpt-5.4', 'claude-sonnet-5'] },
        'custom:https://llm.acme.com/api/v2#aa2f87b585a35b95': { fp: 'y', at: 2, models: ['deepseek-v4-flash'] },
        'custom:https://broken#z': { fp: 'z', at: 3, models: ['m'] }
      })
    )
    expect(parseHermesModels(join(dir, 'provider_models_cache.json'))).toEqual(['copilot/gpt-5.4', 'copilot/claude-sonnet-5', 'llm.acme.com/deepseek-v4-flash', 'broken/m'])
    expect(parseHermesModels(join(dir, 'missing.json'))).toEqual([])
  })
})
