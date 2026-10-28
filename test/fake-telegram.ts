/** Minimal fake Bot API server for integration tests. Records every call. */

export type Call = { method: string; body: Record<string, unknown> }

export class FakeTelegram {
  calls: Call[] = []
  private updates: unknown[] = []
  private waiters: (() => void)[] = []
  private nextUpdateId = 1
  private nextMessageId = 1000
  private nextThreadId = 50
  private server: ReturnType<typeof Bun.serve>
  /** Methods that should fail with this description. */
  failures = new Map<string, { code: number; description: string }>()

  constructor() {
    this.server = Bun.serve({ port: 0, fetch: req => this.handle(req) })
  }

  get apiRoot(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  stop(): void {
    this.server.stop(true)
  }

  push(update: Record<string, unknown>): void {
    this.updates.push({ update_id: this.nextUpdateId++, ...update })
    for (const w of this.waiters.splice(0)) w()
  }

  callsOf(method: string): Call[] {
    return this.calls.filter(c => c.method === method)
  }

  async waitFor(method: string, pred: (c: Call) => boolean = () => true, timeoutMs = 3000): Promise<Call> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const c = this.calls.find(x => x.method === method && pred(x))
      if (c) return c
      await Bun.sleep(20)
    }
    throw new Error(`timeout waiting for ${method}; got: ${this.calls.map(c => c.method).join(', ')}`)
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const m = /^\/bot[^/]+\/(\w+)$/.exec(url.pathname)
    if (!m) return new Response('not found', { status: 404 })
    const method = m[1]
    let body: Record<string, unknown> = {}
    const ct = req.headers.get('content-type') ?? ''
    if (ct.includes('json')) body = (await req.json()) as Record<string, unknown>
    else if (ct.includes('form')) {
      const form = await req.formData()
      for (const [k, v] of form.entries()) body[k] = typeof v === 'string' ? v : '(file)'
    }
    if (method !== 'getUpdates') this.calls.push({ method, body })
    const fail = this.failures.get(method)
    if (fail) return Response.json({ ok: false, error_code: fail.code, description: fail.description })
    return Response.json({ ok: true, result: await this.result(method, body) })
  }

  private async result(method: string, body: Record<string, unknown>): Promise<unknown> {
    const now = Math.floor(Date.now() / 1000)
    switch (method) {
      case 'getMe':
        return { id: 999, is_bot: true, first_name: 'Test', username: 'testbot' }
      case 'getUpdates': {
        if (!this.updates.length) {
          await new Promise<void>(r => {
            const t = setTimeout(r, 500)
            this.waiters.push(() => { clearTimeout(t); r() })
          })
        }
        const offset = Number(body.offset ?? 0)
        const out = this.updates.filter(u => (u as { update_id: number }).update_id >= offset)
        this.updates = this.updates.filter(u => (u as { update_id: number }).update_id >= offset + out.length)
        // grammY confirms by passing offset = last+1 next time.
        this.updates = []
        return out
      }
      case 'sendMessage':
      case 'sendPhoto':
      case 'sendDocument':
      case 'sendRichMessage':
        return {
          message_id: this.nextMessageId++, date: now, chat: { id: Number(body.chat_id), type: String(body.chat_id).startsWith('-') ? 'supergroup' : 'private' },
          ...(body.message_thread_id ? { message_thread_id: Number(body.message_thread_id), is_topic_message: true } : {}),
          text: body.text,
        }
      case 'createForumTopic':
        return { message_thread_id: this.nextThreadId++, name: body.name, icon_color: 7322096 }
      case 'getChat':
        return { id: Number(body.chat_id), type: 'supergroup', title: 'Test Group', is_forum: true }
      case 'getChatMember':
        return { status: 'administrator', user: { id: 999, is_bot: true, first_name: 'Test' }, can_manage_topics: true, can_pin_messages: true, can_delete_messages: true }
      case 'createChatInviteLink':
        return { invite_link: 'https://t.me/+fakeInvite', creator: { id: 999, is_bot: true, first_name: 'Test' }, creates_join_request: false, is_primary: false, is_revoked: false, name: body.name, member_limit: body.member_limit }
      case 'getFile':
        return { file_id: body.file_id, file_unique_id: 'u1', file_path: 'photos/x.jpg' }
      default:
        return true
    }
  }
}

let nextMsg = 1

export function textMessage(o: { from?: number; chat?: number; text: string; thread?: number; replyTo?: Record<string, unknown>; extra?: Record<string, unknown> }): Record<string, unknown> {
  const from = o.from ?? 111
  const chat = o.chat ?? from
  return {
    message: {
      message_id: nextMsg++,
      date: Math.floor(Date.now() / 1000),
      from: { id: from, is_bot: false, first_name: 'Den', username: 'den' },
      chat: chat < 0 ? { id: chat, type: 'supergroup', title: 'Test Group', is_forum: true } : { id: chat, type: 'private', first_name: 'Den' },
      text: o.text,
      ...(o.thread != null ? { message_thread_id: o.thread, is_topic_message: true } : {}),
      ...(o.replyTo ? { reply_to_message: o.replyTo } : {}),
      ...(o.text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: o.text.split(' ')[0].length }] } : {}),
      ...o.extra,
    },
  }
}

export function callbackQuery(data: string, o: { from?: number; chat?: number; messageId?: number } = {}): Record<string, unknown> {
  const from = o.from ?? 111
  const chat = o.chat ?? from
  return {
    callback_query: {
      id: String(nextMsg++),
      from: { id: from, is_bot: false, first_name: 'Den' },
      chat_instance: 'x',
      data,
      message: { message_id: o.messageId ?? 1, date: 0, chat: { id: chat, type: chat < 0 ? 'supergroup' : 'private' }, text: 'q' },
    },
  }
}
