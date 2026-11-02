// A plain terminal client for the relay, for people without the mod and for
// testing. Reads CROSSTALK_URL and CROSSTALK_TOKEN from the environment.
//
//   node src/cli.ts me
//   node src/cli.ts who
//   node src/cli.ts send <handle> <text...>
//   node src/cli.ts inbox [--wait]
//   node src/cli.ts ack <id> [accepted|dismissed]

import type { InboxResponse, Me, Person } from '../../mod/hooks/protocol.ts'

const base = (process.env.CROSSTALK_URL ?? 'http://127.0.0.1:7878').replace(/\/+$/, '')
const token = process.env.CROSSTALK_TOKEN
if (!token) {
  console.error('Set CROSSTALK_TOKEN to your crosstalk token.')
  process.exit(2)
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json()) as T & { message?: string }
  if (!res.ok) throw new Error(`${res.status}: ${data.message ?? 'request failed'}`)
  return data
}

const [command, ...args] = process.argv.slice(2)

try {
  switch (command) {
    case 'me': {
      const me = await call<Me>('GET', '/v1/me')
      console.log(`@${me.handle} (${me.displayName})`)
      break
    }
    case 'who': {
      const { people } = await call<{ people: Person[] }>('GET', '/v1/people')
      for (const p of people) {
        console.log(`${p.online ? '●' : '○'} @${p.handle.padEnd(22)} ${p.displayName}${p.label ? `  [${p.label}]` : ''}`)
      }
      break
    }
    case 'send': {
      const [to, ...words] = args
      if (!to || words.length === 0) throw new Error('Usage: send <handle> <text...>')
      const { id } = await call<{ id: number }>('POST', '/v1/messages', { to, text: words.join(' ') })
      console.log(`Sent (#${id}).`)
      break
    }
    case 'inbox': {
      const wait = args.includes('--wait') ? 25 : 0
      const inbox = await call<InboxResponse>('GET', `/v1/inbox?after=0&wait=${wait}&label=cli`)
      if (inbox.messages.length === 0) console.log('No open messages.')
      for (const m of inbox.messages) {
        console.log(`#${m.id} from @${m.from} (${m.fromName}) at ${new Date(m.createdAt).toLocaleString()}\n${m.text}\n`)
      }
      break
    }
    case 'ack': {
      const [id, action = 'accepted'] = args
      const { acked } = await call<{ acked: number }>('POST', '/v1/inbox/ack', { ids: [Number(id)], action })
      console.log(acked ? `Marked #${id} ${action}.` : `#${id} was not open.`)
      break
    }
    default:
      console.error('Usage: cli.ts me | who | send <handle> <text...> | inbox [--wait] | ack <id> [accepted|dismissed]')
      process.exitCode = 2
  }
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
}
