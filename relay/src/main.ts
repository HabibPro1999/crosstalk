// Starts the crosstalk relay from environment variables.
//
//   CROSSTALK_HOST           interface to bind (default 127.0.0.1; put TLS in front)
//   CROSSTALK_PORT           port (default 7878)
//   CROSSTALK_DB             SQLite file (default ./data/crosstalk.db)
//   CROSSTALK_AUDIT          JSONL audit file (default ./data/audit.jsonl; "off" disables)
//   CROSSTALK_AUDIT_CONTENT  "1" also records message bodies in the audit file

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { createRelay } from './server.ts'
import { openStore } from './store.ts'

const env = process.env
const host = env.CROSSTALK_HOST ?? '127.0.0.1'
const port = Number(env.CROSSTALK_PORT ?? 7878)
const dbPath = resolve(env.CROSSTALK_DB ?? 'data/crosstalk.db')
const auditPath = env.CROSSTALK_AUDIT === 'off' ? null : resolve(env.CROSSTALK_AUDIT ?? 'data/audit.jsonl')

mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
if (auditPath) mkdirSync(dirname(auditPath), { recursive: true, mode: 0o700 })

const store = openStore(dbPath)
const relay = createRelay({
  store,
  auditPath,
  auditContent: env.CROSSTALK_AUDIT_CONTENT === '1',
  log: line => console.error(`[crosstalk] ${line}`),
})

const bound = await relay.listen(port, host)
console.error(`[crosstalk] relay listening on http://${bound.host}:${bound.port} (db ${dbPath})`)
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  console.error('[crosstalk] bound beyond loopback: serve it only behind TLS (a reverse proxy).')
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void relay.close().then(() => {
      store.close()
      process.exit(0)
    })
  })
}
