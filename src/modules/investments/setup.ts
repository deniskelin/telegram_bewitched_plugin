/** Local key-file onboarding. No credential is accepted through Telegram. */
import { randomBytes } from 'crypto'
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { AccountError, atomicPrivate, type AccountRegistry, type AccountRole, type BrokerAccount } from './accounts.ts'
import { inspectReadOnlyAccounts, probeReadOnlyAccount } from './broker.ts'
export type SetupRequest = { id: string; owner: string; role: AccountRole; replaceId?: string }
export class AccountSetup {
  private requests: SetupRequest[]
  private busy = new Set<string>()
  private readonly path: string
  constructor(
    private readonly registry: AccountRegistry,
    private readonly owner: () => string | null | undefined,
    private readonly inspect = inspectReadOnlyAccounts,
    private readonly probe = probeReadOnlyAccount
  ) {
    this.path = registry.path + '.setup.json'
    this.requests = existsSync(this.path) ? JSON.parse(privateFile(this.path, 8192)) : []
    if (
      !Array.isArray(this.requests) ||
      this.requests.length > 4 ||
      this.requests.some(
        (r) =>
          !r ||
          !/^[a-f0-9]{16}$/.test(r.id) ||
          typeof r.owner !== 'string' ||
          !['observe', 'strategy'].includes(r.role) ||
          (r.replaceId !== undefined && typeof r.replaceId !== 'string')
      )
    )
      throw new AccountError('invalid')
  }
  role(id: string, role: AccountRole): void {
    const request = this.find(id)
    if (!request) throw new AccountError('missing')
    if (request.replaceId) throw new AccountError('invalid')
    if (!['observe', 'strategy'].includes(role)) throw new AccountError('invalid')
    request.role = role
    this.save()
  }
  list(): SetupRequest[] {
    return this.requests.filter((r) => r.owner === this.owner())
  }
  find(id: string): SetupRequest | undefined {
    return this.list().find((r) => r.id === id)
  }
  keyFile(id: string): string {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new AccountError('invalid')
    return this.registry.path + '.key-' + id
  }
  private save(): void {
    atomicPrivate(this.path, JSON.stringify(this.requests))
  }
  issue(role: AccountRole, replaceId?: string): SetupRequest {
    if (!this.owner() || !['observe', 'strategy'].includes(role)) throw new AccountError('invalid')
    if (replaceId && !this.registry.config.accounts.some((a) => a.id === replaceId)) throw new AccountError('missing')
    const existing = replaceId ? this.list().find((r) => r.replaceId === replaceId) : undefined
    if (existing) {
      existing.role = role
      this.save()
      return existing
    }
    if (!replaceId && this.registry.config.accounts.length + this.list().filter((r) => !r.replaceId).length >= 4)
      throw new AccountError('limit')
    if (this.requests.length >= 4) throw new AccountError('limit')
    const request = { id: randomBytes(8).toString('hex'), owner: this.owner()!, role, replaceId }
    writeFileSync(this.keyFile(request.id), '', { mode: 0o600, flag: 'wx' })
    this.requests.push(request)
    try {
      this.save()
    } catch (err) {
      this.requests.pop()
      unlinkSync(this.keyFile(request.id))
      throw err
    }
    return request
  }
  private token(id: string): string {
    if (!this.find(id)) throw new AccountError('missing')
    const token = privateFile(this.keyFile(id), 4096).trim()
    if (!token || /[\s\x00-\x1f]/.test(token)) throw new AccountError('invalid')
    return token
  }
  async accounts(id: string): Promise<BrokerAccount[]> {
    if (this.busy.has(id)) throw new AccountError('conflict')
    this.busy.add(id)
    try {
      return await this.inspect(this.token(id))
    } finally {
      this.busy.delete(id)
    }
  }
  async commit(id: string, accountId: string, name: string): Promise<void> {
    const request = this.find(id)
    if (!request) throw new AccountError('missing')
    if (this.busy.has(id)) throw new AccountError('conflict')
    this.busy.add(id)
    try {
      const token = this.token(id),
        accounts = await this.inspect(token),
        account = accounts.find((a) => a.id === accountId)
      if (!account || (request.replaceId && request.replaceId !== account.id)) throw new AccountError('missing')
      await this.probe(token, account.id)
      if (this.find(id) !== request) throw new AccountError('missing')
      if (request.replaceId) this.registry.replace(request.replaceId, token, account.type)
      else this.registry.add(account, name, request.role, token)
      this.cancel(id)
    } finally {
      this.busy.delete(id)
    }
  }
  cancel(id: string): void {
    if (!this.find(id)) throw new AccountError('missing')
    const file = this.keyFile(id)
    if (existsSync(file)) unlinkSync(file)
    this.requests = this.requests.filter((r) => r.id !== id)
    this.save()
  }
}
function privateFile(path: string, max: number): string {
  const stat = statSync(path)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > max) throw new AccountError('invalid')
  return readFileSync(path, 'utf8')
}
/** POSIX shell quoting; never interpolate JSON strings as shell code. */
export const shellQuote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"
export function keyWriteCommand(path: string): string {
  // zsh: silent prompt keeps the secret out of history, argv and tool calls.
  return `read -rs 'invest_key?API key: ' && printf '%s' "$invest_key" > ${shellQuote(path)}; unset invest_key`
}
