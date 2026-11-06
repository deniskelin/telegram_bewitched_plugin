import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AccountRegistry, accountHandle } from '../src/modules/investments/accounts.ts'
import { AccountSetup, keyWriteCommand } from '../src/modules/investments/setup.ts'
import { inspectReadOnlyAccounts, probeReadOnlyAccount } from '../src/modules/investments/broker.ts'
import { loadInvestmentConfig } from '../src/modules/investments/config.ts'
import { InvestmentService } from '../src/modules/investments/service.ts'
import { InvestmentRepository } from '../src/modules/investments/repository.ts'
import type { Config, AccountData, KV } from '../src/modules/investments/types.ts'
const initial = (): Config => ({
  enabled: false,
  chatId: '-100',
  threadId: 1316,
  timezone: 'Europe/Moscow',
  morning: '10:00',
  close: 'main',
  accounts: [],
  feeds: [],
  maxPositionPct: 30,
  priceAlertPct: 5,
  portfolioImpactPct: 1
})
const a = { id: 'one', name: 'Broker', type: 'ACCOUNT_TYPE_TINKOFF' }
const secret = 'not-a-real-broker-key-private'
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'invest-accounts-')),
    path = join(dir, 'config.json'),
    config = initial()
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
  const registry = new AccountRegistry(config, path)
  return { dir, path, config, registry, close: () => rmSync(dir, { recursive: true, force: true }) }
}
test('account CRUD persists encrypted credentials, preserves roles and removes replaced keys', () => {
  const f = fixture()
  try {
    f.registry.add(a, 'Main', 'observe', secret)
    const first = f.config.accounts[0]!,
      ref = first.credentialRef!
    expect(f.registry.find(accountHandle(a.id))?.name).toBe('Main')
    expect(f.registry.token(first.tokenEnv)).toBe(secret)
    f.registry.rename(a.id, 'Renamed')
    f.registry.role(a.id, 'strategy')
    f.registry.enable()
    expect(f.config.enabled).toBe(true)
    expect(f.config.accounts[0]?.strategy).toBe(true)
    const restarted = new AccountRegistry(loadInvestmentConfig(f.path)!, f.path)
    expect(restarted.token(first.tokenEnv)).toBe(secret)
    restarted.replace(a.id, secret + '-rotated', a.type)
    expect(restarted.vault.has(ref)).toBe(false)
    for (const file of readdirSync(f.dir)) {
      expect(statSync(join(f.dir, file)).mode & 0o077).toBe(0)
      expect(readFileSync(join(f.dir, file)).includes(Buffer.from(secret))).toBe(false)
    }
    restarted.remove(a.id)
    expect(restarted.config.accounts).toHaveLength(0)
    expect(restarted.config.enabled).toBe(false)
    expect(readFileSync(f.path + '.keys', 'utf8')).toBe('{}')
  } finally {
    f.close()
  }
})
test('account constraints and external config edits cannot partially commit a new key', () => {
  const f = fixture()
  try {
    f.registry.add(a, 'One', 'strategy', secret)
    expect(() => f.registry.add(a, 'Again', 'observe', secret)).toThrow('duplicate')
    expect(() => f.registry.add({ ...a, id: 'two' }, 'Two', 'strategy', secret)).toThrow('strategy')
    expect(() => f.registry.role(a.id, 'bad' as any)).toThrow('invalid')
    expect(() => f.registry.rename(a.id, '\n')).toThrow()
    for (const id of ['two', 'three', 'four']) f.registry.add({ ...a, id }, id, 'observe', secret)
    expect(() => f.registry.add({ ...a, id: 'five' }, 'Five', 'observe', secret)).toThrow('limit')
    f.registry.remove('four')
    const before = readFileSync(f.path + '.keys', 'utf8')
    writeFileSync(f.path, readFileSync(f.path, 'utf8') + '\n')
    expect(() => f.registry.add({ ...a, id: 'new' }, 'New', 'observe', secret)).toThrow('conflict')
    expect(readFileSync(f.path + '.keys', 'utf8')).toBe(before)
    expect(f.config.accounts).toHaveLength(3)
  } finally {
    f.close()
  }
})
test('broker setup accepts only read-only open accounts and probes the selected portfolio', async () => {
  let access = 'ACCOUNT_ACCESS_LEVEL_FULL_ACCESS',
    status = 'ACCOUNT_STATUS_OPEN',
    portfolio = true
  const fetcher = (async (url: any) =>
    Response.json(
      String(url).endsWith('GetAccounts')
        ? { accounts: [{ ...a, accessLevel: access, status }] }
        : portfolio
          ? { positions: [], totalAmountPortfolio: { units: '0', nano: 0, currency: 'rub' } }
          : {}
    )) as typeof fetch
  await expect(inspectReadOnlyAccounts(secret, fetcher)).rejects.toThrow('Read-only')
  access = 'ACCOUNT_ACCESS_LEVEL_READ_ONLY'
  status = 'ACCOUNT_STATUS_CLOSED'
  await expect(inspectReadOnlyAccounts(secret, fetcher)).rejects.toThrow('No open')
  status = 'ACCOUNT_STATUS_OPEN'
  expect((await inspectReadOnlyAccounts(secret, fetcher))[0]?.id).toBe(a.id)
  await probeReadOnlyAccount(secret, a.id, fetcher)
  portfolio = false
  await expect(probeReadOnlyAccount(secret, a.id, fetcher)).rejects.toThrow('Portfolio incomplete')
})
test('account changes invalidate in-flight reads and queued reports', async () => {
  const values = new Map<string, string>(),
    kv: KV = {
      get: (k) => values.get(k) ?? null,
      set: (k, v) => {
        if (v === null) values.delete(k)
        else values.set(k, v)
      },
      keys: (p) => [...values.keys()].filter((k) => k.startsWith(p))
    }
  const config = { ...initial(), enabled: true, accounts: [{ ...a, tokenEnv: 'INVEST_A' }] },
    repo = new InvestmentRepository(kv)
  let resolve!: (d: AccountData) => void
  const sent: string[] = []
  const service = new InvestmentService(
    config,
    repo,
    {
      account: () =>
        new Promise<AccountData>((r) => {
          resolve = r
        }),
      schedule: async () => []
    },
    async (text) => {
      sent.push(text)
      return 1
    }
  )
  repo.queue('old', 'Private old report', Date.now())
  const tick = service.tick(Date.now(), true)
  service.settingsChanged()
  config.accounts = []
  config.enabled = false
  resolve({
    snapshot: { at: Date.now(), account: a.id, nav: '0', currency: 'rub', positions: [] },
    operations: [],
    payments: [],
    warnings: []
  })
  await tick
  await service.flush(Date.now())
  expect(sent).toHaveLength(0)
  expect(repo.account(a.id)).toBeNull()
  expect(repo.read<any>(repo.keys('outbox:')[0]!, null).status).toBe('cancelled')
})

