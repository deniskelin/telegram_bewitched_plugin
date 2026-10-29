/**
 * Interface languages. Russian is the source: t('русская строка', vars) looks
 * the string up in the dictionary of the current language and falls back to
 * Russian. {name} placeholders are filled from vars.
 *
 * The current language lives in an AsyncLocalStorage: the bot sets it for each
 * update (the chat's /lang, else the user's Telegram language in a DM, else
 * BOT_LANGUAGE), timers and notices set it for the chat they write to, and
 * anything else uses the default — so screens need no language parameter.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import de from './de.ts'
import en from './en.ts'
import es from './es.ts'
import fr from './fr.ts'
import zh from './zh.ts'

export const LANGS = ['ru', 'en', 'es', 'zh', 'fr', 'de'] as const
export type Lang = (typeof LANGS)[number]
export type Dict = Record<string, string>

export const DICTS: Record<Exclude<Lang, 'ru'>, Dict> = { en, es, zh, fr, de }

/** How each language names itself, for the language picker. */
export const LANG_NAMES: Record<Lang, string> = { ru: '🇷🇺 Русский', en: '🇬🇧 English', es: '🇪🇸 Español', zh: '🇨🇳 中文', fr: '🇫🇷 Français', de: '🇩🇪 Deutsch' }

const LOCALES: Record<Lang, string> = { ru: 'ru-RU', en: 'en-GB', es: 'es-ES', zh: 'zh-CN', fr: 'fr-FR', de: 'de-DE' }

const als = new AsyncLocalStorage<Lang>()

/** "en-US", "zh-hans", "RU" → a supported language, or null. */
export function normLang(code: string | null | undefined): Lang | null {
  const c = (code ?? '').toLowerCase().slice(0, 2)
  return (LANGS as readonly string[]).includes(c) ? (c as Lang) : null
}

let defaultLang: () => Lang = () => normLang(process.env.BOT_LANGUAGE) ?? 'ru'

/** The language outside of any chat (set by the daemon: the owner's choice, else BOT_LANGUAGE). */
export function setDefaultLang(f: () => Lang): void {
  defaultLang = f
}

export function lang(): Lang {
  return als.getStore() ?? defaultLang()
}

export function withLang<T>(l: Lang, f: () => T): T {
  return als.run(l, f)
}

/** Locale for toLocaleString of dates and numbers. */
export function locale(): string {
  return LOCALES[lang()]
}

/** The string in every language: for matching a translated label (a reply-keyboard button) in any chat. */
export function variants(ru: string): string[] {
  return [...new Set([ru, ...Object.values(DICTS).map(d => d[ru] ?? ru)])]
}

/** Marks a string for translation where it is stored (t() is applied where it is shown). */
export const k = (ru: string): string => ru

export function t(ru: string, vars?: Record<string, string | number>): string {
  const l = lang()
  const s = l === 'ru' ? ru : DICTS[l][ru] ?? ru
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s
}
