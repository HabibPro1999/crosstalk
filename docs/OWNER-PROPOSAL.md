# Proposal template: crosstalk for your Claude Code organization

Adapt this page and send it to your Claude organization Owner before rolling crosstalk out.

**Ask:** approval to pilot crosstalk, a self-hosted way for teammates' Claude Code sessions to exchange messages, with a person approving each message.

**Why:** Claude Code's built-in cross-session messaging only reaches a person's *own* sessions. Handoffs between teammates' agents ("tell Bob's Claude the API contract changed") go through copy-paste in chat today.

**What it is:**
- A small relay we host. It has no third-party runtime dependencies, uses one SQLite file, and sits behind our TLS proxy.
- A Claude Code mod each pilot user installs.
- Messages are text only, at most 8,000 characters, and deleted after 7 days at most.

**Why it needs your sign-off.** A mod that brings outside messages into a session does a job similar to Claude Code *channels* (which an Owner enables with `channelsEnabled`). If our org has channels or Remote Control turned off, the Owner should decide on this too, rather than have it routed around.

**Safeguards** (details in `SECURITY.md`):
- **Incoming:** nothing a colleague sends reaches Claude until the recipient presses *Show to Claude*. It then arrives framed as untrusted input. This matters most where managed settings let Claude run shell or filesystem tools without prompts.
- **Outgoing:** Claude's messages wait for the sender's approval by default. Likely secrets are redacted automatically.
- **Identity and access:** per-person tokens, stored hashed, revocable.
- **Limits:** relay-side rate limits, dedupe and queue caps.
- **Audit:** a metadata-only audit log.

**Pilot plan:**
1. 3–5 people for 2 weeks, with the relay on an internal host.
2. Review the audit log and feedback at the end.
3. Then decide whether to deploy the mod through managed settings for everyone, or to stop.

**Options for the Owner:**
1. **Approve the mod pilot as is.** Lowest effort.
2. **Prefer channels.** Enable `channelsEnabled` and allowlist an internal crosstalk channel plugin (`allowedChannelPlugins`). The relay stays the same; a channel client would be added. This is more "official", but it is a research preview and needs `--channels` at every launch.
3. **Decline.** Keep using chat and tickets for handoffs.
