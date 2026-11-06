#!/usr/bin/env bun
/** Local setup: secrets never pass through Telegram or an agent tool call. */
import { existsSync, writeFileSync } from 'fs'
import { owner } from '../src/access.ts'
import { AccountSetup, keyWriteCommand } from '../src/modules/investments/setup.ts'
import { AccountRegistry, CredentialVault } from '../src/modules/investments/accounts.ts'
import { loadEnv } from '../src/config.ts'
import { loadInvestmentConfig, validateConfig } from '../src/modules/investments/config.ts'
const [command, path, chat, thread] = process.argv.slice(2)
if (command === 'init' && path && chat && thread) {
  if (existsSync(path)) throw new Error('Refusing to overwrite existing configuration')
  const sample = {
    enabled: false,
    chatId: chat,
    threadId: Number(thread),
    timezone: 'Europe/Moscow',
    morning: '10:00',
    close: 'main',
    accounts: [],
    feeds: [],
    maxPositionPct: 30,
    priceAlertPct: 5,
    portfolioImpactPct: 1
  }
  validateConfig(sample)
  writeFileSync(path, JSON.stringify(sample, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(
    'Created disabled configuration. Add selected account IDs, aliases and token environment names locally; set INVESTMENTS_CONFIG to this path. Never paste tokens into Telegram.'
  )
} else if (command === 'prepare' && path) {
  loadEnv()
  const config = loadInvestmentConfig(path)!,
    registry = new AccountRegistry(config, path),
    setup = new AccountSetup(registry, owner)
  if (!owner()) throw new Error('Owner is not configured')
  if (setup.list().length === 0)
    for (let i = 0; i < 4 - config.accounts.length; i++)
      setup.issue(i === 3 - config.accounts.length && !config.accounts.some((a) => a.strategy) ? 'strategy' : 'observe')
  console.log(
    JSON.stringify(
      setup.list().map((r) => ({
        id: r.id,
        role: r.role,
        keyFile: setup.keyFile(r.id),
        command: keyWriteCommand(setup.keyFile(r.id))
      })),
      null,
      2
    )
  )
} else if (command === 'check' && path) {
  loadEnv()
  const config = loadInvestmentConfig(path)!
  const vault = config.accounts.some((a) => a.credentialRef) ? new CredentialVault(path + '.keys') : undefined
  console.log(
    JSON.stringify(
      {
        valid: true,
        enabled: config.enabled,
        accounts: config.accounts.length,
        configuredCredentials: config.accounts.filter((a) =>
          a.credentialRef ? !!vault?.get(a.credentialRef) : !!process.env[a.tokenEnv]
        ).length,
        feeds: config.feeds.length,
        timezone: config.timezone
      },
      null,
      2
    )
  )
} else {
  console.log(
    'Usage: bun bin/investments.ts init <private-file> <chat-id> <thread-id> | prepare <private-file> | check <private-file>'
  )
  process.exitCode = 1
}
