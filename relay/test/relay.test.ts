import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { InboxResponse, Person } from '../../mod/hooks/protocol.ts'
import { createRelay, type Relay } from '../src/server.ts'
import { openStore, type Store } from '../src/store.ts'

type Client = ReturnType<typeof clientFor>

let base = ''
let relay: Relay
let store: Store
let dir: string
let clock = 1_700_000_000_000
const tokens: Record<string, string> = {}

function clientFor(token: string) {
  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as any }
  }
  return {
    call,
    send: (to: string, text: string, extra: Record<string, unknown> = {}) =>
      call('POST', '/v1/messages', { to, text, ...extra }),
    inbox: (after = 0, wait = 0) =>
      call('GET', `/v1/inbox?after=${after}&wait=${wait}&label=test`) as Promise<{
        status: number
        body: InboxResponse
      }>,
    ack: (ids: number[], action = 'accepted') => call('POST', '/v1/inbox/ack', { ids, action }),
  }
}

let alice: Client
let bob: Client
let carol: Client

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crosstalk-test-'))
})

after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(async () => {
  if (relay) {
    await relay.close()
    store.close()
  }
  store = openStore(':memory:')
  tokens.alice = store.addUser('alice', 'Alice A')
  tokens.bob = store.addUser('bob', 'Bob B')
  tokens.carol = store.addUser('carol', 'Carol C')
  relay = createRelay({
    store,
    auditPath: join(dir, 'audit.jsonl'),
    now: () => clock,
    limits: { perMinute: 5, pendingPerPair: 4 },
  })
  const { port } = await relay.listen(0)
  base = `http://127.0.0.1:${port}`
  alice = clientFor(tokens.alice)
  bob = clientFor(tokens.bob)
  carol = clientFor(tokens.carol)
})

after(async () => {
  await relay.close()
  store.close()
})

describe('auth', () => {
  test('rejects a missing or wrong token', async () => {
    const res = await fetch(`${base}/v1/me`)
    assert.equal(res.status, 401)
    const wrong = await clientFor('ct_' + 'x'.repeat(43)).call('GET', '/v1/me')
    assert.equal(wrong.status, 401)
  })

  test('identifies the caller by token', async () => {
    const { status, body } = await alice.call('GET', '/v1/me')
    assert.equal(status, 200)
    assert.deepEqual(body, { handle: 'alice', displayName: 'Alice A' })
  })

  test('a revoked token stops working and a rotated one replaces it', async () => {
    store.revokeUser('bob')
    assert.equal((await bob.call('GET', '/v1/me')).status, 401)
    const fresh = store.rotateToken('bob')
    assert.equal((await clientFor(fresh).call('GET', '/v1/me')).status, 200)
    assert.equal((await bob.call('GET', '/v1/me')).status, 401)
  })

  test('tokens are stored only as hashes', () => {
    const rows = store.db.prepare('SELECT token_hash FROM users').all() as { token_hash: string }[]
    for (const row of rows) assert.match(row.token_hash, /^[0-9a-f]{64}$/)
    assert.ok(!rows.some(row => Object.values(tokens).includes(row.token_hash)))
  })
})

