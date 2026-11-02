// Manages who may use the relay. Run on the relay host:
//
//   node src/admin.ts add <handle> [display name]   prints the new token once
//   node src/admin.ts rotate <handle>                prints a replacement token
//   node src/admin.ts revoke <handle>
//   node src/admin.ts list
//
// CROSSTALK_DB names the SQLite file (default ./data/crosstalk.db).

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { openStore } from './store.ts'

const dbPath = resolve(process.env.CROSSTALK_DB ?? 'data/crosstalk.db')
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
const store = openStore(dbPath)

const [command, handle, ...rest] = process.argv.slice(2)

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
    default:
      console.error('Usage: admin.ts add <handle> [display name] | rotate <handle> | revoke <handle> | list')
      process.exitCode = 2
  }
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
} finally {
  store.close()
}
