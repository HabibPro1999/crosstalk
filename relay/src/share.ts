// One command to run a relay from this machine and invite people to it:
// starts the relay, opens a Cloudflare quick tunnel (a temporary public https
// address, no account needed), waits until that address really answers, and
// prints an invite to paste to colleagues.
//
//   npm run share                          relay + tunnel, invite for 20 joins over 7 days
//   npm run share -- --uses 5 --days 1     a tighter invite
//   npm run share -- --local               no tunnel: this machine only (for trying it alone)
//   npm run share -- --port 7900
//
// Same environment variables as main.ts (CROSSTALK_DB, CROSSTALK_AUDIT, ...).
// Ctrl+C stops the tunnel and the relay together.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { formatInvite } from '../../mod/hooks/protocol.ts'
import { createRelay } from './server.ts'
import { openStore } from './store.ts'

const MARKETPLACE = 'HabibPro1999/crosstalk'

function flag(name: string): string | undefined {
  const args = process.argv.slice(2)
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}

const isLocal = process.argv.includes('--local')
const port = Number(flag('port') ?? process.env.CROSSTALK_PORT ?? 7878)
const maxUses = Number(flag('uses') ?? 20)
const days = Number(flag('days') ?? 7)
if (!Number.isInteger(maxUses) || maxUses < 1 || !(days > 0) || !Number.isInteger(port)) {
  console.error('--uses and --port must be whole numbers, --days positive.')
  process.exit(2)
}

const env = process.env
const dbPath = resolve(env.CROSSTALK_DB ?? 'data/crosstalk.db')
const auditPath = env.CROSSTALK_AUDIT === 'off' ? null : resolve(env.CROSSTALK_AUDIT ?? 'data/audit.jsonl')
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
if (auditPath) mkdirSync(dirname(auditPath), { recursive: true, mode: 0o700 })

const store = openStore(dbPath)
const relay = createRelay({
  store,
  auditPath,
  auditContent: env.CROSSTALK_AUDIT_CONTENT === '1',
  log: line => console.error(`[relay] ${line}`),
})

let tunnel: ChildProcess | undefined
let isStopping = false

async function stop(code = 0): Promise<never> {
  isStopping = true
  tunnel?.kill('SIGTERM')
  await relay.close()
  store.close()
  process.exit(code)
}
process.once('SIGINT', () => void stop(0))
process.once('SIGTERM', () => void stop(0))

function fail(message: string): Promise<never> {
  console.error(`\n✘ ${message}`)
  return stop(1)
}

try {
  await relay.listen(port, '127.0.0.1')
} catch (error) {
  const code = (error as { code?: string }).code
  await fail(
    code === 'EADDRINUSE'
      ? `Port ${port} is in use: is a relay already running? Stop it, or pass --port <another>.`
      : `The relay could not start: ${(error as Error).message}`,
  )
}

/** Starts cloudflared and resolves the https address it prints. */
function openTunnel(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    tunnel = child
    const timer = setTimeout(() => reject(new Error('cloudflared printed no address within 60 seconds.')), 60_000)
    const onData = (chunk: Buffer) => {
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString())
      if (match) {
        clearTimeout(timer)
        resolvePromise(match[0])
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', error => {
      clearTimeout(timer)
      reject(
        (error as { code?: string }).code === 'ENOENT'
          ? new Error('cloudflared is not installed. Install it (macOS: brew install cloudflared), or run with --local.')
          : error,
      )
    })
    child.once('exit', code => {
      clearTimeout(timer)
      if (!isStopping) {
        console.error(`\n✘ The tunnel stopped (cloudflared exited with ${code}). Run share again for a new address.`)
        void stop(1)
      }
    })
  })
}

/** Waits until the public address answers with the relay's own health check. */
async function waitUntilReachable(url: string): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8000) })
      const body = (await res.json()) as { ok?: boolean }
      if (body.ok) return
    } catch {
      // Not routed yet (Cloudflare answers an error page for a few seconds).
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error('The tunnel address did not start answering within 90 seconds.')
}

let publicUrl = `http://127.0.0.1:${port}`
if (!isLocal) {
  process.stderr.write('Opening a Cloudflare tunnel… ')
  try {
    publicUrl = await openTunnel()
    process.stderr.write(`${publicUrl}\nWaiting for it to answer… `)
    await waitUntilReachable(publicUrl)
    process.stderr.write('ok\n')
  } catch (error) {
    await fail((error as Error).message)
  }
}

const { id, code } = store.createInvite({ maxUses, ttlMs: days * 24 * 60 * 60_000 })
const invite = formatInvite(publicUrl, code)
const members = store.listUsers().filter(u => u.revokedAt === null).length

console.log(`
crosstalk relay is live at ${publicUrl}${isLocal ? ' (this machine only)' : ''}

Invite #${id}, good for ${maxUses} joins over ${days} day${days === 1 ? '' : 's'}. Send it privately:

  ${invite}

Each colleague runs, in Claude Code:

  /plugin install crosstalk --marketplace ${MARKETPLACE}
  /crosstalk join ${invite} <their-handle> <Their Name>
${
  members > 0
    ? `
${members} people already joined. ${isLocal ? '' : 'The address changes every time share starts, so they run:\n\n  /crosstalk url ' + publicUrl + '\n'}`
    : ''
}
Keep this running (and this computer awake: caffeinate -i). Ctrl+C stops it.
`)
