// The crosstalk mod's state contract: the session values its pane, band and
// status line draw from.

/** A colleague's message waiting for this person to show it to Claude or dismiss it. */
export type Incoming = {
  id: number
  from: string
  fromName: string
  text: string
  replyTo: number | null
  createdAt: number
  /** `busy` while an accept or dismiss is in flight. */
  isBusy: boolean
}

/** A message Claude composed, waiting for this person to send or discard it. */
export type Outgoing = {
  localId: string
  to: string
  text: string
  replyTo: number | null
  createdAt: number
  /** Kinds of secret that were redacted from the text before it was queued. */
  redacted: string[]
  isBusy: boolean
  error: string | null
}

export type ConnectionStatus = 'unconfigured' | 'connecting' | 'online' | 'error'

export type Connection = {
  status: ConnectionStatus
  /** This person's handle, once the relay confirmed the token. */
  handle: string | null
  detail: string | null
}

declare module 'claude-code' {
  interface PluginState {
    crosstalk: {
      inbox: Shaped<Incoming[]>
      outbox: Shaped<Outgoing[]>
      connection: Shaped<Connection>
    }
  }
}
