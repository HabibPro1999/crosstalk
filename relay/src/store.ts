// Durable storage for the crosstalk relay: people, their hashed tokens,
// queued messages and presence. Built on node:sqlite, so the relay has no
// third-party runtime dependencies.

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'

import type { AckAction, InboxMessage } from '../../mod/hooks/protocol.ts'

const HANDLE = /^[a-z0-9][a-z0-9._-]{1,38}[a-z0-9]$/

export type User = { handle: string; displayName: string }
export type UserRecord = User & { createdAt: number; revokedAt: number | null }
export type PresenceRow = User & { lastSeen: number | null; label: string | null }

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function isValidHandle(handle: unknown): handle is string {
  return typeof handle === 'string' && HANDLE.test(handle)
}

export function newToken(): string {
  return `ct_${randomBytes(32).toString('base64url')}`
}

export type Store = ReturnType<typeof openStore>

export function openStore(path = ':memory:') {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      handle        TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      token_hash    TEXT NOT NULL UNIQUE,
      created_at    INTEGER NOT NULL,
      revoked_at    INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sender      TEXT NOT NULL REFERENCES users(handle),
      recipient   TEXT NOT NULL REFERENCES users(handle),
      text        TEXT NOT NULL,
      text_hash   TEXT NOT NULL,
      reply_to    INTEGER,
      created_at  INTEGER NOT NULL,
      acked_at    INTEGER,
      ack_action  TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_open ON messages(recipient, acked_at, id);
    CREATE INDEX IF NOT EXISTS messages_dupe ON messages(sender, recipient, text_hash, created_at);
    CREATE TABLE IF NOT EXISTS invites (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash   TEXT NOT NULL UNIQUE,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      max_uses    INTEGER NOT NULL,
      uses        INTEGER NOT NULL DEFAULT 0,
      revoked_at  INTEGER
    );
    CREATE TABLE IF NOT EXISTS presence (
      handle     TEXT PRIMARY KEY REFERENCES users(handle),
      last_seen  INTEGER NOT NULL,
      label      TEXT
    );
  `)

  const q = {
    addUser: db.prepare(
      'INSERT INTO users (handle, display_name, token_hash, created_at) VALUES (?, ?, ?, ?)',
    ),
    rotate: db.prepare('UPDATE users SET token_hash = ?, revoked_at = NULL WHERE handle = ?'),
    revoke: db.prepare('UPDATE users SET revoked_at = ? WHERE handle = ? AND revoked_at IS NULL'),
    byToken: db.prepare(
      'SELECT handle, display_name AS displayName FROM users WHERE token_hash = ? AND revoked_at IS NULL',
    ),
    byHandle: db.prepare(
      'SELECT handle, display_name AS displayName, created_at AS createdAt, revoked_at AS revokedAt FROM users WHERE handle = ?',
    ),
    users: db.prepare(
      'SELECT handle, display_name AS displayName, created_at AS createdAt, revoked_at AS revokedAt FROM users ORDER BY handle',
    ),
    insert: db.prepare(
      'INSERT INTO messages (sender, recipient, text, text_hash, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    open: db.prepare(`
      SELECT m.id, m.sender AS "from", u.display_name AS fromName, m.text,
             m.reply_to AS replyTo, m.created_at AS createdAt
      FROM messages m JOIN users u ON u.handle = m.sender
      WHERE m.recipient = ? AND m.acked_at IS NULL AND m.id > ?
      ORDER BY m.id LIMIT ?`),
    openIds: db.prepare(
      'SELECT id FROM messages WHERE recipient = ? AND acked_at IS NULL ORDER BY id',
    ),
    pending: db.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE recipient = ? AND acked_at IS NULL',
    ),
    pendingFrom: db.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE recipient = ? AND sender = ? AND acked_at IS NULL',
    ),
    dupe: db.prepare(
      'SELECT id FROM messages WHERE sender = ? AND recipient = ? AND text_hash = ? AND created_at >= ? LIMIT 1',
    ),
    ack: db.prepare(
      'UPDATE messages SET acked_at = ?, ack_action = ? WHERE id = ? AND recipient = ? AND acked_at IS NULL',
    ),
    purgeAcked: db.prepare('DELETE FROM messages WHERE acked_at IS NOT NULL AND acked_at < ?'),
    purgeStale: db.prepare('DELETE FROM messages WHERE acked_at IS NULL AND created_at < ?'),
    touch: db.prepare(`
      INSERT INTO presence (handle, last_seen, label) VALUES (?, ?, ?)
      ON CONFLICT(handle) DO UPDATE SET last_seen = excluded.last_seen,
        label = COALESCE(excluded.label, presence.label)`),
    addInvite: db.prepare(
      'INSERT INTO invites (code_hash, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?)',
    ),
    inviteByHash: db.prepare(
      'SELECT id, expires_at AS expiresAt, max_uses AS maxUses, uses, revoked_at AS revokedAt FROM invites WHERE code_hash = ?',
    ),
    useInvite: db.prepare('UPDATE invites SET uses = uses + 1 WHERE id = ?'),
    invites: db.prepare(
      'SELECT id, created_at AS createdAt, expires_at AS expiresAt, max_uses AS maxUses, uses, revoked_at AS revokedAt FROM invites ORDER BY id',
    ),
    revokeInvite: db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    people: db.prepare(`
      SELECT u.handle, u.display_name AS displayName, p.last_seen AS lastSeen, p.label
      FROM users u LEFT JOIN presence p ON p.handle = u.handle
      WHERE u.revoked_at IS NULL ORDER BY u.handle`),
  }

  const count = (row: unknown): number => Number((row as { n: number | bigint }).n)

  return {
    db,
    close: () => db.close(),

    /** Adds a person and returns their token, which is shown once and stored only as a hash. */
    addUser(handle: string, displayName: string, now = Date.now()): string {
      if (!isValidHandle(handle)) {
        throw new Error(
          'A handle is 3-40 characters: lowercase letters, digits, ".", "_" or "-", starting and ending with a letter or digit.',
        )
      }
      if (q.byHandle.get(handle)) throw new Error(`"${handle}" already exists.`)
      const token = newToken()
      q.addUser.run(handle, String(displayName || handle).slice(0, 80), sha256(token), now)
      return token
    },

    rotateToken(handle: string): string {
      if (!q.byHandle.get(handle)) throw new Error(`No user "${handle}".`)
      const token = newToken()
      q.rotate.run(sha256(token), handle)
      return token
    },

    revokeUser(handle: string, now = Date.now()): boolean {
      return Number(q.revoke.run(now, handle).changes) > 0
    },

    listUsers: () => q.users.all() as unknown as UserRecord[],
    getUser: (handle: string) => q.byHandle.get(handle) as UserRecord | undefined,

    authenticate(token: unknown): User | undefined {
      if (typeof token !== 'string' || !token.startsWith('ct_')) return undefined
      return q.byToken.get(sha256(token)) as User | undefined
    },

    insertMessage(
      m: { sender: string; recipient: string; text: string; replyTo?: number | null },
      now = Date.now(),
    ): number {
      const { lastInsertRowid } = q.insert.run(
        m.sender,
        m.recipient,
        m.text,
        sha256(m.text),
        m.replyTo ?? null,
        now,
      )
      return Number(lastInsertRowid)
    },

    openMessages(recipient: string, afterId = 0, limit = 50): InboxMessage[] {
      return (q.open.all(recipient, afterId, limit) as unknown as InboxMessage[]).map(row => ({
        ...row,
        id: Number(row.id),
        replyTo: row.replyTo === null ? null : Number(row.replyTo),
        createdAt: Number(row.createdAt),
      }))
    },

    openIds: (recipient: string): number[] =>
      (q.openIds.all(recipient) as { id: number | bigint }[]).map(row => Number(row.id)),
    pendingCount: (recipient: string) => count(q.pending.get(recipient)),
    pendingFrom: (recipient: string, sender: string) => count(q.pendingFrom.get(recipient, sender)),

    isDuplicate(sender: string, recipient: string, text: string, sinceMs: number): boolean {
      return q.dupe.get(sender, recipient, sha256(text), sinceMs) !== undefined
    },

    ack(recipient: string, ids: readonly number[], action: AckAction, now = Date.now()): number {
      let changed = 0
      for (const id of ids) changed += Number(q.ack.run(now, action, id, recipient).changes)
      return changed
    },

    purge(cutoffs: { ackedBefore: number; staleBefore: number }): number {
      return (
        Number(q.purgeAcked.run(cutoffs.ackedBefore).changes) +
        Number(q.purgeStale.run(cutoffs.staleBefore).changes)
      )
    },

    /** Creates an invite and returns its code, which is stored only as a hash. */
    createInvite(options: { maxUses: number; ttlMs: number }, now = Date.now()): { id: number; code: string } {
      const code = `inv_${randomBytes(32).toString('base64url')}`
      const { lastInsertRowid } = q.addInvite.run(sha256(code), now, now + options.ttlMs, options.maxUses)
      return { id: Number(lastInsertRowid), code }
    },

    /**
     * Spends one use of an invite to add a person, all or nothing. Throws an
     * Error whose `code` is `invite_invalid` or `handle_taken`.
     */
    redeemInvite(code: string, handle: string, displayName: string, now = Date.now()): string {
      db.exec('BEGIN IMMEDIATE')
      try {
        const invite = q.inviteByHash.get(sha256(code)) as
          | { id: number; expiresAt: number; maxUses: number; uses: number; revokedAt: number | null }
          | undefined
        if (!invite || invite.revokedAt !== null || invite.expiresAt <= now || invite.uses >= invite.maxUses) {
          throw Object.assign(new Error('This invite is not valid any more. Ask for a new one.'), {
            code: 'invite_invalid',
          })
        }
        if (q.byHandle.get(handle)) {
          throw Object.assign(new Error(`The handle @${handle} is taken. Pick another.`), { code: 'handle_taken' })
        }
        const token = this.addUser(handle, displayName, now)
        q.useInvite.run(invite.id)
        db.exec('COMMIT')
        return token
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    listInvites: () =>
      q.invites.all() as unknown as {
        id: number
        createdAt: number
        expiresAt: number
        maxUses: number
        uses: number
        revokedAt: number | null
      }[],

    revokeInvite(id: number, now = Date.now()): boolean {
      return Number(q.revokeInvite.run(now, id).changes) > 0
    },

    touchPresence(handle: string, label: string | null, now = Date.now()): void {
      q.touch.run(handle, now, label)
    },

    people: () =>
      (q.people.all() as unknown as PresenceRow[]).map(row => ({
        ...row,
        lastSeen: row.lastSeen === null ? null : Number(row.lastSeen),
      })),
  }
}
