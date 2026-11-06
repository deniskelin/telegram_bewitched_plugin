/** Telegram adapter only. No model, tool orchestration or session launch. */
import { InlineKeyboard, InputFile, type Bot, type Context } from 'grammy'
import { can, owner } from '../../access.ts'
import { t } from '../../i18n/index.ts'
import { htmlPages } from '../../core/html-pages.ts'
import type { Daemon } from '../../daemon/daemon.ts'
import { button } from '../../daemon/stream.ts'
import { loadInvestmentConfig } from './config.ts'
import { ReadOnlyBroker } from './broker.ts'
import { InvestmentRepository } from './repository.ts'
import { InvestmentService } from './service.ts'
import { render } from './render.ts'
import type { Config } from './types.ts'
import { inChat } from '../../daemon/lang.ts'
import { createHash } from 'crypto'
import { AccountRegistry } from './accounts.ts'
import { AccountSetup } from './setup.ts'
import { registerAccountUI } from './account-ui.ts'
const runtimes = new WeakMap<
  Daemon,
  {
    config: Config
    service: InvestmentService
    views: Map<string, number>
    revision: number
    registry: AccountRegistry
    setup: AccountSetup
  }
>()
export function investmentScope(config: Config, ctx: Context): boolean {
  const m = ctx.callbackQuery?.message ?? ctx.message,
    chat = String(ctx.chat?.id ?? m?.chat.id ?? ''),
    thread = m && 'message_thread_id' in m ? m.message_thread_id : undefined
  return (
    !!ctx.from &&
    String(ctx.from.id) === owner() &&
    ((chat === owner() && thread == null) || (chat === config.chatId && thread === config.threadId))
  )
}
function keyboard(section: string, page: number, pages: number): InlineKeyboard {
  const kb = new InlineKeyboard([
    [button(t('Портфель'), 'iv:portfolio:0'), button(t('Новости портфеля'), 'iv:news:0')],
    [button(t('Календарь выплат'), 'iv:calendar:0'), button(t('Операции'), 'iv:operations:0')],
    [button(t('Счёт стратегии'), 'iv:strategy:0'), button(t('📈 Статус модуля'), 'iv:summary:0')],
    [
      button(t('🔄 Обновить'), 'iv:refresh:0'),
      button(t('⏸ Мониторинг'), 'iv:pause:0'),
      button(t('▶️ Мониторинг'), 'iv:resume:0')
    ],
    [button(t('Счета инвестиций'), 'iva:list:0')],
    [button('JSON', 'iv:export:0'), button('CSV', 'iv:csv:0'), button('ICS', 'iv:ics:0')]
  ])
  if (pages > 1)
    kb.row()
      .text('◀', `iv:${section}:${Math.max(0, page - 1)}`)
      .text(`${page + 1}/${pages}`, `iv:${section}:${page}`)
      .text('▶', `iv:${section}:${Math.min(pages - 1, page + 1)}`)
  return kb
}
function exportData(c: Config, r: InvestmentRepository): unknown {
  return {
    at: Date.now(),
    accounts: c.accounts.map((a) => {
      const d = r.account(a.id)
      return {
        name: a.name,
        ...(d
          ? {
              snapshot: { ...d.snapshot, account: a.name },
              operations: d.operations.map((o) => ({
                ...o,
                id: createHash('sha256').update(o.id).digest('hex').slice(0, 16)
              })),
              payments: d.payments,
              warnings: d.warnings
            }
          : {})
      }
    }),
    paper: r.read('paper', null)
  }
}
export function exportCalendar(c: Config, r: InvestmentRepository): string {
  const esc = (s: string) =>
    s
      .replace(/\\/g, '\\\\')
      .replace(/[\r\n]+/g, '\\n')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;')
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//telegram-bewitched//Investments//EN']
  for (const a of c.accounts)
    for (const p of r.account(a.id)?.payments ?? []) {
      const day = p.date.slice(0, 10).replace(/-/g, '')
      if (!/^\d{8}$/.test(day)) continue
      const id = createHash('sha256')
        .update(a.name + p.id)
        .digest('hex')
      lines.push(
        'BEGIN:VEVENT',
        `UID:${id}@bewitched`,
        `DTSTAMP:${new Date()
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\.\d+Z$/, 'Z')}`,
        `DTSTART;VALUE=DATE:${day}`,
        `SUMMARY:${esc(a.name + ' · ' + p.instrument + ' · ' + p.kind)}`,
        'DESCRIPTION:Announced event; entitlement and actual broker credit require verification.',
        'END:VEVENT'
      )
    }
  return lines.concat('END:VCALENDAR', '').join('\r\n')
}
export function registerInvestments(d: Daemon, bot: Bot): void {
  let runtime = runtimes.get(d)
  if (!runtime) {
    try {
      const config = loadInvestmentConfig()
      if (config) {
        const tokens = new Map(config.accounts.map((a) => [a.tokenEnv, process.env[a.tokenEnv]]))
        for (const name of Object.keys(process.env)) if (/^INVEST_[A-Z0-9_]+$/.test(name)) delete process.env[name]
        const repo = new InvestmentRepository(d.store, config.chatId + ':' + config.threadId)
        let service: InvestmentService
        const registry = new AccountRegistry(config, process.env.INVESTMENTS_CONFIG!, tokens, () => {
          service?.settingsChanged()
          if (config.enabled) d.backgroundModules.add('investments')
          else d.backgroundModules.delete('investments')
          runtimes.get(d)?.views.clear()
        })
        const broker = new ReadOnlyBroker(
          (name) => registry.token(name),
          undefined,
          () => config.accounts[0]?.tokenEnv ?? ''
        )
        service = new InvestmentService(config, repo, broker, async (text, urgent) => {
          const sent = await bot.api.sendMessage(config.chatId, text, {
            parse_mode: 'HTML',
            message_thread_id: config.threadId,
            disable_notification: !urgent || config.criticalSound === false
          })
          return sent.message_id
        })
        const setup = new AccountSetup(registry, owner)
        runtime = { config, service, views: new Map(), revision: 0, registry, setup }
        runtimes.set(d, runtime)
        if (config.enabled) d.backgroundModules.add('investments')
        {
          const tick = () =>
            void inChat(d, config.chatId, config.threadId, () => service.tick()).catch(() =>
              d.log('investments cycle failed')
            )
          setInterval(tick, 60_000).unref()
          tick()
        }
      }
    } catch {
      d.log('investments config invalid; module disabled')
    }
  }
  if (runtime) registerAccountUI(bot, runtime.registry, runtime.setup, investmentScope)
  const draw = async (ctx: Context, section = 'summary', page = 0, edit = false) => {
    if (!ctx.from || !can(ctx.from.id, 'control')) return
    if (!runtime) {
      await ctx.reply(t('Модуль инвестиций не настроен; подключите локальный конфиг.'))
      return
    }
    if (!investmentScope(runtime.config, ctx)) {
      if (edit) await ctx.answerCallbackQuery({ text: t('Нет доступа.') })
      return
    }
    const pages = htmlPages(
        render(runtime.config, runtime.service.repo, section) +
          (runtime.service.running ? '\n\n' + t('📊 Собираю…') : '')
      ),
      at = Math.min(page, pages.length - 1),
      extra = { parse_mode: 'HTML' as const, reply_markup: keyboard(section, at, pages.length) }
    if (edit) await ctx.editMessageText(pages[at]!, extra).catch(() => {})
    else await ctx.reply(pages[at]!, { ...extra, message_thread_id: ctx.message?.message_thread_id })
  }
  bot.command('invest', (ctx) => draw(ctx))
  bot.callbackQuery(/^iv:([a-z]+):(\d{1,6})$/, async (ctx) => {
    if (!runtime || !investmentScope(runtime.config, ctx)) {
      await ctx.answerCallbackQuery({ text: t('Нет доступа.') })
      return
    }
    const action = ctx.match[1]!,
      repo = runtime.service.repo
    const viewKey = String(ctx.chat?.id) + ':' + ctx.callbackQuery.message?.message_id,
      revision = ++runtime.revision
    runtime.views.set(viewKey, revision)
    if (runtime.views.size > 500) runtime.views.delete(runtime.views.keys().next().value!)
    if (
      ![
        'summary',
        'portfolio',
        'calendar',
        'news',
        'operations',
        'strategy',
        'refresh',
        'pause',
        'resume',
        'export',
        'csv',
        'ics'
      ].includes(action)
    ) {
      await ctx.answerCallbackQuery()
      return
    }
    await ctx.answerCallbackQuery()
    if (action === 'resume') {
      try {
        runtime.registry.enable()
      } catch {
        await ctx.reply(t('Сначала подключите хотя бы один счёт.'))
        return
      }
    }
    if (action === 'pause' || action === 'resume') repo.save('paused', action === 'pause')
    if (action === 'refresh' || action === 'resume') {
      const active = runtime,
        task = active.service.tick(Date.now(), true)
      await draw(ctx, 'summary', 0, true)
      void task
        .then(async () => {
          if (active.views.get(viewKey) === revision) await draw(ctx, 'summary', 0, true)
        })
        .catch(() => d.log('investments refresh failed'))
      return
    }
    if (action === 'export' || action === 'ics' || action === 'csv') {
      const data =
        action === 'ics'
          ? exportCalendar(runtime.config, repo)
          : action === 'csv'
            ? exportCsv(runtime.config, repo)
            : JSON.stringify(exportData(runtime.config, repo), null, 2)
      await bot.api.sendDocument(
        String(ctx.chat!.id),
        new InputFile(
          Buffer.from(data),
          action === 'ics' ? 'investments.ics' : action === 'csv' ? 'investments.csv' : 'investments.json'
        ),
        { message_thread_id: ctx.callbackQuery.message?.message_thread_id, disable_notification: true }
      )
      return
    }
    await draw(ctx, ['refresh', 'pause', 'resume'].includes(action) ? 'summary' : action, Number(ctx.match[2]), true)
  })
  // The bound topic belongs to the module; text, voice and files never wake an agent.
  bot.on('message', async (ctx, next) => {
    if (
      runtime &&
      String(ctx.chat.id) === runtime.config.chatId &&
      ctx.message.message_thread_id === runtime.config.threadId
    ) {
      await draw(ctx)
      return
    }
    await next()
  })
}

export function exportCsv(c: Config, r: InvestmentRepository): string {
  const quote = (v: string) => '"' + (/^[=+\-@\t\r]/.test(v) ? "'" + v : v).replace(/"/g, '""') + '"'
  const rows = [['account', 'at', 'type', 'amount', 'currency', 'state', 'instrument']]
  for (const a of c.accounts)
    for (const o of r.account(a.id)?.operations ?? [])
      rows.push([
        a.name,
        new Date(o.at).toISOString(),
        o.type,
        formatAmount(o.amount),
        o.currency,
        o.state,
        o.instrument
      ])
  return '\uFEFF' + rows.map((row) => row.map(quote).join(',')).join('\r\n')
}
function formatAmount(s: string): string {
  const n = BigInt(s),
    a = n < 0n ? -n : n
  return (n < 0n ? '-' : '') + String(a / 1_000_000_000n) + '.' + String(a % 1_000_000_000n).padStart(9, '0')
}
