// The crosstalk relay: an HTTP server that authenticates each person by a
// bearer token, queues their messages to each other, and hands each person
// their open messages through a long-poll inbox. Nothing here trusts a
// client's claim about who it is: identity is the token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'

import {
  MAX_TEXT,
  MAX_WAIT_SECONDS,
  PROTOCOL_VERSION,
  INVITE_CODE,
  cleanText,
  isAckAction,
  type AckResponse,
  type ErrorCode,
  type InboxResponse,
  type JoinResponse,
  type Me,
  type Person,
  type SendResponse,
} from '../../mod/hooks/protocol.ts'
import { isValidHandle, sha256, type Store, type User } from './store.ts'

export type Limits = {
  /** Messages one person may send per rolling minute. */
  perMinute: number
  /** Messages one person may send per rolling day. */
  perDay: number
  /** Open (unacknowledged) messages a person's inbox holds before refusing more. */
  pendingPerRecipient: number
  /** Open messages one sender may have waiting in one recipient's inbox. */
  pendingPerPair: number
  /** An identical text to the same person within this window is refused. */
  dedupeMs: number
  /** A person counts as online this long after their last inbox poll. */
  onlineMs: number
  /** Acknowledged messages are deleted after this long. */
  ackedRetentionMs: number
  /** Unacknowledged messages are deleted after this long. */
  staleMs: number
  /** Largest request body accepted, in bytes. */
  maxBodyBytes: number
  /** Join attempts one client (by address) may make per ten minutes. */
  joinAttemptsPer10Min: number
}

export const DEFAULT_LIMITS: Limits = {
  perMinute: 12,
  perDay: 300,
  pendingPerRecipient: 100,
  pendingPerPair: 20,
  dedupeMs: 10 * 60_000,
  onlineMs: 75_000,
  ackedRetentionMs: 24 * 60 * 60_000,
  staleMs: 7 * 24 * 60 * 60_000,
  maxBodyBytes: 32 * 1024,
  joinAttemptsPer10Min: 10,
}

export type RelayOptions = {
  store: Store
  limits?: Partial<Limits>
  /** JSONL audit file; null or absent turns auditing off. */
  auditPath?: string | null
  /** Also write message bodies to the audit file (off by default). */
  auditContent?: boolean
  now?: () => number
  log?: (line: string) => void
}

export type Relay = {
  server: Server
  listen(port: number, host?: string): Promise<{ port: number; host: string }>
  close(): Promise<void>
}

