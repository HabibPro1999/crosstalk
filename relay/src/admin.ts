// Manages who may use the relay. Run on the relay host:
//
//   node src/admin.ts add <handle> [display name]   prints the new token once
//   node src/admin.ts rotate <handle>                prints a replacement token
//   node src/admin.ts revoke <handle>
//   node src/admin.ts list
//   node src/admin.ts invite [--uses N] [--days D] [--url https://relay]   prints an invite
//   node src/admin.ts invites
//   node src/admin.ts revoke-invite <id>
//
// CROSSTALK_DB names the SQLite file (default ./data/crosstalk.db).

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { formatInvite } from '../../mod/hooks/protocol.ts'
import { openStore } from './store.ts'

const dbPath = resolve(process.env.CROSSTALK_DB ?? 'data/crosstalk.db')
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
const store = openStore(dbPath)

const [command, handle, ...rest] = process.argv.slice(2)

/** Reads `--name value` from the arguments after the command. */
function flag(name: string): string | undefined {
  const args = process.argv.slice(3)
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}

function need(value: string | undefined, what: string): string {
  if (!value) {
    console.error(`Missing ${what}.`)
    process.exit(2)
  }
  return value
}

try {
  switch (command) {
    case 'add': {
      const h = need(handle, 'a handle')
      const token = store.addUser(h, rest.join(' ') || h)
      console.log(`Added @${h}. Their token (shown once; give it to them privately):\n${token}`)
      break
    }
    case 'rotate': {
      const token = store.rotateToken(need(handle, 'a handle'))
      console.log(`New token for @${handle} (the old one no longer works):\n${token}`)
      break
    }
    case 'revoke':
      console.log(store.revokeUser(need(handle, 'a handle')) ? `Revoked @${handle}.` : `No active @${handle}.`)
      break
    case 'list':
      for (const u of store.listUsers()) {
        const state = u.revokedAt ? 'revoked' : 'active'
        console.log(`${u.handle.padEnd(24)} ${state.padEnd(8)} ${u.displayName}`)
      }
      break
    case 'invite': {
      const maxUses = Number(flag('uses') ?? 20)
      const days = Number(flag('days') ?? 7)
      if (!Number.isInteger(maxUses) || maxUses < 1 || !(days > 0)) throw new Error('--uses must be a whole number and --days positive.')
      const { id, code } = store.createInvite({ maxUses, ttlMs: days * 24 * 60 * 60_000 })
      const url = flag('url')
      console.log(`Invite #${id} (${maxUses} joins, valid ${days} days):\n${url ? formatInvite(url, code) : code}`)
      break
    }
    case 'invites':
      for (const i of store.listInvites()) {
        const state = i.revokedAt ? 'revoked' : i.expiresAt <= Date.now() ? 'expired' : i.uses >= i.maxUses ? 'used up' : 'active'
        console.log(`#${String(i.id).padEnd(4)} ${state.padEnd(8)} ${i.uses}/${i.maxUses} joins, expires ${new Date(i.expiresAt).toLocaleString()}`)
      }
      break
    case 'revoke-invite':
      console.log(store.revokeInvite(Number(handle)) ? `Revoked invite #${handle}.` : `No active invite #${handle}.`)
      break
    default:
      console.error(
        'Usage: admin.ts add <handle> [display name] | rotate <handle> | revoke <handle> | list | invite [--uses N] [--days D] [--url URL] | invites | revoke-invite <id>',
      )
      process.exitCode = 2
  }
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
} finally {
  store.close()
}
