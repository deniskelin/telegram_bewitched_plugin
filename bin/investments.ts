#!/usr/bin/env bun
/** Local setup: secrets never pass through Telegram or an agent tool call. */
import { existsSync, writeFileSync } from 'fs'
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
} else if (command === 'check' && path) {
  loadEnv()
  const config = loadInvestmentConfig(path)!
  console.log(
    JSON.stringify(
      {
        valid: true,
        enabled: config.enabled,
        accounts: config.accounts.length,
        configuredCredentials: config.accounts.filter((a) => !!process.env[a.tokenEnv]).length,
        feeds: config.feeds.length,
        timezone: config.timezone
      },
      null,
      2
    )
  )
} else {
  console.log('Usage: bun bin/investments.ts init <private-file> <chat-id> <thread-id> | check <private-file>')
  process.exitCode = 1
}