class HttpError extends Error {
  readonly status: number
  readonly code: ErrorCode
  constructor(status: number, code: ErrorCode, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function createRelay(options: RelayOptions): Relay {
  const { store } = options
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits }
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})

  const sentAt = new Map<string, number[]>()
  const joinAttempts = new Map<string, number[]>()
  const waiters = new Map<string, Set<() => void>>()

  function audit(entry: Record<string, unknown>): void {
    if (!options.auditPath) return
    try {
      appendFileSync(options.auditPath, `${JSON.stringify({ ts: new Date(now()).toISOString(), ...entry })}\n`, {
        mode: 0o600,
      })
    } catch (error) {
      log(`audit write failed: ${(error as Error).message}`)
    }
  }

  function wake(handle: string): void {
    for (const resolve of waiters.get(handle) ?? []) resolve()
  }

  function waitForChange(handle: string, ms: number, res: ServerResponse): Promise<void> {
    return new Promise(resolve => {
      let set = waiters.get(handle)
      if (!set) waiters.set(handle, (set = new Set()))
      const done = () => {
        clearTimeout(timer)
        set.delete(done)
        if (set.size === 0) waiters.delete(handle)
        res.off('close', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      set.add(done)
      res.once('close', done)
    })
  }

  function checkRate(sender: string): void {
    const t = now()
    const recent = (sentAt.get(sender) ?? []).filter(at => at > t - 24 * 60 * 60_000)
    sentAt.set(sender, recent)
    if (recent.filter(at => at > t - 60_000).length >= limits.perMinute) {
      throw new HttpError(429, 'rate_limited', `At most ${limits.perMinute} messages a minute.`)
    }
    if (recent.length >= limits.perDay) {
      throw new HttpError(429, 'rate_limited', `At most ${limits.perDay} messages a day.`)
    }
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > limits.maxBodyBytes) throw new HttpError(413, 'too_large', 'Request body too large.')
      chunks.push(chunk as Buffer)
    }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      return value as Record<string, unknown>
    } catch {
      throw new HttpError(400, 'bad_request', 'The body must be a JSON object.')
    }
  }

  function authenticate(req: IncomingMessage): User {
    const header = req.headers.authorization ?? ''
    const match = /^Bearer\s+(\S+)$/i.exec(header)
    const user = match ? store.authenticate(match[1]) : undefined
    if (!user) throw new HttpError(401, 'unauthorized', 'A valid crosstalk token is required.')
    return user
  }

  function send(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded || res.destroyed) return
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(text)
  }

  async function postMessage(user: User, body: Record<string, unknown>): Promise<SendResponse> {
    const to = typeof body.to === 'string' ? body.to.trim().replace(/^@/, '').toLowerCase() : ''
    if (!isValidHandle(to)) throw new HttpError(400, 'bad_request', '"to" must be a handle.')
    if (to === user.handle) throw new HttpError(400, 'self_message', 'You cannot message yourself.')
    const recipient = store.getUser(to)
    if (!recipient || recipient.revokedAt !== null) {
      throw new HttpError(404, 'unknown_recipient', `Nobody is called @${to}.`)
    }
    if (typeof body.text !== 'string') throw new HttpError(400, 'bad_request', '"text" must be a string.')
    const text = cleanText(body.text)
    if (text.length === 0) throw new HttpError(400, 'bad_request', 'The message is empty.')
    if (text.length > MAX_TEXT) {
      throw new HttpError(413, 'too_large', `Messages are at most ${MAX_TEXT} characters.`)
    }
    const replyTo = body.replyTo === undefined || body.replyTo === null ? null : Number(body.replyTo)
    if (replyTo !== null && !Number.isSafeInteger(replyTo)) {
      throw new HttpError(400, 'bad_request', '"replyTo" must be a message id.')
    }

    checkRate(user.handle)
    if (store.isDuplicate(user.handle, to, text, now() - limits.dedupeMs)) {
      throw new HttpError(409, 'duplicate', 'You sent this exact message to them recently.')
    }
    if (store.pendingCount(to) >= limits.pendingPerRecipient) {
      throw new HttpError(429, 'recipient_full', `@${to} has too many unread messages.`)
    }
    if (store.pendingFrom(to, user.handle) >= limits.pendingPerPair) {
      throw new HttpError(429, 'recipient_full', `@${to} has not read your earlier messages yet.`)
    }

    const id = store.insertMessage({ sender: user.handle, recipient: to, text, replyTo }, now())
    sentAt.get(user.handle)?.push(now())
    audit({
      event: 'message',
      id,
      from: user.handle,
      to,
      chars: text.length,
      sha256: sha256(text),
      ...(options.auditContent ? { text } : {}),
    })
    wake(to)
    return { id }
  }

  async function getInbox(user: User, url: URL, res: ServerResponse): Promise<InboxResponse | undefined> {
    const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0)
    const wait = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0))
    const label = (url.searchParams.get('label') ?? '').slice(0, 60) || null
    store.touchPresence(user.handle, label, now())

    let messages = store.openMessages(user.handle, after)
    if (messages.length === 0 && wait > 0) {
      await waitForChange(user.handle, wait * 1000, res)
      if (res.destroyed) return undefined
      store.touchPresence(user.handle, label, now())
      messages = store.openMessages(user.handle, after)
    }
    const last = messages.at(-1)
    return { messages, openIds: store.openIds(user.handle), cursor: last ? last.id : after }
  }

  function ack(user: User, body: Record<string, unknown>): AckResponse {
    const ids = Array.isArray(body.ids) ? body.ids.map(Number) : []
    if (ids.length === 0 || ids.length > 200 || !ids.every(Number.isSafeInteger)) {
      throw new HttpError(400, 'bad_request', '"ids" must list 1-200 message ids.')
    }
    if (!isAckAction(body.action)) {
      throw new HttpError(400, 'bad_request', '"action" must be "accepted" or "dismissed".')
    }
    const acked = store.ack(user.handle, ids, body.action, now())
    if (acked > 0) {
      audit({ event: 'ack', by: user.handle, ids, action: body.action })
      wake(user.handle)
    }
    return { acked }
  }

  /**
   * The client's address: the proxy's header when one is in front (Cloudflare,
   * or a reverse proxy's X-Forwarded-For), else the socket's. The relay binds
   * loopback by default, so only the proxy can set these headers.
   */
  function clientAddress(req: IncomingMessage): string {
    const cf = req.headers['cf-connecting-ip']
    if (typeof cf === 'string' && cf) return cf
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0]!.trim()
    return req.socket.remoteAddress ?? 'unknown'
  }

  function join(req: IncomingMessage, body: Record<string, unknown>): JoinResponse {
    const client = clientAddress(req)
    const t = now()
    const recent = (joinAttempts.get(client) ?? []).filter(at => at > t - 10 * 60_000)
    if (recent.length >= limits.joinAttemptsPer10Min) {
      joinAttempts.set(client, recent)
      throw new HttpError(429, 'rate_limited', 'Too many join attempts. Try again in a few minutes.')
    }
    recent.push(t)
    joinAttempts.set(client, recent)

    const invite = typeof body.invite === 'string' ? body.invite.trim() : ''
    if (!INVITE_CODE.test(invite)) throw new HttpError(400, 'bad_request', '"invite" must be an invite code.')
    const handle = typeof body.handle === 'string' ? body.handle.trim().replace(/^@/, '').toLowerCase() : ''
    if (!isValidHandle(handle)) {
      throw new HttpError(
        400,
        'bad_request',
        'A handle is 3-40 characters: lowercase letters, digits, ".", "_" or "-", starting and ending with a letter or digit.',
      )
    }
    const displayName = cleanText(typeof body.displayName === 'string' ? body.displayName : '').slice(0, 80) || handle

    try {
      const token = store.redeemInvite(invite, handle, displayName, t)
      audit({ event: 'join', handle, client })
      return { handle, displayName, token }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'invite_invalid') throw new HttpError(403, 'invite_invalid', (error as Error).message)
      if (code === 'handle_taken') throw new HttpError(409, 'handle_taken', (error as Error).message)
      throw error
    }
  }

  function people(): Person[] {
    const t = now()
    return store.people().map(row => {
      const online = row.lastSeen !== null && t - row.lastSeen < limits.onlineMs
      return { ...row, online, label: online ? row.label : null }
    })
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://relay.invalid')
    const key = `${req.method} ${url.pathname}`

    if (key === 'GET /healthz') return send(res, 200, { ok: true, protocol: PROTOCOL_VERSION })
    if (key === 'POST /v1/join') return send(res, 201, join(req, await readJson(req)))

    const user = authenticate(req)
    switch (key) {
      case 'GET /v1/me':
        return send(res, 200, { handle: user.handle, displayName: user.displayName } satisfies Me)
      case 'GET /v1/people':
        return send(res, 200, { people: people() })
      case 'GET /v1/inbox': {
        const inbox = await getInbox(user, url, res)
        if (inbox) send(res, 200, inbox)
        return
      }
      case 'POST /v1/inbox/ack':
        return send(res, 200, ack(user, await readJson(req)))
      case 'POST /v1/messages':
        return send(res, 201, await postMessage(user, await readJson(req)))
      default:
        throw new HttpError(404, 'not_found', `No route ${key}.`)
    }
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        send(res, error.status, { error: error.code, message: error.message })
      } else {
        log(`error on ${req.method} ${req.url}: ${(error as Error)?.stack ?? error}`)
        send(res, 500, { error: 'server_error', message: 'Internal error.' })
      }
    })
  })
  // Long-polls hold a request up to MAX_WAIT_SECONDS; leave room above that.
  server.requestTimeout = (MAX_WAIT_SECONDS + 15) * 1000
  server.headersTimeout = 15_000

  const purge = setInterval(() => {
    const t = now()
    const removed = store.purge({
      ackedBefore: t - limits.ackedRetentionMs,
      staleBefore: t - limits.staleMs,
    })
    if (removed > 0) log(`purged ${removed} messages`)
  }, 10 * 60_000)
  purge.unref()

  return {
    server,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          const address = server.address()
          resolve({ port: typeof address === 'object' && address ? address.port : port, host })
        })
      })
    },
    close() {
      clearInterval(purge)
      for (const set of waiters.values()) for (const resolve of set) resolve()
      return new Promise(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
