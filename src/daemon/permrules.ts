/**
 * "📌 Всегда в проекте": tools the owner allowed for a project for good, kept
 * in the bot's store by project folder. Unlike "♾ в этой сессии" they survive
 * reconnects and restarts; Claude Code's own settings files are not touched.
 */

import type { Daemon } from './daemon.ts'

const key = (projectKey: string) => `perm_rules:${projectKey}`

export function projectRules(d: Daemon, projectKey: string): string[] {
  try {
    const v = JSON.parse(d.store.get(key(projectKey)) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function addProjectRule(d: Daemon, projectKey: string, tool: string): void {
  const rules = projectRules(d, projectKey)
  if (!rules.includes(tool)) d.store.set(key(projectKey), JSON.stringify([...rules, tool]))
}

export function removeProjectRule(d: Daemon, projectKey: string, tool: string): void {
  const rules = projectRules(d, projectKey).filter(t => t !== tool)
  d.store.set(key(projectKey), rules.length ? JSON.stringify(rules) : null)
}