describe('messages', () => {
  test('delivers a message to the recipient only', async () => {
    const sent = await alice.send('@Bob', '  hello bob\r\n')
    assert.equal(sent.status, 201)
    const inbox = await bob.inbox()
    assert.equal(inbox.body.messages.length, 1)
    assert.deepEqual(
      { from: inbox.body.messages[0]!.from, fromName: inbox.body.messages[0]!.fromName, text: inbox.body.messages[0]!.text },
      { from: 'alice', fromName: 'Alice A', text: 'hello bob' },
    )
    assert.deepEqual(inbox.body.openIds, [sent.body.id])
    assert.equal((await carol.inbox()).body.messages.length, 0)
  })

  test('refuses unknown, self, empty and oversized messages', async () => {
    assert.equal((await alice.send('nobody', 'hi')).body.error, 'unknown_recipient')
    assert.equal((await alice.send('alice', 'hi')).body.error, 'self_message')
    assert.equal((await alice.send('bob', '  \u0000 ')).body.error, 'bad_request')
    assert.equal((await alice.send('bob', 'x'.repeat(8001))).status, 413)
    assert.equal((await alice.send('../etc', 'hi')).status, 400)
  })

  test('refuses an identical message within the dedupe window, allows it after', async () => {
    assert.equal((await alice.send('bob', 'same')).status, 201)
    assert.equal((await alice.send('bob', 'same')).body.error, 'duplicate')
    clock += 11 * 60_000
    assert.equal((await alice.send('bob', 'same')).status, 201)
  })

  test('rate-limits a sender per minute', async () => {
    for (let i = 0; i < 4; i++) assert.equal((await alice.send(i % 2 ? 'bob' : 'carol', `m${i}`)).status, 201)
    assert.equal((await alice.send('carol', 'm4')).status, 201)
    const limited = await alice.send('carol', 'm5')
    assert.equal(limited.status, 429)
    assert.equal(limited.body.error, 'rate_limited')
    clock += 61_000
    assert.equal((await alice.send('carol', 'm6')).status, 201)
  })

  test('caps unread messages from one sender to one recipient', async () => {
    for (let i = 0; i < 4; i++) assert.equal((await alice.send('bob', `p${i}`)).status, 201)
    clock += 61_000
    assert.equal((await alice.send('bob', 'p4')).body.error, 'recipient_full')
    assert.equal((await carol.send('bob', 'from carol')).status, 201)
  })

  test('acknowledging closes a message for every session of the recipient', async () => {
    const { body } = await alice.send('bob', 'ack me')
    assert.equal((await bob.ack([body.id], 'dismissed')).body.acked, 1)
    const inbox = await bob.inbox()
    assert.deepEqual(inbox.body.openIds, [])
    assert.equal(inbox.body.messages.length, 0)
    // Only the recipient can acknowledge.
    const other = await alice.send('bob', 'second')
    assert.equal((await carol.ack([other.body.id])).body.acked, 0)
  })

  test('validates ack bodies', async () => {
    assert.equal((await bob.ack([], 'accepted')).status, 400)
    assert.equal((await bob.ack([1], 'deleted')).status, 400)
  })

  test('audits metadata without bodies by default', async () => {
    await alice.send('bob', 'secret-ish words')
    const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n')
    const last = JSON.parse(lines.at(-1)!)
    assert.equal(last.event, 'message')
    assert.equal(last.from, 'alice')
    assert.equal(last.text, undefined)
    assert.match(last.sha256, /^[0-9a-f]{64}$/)
  })
})

describe('long-poll inbox', () => {
  test('a waiting poll returns as soon as a message arrives', async () => {
    const started = Date.now()
    const waiting = bob.inbox(0, 10)
    await new Promise(resolve => setTimeout(resolve, 100))
    await alice.send('bob', 'wake up')
    const { body } = await waiting
    assert.equal(body.messages[0]?.text, 'wake up')
    assert.ok(Date.now() - started < 3000, 'the poll should not wait for its timeout')
  })

  test('a waiting poll returns when another session acknowledges', async () => {
    const { body: sent } = await alice.send('bob', 'seen elsewhere')
    const first = await bob.inbox(0, 0)
    const waiting = bob.inbox(first.body.cursor, 10)
    await new Promise(resolve => setTimeout(resolve, 100))
    await bob.ack([sent.id])
    const { body } = await waiting
    assert.deepEqual(body.openIds, [])
    assert.equal(body.cursor, first.body.cursor)
  })

  test('the cursor skips messages already seen', async () => {
    await alice.send('bob', 'one')
    const first = await bob.inbox()
    await alice.send('bob', 'two')
    const second = await bob.inbox(first.body.cursor)
    assert.deepEqual(second.body.messages.map(m => m.text), ['two'])
    assert.equal(second.body.openIds.length, 2)
  })
})

describe('presence', () => {
  test('a poll marks a person online with their session label, then they age out', async () => {
    await bob.inbox()
    let people = (await alice.call('GET', '/v1/people')).body.people as Person[]
    const bobRow = people.find(p => p.handle === 'bob')!
    assert.equal(bobRow.online, true)
    assert.equal(bobRow.label, 'test')
    assert.equal(people.find(p => p.handle === 'carol')!.online, false)
    clock += 80_000
    people = (await alice.call('GET', '/v1/people')).body.people as Person[]
    assert.equal(people.find(p => p.handle === 'bob')!.online, false)
    assert.equal(people.find(p => p.handle === 'bob')!.label, null)
  })
})

