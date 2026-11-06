/** Local account registry and encrypted secret vault. No Telegram token ingestion. */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'fs'
import { validateConfig } from './config.ts'
import type { AccountConfig, Config } from './types.ts'
export type BrokerAccount = { id: string; name: string; type: string }
export type AccountRole = 'observe' | 'strategy'
export type AccountFailure = 'conflict' | 'missing' | 'duplicate' | 'limit' | 'strategy' | 'invalid'
export class AccountError extends Error {
  constructor(readonly code: AccountFailure) {
    super(code)
  }
}
function privateRead(path: string, max = 131072): Buffer {
  const st = statSync(path)
  if ((st.mode & 0o077) !== 0 || st.size > max || !st.isFile()) throw new AccountError('invalid')
  return readFileSync(path)
}
export function atomicPrivate(path: string, body: string | Buffer): void {
  const tmp = path + '.tmp-' + randomBytes(8).toString('hex')
  try {
    writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' })
    renameSync(tmp, path)
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp)
  }
}
type Sealed = { iv: string; tag: string; data: string }
export class CredentialVault {
  private master: Buffer
  private values: Record<string, Sealed>
  constructor(private readonly path: string) {
    const keyPath = path + '.master'
    if (existsSync(path) && !existsSync(keyPath)) throw new AccountError('invalid')
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' })
    this.master = privateRead(keyPath, 32)
    if (this.master.length !== 32) throw new AccountError('invalid')
    this.values = existsSync(path) ? JSON.parse(privateRead(path).toString('utf8')) : {}
    if (!this.values || typeof this.values !== 'object' || Array.isArray(this.values)) throw new AccountError('invalid')
  }
  has(ref: string): boolean {
    return typeof this.values[ref]?.data === 'string'
  }
  get(ref: string): string | undefined {
    const value = this.values[ref]
    if (!value) return undefined
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.master, Buffer.from(value.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8')
    } catch {
      throw new AccountError('invalid')
    }
  }
  put(ref: string, token: string): void {
    if (!/^[a-f0-9]{32}$/.test(ref) || !token || token.length > 4096 || /[\s\x00-\x1f]/.test(token))
      throw new AccountError('invalid')
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.master, iv),
      data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
    const next = {
      ...this.values,
      [ref]: { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
    }
    atomicPrivate(this.path, JSON.stringify(next))
    this.values = next
  }
  prune(refs: Set<string>): void {
    const next = Object.fromEntries(Object.entries(this.values).filter(([ref]) => refs.has(ref)))
    atomicPrivate(this.path, JSON.stringify(next))
    this.values = next
  }
}
export class AccountRegistry {
  private digest: string
  readonly vault: CredentialVault
  constructor(
    readonly config: Config,
    readonly path: string,
    private readonly legacy = new Map<string, string | undefined>(),
    private readonly changed: () => void = () => {}
  ) {
    this.digest = createHash('sha256').update(privateRead(path)).digest('hex')
    this.vault = new CredentialVault(path + '.keys')
    this.vault.prune(new Set(config.accounts.flatMap((a) => (a.credentialRef ? [a.credentialRef] : []))))
  }
  token(name: string): string | undefined {
    const a = this.config.accounts.find((a) => a.tokenEnv === name)
    return a?.credentialRef ? this.vault.get(a.credentialRef) : a ? this.legacy.get(name) : undefined
  }
  hasKey(a: AccountConfig): boolean {
    return a.credentialRef ? this.vault.has(a.credentialRef) : !!this.legacy.get(a.tokenEnv)
  }
  find(handle: string): AccountConfig | undefined {
    return this.config.accounts.find((a) => accountHandle(a.id) === handle)
  }
  private save(next: Config): void {
    validateConfig(next)
    const current = createHash('sha256').update(privateRead(this.path)).digest('hex')
    if (current !== this.digest) throw new AccountError('conflict')
    const body = JSON.stringify(next, null, 2) + '\n'
    atomicPrivate(this.path, body)
    this.digest = createHash('sha256').update(body).digest('hex')
    Object.assign(this.config, next)
    this.changed()
  }
  private cleanup(): void {
    for (const name of this.legacy.keys())
      if (!this.config.accounts.some((a) => !a.credentialRef && a.tokenEnv === name)) this.legacy.delete(name)
    this.vault.prune(new Set(this.config.accounts.flatMap((a) => (a.credentialRef ? [a.credentialRef] : []))))
  }
  add(account: BrokerAccount, name: string, role: AccountRole, token: string): void {
    if (!['observe', 'strategy'].includes(role)) throw new AccountError('invalid')
    if (this.config.accounts.some((a) => a.id === account.id)) throw new AccountError('duplicate')
    if (this.config.accounts.length >= 4) throw new AccountError('limit')
    if (role === 'strategy' && this.config.accounts.some((a) => a.strategy)) throw new AccountError('strategy')
    const ref = randomBytes(16).toString('hex'),
      a: AccountConfig = {
        id: account.id,
        name: name.trim(),
        tokenEnv: 'INVEST_UI_' + ref.toUpperCase(),
        credentialRef: ref,
        brokerType: account.type,
        strategy: role === 'strategy'
      }
    const next = { ...this.config, accounts: [...this.config.accounts, a] }
    validateConfig(next)
    this.vault.put(ref, token)
    try {
      this.save(next)
    } catch (err) {
      this.cleanup()
      throw err
    }
  }
  rename(id: string, name: string): void {
    if (!this.config.accounts.some((a) => a.id === id)) throw new AccountError('missing')
    this.save({
      ...this.config,
      accounts: this.config.accounts.map((a) => (a.id === id ? { ...a, name: name.trim() } : a))
    })
  }
  role(id: string, role: AccountRole): void {
    if (!['observe', 'strategy'].includes(role)) throw new AccountError('invalid')
    if (!this.config.accounts.some((a) => a.id === id)) throw new AccountError('missing')
    if (role === 'strategy' && this.config.accounts.some((a) => a.id !== id && a.strategy))
      throw new AccountError('strategy')
    this.save({
      ...this.config,
      accounts: this.config.accounts.map((a) => (a.id === id ? { ...a, strategy: role === 'strategy' } : a))
    })
  }
  replace(id: string, token: string, type: string): void {
    if (!this.config.accounts.some((a) => a.id === id)) throw new AccountError('missing')
    const ref = randomBytes(16).toString('hex'),
      next = {
        ...this.config,
        accounts: this.config.accounts.map((a) =>
          a.id === id ? { ...a, credentialRef: ref, tokenEnv: 'INVEST_UI_' + ref.toUpperCase(), brokerType: type } : a
        )
      }
    this.vault.put(ref, token)
    try {
      this.save(next)
    } catch (err) {
      this.cleanup()
      throw err
    }
    this.cleanup()
  }
  remove(id: string): void {
    if (!this.config.accounts.some((a) => a.id === id)) throw new AccountError('missing')
    const accounts = this.config.accounts.filter((a) => a.id !== id)
    this.save({ ...this.config, accounts, enabled: accounts.length ? this.config.enabled : false })
    this.cleanup()
  }
  enable(): void {
    if (this.config.enabled) return
    if (!this.config.accounts.length) throw new AccountError('missing')
    this.save({ ...this.config, enabled: true })
  }
}
export const accountHandle = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 16)
