import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConnectorManager } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { plainCipher, Secrets } from '../src/core/secrets'

let server: Server
let base: string
let db: Db
let connectors: ConnectorManager

// An MCP server behind OAuth whose authorization server has no registration
// endpoint, like GitHub's: only apps registered ahead of time may sign in.
beforeEach(async () => {
  server = createServer((req, res) => {
    const json = (body: unknown): void => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (req.url?.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: `${base}/mcp`, authorization_servers: [base] })
    if (req.url?.startsWith('/.well-known/oauth-authorization-server')) {
      return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] })
    }
    res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  db = new Db(join(mkdtempSync(join(tmpdir(), 'tucano-connectors-')), 'test.db'))
  connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => 'http://127.0.0.1:1/oauth/callback' })
})

afterEach(async () => {
  await connectors.closeAll()
  db.close()
  await new Promise((resolve) => server.close(resolve))
})

describe('OAuth on a server that takes no new apps', () => {
  it('says to add it with a token instead of the SDK error', async () => {
    const id = await connectors.add({ name: 'GitHub', kind: 'remote', url: `${base}/mcp`, auth: 'oauth' })
    await connectors.authorize(id)
    const c = connectors.get(id)!
    expect(c.status).toBe('error')
    expect(c.error).toMatch(/token/)
    expect(c.error).not.toMatch(/Incompatible/)
  })
})
