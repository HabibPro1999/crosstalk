// crosstalk: message colleagues' Claude Code sessions through your
// organization's relay.
//
// Safety rules this module keeps:
//  - Nothing a colleague sends reaches the model until this person presses
//    "Show to Claude"; it then arrives framed as another person's untrusted
//    words (protocol.ts `envelope`), never as the user's own (no `asUser`).
//  - A message Claude composes waits for this person's "Send" unless they
//    turned `approveOutgoing` off; likely secrets are redacted before queueing.
//  - The relay URL must be https, except on localhost.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Connection, Incoming, Outgoing } from '../types'
import {
  MAX_TEXT,
  cleanText,
  envelope,
  parseInvite,
  redactSecrets,
  type InboxMessage,
  type InboxResponse,
  type JoinResponse,
  type Me,
  type Person,
  type SendResponse,
} from './protocol'
import {
  RelayError,
  ago,
  basename,
  describeError,
  formatPeople,
  isSavedCredentials,
  isTrustedSender,
  newLocalId,
  normalizeHandle,
  parseDm,
  parseJoin,
  preview,
  readConfig,
  relayUrlProblem,
  type Config,
} from './util'

type $ = EngineInterface

const PANE = 'crosstalk'
const TITLE = 'crosstalk'
const SEND_TOOL = 'mcp__crosstalk__send'
const WHO_TOOL = 'mcp__crosstalk__who'
/** `$.store` key of credentials `/crosstalk join` saved when settings refused them. */
const CREDENTIALS_KEY = 'credentials'

const inbox = atom({ plugin: 'crosstalk', key: 'inbox' } as const, [] as Incoming[], {
  shape: 'inbox-1',
})
const outbox = atom({ plugin: 'crosstalk', key: 'outbox' } as const, [] as Outgoing[], {
  shape: 'outbox-1',
})
const connection = atom(
  { plugin: 'crosstalk', key: 'connection' } as const,
  { status: 'connecting', handle: null, detail: null } as Connection,
  { shape: 'connection-1' },
)

// Session-local state. The module is evaluated afresh on every reload, and
// session.start runs again then, so these start over with it.
const session = {
  options: {} as Readonly<Record<string, unknown>>,
  isInteractive: false,
  config: readConfig({}) as Config,
  cursor: 0,
  label: 'claude-code',
  me: null as Me | null,
  failures: 0,
  isPolling: false,
  /** Where the credentials in force came from: `/config`, or what `/crosstalk join` stored. */
  source: 'settings' as 'settings' | 'store',
  /** Set once the settings in force have been read for this module load. */
  isLoaded: false,
  /** Set when the settings cannot work; no restart is tried until they change. */
  isParked: false,
  /** When each sender's messages were last delivered straight to Claude (the loop guard). */
  directTimes: new Map<string, number[]>(),
  timer: undefined as { cancel(): void } | undefined,
}

// ---------------------------------------------------------------- relay calls

