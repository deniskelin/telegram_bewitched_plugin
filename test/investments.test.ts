import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { nano, decimal, format, performance, closeAt, localDay, dayStart } from '../src/modules/investments/core.ts'
import { validateConfig, loadInvestmentConfig } from '../src/modules/investments/config.ts'
import { ReadOnlyBroker } from '../src/modules/investments/broker.ts'
import { InvestmentRepository } from '../src/modules/investments/repository.ts'
import { InvestmentService } from '../src/modules/investments/service.ts'
import { paperStep } from '../src/modules/investments/paper.ts'
import { parseFeed, publicUrl } from '../src/modules/investments/news.ts'
import { render } from '../src/modules/investments/render.ts'
import { exportCalendar, investmentScope } from '../src/modules/investments/ui.ts'
import type { AccountData, Broker, Config, KV, Snapshot } from '../src/modules/investments/types.ts'
const at = Date.parse('2026-11-07T08:00:00Z')
const config: Config = {
  enabled: true,
  chatId: '-100',
  threadId: 1316,
  timezone: 'Europe/Moscow',
  morning: '10:00',
  close: 'main',
  accounts: [{ id: 'a', name: 'Primary', tokenEnv: 'INVEST_A' }],
  feeds: [],
  maxPositionPct: 30,
  priceAlertPct: 5,
  portfolioImpactPct: 1
}
function store(): KV {
  const map = new Map<string, string>()
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => {
      if (v === null) map.delete(k)
      else map.set(k, v)
    },
    keys: (p) => [...map.keys()].filter((k) => k.startsWith(p))
  }
}
const data = (time = at): AccountData => ({
  snapshot: {
    at: time,
    account: 'a',
    nav: decimal('1000').toString(),
    currency: 'rub',
    positions: [
      {
        id: 'uid',
        figi: 'figi',
        type: 'share',
        quantity: decimal('2').toString(),
        price: decimal('100').toString(),
        currency: 'rub',
        expectedYield: '0'
      }
    ]
  },
  operations: [],
  payments: [],
  warnings: []
})
function fixture() {
  let calls = 0
  const broker: Broker = {
      account: async (_, now) => {
        calls++
        return data(now)
      },
      schedule: async () => [
        {
          date: '2026-11-07T00:00:00Z',
          isTradingDay: true,
          endTime: '2026-11-07T16:00:00Z',
          eveningEndTime: '2026-11-07T20:50:00Z'
        }
      ]
    },
    repo = new InvestmentRepository(store()),
    sent: string[] = [],
    service = new InvestmentService(config, repo, broker, async (text) => {
      sent.push(text)
      return sent.length
    })
  return { broker, repo, sent, service, calls: () => calls }
}
test('exact money, input validation, no binary floating point accumulation', () => {
  expect(nano({ units: '9007199254740993', nano: 1 })).toBe(9007199254740993000000001n)
  expect(format(decimal('-123.45'))).toBe('-123.45')
  expect(() => nano(undefined)).toThrow()
  expect(() => decimal('1e3')).toThrow()
  expect(() => nano({ units: '1.2' })).toThrow()
  expect(() => nano({ units: 0, nano: 1e9 })).toThrow()
})
test('NAV result excludes external flows and keeps dividends in NAV once; unsupported transfers stay unknown', () => {
  const before = data().snapshot,
    after = { ...before, at: at + 1000, nav: decimal('1150').toString() }
  const op = {
    id: 'op',
    at: at + 500,
    type: 'OPERATION_TYPE_INPUT',
    state: 'OPERATION_STATE_EXECUTED',
    amount: decimal('100').toString(),
    currency: 'rub',
    instrument: '',
    name: ''
  }
  expect(performance(before, after, [op])).toBe(decimal('50'))
  expect(performance(before, after, [{ ...op, type: 'OPERATION_TYPE_DIVIDEND' }])).toBe(decimal('150'))
  expect(performance(before, after, [{ ...op, type: 'OPERATION_TYPE_TRANS_BS_BS' }])).toBeNull()
  expect(performance(undefined, after, [])).toBeNull()
})
test('timezone midnight and exchange calendar decide closing, including weekends and nontrading days', () => {
  expect(localDay(at, 'Europe/Moscow')).toBe('2026-11-07')
  expect(new Date(dayStart(at, 'Europe/Moscow')).toISOString()).toBe('2026-11-06T21:00:00.000Z')
  expect(closeAt({ date: '', isTradingDay: false, endTime: new Date(at).toISOString() }, 'main')).toBeNull()
  const day = {
    date: '',
    isTradingDay: true,
    endTime: new Date(at).toISOString(),
    eveningEndTime: new Date(at + 1000).toISOString()
  }
  expect(closeAt(day, 'last')).toBe(at + 1000)
  expect(closeAt(day, 'main')).toBe(at)
})
test('private configuration validation and secrets absent from configuration output', () => {
  expect(validateConfig(config)).toEqual(config)
  expect(() => validateConfig({ ...config, accounts: [] })).toThrow()
  expect(() => validateConfig({ ...config, accounts: [...config.accounts, ...config.accounts] })).toThrow()
  expect(() => validateConfig({ ...config, morning: '25:00' })).toThrow()
  const dir = mkdtempSync(join(tmpdir(), 'invest-config-')),
    path = join(dir, 'config.json')
  try {
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
    expect(loadInvestmentConfig(path)?.accounts[0]?.tokenEnv).toBe('INVEST_A')
    chmodSync(path, 0o644)
    expect(() => loadInvestmentConfig(path)).toThrow()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('broker rejects full-access tokens before reading portfolio and never exposes broker error bodies', async () => {
  const calls: string[] = []
  const fetcher = async (url: any) => {
    calls.push(String(url))
    return Response.json({ accounts: [{ id: 'a', accessLevel: 'ACCOUNT_ACCESS_LEVEL_FULL_ACCESS' }] })
  }
  const broker = new ReadOnlyBroker(() => 'SECRET', fetcher as typeof fetch, 'INVEST_A')
  await expect(broker.account(config.accounts[0]!, at, at - 1000)).rejects.toThrow('read-only')
  expect(calls).toHaveLength(1)
  expect(calls[0]).toContain('/GetAccounts')
  const failing = new ReadOnlyBroker(
    () => 'SECRET',
    (async () => new Response('SECRET broker diagnostics', { status: 403 })) as unknown as typeof fetch
  )
  await expect(failing.account(config.accounts[0]!, at, 0)).rejects.toThrow('Broker request failed (403)')
})
test('read-only broker paginates operations, preserves exact NAV and fails on a repeated cursor', async () => {
  let pages = 0
  const methods: string[] = []
  const fetcher = async (url: any, init: any) => {
    const method = String(url).split('/').at(-1)!
    methods.push(method)
    if (method === 'GetAccounts')
      return Response.json({ accounts: [{ id: 'a', accessLevel: 'ACCOUNT_ACCESS_LEVEL_READ_ONLY' }] })
    if (method === 'GetPortfolio')
      return Response.json({ totalAmountPortfolio: { units: '1000', nano: 1, currency: 'rub' }, positions: [] })
    const body = JSON.parse(init.body)
    pages++
    expect(body.accountId).toBe('a')
    return Response.json({
      items: [
        {
          id: 'op' + pages,
          date: new Date(at).toISOString(),
          type: 'OPERATION_TYPE_COUPON',
          state: 'OPERATION_STATE_EXECUTED',
          payment: { units: 10, currency: 'rub' }
        }
      ],
      hasNext: pages === 1,
      nextCursor: 'page2'
    })
  }
  const broker = new ReadOnlyBroker(() => 'SECRET', fetcher as typeof fetch, 'INVEST_A'),
    result = await broker.account(config.accounts[0]!, at, at - 1000)
  expect(result.operations).toHaveLength(2)
  expect(result.snapshot.nav).toBe('1000000000001')
  expect(methods).toEqual(['GetAccounts', 'GetPortfolio', 'GetOperationsByCursor', 'GetOperationsByCursor'])
})
test('repository upserts amended operations, clears an empty fresh calendar, isolates destinations', () => {
  const kv = store(),
    repo = new InvestmentRepository(kv, 'one'),
    d = data(),
    op = {
      id: 'x',
      at,
      type: 'OPERATION_TYPE_DIVIDEND',
      state: 'OPERATION_STATE_EXECUTED',
      amount: '1',
      currency: 'rub',
      instrument: 'uid',
      name: ''
    }
  repo.saveAccount('a', {
    ...d,
    operations: [op],
    calendarFresh: true,
    payments: [
      {
        id: 'p',
        instrument: 'uid',
        kind: 'dividend',
        date: new Date(at).toISOString(),
        amount: '1',
        currency: 'rub',
        quantity: '1',
        status: 'announced'
      }
    ]
  })
  repo.saveAccount('a', { ...d, operations: [{ ...op, state: 'OPERATION_STATE_CANCELED' }], calendarFresh: true })
  expect(repo.account('a')?.operations).toHaveLength(1)
  expect(repo.account('a')?.operations[0]?.state).toBe('OPERATION_STATE_CANCELED')
  expect(repo.account('a')?.payments).toEqual([])
  expect(new InvestmentRepository(kv, 'two').account('a')).toBeNull()
})
test('monitoring works without sessions or LLM and suppresses duplicate schedules across restart', async () => {
  const { service, repo, broker, sent, calls } = fixture()
  await service.tick(at)
  expect(calls()).toBe(1)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('Источники новостей не настроены')
  const restarted = new InvestmentService(config, repo, broker, async (text) => {
    sent.push(text)
    return 1
  })
  await restarted.tick(at + 10 * 60_000)
  expect(calls()).toBe(2)
  expect(sent).toHaveLength(1)
  repo.save('paused', true)
  await restarted.tick(at + 20 * 60_000)
  expect(calls()).toBe(2)
})
test('failed Telegram delivery survives a wrapper restart and acknowledgements advance news cursor only on success', async () => {
  const { repo, broker } = fixture()
  let attempts = 0
  const failing = new InvestmentService(config, repo, broker, async () => {
    attempts++
    throw new Error('offline')
  })
  await failing.tick(at)
  expect(repo.read('newsCutoff', 0)).toBe(0)
  const restored = new InvestmentService(config, repo, broker, async () => {
    attempts++
    return 77
  })
  await restored.tick(at + 10000)
  expect(attempts).toBe(2)
  expect(repo.read('newsCutoff', 0)).toBe(at)
  await restored.tick(at + 20000)
  expect(attempts).toBe(2)
})
test('no evening report without a verified schedule; main close and late pending retries remain explicit', async () => {
  const f = fixture()
  await f.service.tick(at)
  await f.service.tick(Date.parse('2026-11-07T16:06:00Z'))
  expect(f.sent).toHaveLength(2)
  const broken = fixture()
  broken.broker.schedule = async () => {
    throw new Error('offline')
  }
  await broken.service.tick(at)
  await broken.service.tick(Date.parse('2026-11-07T16:06:00Z'))
  expect(broken.sent).toHaveLength(1)
  expect(render(config, broken.repo)).toContain('Расписание биржи недоступно')
})
test('feed matching is limited to holdings, stale/future stories and unsafe URLs are rejected', async () => {
  const feed = { url: 'https://example.com/feed', name: 'Issuer', keywords: { uid: ['Example Issuer'] } },
    xml = `<rss><item><title>Example Issuer: объявлен дефолт</title><link>https://example.com/1</link><pubDate>${new Date(at).toUTCString()}</pubDate></item></rss>`
  expect(parseFeed(xml, feed, new Set(['uid']), at)[0]?.critical).toBe(true)
  expect(parseFeed(xml, feed, new Set(), at)).toEqual([])
  expect(parseFeed(xml.replace('example.com/1', 'evil.com/1'), feed, new Set(['uid']), at)).toEqual([])
  expect(parseFeed(xml.replace('объявлен дефолт', 'не объявлен дефолт'), feed, new Set(['uid']), at)[0]?.critical).toBe(
    false
  )
  await expect(publicUrl('https://127.0.0.1/feed')).rejects.toThrow()
})
test('critical headline signals are labelled for verification and deduplicated; empty cycles send nothing', async () => {
  const f = fixture(),
    feed = { url: 'https://example.com/feed', name: 'Issuer', keywords: { uid: ['Issuer'] } },
    n = {
      id: 'event',
      at,
      title: 'Issuer: объявлен дефолт',
      url: 'https://example.com/1',
      source: 'Issuer',
      instruments: ['uid'],
      critical: true
    }
  const c = { ...config, feeds: [feed] },
    service = new InvestmentService(
      c,
      f.repo,
      f.broker,
      async (text) => {
        f.sent.push(text)
        return 1
      },
      async () => [n]
    )
  await service.tick(at)
  await service.tick(at + 600000)
  expect(f.sent.filter((s) => s.includes('Требуется проверка новости'))).toHaveLength(1)
})
test('paper allocation is local only, respects cash/fees and refuses incomplete quote sets', () => {
  const p = data().snapshot.positions[0]!,
    settings = { cash: '1000', weights: { uid: 50 }, feeBps: 10 }
  const state = paperStep(undefined, settings, [p], at)
  expect(BigInt(state.cash)).toBeGreaterThanOrEqual(0n)
  expect(state.trades).toHaveLength(1)
  expect(BigInt(state.fees)).toBeGreaterThan(0n)
  const unchanged = paperStep(state, { ...settings, weights: { unknown: 50 } }, [p], at + 1000)
  expect(unchanged).toEqual(state)
})
test('module callbacks cannot expose portfolios to another user, chat or neighboring topic', () => {
  const ctx = (actor: number, chat: number, thread?: number) =>
    ({
      from: { id: actor },
      chat: { id: chat },
      callbackQuery: { message: { chat: { id: chat }, message_thread_id: thread } }
    }) as any
  expect(investmentScope(config, ctx(111, 111))).toBe(true)
  expect(investmentScope(config, ctx(111, -100, 1316))).toBe(true)
  expect(investmentScope(config, ctx(222, -100, 1316))).toBe(false)
  expect(investmentScope(config, ctx(111, -100, 37))).toBe(false)
})
test('calendar export is labelled as announced, stable and does not include account IDs or credentials', () => {
  const repo = new InvestmentRepository(store())
  repo.saveAccount('a', {
    ...data(),
    calendarFresh: true,
    payments: [
      {
        id: 'event',
        instrument: 'uid',
        kind: 'coupon',
        date: '2026-11-10T00:00:00Z',
        amount: '1000000000',
        currency: 'rub',
        quantity: '1000000000',
        status: 'announced'
      }
    ]
  })
  const ics = exportCalendar(config, repo)
  expect(ics).toContain('BEGIN:VEVENT')
  expect(ics).toContain('20261110')
  expect(ics).toContain('entitlement')
  expect(ics).not.toContain('INVEST_A')
})

test('headline matching respects issuer word boundaries, escapes regex characters and rejects stale or future timestamps', () => {
  const feed = { url: 'https://example.com/feed', name: 'Issuer', keywords: { uid: ['Газпром'] } },
    make = (title: string, time = at) =>
      `<rss><item><title>${title}</title><link>https://example.com/1</link><pubDate>${new Date(time).toUTCString()}</pubDate></item></rss>`
  expect(parseFeed(make('Газпромбанк: объявлен дефолт'), feed, new Set(['uid']), at)).toEqual([])
  expect(parseFeed(make('Газпром: объявлен дефолт'), feed, new Set(['uid']), at)).toHaveLength(1)
  expect(parseFeed(make('Газпром', at - 8 * 86400_000), feed, new Set(['uid']), at)).toEqual([])
  expect(parseFeed(make('Газпром', at + 600000), feed, new Set(['uid']), at)).toEqual([])
  expect(
    parseFeed(make('A+ Corp: update'), { ...feed, keywords: { uid: ['A+ Corp'] } }, new Set(['uid']), at)
  ).toHaveLength(1)
})
test('fresh quote alerts require both movement and portfolio impact; stale samples cannot trigger', async () => {
  const f = fixture()
  f.broker.schedule = async () => [
    {
      date: '2026-11-07T00:00:00Z',
      isTradingDay: true,
      startTime: '2026-11-07T06:00:00Z',
      endTime: '2026-11-07T16:00:00Z'
    }
  ]
  let n = 0
  f.broker.account = async (_, now) => {
    const d = data(now)
    d.snapshot.positions[0]!.price = decimal(n++ ? '110' : '100').toString()
    d.snapshot.positions[0]!.priceAt = now
    return d
  }
  await f.service.tick(at)
  await f.service.tick(at + 600000)
  expect(f.sent.filter((s) => s.includes('Резкое изменение цены'))).toHaveLength(1)
  const stale = fixture()
  let price = 100
  stale.broker.account = async (_, now) => {
    const d = data(now)
    d.snapshot.positions[0]!.price = decimal(String(price)).toString()
    price = 200
    d.snapshot.positions[0]!.priceAt = at - 86400_000
    return d
  }
  stale.broker.schedule = f.broker.schedule
  await stale.service.tick(at)
  await stale.service.tick(at + 600000)
  expect(stale.sent.filter((s) => s.includes('Резкое изменение цены'))).toHaveLength(0)
})
test('unknown external operation types cannot be mistaken for investment profit', () => {
  const before = data().snapshot,
    after = { ...before, at: at + 1000, nav: decimal('1100').toString() }
  const op = {
    id: 'new',
    at: at + 500,
    type: 'OPERATION_TYPE_INPUT_ACQUIRING',
    state: 'OPERATION_STATE_EXECUTED',
    amount: decimal('100').toString(),
    currency: 'rub',
    instrument: '',
    name: ''
  }
  expect(performance(before, after, [op])).toBeNull()
  expect(performance(before, after, [{ ...op, type: 'OPERATION_TYPE_OTHER' }])).toBeNull()
})
test('a nonadvancing operations cursor fails rather than silently truncating history', async () => {
  const fetcher = async (url: any) => {
    const method = String(url).split('/').at(-1)
    return Response.json(
      method === 'GetAccounts'
        ? { accounts: [{ id: 'a', accessLevel: 'ACCOUNT_ACCESS_LEVEL_READ_ONLY' }] }
        : method === 'GetPortfolio'
          ? { positions: [], totalAmountPortfolio: { units: 1, currency: 'rub' } }
          : { items: [], hasNext: true, nextCursor: 'same' }
    )
  }
  const broker = new ReadOnlyBroker(() => 'SECRET', fetcher as typeof fetch)
  await expect(broker.account(config.accounts[0]!, at, 0)).rejects.toThrow('cursor did not advance')
})
test('module Telegram topic is served without forwarding text to an agent, including when monitoring is paused', async () => {
  const { Bot } = await import('grammy'),
    { registerInvestments } = await import('../src/modules/investments/ui.ts'),
    { Store } = await import('../src/db.ts'),
    { FakeTelegram } = await import('./fake-telegram.ts')
  const fakeTelegram = new FakeTelegram(),
    dir = mkdtempSync(join(tmpdir(), 'invest-ui-')),
    path = join(dir, 'config.json'),
    previous = process.env.INVESTMENTS_CONFIG
  writeFileSync(path, JSON.stringify({ ...config, enabled: false, accounts: [] }), { mode: 0o600 })
  process.env.INVESTMENTS_CONFIG = path
  try {
    const bot = new Bot('123:TEST', { client: { apiRoot: fakeTelegram.apiRoot } }),
      d = { store: new Store(':memory:'), backgroundModules: new Set(), log: () => {} } as any
    registerInvestments(d, bot)
    let forwarded = 0
    bot.on('message', () => {
      forwarded++
    })
    await bot.init()
    const update = (thread: number, id: number) => ({
      update_id: id,
      message: {
        message_id: id,
        date: at / 1000,
        from: { id: 111, is_bot: false, first_name: 'Owner' },
        chat: { id: -100, type: 'supergroup', title: 'Investments' },
        message_thread_id: thread,
        text: 'hello'
      }
    })
    await bot.handleUpdate(update(1316, 9001) as any)
    expect(forwarded).toBe(0)
    const voice = update(1316, 9003) as any
    delete voice.message.text
    voice.message.voice = { file_id: 'voice', file_unique_id: 'unique', duration: 1 }
    await bot.handleUpdate(voice)
    expect(forwarded).toBe(0)
    await bot.handleUpdate(update(37, 9002) as any)
    expect(forwarded).toBe(1)
    expect(d.backgroundModules.size).toBe(0)
  } finally {
    fakeTelegram.stop()
    if (previous === undefined) delete process.env.INVESTMENTS_CONFIG
    else process.env.INVESTMENTS_CONFIG = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
test('calendar reminders and actual cash receipt notifications deduplicate independently', async () => {
  const f = fixture()
  f.broker.calendar = async () => [
    {
      id: 'p',
      instrument: 'uid',
      kind: 'coupon',
      date: new Date(at + 86400_000).toISOString(),
      amount: '1',
      currency: 'rub',
      quantity: '1000000000',
      status: 'announced'
    }
  ]
  f.broker.account = async (_, now) => ({
    ...data(now),
    operations: [
      {
        id: 'receipt',
        at,
        type: 'OPERATION_TYPE_COUPON',
        state: 'OPERATION_STATE_EXECUTED',
        amount: '1000000000',
        currency: 'rub',
        instrument: 'uid',
        name: 'Coupon'
      }
    ]
  })
  await f.service.tick(at)
  await f.service.tick(at + 600000)
  expect(f.sent.filter((text) => text.startsWith('Поступления'))).toHaveLength(1)
  expect(f.sent.filter((text) => text.startsWith('Календарь выплат'))).toHaveLength(1)
})
test('multipage outbox is one durable envelope; restart retries only unacknowledged pages', async () => {
  const f = fixture(),
    text = '📈 <b>Report</b>\n' + Array.from({ length: 5 }, (_, i) => 'line-' + i + ' ' + 'x'.repeat(1700)).join('\n')
  f.repo.queue('large', text, at, { key: 'complete', value: true }, true)
  let n = 0
  const first = new InvestmentService(config, f.repo, f.broker, async (_, urgent) => {
    expect(urgent).toBe(true)
    n++
    if (n === 2) throw new Error('offline')
    return n
  })
  await first.flush(at)
  expect(f.repo.read('complete', false)).toBe(false)
  const key = f.repo.keys('outbox:')[0]!
  expect(f.repo.read<any>(key, null).page).toBe(1)
  const restored = new InvestmentService(config, f.repo, f.broker, async () => {
    n++
    return n
  })
  await restored.flush(at + 10000)
  expect(f.repo.read('complete', false)).toBe(true)
  expect(n).toBe(4)
})
test('a crash-like acknowledgement storage error does not replay pages already persisted as delivered', async () => {
  const f = fixture()
  f.repo.queue('ack', 'report', at, { key: 'complete', value: true })
  const save = f.repo.save.bind(f.repo)
  let crash = true,
    sends = 0
  f.repo.save = (key, value) => {
    if (key === 'complete' && crash) {
      crash = false
      throw new Error('storage interrupted')
    }
    save(key, value)
  }
  const service = new InvestmentService(config, f.repo, f.broker, async () => {
    sends++
    return sends
  })
  await service.flush(at)
  expect(sends).toBe(1)
  expect(f.repo.read('complete', false)).toBe(false)
  await service.flush(at + 10000)
  expect(sends).toBe(1)
  expect(f.repo.read('complete', false)).toBe(true)
})
test('a record date is never substituted for an unknown dividend payment date', async () => {
  const fetcher = async () =>
    Response.json({ dividends: [{ recordDate: '2026-11-10T00:00:00Z', dividendNet: { units: 1, currency: 'rub' } }] })
  const broker = new ReadOnlyBroker(() => 'SECRET', fetcher as unknown as typeof fetch)
  const payments = await broker.calendar(config.accounts[0]!, data().snapshot.positions, at)
  expect(payments[0]?.date).toBe('')
  expect(payments[0]?.recordDate).toBe('2026-11-10T00:00:00Z')
  const r = new InvestmentRepository(store())
  r.saveAccount('a', { ...data(), payments, calendarFresh: true })
  expect(exportCalendar(config, r)).not.toContain('BEGIN:VEVENT')
  expect(render(config, r, 'calendar', at)).toContain('Дата реестра: 2026-11-10')
})
test('malformed identity/timezone fields cannot silently fall back to another runtime context', () => {
  expect(() => validateConfig({ ...config, timezone: undefined })).toThrow()
  expect(() => validateConfig({ ...config, accounts: [{ ...config.accounts[0], id: undefined }] })).toThrow()
  expect(() => validateConfig({ ...config, accounts: [{ ...config.accounts[0], name: 123 }] })).toThrow()
  expect(() => validateConfig({ ...config, accounts: [{ ...config.accounts[0], strategy: 'false' }] })).toThrow()
})
