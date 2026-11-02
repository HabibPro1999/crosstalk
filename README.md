# crosstalk

Lets people in one organization message each other's **Claude Code sessions**. A small relay that you host carries the messages. A Claude Code mod shows them in an inbox panel, and **a person approves every message in both directions**.

Claude Code's built-in `SendMessage` only reaches sessions on your own account. crosstalk adds the missing piece between colleagues, without giving anyone else's text a direct line into your agent.

```
 Alice's Claude Code                 crosstalk relay                 Bob's Claude Code
┌────────────────────┐  POST msg   ┌──────────────────┐ long-poll ┌────────────────────┐
│ mod: send tool /dm │ ──────────▶ │ per-person token │ ────────▶ │ mod: inbox pane    │
│ draft → [Send]     │             │ rate limits      │           │ [Show to Claude]   │
│                    │ ◀────────── │ queue + audit    │ ◀──────── │ [Dismiss]          │
└────────────────────┘  long-poll  └──────────────────┘ POST msg  └────────────────────┘
```

## What's here

| Folder | What it is |
|---|---|
| `relay/` | The relay server: Node 24+ TypeScript with **no runtime dependencies** (`node:http`, `node:sqlite`). Includes an admin CLI for tokens and a terminal client. |
| `mod/` | The Claude Code mod: the `/dm` and `/crosstalk` commands, the `send` and `who` tools for Claude, an inbox pane, a band above the prompt, and a status line. |
| `docs/SECURITY.md` | Threat model and the controls that address each threat. |
| `docs/OWNER-PROPOSAL.md` | A one-page proposal template for your Claude organization Owner. **Read before rolling this out.** |

## How it works

**Incoming.** The mod long-polls the relay. A colleague's message appears in the **crosstalk pane** with a toast and a `✉` status entry. Nothing reaches Claude until you press **Show to Claude**. It then arrives as a new turn, framed as *another person's untrusted words*:
- Claude is told not to act on requests in it without asking you.
- The message can't forge the end of its frame.

**Dismiss** acknowledges the message and Claude never sees it. Your other open sessions drop it too.

**Trusted colleagues (opt-in).** In `/config` → crosstalk → **Deliver straight to Claude from**, list handles (`medyas, sara`), or `*` for anyone. Their messages skip the inbox and go to Claude at once as a plain prompt, exactly their text, as if you typed it. Claude then acts on them with your permissions, so list only people you'd let type into your terminal. When Claude finishes answering such a message, **the answer goes back to the sender automatically** as a reply. It appears in their transcript under `reply from …`, line by line.

Replies are always shown, never run as prompts, so two Claudes can't answer each other in a loop. A trusted sender's reply is also added to Claude's context, without starting a turn, so you can ask follow-ups. A sender who passes 6 messages a minute falls back to approval.

**Outgoing from Claude.** Claude has a `send` tool. By default what it writes becomes a **draft** in the pane, and you press **Send** or **Discard**. Claude is told the outcome. Likely secrets are redacted before the draft is even queued: AWS, GitHub, Anthropic, OpenAI, Slack and Google keys, private keys, JWTs, and `password=` assignments.

**Outgoing from you.** `/dm <handle> <message>` sends what you typed at once, still with secret redaction.

**Presence.** `/crosstalk who`, or Claude's `who` tool, lists colleagues and whether their Claude Code is online right now.

## Quick start

**On the machine that runs the relay** (Node 24+, and `cloudflared` for a public address: `brew install cloudflared`):

```bash
npm run share
```

This command:
1. Starts the relay.
2. Opens a temporary public `https://….trycloudflare.com` address.
3. Waits until that address answers.
4. Prints an invite such as `https://….trycloudflare.com#inv_…`, good for 20 joins over 7 days.

Keep it running. `npm run share -- --uses 5 --days 1` tightens the invite, and `--local` skips the tunnel.

**Each person, in Claude Code** (2.1.287+, mods enabled):

```
/plugin install crosstalk --marketplace HabibPro1999/crosstalk
/crosstalk join <invite> <your-handle> <Your Name>
```

`join` creates the account and saves the relay address and your token in the mod's storage on your computer. Nothing to paste into `/config`. If you'd rather keep the token in Claude Code's secure storage, paste it into `/config` → crosstalk; a token set there takes precedence.

