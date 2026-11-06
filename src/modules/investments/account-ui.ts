/** Owner-only account screens; credentials are read solely from private server files. */
import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { brokerTypeLabel } from './account-labels.ts'
import { owner } from '../../access.ts'
import { t } from '../../i18n/index.ts'
import { escapeHtml } from '../../format.ts'
import { AccountError, AccountRegistry, accountHandle, type AccountRole } from './accounts.ts'
import { keyWriteCommand, type AccountSetup } from './setup.ts'
import type { Config } from './types.ts'

type Rename = { id: string; prompt: number; expires: number }
export function registerAccountUI(
  bot: Bot,
  registry: AccountRegistry,
  setup: AccountSetup,
  scope: (c: Config, ctx: Context) => boolean
): void {
  // prettier-ignore
  const failure = t('Не удалось проверить файл или подключить счёт. Проверьте ключ только для чтения и права файла 0600.')
  let rename: Rename | undefined
  const role = (strategy?: boolean) => (strategy ? t('Стратегия и отчёты') : t('Наблюдение'))
  const card = async (ctx: Context, handle?: string) => {
    const a = handle ? registry.find(handle) : undefined,
      kb = new InlineKeyboard()
    let text = ''
    if (a) {
      text = `<b>${escapeHtml(a.name)}</b>\n\n${t('Роль')}: ${role(a.strategy)}\n${t('Тип счёта')}: ${escapeHtml(brokerTypeLabel(a.brokerType))}\n${t('Ключ')}: ${registry.hasKey(a) ? t('Настроен') : t('Не настроен')}\n\n${t('Доступ только для чтения. Реальные сделки недоступны.')}`
      kb.text(t('Переименовать'), `iva:rename:${handle}`)
        .text(t('Изменить роль'), `iva:role:${handle}`)
        .row()
        .text(t('Заменить ключ'), `iva:key:${handle}`)
        .text(t('Отключить счёт'), `iva:remove:${handle}`)
        .row()
    } else {
      text = `<b>${t('Счета инвестиций')}</b>\n\n${registry.config.accounts.length ? t('Выберите счёт для настройки.') : t('Счета пока не подключены.')}\n\n${t('До четырёх счетов: наблюдение и один счёт стратегии. Все подключения только для чтения.')}`
      for (const account of registry.config.accounts)
        kb.text(`${account.strategy ? '📊' : '👁'} ${account.name}`, `iva:card:${accountHandle(account.id)}`).row()
      for (const [index, request] of setup.list().entries())
        kb.text('🗝 ' + (index + 1) + ' · ' + role(request.role === 'strategy'), `iva:pending:${request.id}`).row()
      if (registry.config.accounts.length + setup.list().filter((r) => !r.replaceId).length < 4)
        kb.text(t('Добавить счёт'), 'iva:add:0').row()
    }
    kb.text(t('Назад'), a ? 'iva:list:0' : 'iv:summary:0')
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {})
  }
  const instructions = async (ctx: Context, id: string) => {
    const request = setup.find(id)
    if (!request) throw new AccountError('missing')
    const path = setup.keyFile(id),
      command = keyWriteCommand(path),
      kb = new InlineKeyboard()
    kb.add({ text: t('Копировать команду'), copy_text: { text: command } })
      .row()
      .text(t('Проверить файл'), `iva:verify:${id}`)
      .row()
    if (!request.replaceId)
      kb.text(t('Наблюдение'), `iva:pendingrole:${id}:observe`)
        .text(t('Стратегия и отчёты'), `iva:pendingrole:${id}:strategy`)
        .row()
    kb.text(t('Отменить подключение'), `iva:cancel:${id}`)
    await bot.api.sendMessage(
      owner()!,
      `<b>${t('Подключение счёта')}</b>\n\n${t('Роль')}: ${role(request.role === 'strategy')}\n\n${t('Заполните приватный файл ключа на сервере командой ниже, затем нажмите «Проверить файл». Ввод скрыт и не попадает в историю команд.')}\n<code>${escapeHtml(path)}</code>\n\n<pre>${escapeHtml(command)}</pre>\n\n${t('Ключ в Telegram не отправляйте. После подключения файл будет удалён; ключ сохранится в защищённом хранилище.')}`,
      { parse_mode: 'HTML', reply_markup: kb, disable_notification: true }
    )
    if (String(ctx.chat?.id) !== owner()) await ctx.reply(t('Инструкция по записи ключа отправлена вам в личный чат.'))
  }
  bot.callbackQuery(/^iva:([a-z]+):([a-z0-9]{1,16})(?::([a-z0-9]{1,16}))?$/, async (ctx) => {
    if (!scope(registry.config, ctx)) {
      await ctx.answerCallbackQuery({ text: t('Нет доступа.') })
      return
    }
    await ctx.answerCallbackQuery()
    const action = ctx.match[1]!,
      handle = ctx.match[2]!,
      a = registry.find(handle)
    try {
      if (action === 'list' || action === 'card') {
        await card(ctx, action === 'card' ? handle : undefined)
        return
      }
      if (action === 'add' || action === 'role') {
        if (action === 'role' && !a) throw new AccountError('missing')
        const kb = new InlineKeyboard()
          .text(
            t('Наблюдение'),
            `iva:${action === 'add' ? 'connect' : 'setrole'}:${action === 'add' ? '0' : handle}:observe`
          )
          .row()
          .text(
            t('Стратегия и отчёты'),
            `iva:${action === 'add' ? 'connect' : 'setrole'}:${action === 'add' ? '0' : handle}:strategy`
          )
          .row()
          .text(t('Назад'), a ? `iva:card:${handle}` : 'iva:list:0')
        await ctx.editMessageText(
          t('Выберите роль. Стратегия — отдельные анализ и отчёты; доступ остаётся только для чтения.'),
          { reply_markup: kb }
        )
        return
      }
      if (action === 'connect') {
        const request = setup.issue(ctx.match[3] as AccountRole)
        await instructions(ctx, request.id)
        return
      }
      if (action === 'pending') {
        await instructions(ctx, handle)
        return
      }
      if (action === 'pendingrole') {
        setup.role(handle, ctx.match[3] as AccountRole)
        await instructions(ctx, handle)
        return
      }
      if (action === 'cancel') {
        setup.cancel(handle)
        await card(ctx)
        return
      }
      if (action === 'verify' || action === 'pick') {
        const request = setup.find(handle)
        if (!request) throw new AccountError('missing')
        await ctx.editMessageText(t('Проверяю ключ…'))
        const task = async () => {
          const accounts = await setup.accounts(handle)
          if (!setup.find(handle)) return
          if (action === 'pick') {
            const selected = accounts.find((a) => accountHandle(a.id) === ctx.match[3])
            if (!selected) throw new AccountError('missing')
            await setup.commit(handle, selected.id, selected.name || t('Счёт'))
            await ctx.editMessageText(
              t('Счёт сохранён. Откройте список счетов; включите мониторинг, когда будете готовы.'),
              { reply_markup: new InlineKeyboard().text(t('Счета инвестиций'), 'iva:list:0') }
            )
          } else {
            const kb = new InlineKeyboard()
            for (const account of accounts.filter((a) => !request.replaceId || a.id === request.replaceId))
              kb.text(
                `${account.name} · ${brokerTypeLabel(account.type)}`,
                `iva:pick:${handle}:${accountHandle(account.id)}`
              ).row()
            kb.text(t('Назад'), `iva:pending:${handle}`)
            await ctx.editMessageText(
              t('Выберите счёт для подключения. Тип получен от брокера; название можно изменить после подключения.'),
              { reply_markup: kb }
            )
          }
        }
        void task().catch(async (err) => {
          await ctx
            .editMessageText(
              err instanceof AccountError && err.code === 'strategy'
                ? t('Счёт стратегии уже выбран. Сначала измените его роль.')
                : failure,
              {
                reply_markup: new InlineKeyboard()
                  .text(t('Повторить'), `iva:verify:${handle}`)
                  .text(t('Назад'), 'iva:list:0')
              }
            )
            .catch(() => {})
        })
        return
      }
      if (!a) throw new AccountError('missing')
      if (action === 'setrole') {
        registry.role(a.id, ctx.match[3] as AccountRole)
        await card(ctx, handle)
        return
      }
      if (action === 'key') {
        const request = setup.issue(a.strategy ? 'strategy' : 'observe', a.id)
        await instructions(ctx, request.id)
        return
      }
      if (action === 'rename') {
        const msg = await bot.api.sendMessage(
          owner()!,
          t('Ответьте на это сообщение новым названием счёта (до 60 символов). Не отправляйте ключ API.'),
          { reply_markup: { force_reply: true, selective: true } }
        )
        rename = { id: a.id, prompt: msg.message_id, expires: Date.now() + 300000 }
        if (String(ctx.chat?.id) !== owner()) await ctx.reply(t('Запрос нового названия отправлен вам в личный чат.'))
        return
      }
      if (action === 'remove') {
        await ctx.editMessageText(
          t('Отключить счёт от мониторинга? Брокерский счёт останется открытым; локальный ключ будет удалён.'),
          {
            reply_markup: new InlineKeyboard()
              .text(t('Отключить'), `iva:confirm:${handle}`)
              .text(t('Отмена'), `iva:card:${handle}`)
          }
        )
        return
      }
      if (action === 'confirm') {
        registry.remove(a.id)
        if (rename?.id === a.id) rename = undefined
        await card(ctx)
        return
      }
    } catch (err) {
      const text =
        err instanceof AccountError && err.code === 'strategy'
          ? t('Счёт стратегии уже выбран. Сначала измените его роль.')
          : t('Не удалось изменить счёт. Обновите список и повторите попытку.')
      await ctx.reply(text)
    }
  })
  bot.on('message:text', async (ctx, next) => {
    if (
      String(ctx.from.id) !== owner() ||
      String(ctx.chat.id) !== owner() ||
      !rename ||
      ctx.message.reply_to_message?.message_id !== rename.prompt
    ) {
      await next()
      return
    }
    const pending = rename
    rename = undefined
    if (pending.expires <= Date.now()) {
      await ctx.reply(t('Запрос истёк. Откройте настройку счёта заново.'))
      return
    }
    try {
      registry.rename(pending.id, ctx.message.text)
      await ctx.reply(t('Название счёта сохранено.'), {
        reply_markup: new InlineKeyboard().text(t('Счета инвестиций'), 'iva:list:0')
      })
    } catch {
      await ctx.reply(t('Не удалось изменить счёт. Обновите список и повторите попытку.'))
    }
  })
}
