# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Use GitHub's private
reporting instead: **Security → Report a vulnerability** on this repository
(`https://github.com/DaBiGu/dsh-remote-workspaces/security/advisories/new`), or
reach the maintainer through the contact details on their GitHub profile.

Useful details to include: what you expected, what happened, the exact version
(`package.json`), the platforms on both ends, and — if you have one — a minimal
reproduction. A proof of concept in the repo's own self-test style is ideal.

Expect an acknowledgement within a few days. Please give a fix a reasonable
window before publishing details.

## What this project protects

- **Content, tunnel targets and DSH launch tokens are end-to-end encrypted.** The
  relay in the middle forwards fixed-size ciphertext frames carrying only
  `{from, to, circuitId}`; it has no key material and no way to decrypt.
- **Handshake authentication.** Every link is authenticated with the shared
  cluster key plus four ECDH exchanges (ephemeral×ephemeral for forward secrecy,
  static×static for identity, ephemeral×static for key-compromise impersonation
  resistance). A wrong cluster key, a tampered HELLO and a replayed nonce are all
  rejected, with tests covering each.
- **The local browser surface is loopback-only.** The panel talks to a
  self-registered route that checks the source socket, `Host`, `Origin` and a
  per-process random boot token injected into the shell HTML. Requests from other
  origins or non-loopback sockets get 403.
- **No arbitrary dialing.** A peer can only ask this machine to reach the in-band
  API target or a loopback `host:port`; anything else is refused (SSRF guard).

## What it does not protect

- **A compromised machine.** Anyone who can read
  `$DSH_HOME\dsh-remote-workspaces\config.json` has that node's identity key and
  the cluster key, and can impersonate any machine in the mesh. Treat that file
  like an SSH private key.
- **A leaked pairing code.** The code carries the cluster key, so anyone who has
  it can join your mesh. Never paste one into an issue, a screenshot or a chat.
- **The receiving side's own authorization.** Once a peer is paired and trusted,
  it can read your workspaces, conversations and GUI. Pairing is the trust
  boundary — there is no finer-grained per-peer permission model yet.
- **Metadata.** The relay (and anyone watching that server's traffic) can see
  node ids, circuit ids, frame sizes and timing.
- **The DSH instance itself.** This plugin extends the Harness; it does not add
  authorization on top of it. Whoever can reach your `dsh web` can do whatever
  that instance allows.

## Hardening checklist for deployments

- Keep the relay behind TLS and make nginx send the **whole certificate chain** —
  Node refuses a leaf-only chain (`node tools/deploy-relay.mjs chain --domain …`
  tells you which one you have).
- Keep the relay bound to `127.0.0.1`; only nginx should be reachable publicly.
- Give each machine its own node identity and rotate the cluster key by re-pairing
  if you ever suspect it leaked.
- Restrict who can reach the relay's `location` if you do not need it from the
  whole internet.
