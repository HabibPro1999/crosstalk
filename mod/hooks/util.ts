// Pure helpers of the crosstalk mod: no `$`, so tests import them directly.

import { MAX_WAIT_SECONDS, type Person } from './protocol'

export const PREVIEW_CHARS = 1200

export type Config = {
  relayUrl: string
  token: string
  approveOutgoing: boolean
  waitSeconds: number
  /** Why the mod cannot talk to the relay, or null when it can. */
  problem: string | null
}

export function readConfig(options: Readonly<Record<string, unknown>>): Config {
  const relayUrl = String(options.relayUrl ?? '').trim().replace(/\/+$/, '')
  const token = String(options.token ?? '').trim()
  const wait = Number(options.longPollSeconds ?? 20)
  let problem: string | null = null

  if (!token) {
    problem = 'No token set. Run /config, find crosstalk, and paste the token your relay admin gave you.'
  } else if (!token.startsWith('ct_')) {
    problem = 'The crosstalk token should start with ct_.'
  } else {
    try {
      const url = new URL(relayUrl)
      const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
        problem = 'The relay URL must use https (plain http is only allowed for localhost).'
      }
    } catch {
      problem = `The relay URL "${relayUrl}" is not a valid URL.`
    }
  }

  return {
    relayUrl,
    token,
    approveOutgoing: options.approveOutgoing !== 'off',
    waitSeconds: Number.isFinite(wait) ? Math.min(MAX_WAIT_SECONDS, Math.max(1, Math.round(wait))) : 20,
    problem,
  }
}

export class RelayError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function describeError(error: unknown): string {
  if (error instanceof RelayError) return error.message
  if (error instanceof Error) return `could not reach the relay (${error.message})`
  return 'could not reach the relay'
}

export function normalizeHandle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const handle = value.trim().replace(/^@/, '').toLowerCase()
  return /^[a-z0-9][a-z0-9._-]{1,38}[a-z0-9]$/.test(handle) ? handle : null
}

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function preview(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text
  return `${text.slice(0, PREVIEW_CHARS)}\n… ${text.length - PREVIEW_CHARS} more characters (shown in full if you show it to Claude)`
}

export function formatPeople(people: readonly Person[], myHandle: string | null): string {
  if (people.length === 0) return 'Nobody is registered on the relay yet.'
  return people
    .map(p => {
      const you = p.handle === myHandle ? ' (you)' : ''
      const where = p.online ? `online${p.label ? ` in ${p.label}` : ''}` : 'offline'
      return `${p.online ? '●' : '○'} @${p.handle}${you}: ${p.displayName}, ${where}`
    })
    .join('\n')
}

export function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'claude-code'
}

export function newLocalId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Splits `/dm` arguments into a handle and the message text. */
export function parseDm(args: string): { to: string; text: string } | null {
  const match = /^\s*(\S+)\s+([\s\S]+)$/.exec(args)
  const to = normalizeHandle(match?.[1])
  return match && to ? { to, text: match[2] ?? '' } : null
}