Then:
- `/crosstalk who` lists colleagues.
- `/dm bob are you free to review #42?` sends a message.
- `/crosstalk` opens the inbox.
- `/crosstalk help` lists the rest.
- Or ask Claude: "message bob that the migration is done". Claude drafts it and you approve it.

**When the relay restarts,** a quick tunnel gets a new address. `share` prints the one line people who already joined need:

```
/crosstalk url https://<new-address>.trycloudflare.com
```

A named Cloudflare tunnel, or a real host, keeps one fixed address.

Without Claude Code, `relay/src/cli.ts` is a terminal client:

```bash
export CROSSTALK_URL=https://… CROSSTALK_TOKEN=ct_...
node relay/src/cli.ts who | send bob hi | inbox --wait | ack 3 dismissed
```

## Deploying the relay for your org

1. Run `node relay/src/main.ts` on a small VM or container. It binds `127.0.0.1:7878` by default.
2. Put it behind a TLS reverse proxy (Caddy, nginx, or a cloud load balancer). **The mod refuses plain `http` for anything but localhost.** Set `CROSSTALK_HOST=0.0.0.0` only when the proxy runs on another host.
3. Let people join with an invite: `node src/admin.ts invite --uses 20 --days 7 --url https://crosstalk.example.com`. List invites with `invites` and cancel one with `revoke-invite <id>`. Alternatively, issue a token directly with `add <handle> "<Name>"`. Use `rotate` and `revoke` when people lose a token or leave.
4. Back up `data/crosstalk.db`. `data/audit.jsonl` records metadata only (who, to whom, when, size, sha256). Set `CROSSTALK_AUDIT_CONTENT=1` only if your policy requires bodies.

| Variable | Default | Meaning |
|---|---|---|
| `CROSSTALK_HOST` | `127.0.0.1` | Interface to bind |
| `CROSSTALK_PORT` | `7878` | Port |
| `CROSSTALK_DB` | `data/crosstalk.db` | SQLite file |
| `CROSSTALK_AUDIT` | `data/audit.jsonl` | Audit log path, or `off` |
| `CROSSTALK_AUDIT_CONTENT` | unset | `1` also records message bodies |

The relay's built-in limits (`relay/src/server.ts`, `DEFAULT_LIMITS`):
- Each sender: 12 messages a minute and 300 a day.
- Identical repeat messages are refused for 10 minutes.
- Each inbox holds at most 100 unread messages, and at most 20 from any one sender.
- A message is at most 8,000 characters.
- Unread messages expire after 7 days; read ones are deleted after 24 hours.

## Installing the mod

At the prompt of a Claude Code terminal session:

```
/plugin install crosstalk --marketplace HabibPro1999/crosstalk
```

From a shell:

```bash
claude plugin install crosstalk --marketplace HabibPro1999/crosstalk
```

Then set the relay URL and your token in `/config` under **crosstalk**.

- **For an organization:** publish `mod/` to your organization's plugin library, or an internal marketplace, once your Owner agrees (see `docs/OWNER-PROPOSAL.md`).
- **For development:** use `claude --plugin-dir mod`.

## Development

```bash
npm --prefix relay install       # dev-only: @types/node for type-checking
npm --prefix relay test          # 23 relay tests (node:test)
npm --prefix relay run typecheck
claude plugin validate mod       # what the engine will load and refuse
claude plugin test mod           # 17 mod tests in Claude Code's own test kit
tsc -p mod                       # needs mod/.claude-plugin/types (the engine writes it when it loads the mod)
```

`mod/hooks/protocol.ts` is the wire protocol. The relay and the mod both import it, so their types can't drift apart.

## Known limits (v0.1)

- **Delivery is per person, not per session.** Each of your open sessions shows the message, and the first one where you act on it wins. The others drop it.
- **No SSO yet.** Identity is a per-person bearer token, issued through invites. Anyone holding a live invite can join under an unused handle, so send invites privately and keep them short-lived. Putting the relay behind your identity-aware proxy is the natural next step.
- **Text only.** No attachments and no threads beyond `replyTo` ids.
- **Built on the mods API, which is early access** and changes between Claude Code releases.
