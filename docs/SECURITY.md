# crosstalk security model

crosstalk connects two things that can each act on a computer: Claude Code sessions belonging to different people. The design assumes a colleague's message is **untrusted input** to your agent, even when the colleague is trusted. Their session, or text they pasted, may itself be carrying an injection.

## Threats and controls

| Threat | Control | Where |
|---|---|---|
| **Prompt injection.** A message tells your Claude to run commands, push code or leak files. | Nothing reaches the model until the person presses **Show to Claude**. The message then arrives framed as another person's words, with explicit instructions not to act without asking. It is never submitted as the user's own words (`asUser` is never used). | `mod/hooks/register.tsx` `accept`, `mod/hooks/protocol.ts` `envelope` |
| **Frame forgery.** The message contains a fake end marker followed by "the user says…". | Every `<<<` and `>>>` in the body is replaced before framing, so the real end marker appears exactly once. A test covers this. | `envelope`, test "cannot forge the end of its frame" |
| **Permission laundering.** A colleague gets your agent to do what their own permissions block. | Same human gate as above. The pane shows the text before the model sees it. Tool permissions are never relayed. | design |
| **Agent ping-pong or worm.** Two agents auto-reply to each other forever, or a message spreads itself. | A person approves incoming messages. By default a person also approves outgoing messages Claude writes. The relay enforces per-sender rate limits (12/min, 300/day), refuses identical repeats for 10 minutes, caps unread messages per recipient (100) and per sender-recipient pair (20), and limits size (8,000 chars). | `relay/src/server.ts` |
| **Data leakage.** Claude puts secrets or code into a message. | Drafts need approval by default, and the person sees the exact text. Likely secrets are redacted before queueing and before `/dm` sends. The tool description tells Claude not to share credentials or code that wasn't asked for. | `protocol.ts` `redactSecrets` |
| **Impersonation.** Someone claims to be a colleague. | Identity comes only from the bearer token, which the relay stores only as a SHA-256 hash. The sender's handle is stamped by the relay, never taken from the client. Tokens can be rotated and revoked. | `relay/src/store.ts` |
| **Token theft in transit.** | The mod refuses any relay URL that isn't `https`, except localhost. The relay binds loopback by default and should sit behind a TLS proxy. | `mod/hooks/util.ts` `readConfig` |
| **Token theft at rest.** | The mod declares the token `sensitive`, so Claude Code keeps it in secure storage. The relay database holds hashes only. Database and audit files are created with mode 0700/0600. | `plugin.json`, `relay/src/main.ts` |
| **Relay as a data store.** | Unread messages are deleted after 7 days and read ones after 24 hours. The audit log records metadata and a body hash only, unless `CROSSTALK_AUDIT_CONTENT=1`. | `DEFAULT_LIMITS` |
| **Control characters and invisible text.** Bidi overrides or zero-width characters hide instructions. | `cleanText` strips C0 controls, zero-width characters and bidi overrides on both client and relay. | `protocol.ts` |

## What crosstalk does not protect against

- **A person who reads a malicious message and tells Claude to do it anyway.** The gate is a human decision, not a sandbox.
- **Redaction gaps.** Redaction is pattern-based. Novel secret formats get through, which is why approving drafts is the default.
- **A compromised relay host.** The host sees message bodies. Run the relay inside your network, behind your identity-aware proxy.
- **A colleague's session that is already compromised.** Its messages are still only text, gated as above.

## Org controls this tool interacts with

- **Mods.** The mod is a user mod unless your org deploys it via managed settings. `allowManagedModsOnly` would disable it, and that is the Owner's call (see `OWNER-PROPOSAL.md`).
- **Channels.** crosstalk does not use Claude Code channels. A mod that delivers outside messages is functionally similar to a channel, which is exactly why this needs the Owner's agreement and is not something to deploy quietly.
- **Network policy.** `$.http.fetch` goes through Claude Code's host. An org web-fetch policy that blocks the relay's domain blocks crosstalk.