async function api<T>($: $, method: string, path: string, body?: unknown): Promise<T> {
  const { relayUrl, token } = session.config
  const res = await $.http.fetch(`${relayUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let data: unknown
  try {
    data = JSON.parse(res.text)
  } catch {
    throw new RelayError(res.status, 'bad_response', `the relay answered ${res.status} with something that is not JSON`)
  }
  if (!res.ok) {
    const err = data as { error?: string; message?: string }
    throw new RelayError(res.status, err.error ?? 'error', err.message ?? `the relay answered ${res.status}`)
  }
  return data as T
}

async function whoAmI($: $): Promise<Me> {
  if (!session.me) session.me = await api<Me>($, 'GET', '/v1/me')
  return session.me
}

async function listPeople($: $): Promise<string> {
  const { people } = await api<{ people: Person[] }>($, 'GET', '/v1/people')
  const me = await whoAmI($)
  return formatPeople(people, me.handle)
}

function deliver($: $, to: string, text: string, replyTo: number | null): Promise<SendResponse> {
  return api<SendResponse>($, 'POST', '/v1/messages', {
    to,
    text,
    ...(replyTo === null ? {} : { replyTo }),
  })
}

// ---------------------------------------------------------------- session ui

async function setConnection($: $, next: Connection): Promise<void> {
  await update($, connection, () => next)
}

async function refreshStatus($: $): Promise<void> {
  const waiting = (await read($, inbox)).length
  const drafts = (await read($, outbox)).length
  const parts = [waiting ? `${waiting} in` : '', drafts ? `${drafts} to approve` : ''].filter(Boolean)
  // The engine already prefixes a status entry with the plugin's name.
  $.ui.status(parts.length ? `✉ ${parts.join(', ')}` : undefined)
}

async function tellClaude($: $, text: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch {
    // A note for the model is a courtesy; the pane already shows the outcome.
  }
}

function openPane($: $) {
  return $.ui.open({ id: PANE, title: TITLE })
}

// ---------------------------------------------------------------- inbox

async function mergeInbox($: $, res: InboxResponse): Promise<InboxMessage[]> {
  const before = await read($, inbox)
  const known = new Set(before.map(m => m.id))
  const fresh = res.messages.filter(m => !known.has(m.id))
  const open = new Set(res.openIds)
  await update($, inbox, list => {
    // Drop what another of this person's sessions accepted or dismissed.
    const kept = list.filter(m => open.has(m.id) || m.isBusy)
    const ids = new Set(kept.map(m => m.id))
    const added = fresh.filter(m => !ids.has(m.id)).map(m => ({ ...m, isBusy: false }))
    return [...kept, ...added].slice(-100)
  })
  return fresh
}

function schedule($: $, ms: number): void {
  session.timer?.cancel()
  session.timer = $.clock.after(ms, () => {
    void poll($)
  })
}

/**
 * Starts the connection when nothing runs it: after a reload (a settings
 * change reloads the module without a new session.start), the first redraw
 * of the band or pane calls this. Cheap and idempotent.
 */
function ensureConnection($: $): void {
  if (session.timer || session.isPolling || session.isParked) return
  session.isInteractive = true
  schedule($, 0)
}

async function poll($: $): Promise<void> {
  if (session.isPolling) return
  session.isPolling = true
  if (!session.isLoaded) {
    session.isLoaded = true
    session.config = await loadConfig($)
    session.isLoaded = true
  }
  if (session.config.problem) {
    session.isPolling = false
    session.isParked = true
    session.timer = undefined
    await setConnection($, { status: 'unconfigured', handle: null, detail: session.config.problem })
    await refreshStatus($)
    return
  }
  let delay = 200
  try {
    const me = await whoAmI($)
    // Online as soon as the relay accepts the token, not after the first
    // long-poll returns (up to 20 s later).
    if ((await read($, connection)).status !== 'online') {
      await setConnection($, { status: 'online', handle: me.handle, detail: null })
    }
    const res = await api<InboxResponse>(
      $,
      'GET',
      `/v1/inbox?after=${session.cursor}&wait=${session.config.waitSeconds}&label=${encodeURIComponent(session.label)}`,
    )
    session.cursor = res.cursor
    session.failures = 0
    const current = await read($, connection)
    if (current.status !== 'online') await setConnection($, { status: 'online', handle: me.handle, detail: null })
    const fresh = await mergeInbox($, res)
    const waiting: InboxMessage[] = []
    for (const message of fresh) {
      const isDirect = mayDeliverDirect(message.from) && (await deliverDirect($, message))
      if (!isDirect) waiting.push(message)
    }
    if (waiting.length > 0) {
      const senders = [...new Set(waiting.map(m => `@${m.from}`))].join(', ')
      $.ui.toast(`crosstalk: new message from ${senders}. Open it with /crosstalk.`)
      void $.ui.notify(`New message from ${senders}`, { title: 'crosstalk' }).catch(() => {})
    }
    await refreshStatus($)
  } catch (error) {
    session.failures += 1
    const isUnauthorized = error instanceof RelayError && error.status === 401
    if (isUnauthorized) session.me = null
    await setConnection($, {
      status: 'error',
      handle: session.me?.handle ?? null,
      detail: isUnauthorized
        ? 'The relay rejected your token. Ask your relay admin for a new one, then update it in /config.'
        : describeError(error),
    })
    delay = isUnauthorized ? 5 * 60_000 : Math.min(60_000, 1000 * 2 ** Math.min(session.failures, 6))
  } finally {
    session.isPolling = false
  }
  schedule($, delay)
}

async function setIncomingBusy($: $, id: number, isBusy: boolean): Promise<void> {
  await update($, inbox, list => list.map(m => (m.id === id ? { ...m, isBusy } : m)))
}

async function acknowledge($: $, id: number, action: 'accepted' | 'dismissed'): Promise<Incoming | null> {
  const message = (await read($, inbox)).find(m => m.id === id)
  if (!message || message.isBusy) return null
  await setIncomingBusy($, id, true)
  try {
    await api($, 'POST', '/v1/inbox/ack', { ids: [id], action })
  } catch (error) {
    await setIncomingBusy($, id, false)
    $.ui.toast(`crosstalk: could not ${action === 'accepted' ? 'open' : 'dismiss'} the message: ${describeError(error)}`)
    return null
  }
  await update($, inbox, list => list.filter(m => m.id !== id))
  await refreshStatus($)
  return message
}

async function accept($: $, id: number): Promise<void> {
  const message = await acknowledge($, id, 'accepted')
  if (!message) return
  // A turn of its own once the session is idle, framed as a plugin's message
  // carrying another person's words: never `asUser`.
  void $.prompt.submit({ text: envelope(message, session.me?.handle ?? 'you') })
}

/** Messages one sender may deliver straight to Claude per minute before they wait for approval. */
const DIRECT_PER_MINUTE = 6

function mayDeliverDirect(from: string): boolean {
  if (!isTrustedSender(from, session.config.autoDeliverFrom)) return false
  const now = Date.now()
  const recent = (session.directTimes.get(from) ?? []).filter(at => at > now - 60_000)
  session.directTimes.set(from, recent)
  if (recent.length >= DIRECT_PER_MINUTE) return false
  recent.push(now)
  return true
}

/**
 * Hands a trusted sender's message to Claude as this person's own prompt:
 * exactly the text, no frame, no approval (`autoDeliverFrom`).
 */
async function deliverDirect($: $, message: InboxMessage): Promise<boolean> {
  const acked = await acknowledge($, message.id, 'accepted')
  if (!acked) return false
  void $.prompt.submit({ text: message.text, asUser: true })
  $.ui.toast(`crosstalk: @${message.from}'s message went to Claude.`)
  return true
}

async function dismiss($: $, id: number): Promise<void> {
  await acknowledge($, id, 'dismissed')
}

// ---------------------------------------------------------------- outbox

function prepare(raw: unknown): { text: string; redacted: string[] } {
  const cleaned = cleanText(typeof raw === 'string' ? raw : '')
  const { text, kinds } = redactSecrets(cleaned)
  return { text, redacted: kinds }
}

async function queueDraft($: $, draft: Outgoing): Promise<void> {
  await update($, outbox, list => [...list, draft].slice(-50))
  await refreshStatus($)
  $.ui.toast(`crosstalk: Claude drafted a message to @${draft.to}. Review it in the crosstalk pane.`)
  void openPane($)
}

async function approve($: $, localId: string): Promise<void> {
  const draft = (await read($, outbox)).find(d => d.localId === localId)
  if (!draft || draft.isBusy) return
  await update($, outbox, list => list.map(d => (d.localId === localId ? { ...d, isBusy: true, error: null } : d)))
  try {
    const { id } = await deliver($, draft.to, draft.text, draft.replyTo)
    await update($, outbox, list => list.filter(d => d.localId !== localId))
    $.ui.toast(`crosstalk: sent to @${draft.to}.`)
    await tellClaude($, `crosstalk: the user approved your message to @${draft.to}; it was sent (message #${id}).`)
  } catch (error) {
    const reason = describeError(error)
    await update($, outbox, list => list.map(d => (d.localId === localId ? { ...d, isBusy: false, error: reason } : d)))
  }
  await refreshStatus($)
}

async function discard($: $, localId: string): Promise<void> {
  const draft = (await read($, outbox)).find(d => d.localId === localId)
  if (!draft || draft.isBusy) return
  await update($, outbox, list => list.filter(d => d.localId !== localId))
  await refreshStatus($)
  await tellClaude(
    $,
    `crosstalk: the user discarded your draft message to @${draft.to}; it was not sent. Do not resend it unless they ask.`,
  )
}

// ---------------------------------------------------------------- joining

/**
 * The settings in force: credentials `/crosstalk join` had to keep in the
 * mod's own store win (settings refused them); else the `/config` values.
 */
async function loadConfig($: $): Promise<Config> {
  // A token typed into /config wins; else what /crosstalk join stored.
  if (String(session.options.token ?? '').trim()) {
    session.source = 'settings'
    return readConfig(session.options)
  }
  let saved: unknown
  try {
    saved = await $.store.get(CREDENTIALS_KEY)
  } catch {
    saved = undefined
  }
  session.source = isSavedCredentials(saved) ? 'store' : 'settings'
  return isSavedCredentials(saved)
    ? readConfig({ ...session.options, relayUrl: saved.relayUrl, token: saved.token })
    : readConfig(session.options)
}

/** Switches this session to new settings and reconnects. */
async function applyConfig($: $, config: Config): Promise<void> {
  session.timer?.cancel()
  session.timer = undefined
  session.isLoaded = true
  session.isParked = false
  session.config = config
  session.me = null
  session.cursor = 0
  session.failures = 0
  await startConnection($, session.isInteractive)
}

async function trySetting($: $, key: string, value: string): Promise<boolean> {
  try {
    const result = await $.config.set({ key, value })
    return result.deny === undefined
  } catch {
    return false
  }
}

/**
 * Keeps the credentials `/crosstalk join` received in the mod's own store.
 *
 * Not in settings: changing a setting reloads the module at once, which can
 * cut the command off between two writes and lose the token (0.2.0 did).
 * A person who wants the token in secure storage pastes it into /config,
 * which then wins (`loadConfig`).
 */
async function storeCredentials($: $, relayUrl: string, token: string, handle: string): Promise<void> {
  await $.store.set(CREDENTIALS_KEY, { relayUrl, token, handle })
}

async function postJoin($: $, relayUrl: string, body: Record<string, unknown>): Promise<JoinResponse> {
  const res = await $.http.fetch(`${relayUrl}/v1/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  let data: unknown
  try {
    data = JSON.parse(res.text)
  } catch {
    throw new RelayError(res.status, 'bad_response', `the relay answered ${res.status} with something that is not JSON`)
  }
  if (!res.ok) {
    const err = data as { error?: string; message?: string }
    throw new RelayError(res.status, err.error ?? 'error', err.message ?? `the relay answered ${res.status}`)
  }
  return data as JoinResponse
}

async function runJoin($: $, args: string): Promise<{ text: string }> {
  const parsed = parseJoin(args)
  const invite = parsed ? parseInvite(parsed.invite) : null
  if (!parsed || !invite) {
    return {
      text:
        'Usage: /crosstalk join <invite> <your-handle> [Your Name]\n' +
        'The invite looks like https://relay.example.com#inv_… ; a handle is 3-40 lowercase letters, digits, ".", "_" or "-".',
    }
  }
  const urlProblem = relayUrlProblem(invite.relayUrl)
  if (urlProblem) return { text: urlProblem }

  let joined: JoinResponse
  try {
    joined = await postJoin($, invite.relayUrl, {
      invite: invite.code,
      handle: parsed.handle,
      displayName: parsed.displayName,
    })
  } catch (error) {
    return { text: `Could not join: ${describeError(error)}` }
  }

  try {
    await storeCredentials($, invite.relayUrl, joined.token, joined.handle)
  } catch (error) {
    return {
      text:
        `Joined as @${joined.handle}, but could not save your token (${(error as Error).message}). ` +
        'Ask your relay admin to run: admin.ts rotate ' + joined.handle + ', then paste the new token into /config.',
    }
  }
  session.source = 'store'
  session.options = { ...session.options, token: '' }
  await applyConfig($, readConfig({ ...session.options, relayUrl: invite.relayUrl, token: joined.token }))
  return {
    text:
      `Joined crosstalk as @${joined.handle} (${joined.displayName}). Your token is saved in the mod's storage on this computer.\n` +
      'Try /crosstalk who, then /dm <handle> <message>. Incoming messages appear in /crosstalk.',
  }
}

async function runUrl($: $, args: string): Promise<{ text: string }> {
  const relayUrl = args.trim().replace(/\/+$/, '')
  if (!relayUrl) return { text: 'Usage: /crosstalk url <relay url>, e.g. /crosstalk url https://relay.example.com' }
  const urlProblem = relayUrlProblem(relayUrl)
  if (urlProblem) return { text: urlProblem }
  const { token } = session.config
  if (!token) return { text: 'Not joined yet: use /crosstalk join with an invite first.' }

  const next = readConfig({ ...session.options, relayUrl, token })
  const previous = session.config
  session.config = next
  try {
    const me = await api<Me>($, 'GET', '/v1/me')
    if (session.source === 'store') {
      await storeCredentials($, relayUrl, token, me.handle)
    } else if (!(await trySetting($, 'crosstalk.relayUrl', relayUrl))) {
      // Settings refused the address: keep it beside the token in the store.
      await storeCredentials($, relayUrl, token, me.handle)
      session.source = 'store'
    }
    await applyConfig($, next)
    return { text: `crosstalk now uses ${relayUrl}, as @${me.handle}.` }
  } catch (error) {
    session.config = previous
    return { text: `Kept the old address: ${relayUrl} did not accept your token (${describeError(error)}).` }
  }
}

const HELP = [
  '/crosstalk                 open the inbox',
  '/crosstalk who             list colleagues and who is online',
  '/crosstalk status          show the connection',
  '/crosstalk join <invite> <handle> [Your Name]   join a relay with an invite',
  '/crosstalk url <relay url> switch to a relay\'s new address (after it restarts)',
  '/dm <handle> <message>     send a message now',
].join('\n')

// ---------------------------------------------------------------- setup

async function registerSurface($: $): Promise<void> {
  await $.command.register({
    name: 'dm',
    description: 'Send a crosstalk message to a colleague (sent at once, as you typed it)',
    argumentHint: '<handle> <message>',
  })
  await $.command.register({
    name: 'crosstalk',
    description: 'Open the crosstalk inbox; join a relay, list colleagues, show the connection',
    argumentHint: '[join <invite> <handle> <Name> | url <relay url> | who | status | help]',
  })
  await $.tool.register({
    name: 'send',
    description:
      "Send a short plain-text message to a colleague's Claude Code session through the organization's crosstalk relay. " +
      'Use only when the user asks you to message someone, or to reply to a crosstalk message they showed you. ' +
      'Never include secrets, credentials or code the user has not asked you to share. ' +
      'Unless the user turned approval off, the message waits for the user to approve it in the crosstalk pane.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The colleague\'s handle, e.g. "bob" (the who tool lists them).' },
        text: { type: 'string', description: `The message, at most ${MAX_TEXT} characters.` },
        replyTo: { type: 'number', description: 'The id of the crosstalk message this answers, if any.' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'who',
    description:
      'List the colleagues reachable through crosstalk, with their handles and whether their Claude Code is online.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    isDeferred: false,
  })
}

async function startConnection($: $, isInteractive: boolean): Promise<void> {
  const { problem } = session.config
  session.timer?.cancel()
  if (problem) {
    session.isParked = true
    await setConnection($, { status: 'unconfigured', handle: null, detail: problem })
  } else if (isInteractive) {
    // Only an interactive session has a person to show incoming messages to.
    await setConnection($, { status: 'connecting', handle: null, detail: null })
    schedule($, 0)
  }
  await refreshStatus($)
}

// ---------------------------------------------------------------- commands and tools

async function runDm($: $, args: string): Promise<{ text: string }> {
  const parsed = parseDm(args)
  if (!parsed) return { text: 'Usage: /dm <handle> <message>. See who is there with /crosstalk who.' }
  if (session.config.problem) return { text: `crosstalk is not set up: ${session.config.problem}` }
  const { text, redacted } = prepare(parsed.text)
  if (!text) return { text: 'The message is empty.' }
  if (text.length > MAX_TEXT) return { text: `Messages are at most ${MAX_TEXT} characters.` }
  try {
    const { id } = await deliver($, parsed.to, text, null)
    const note = redacted.length ? ` Redacted before sending: ${redacted.join(', ')}.` : ''
    return { text: `Sent to @${parsed.to} (message #${id}).${note}` }
  } catch (error) {
    return { text: `Not sent: ${describeError(error)}` }
  }
}

async function runCrosstalk($: $, args: string): Promise<{ text: string }> {
  const [first = '', ...rest] = args.trim().split(/\s+/)
  const arg = first.toLowerCase()
  if (arg === 'join') return runJoin($, rest.join(' '))
  if (arg === 'url') return runUrl($, rest.join(' '))
  if (arg === 'help') return { text: HELP }
  if (arg === 'who') {
    if (session.config.problem) return { text: `crosstalk is not set up: ${session.config.problem}` }
    try {
      return { text: await listPeople($) }
    } catch (error) {
      return { text: `Could not list colleagues: ${describeError(error)}` }
    }
  }
  if (arg === 'status') {
    const c = await read($, connection)
    const who = c.handle ? ` as @${c.handle}` : ''
    return { text: `crosstalk ${c.status}${who}${c.detail ? `: ${c.detail}` : ''}. Relay: ${session.config.relayUrl}.` }
  }
  await openPane($)
  const waiting = (await read($, inbox)).length
  const drafts = (await read($, outbox)).length
  return { text: `crosstalk inbox opened: ${waiting} waiting, ${drafts} to approve.` }
}

async function runSendTool(
  $: $,
  input: { to?: unknown; text?: unknown; replyTo?: unknown },
): Promise<{ result: string } | { deny: string }> {
  const { config } = session
  if (config.problem) return { deny: `crosstalk is not set up: ${config.problem}` }
  const to = normalizeHandle(input.to)
  if (!to) return { deny: '"to" must be a colleague\'s handle, like "bob". The who tool lists them.' }
  const { text, redacted } = prepare(input.text)
  if (!text) return { deny: 'The message is empty.' }
  if (text.length > MAX_TEXT) return { deny: `Messages are at most ${MAX_TEXT} characters; shorten it.` }
  const replyTo = typeof input.replyTo === 'number' && Number.isSafeInteger(input.replyTo) ? input.replyTo : null
  const redactNote = redacted.length ? ` Redacted before queueing: ${redacted.join(', ')}.` : ''

  if (config.approveOutgoing) {
    await queueDraft($, {
      localId: newLocalId(),
      to,
      text,
      replyTo,
      createdAt: Date.now(),
      redacted,
      isBusy: false,
      error: null,
    })
    return {
      result:
        `Not sent yet: the message to @${to} is waiting for the user's approval in the crosstalk pane.${redactNote} ` +
        'You will be told when they send or discard it. Do not send it again.',
    }
  }

  try {
    const { id } = await deliver($, to, text, replyTo)
    return { result: `Sent to @${to} (message #${id}).${redactNote}` }
  } catch (error) {
    return { deny: `Not sent: ${describeError(error)}` }
  }
}

async function runWhoTool($: $): Promise<{ result: string } | { deny: string }> {
  if (session.config.problem) return { deny: `crosstalk is not set up: ${session.config.problem}` }
  try {
    return { result: await listPeople($) }
  } catch (error) {
    return { deny: `Could not list colleagues: ${describeError(error)}` }
  }
}

// ---------------------------------------------------------------- module

export const register: Register = (on, options) => {
  session.options = options
  session.config = readConfig(options)

  on('session.start', async ($, e, next) => {
    session.label = basename(e.cwd)
    session.isInteractive = e.isInteractive
    session.config = await loadConfig($)
    await registerSurface($)
    const started = await next(e)
    await startConnection($, e.isInteractive)
    return started
  })

  on('session.end', ($, e, next) => {
    session.timer?.cancel()
    session.timer = undefined
    return next(e)
  })

  on('command.run', { command: 'dm' }, ($, e) => runDm($, e.args))
  on('command.run', { command: 'crosstalk' }, ($, e) => runCrosstalk($, e.args))
  on('tool.call', { tool: SEND_TOOL }, ($, e) =>
    runSendTool($, { to: e.to, text: e.text, replyTo: e.replyTo }),
  ).catch(() => ({ deny: 'crosstalk failed while sending; nothing was sent.' }))
  on('tool.call', { tool: WHO_TOOL }, $ => runWhoTool($)).catch(() => ({
    deny: 'crosstalk failed while listing colleagues.',
  }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    ensureConnection($)
    if (e.props.hasSurvey) return next(e)
    const waiting = await read($, inbox)
    const drafts = (await read($, outbox)).filter(d => !d.isBusy)
    if (waiting.length === 0 && drafts.length === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const parts: string[] = []
    if (waiting.length) {
      const senders = [...new Set(waiting.map(m => `@${m.from}`))]
      const shown = senders.slice(0, 3).join(', ') + (senders.length > 3 ? ` +${senders.length - 3}` : '')
      parts.push(`${waiting.length} message${waiting.length > 1 ? 's' : ''} from ${shown}`)
    }
    if (drafts.length) parts.push(`${drafts.length} draft${drafts.length > 1 ? 's' : ''} to approve`)

    return (
      <Box flexDirection="row" gap={1}>
        <Text color="suggestion">{`✉ crosstalk: ${parts.join(' · ')}`}</Text>
        <Button key="crosstalk-open" label="Open" onPress={() => openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    ensureConnection($)
    const { Box, Text, Button } = $.ui.resolve(e)
    const conn = await read($, connection)
    const waiting = await read($, inbox)
    const drafts = await read($, outbox)

    const statusLine =
      conn.status === 'online'
        ? `● online as @${conn.handle}`
        : conn.status === 'connecting'
          ? '○ connecting…'
          : `○ ${conn.status === 'unconfigured' ? 'not set up' : 'offline'}: ${conn.detail ?? ''}`
    const statusColor = conn.status === 'online' ? 'success' : conn.status === 'connecting' ? 'subtle' : 'warning'

    return (
      <Box flexDirection="column" gap={1}>
        <Text color={statusColor}>{statusLine}</Text>

        {waiting.length === 0 && drafts.length === 0 && (
          <Text dimColor>{'No messages. Send one with /dm <handle> <message>; /crosstalk who lists colleagues.'}</Text>
        )}

        {waiting.length > 0 && <Text bold>{`Incoming (${waiting.length})`}</Text>}
        {waiting.map(m => (
          <Box key={`in-${m.id}`} flexDirection="column">
            <Text bold>{`${m.fromName} (@${m.from}) · ${ago(m.createdAt)}${m.replyTo ? ` · reply to #${m.replyTo}` : ''}`}</Text>
            <Text wrap="wrap">{preview(m.text)}</Text>
            <Box flexDirection="row" gap={2}>
              <Button
                key={`show-${m.id}`}
                label={m.isBusy ? 'Working…' : 'Show to Claude'}
                variant="primary"
                onPress={() => accept($, m.id)}
              />
              <Button key={`dismiss-${m.id}`} label="Dismiss" onPress={() => dismiss($, m.id)} />
            </Box>
          </Box>
        ))}

        {drafts.length > 0 && <Text bold>{`Claude's drafts to approve (${drafts.length})`}</Text>}
        {drafts.map(d => (
          <Box key={`out-${d.localId}`} flexDirection="column">
            <Text bold>{`To @${d.to} · ${ago(d.createdAt)}${d.replyTo ? ` · reply to #${d.replyTo}` : ''}`}</Text>
            <Text wrap="wrap">{preview(d.text)}</Text>
            {d.redacted.length > 0 && <Text color="warning">{`Redacted: ${d.redacted.join(', ')}`}</Text>}
            {d.error && <Text color="error">{`Not sent: ${d.error}`}</Text>}
            <Box flexDirection="row" gap={2}>
              <Button
                key={`send-${d.localId}`}
                label={d.isBusy ? 'Sending…' : 'Send'}
                variant="primary"
                onPress={() => approve($, d.localId)}
              />
              <Button key={`discard-${d.localId}`} label="Discard" onPress={() => discard($, d.localId)} />
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