test('account UI scopes changes, sends key-file instructions only by DM and binds rename to its prompt', async () => {
  const { Bot } = await import('grammy'),
    { FakeTelegram } = await import('./fake-telegram.ts'),
    { registerAccountUI } = await import('../src/modules/investments/account-ui.ts'),
    { investmentScope } = await import('../src/modules/investments/ui.ts')
  const f = fixture(),
    tg = new FakeTelegram()
  try {
    f.registry.add(a, 'Main', 'observe', secret)
    const portal = new AccountSetup(
      f.registry,
      () => '111',
      async () => [a],
      async () => {}
    )
    const bot = new Bot('123:TEST', { client: { apiRoot: tg.apiRoot } })
    registerAccountUI(bot, f.registry, portal, investmentScope)
    let forwarded = 0
    bot.on('message', () => {
      forwarded++
    })
    await bot.init()
    let id = 1
    const callback = async (data: string, thread = 1316, user = 111) =>
      bot.handleUpdate({
        update_id: id++,
        callback_query: {
          id: String(id),
          chat_instance: 'instance',
          from: { id: user, is_bot: false, first_name: 'Owner' },
          data,
          message: {
            message_id: 88,
            date: 1,
            chat: { id: -100, type: 'supergroup', title: 'Investments' },
            message_thread_id: thread,
            text: 'Menu'
          }
        }
      } as any)
    const handle = accountHandle(a.id)
    await callback(`iva:card:${handle}`, 37)
    expect(tg.callsOf('editMessageText')).toHaveLength(0)
    await callback(`iva:card:${handle}`, 1316, 222)
    expect(tg.callsOf('editMessageText')).toHaveLength(0)
    await callback(`iva:card:${handle}`)
    expect(String(tg.callsOf('editMessageText').at(-1)?.body.text)).toContain('Main')
    await callback(`iva:key:${handle}`)
    const links = tg
      .callsOf('sendMessage')
      .filter((c) => JSON.stringify(c.body.reply_markup ?? {}).includes('copy_text'))
    expect(links).toHaveLength(1)
    expect(String(links[0]!.body.chat_id)).toBe('111')
    expect(JSON.stringify(tg.calls)).not.toContain(secret)
    await callback(`iva:rename:${handle}`)
    const prompt = tg.callsOf('sendMessage').find((c) => (c.body.reply_markup as any)?.force_reply)!
    expect(String(prompt.body.chat_id)).toBe('111')
    // FakeTelegram allocates IDs monotonically starting at 1000 for sendMessage.
    const promptId = 1000 + tg.callsOf('sendMessage').indexOf(prompt)
    const message = async (replyId: number, text: string) =>
      bot.handleUpdate({
        update_id: id++,
        message: {
          message_id: id,
          date: 1,
          from: { id: 111, is_bot: false, first_name: 'Owner' },
          chat: { id: 111, type: 'private', first_name: 'Owner' },
          text,
          reply_to_message: {
            message_id: replyId,
            date: 1,
            chat: { id: 111, type: 'private', first_name: 'Owner' },
            text: 'Name'
          }
        }
      } as any)
    await message(promptId + 999, 'Unrelated')
    expect(forwarded).toBe(1)
    await message(promptId, 'New name')
    expect(forwarded).toBe(1)
    expect(f.config.accounts[0]?.name).toBe('New name')
    const pending = portal.list()[0]!
    writeFileSync(portal.keyFile(pending.id), secret + 'rotated')
    await callback(`iva:verify:${pending.id}`)
    await tg.waitFor('editMessageText', (c) => String(c.body.text).includes('Выберите счёт для подключения'))
    await callback(`iva:pick:${pending.id}:${handle}`)
    await tg.waitFor('editMessageText', (c) => String(c.body.text).includes('Счёт сохранён.'))
    expect(f.registry.token(f.config.accounts[0]!.tokenEnv)).toBe(secret + 'rotated')
    expect(portal.list()).toHaveLength(0)
    await callback(`iva:remove:${handle}`)
    expect(f.config.accounts).toHaveLength(1)
    await callback(`iva:confirm:${handle}`)
    expect(f.config.accounts).toHaveLength(0)
  } finally {
    tg.stop()
    f.close()
  }
})

