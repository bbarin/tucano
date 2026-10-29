import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hermesParser } from '../src/core/engines/hermes'

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
