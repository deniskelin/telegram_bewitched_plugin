/**
 * Real processes: the MCP client (server.ts) over stdio spawns the daemon
 * detached; tools are listed and a call round-trips through the daemon.
 */

import { afterAll, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFileSync } from 'fs'
import { join } from 'path'
import './setup.ts'

const stateDir = process.env.TELEGRAM_BEWITCHED_STATE_DIR!
let client: Client | null = null

afterAll(async () => {
  await client?.close()
  try {
    process.kill(parseInt(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'), 10), 'SIGTERM')
  } catch {}
})

test('server.ts starts the daemon and proxies tool calls', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, '..', 'server.ts')],
    env: { ...process.env } as Record<string, string>,
    stderr: 'pipe',
  })
  client = new Client({ name: 'test', version: '0' })
  await client.connect(transport)
  const { tools } = await client.listTools()
  expect(tools.map(t => t.name)).toContain('ask_user')
  expect(tools.map(t => t.name)).toContain('notify')

  // Passive when the test runs outside a channel-enabled Claude session (tools refused),
  // active when run from inside one (no topics group in the temp state).
  let result: Awaited<ReturnType<Client['callTool']>> | null = null
  for (let i = 0; i < 50; i++) {
    result = await client.callTool({ name: 'list_topics', arguments: {} })
    const text = (result.content as { text: string }[])[0].text
    if (!text.includes('not connected')) break
    await Bun.sleep(200)
  }
  const text = (result!.content as { text: string }[])[0].text
  expect(text).toMatch(/not registered as a channel|no topics group connected/)
  expect(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')).toMatch(/^\d+$/)
}, 30_000)