test('a cancelled report can be rebuilt from current accounts without breaking sent-report deduplication', () => {
  const values = new Map<string, string>(),
    kv: KV = {
      get: (k) => values.get(k) ?? null,
      set: (k, v) => {
        if (v === null) values.delete(k)
        else values.set(k, v)
      },
      keys: (p) => [...values.keys()].filter((k) => k.startsWith(p))
    },
    repo = new InvestmentRepository(kv)
  repo.queue('morning:today', 'Old account', 1)
  const key = repo.keys('outbox:')[0]!,
    old = repo.read<any>(key, null)
  repo.save(key, { ...old, status: 'cancelled' })
  repo.queue('morning:today', 'Current account', 2)
  expect(repo.read<any>(key, null).text).toBe('Current account')
  repo.save(key, { ...repo.read<any>(key, null), status: 'sent' })
  repo.queue('morning:today', 'Duplicate', 3)
  expect(repo.read<any>(key, null).text).toBe('Current account')
})

test('monitoring can be enabled and the last account disconnected without a daemon restart', async () => {
  const { Bot } = await import('grammy'),
    { FakeTelegram } = await import('./fake-telegram.ts'),
    { registerInvestments } = await import('../src/modules/investments/ui.ts'),
    { Store } = await import('../src/db.ts')
  const f = fixture(),
    tg = new FakeTelegram(),
    previous = process.env.INVESTMENTS_CONFIG
  writeFileSync(f.path, JSON.stringify({ ...initial(), accounts: [{ ...a, tokenEnv: 'INVEST_MISSING_TEST' }] }), {
    mode: 0o600
  })
  process.env.INVESTMENTS_CONFIG = f.path
  const d = { store: new Store(':memory:'), backgroundModules: new Set<string>(), log: () => {} } as any
  try {
    const bot = new Bot('123:TEST', { client: { apiRoot: tg.apiRoot } })
    registerInvestments(d, bot)
    await bot.init()
    let id = 0
    const callback = async (data: string) =>
      bot.handleUpdate({
        update_id: ++id,
        callback_query: {
          id: String(id),
          chat_instance: 'instance',
          from: { id: 111, is_bot: false, first_name: 'Owner' },
          data,
          message: { message_id: 88, date: 1, chat: { id: 111, type: 'private', first_name: 'Owner' }, text: 'Menu' }
        }
      } as any)
    expect(d.backgroundModules.size).toBe(0)
    await callback('iv:resume:0')
    expect(d.backgroundModules.has('investments')).toBe(true)
    expect(loadInvestmentConfig(f.path)?.enabled).toBe(true)
    await callback('iva:confirm:' + accountHandle(a.id))
    expect(d.backgroundModules.size).toBe(0)
    expect(loadInvestmentConfig(f.path)?.accounts).toHaveLength(0)
    expect(loadInvestmentConfig(f.path)?.enabled).toBe(false)
  } finally {
    tg.stop()
    d.store.close()
    if (previous === undefined) delete process.env.INVESTMENTS_CONFIG
    else process.env.INVESTMENTS_CONFIG = previous
    f.close()
  }
})