describe('retention', () => {
  test('purges acknowledged and stale messages', async () => {
    const a = await alice.send('bob', 'old acked')
    await alice.send('bob', 'old open')
    await bob.ack([a.body.id])
    const removed = store.purge({ ackedBefore: clock + 1, staleBefore: clock + 1 })
    assert.equal(removed, 2)
  })
})

describe('join with an invite', () => {
  async function join(body: Record<string, unknown>, client = '203.0.113.7') {
    const res = await fetch(`${base}/v1/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': client },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as any }
  }

  test('a valid invite adds the person and returns a working token', async () => {
    const { code } = store.createInvite({ maxUses: 2, ttlMs: 60_000 }, clock)
    const joined = await join({ invite: code, handle: '@Dana', displayName: 'Dana D' })
    assert.equal(joined.status, 201)
    assert.equal(joined.body.handle, 'dana')
    assert.match(joined.body.token, /^ct_/)
    const me = await clientFor(joined.body.token).call('GET', '/v1/me')
    assert.deepEqual(me.body, { handle: 'dana', displayName: 'Dana D' })
    assert.equal((await alice.send('dana', 'welcome')).status, 201)
  })

  test('refuses a taken handle without spending a use', async () => {
    const { code } = store.createInvite({ maxUses: 1, ttlMs: 60_000 }, clock)
    const taken = await join({ invite: code, handle: 'bob' })
    assert.equal(taken.status, 409)
    assert.equal(taken.body.error, 'handle_taken')
    assert.equal((await join({ invite: code, handle: 'erin' })).status, 201)
  })

  test('an invite stops working when used up, expired or revoked', async () => {
    const once = store.createInvite({ maxUses: 1, ttlMs: 60_000 }, clock)
    assert.equal((await join({ invite: once.code, handle: 'frank' })).status, 201)
    assert.equal((await join({ invite: once.code, handle: 'gina' })).body.error, 'invite_invalid')

    const short = store.createInvite({ maxUses: 5, ttlMs: 1000 }, clock)
    clock += 2000
    assert.equal((await join({ invite: short.code, handle: 'hank' })).body.error, 'invite_invalid')

    const revoked = store.createInvite({ maxUses: 5, ttlMs: 60_000 }, clock)
    store.revokeInvite(revoked.id, clock)
    assert.equal((await join({ invite: revoked.code, handle: 'ivy' })).body.error, 'invite_invalid')
  })

  test('refuses a made-up invite and a bad handle', async () => {
    assert.equal((await join({ invite: 'inv_' + 'x'.repeat(43), handle: 'jo-e' })).body.error, 'invite_invalid')
    assert.equal((await join({ invite: 'nope', handle: 'joe' })).status, 400)
    const { code } = store.createInvite({ maxUses: 5, ttlMs: 60_000 }, clock)
    assert.equal((await join({ invite: code, handle: 'x' })).status, 400)
    assert.equal((await join({ invite: code, handle: '../root' })).status, 400)
  })

  test('rate-limits join attempts per client address', async () => {
    for (let i = 0; i < 10; i++) {
      await join({ invite: 'inv_' + 'y'.repeat(43), handle: `guess${i}` }, '198.51.100.9')
    }
    const limited = await join({ invite: 'inv_' + 'y'.repeat(43), handle: 'guess10' }, '198.51.100.9')
    assert.equal(limited.status, 429)
    // Another address is unaffected.
    const { code } = store.createInvite({ maxUses: 1, ttlMs: 60_000 }, clock)
    assert.equal((await join({ invite: code, handle: 'kim' }, '198.51.100.10')).status, 201)
  })
})

describe('invites in the protocol', async () => {
  const { parseInvite, formatInvite } = await import('../../mod/hooks/protocol.ts')
  test('formats and parses relay URL plus code as one string', () => {
    const code = 'inv_' + 'A'.repeat(43)
    const text = formatInvite('https://relay.example.com/', code)
    assert.equal(text, `https://relay.example.com#${code}`)
    assert.deepEqual(parseInvite(`  ${text}  `), { relayUrl: 'https://relay.example.com', code })
    assert.equal(parseInvite('https://relay.example.com#inv_short'), null)
    assert.equal(parseInvite(code), null)
    assert.equal(parseInvite(`ftp://x#${code}`), null)
  })
})