test('private key files survive restart, verify read-only access and disappear after successful connection', async () => {
  const f = fixture()
  let probed = false
  const inspect = async (token: string) => {
      expect(token).toBe(secret)
      return [a]
    },
    probe = async (token: string, id: string) => {
      expect(token).toBe(secret)
      expect(id).toBe(a.id)
      probed = true
    }
  try {
    const setup = new AccountSetup(f.registry, () => '111', inspect, probe),
      request = setup.issue('observe'),
      path = setup.keyFile(request.id)
    expect(readFileSync(path, 'utf8')).toBe('')
    expect(statSync(path).mode & 0o077).toBe(0)
    await expect(setup.accounts(request.id)).rejects.toThrow('invalid')
    writeFileSync(path, secret + '\n')
    const restarted = new AccountSetup(f.registry, () => '111', inspect, probe)
    expect(restarted.list()).toHaveLength(1)
    expect((await restarted.accounts(request.id))[0]?.id).toBe(a.id)
    await restarted.commit(request.id, a.id, 'Main')
    expect(probed).toBe(true)
    expect(restarted.list()).toHaveLength(0)
    expect(() => readFileSync(path)).toThrow()
    expect(f.registry.token(f.config.accounts[0]!.tokenEnv)).toBe(secret)
  } finally {
    f.close()
  }
})
test('cancelled or wrong-account file setup cannot commit late; replacement never changes account identity', async () => {
  const f = fixture()
  let resolve!: () => void
  try {
    f.registry.add(a, 'Main', 'observe', secret)
    const setup = new AccountSetup(
        f.registry,
        () => '111',
        async () => [a, { ...a, id: 'two' }],
        () =>
          new Promise<void>((r) => {
            resolve = r
          })
      ),
      request = setup.issue('observe', a.id)
    writeFileSync(setup.keyFile(request.id), secret + 'new')
    await expect(setup.commit(request.id, 'two', 'Wrong')).rejects.toThrow('missing')
    const commit = setup.commit(request.id, a.id, 'Same')
    while (!resolve) await Bun.sleep(1)
    setup.cancel(request.id)
    resolve()
    await expect(commit).rejects.toThrow('missing')
    expect(f.registry.token(f.config.accounts[0]!.tokenEnv)).toBe(secret)
    expect(f.config.accounts).toHaveLength(1)
  } finally {
    f.close()
  }
})
test('key file commands quote paths safely and local setup is owner-scoped and bounded', async () => {
  const f = fixture()
  try {
    const setup = new AccountSetup(
      f.registry,
      () => '111',
      async () => [a]
    )
    for (let i = 0; i < 4; i++) setup.issue(i === 3 ? 'strategy' : 'observe')
    expect(() => setup.issue('observe')).toThrow('limit')
    expect(new AccountSetup(f.registry, () => '222').list()).toHaveLength(0)
    const request = setup.list()[0]!,
      file = setup.keyFile(request.id)
    writeFileSync(file, secret)
    const { chmodSync } = await import('fs')
    chmodSync(file, 0o644)
    await expect(setup.accounts(request.id)).rejects.toThrow('invalid')
    expect(keyWriteCommand("/private/a'$(touch NO).key")).toContain("'\\''")
    expect(keyWriteCommand(file)).not.toContain(secret)
  } finally {
    f.close()
  }
})
