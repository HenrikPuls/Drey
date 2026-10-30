# 0084 — Tickets remote access

- Status: accepted (2026-10-30, req-66; owner decisions D1–D5)
- Amends: the "No server" principle (`specs/roadmap.md`, Core
  Architectural Principles) with one opt-in, documented exception
- Relates: [ADR-0075](0075-agent-fleet-architecture-governance-and-run-control.md) (the fleet runner, which
  stays on loopback), [ADR-0076](0076-ticket-repository-format-and-coordination.md)
  (the format every remote action writes), [ADR-0060](0060-save-conflicts-and-local-note-history.md)
  (the revision guard refine reuses)

## Context

The owner wants to work the tickets board from an iPhone or iPad on
the couch: move tickets, start and steer runs, answer a waiting
worker, take over claims, refine plans. Drey runs on the desk; the
phone is a remote control, not a second Drey (running Drey on the
device stays excluded, `specs/decisions.md` req-10).

Every board action already exists as a validated IPC command in the
tickets plugin's main side (`transition`, `claim`, `fleetStart`,
`fleetAnswer`, …), and the board pushes `board-changed` /
`fleet-changed`. The fleet runner is a separate process with a
loopback HTTP endpoint and a bearer token; it owns worker processes
but no board logic. The owner plans to split the tickets plugin later
(standalone, or a VS Code integration).

## Decision

- **The gateway lives in the tickets plugin's main side**
  (`plugins/tickets/main/remote/`), not in the fleet runner. The runner
  has no board logic, idles itself out, and starts processes — the
  worst place to accept network requests. Its token never leaves the
  machine; the gateway reaches it only through the plugin's
  `FleetClient`.
- **The gateway talks to a host-neutral port**, `TicketsRemotePort`
  (`plugins/tickets/shared/remote-protocol.ts`). In Drey an adapter
  implements it over `BoardService` + `FleetClient`. A later standalone
  or VS Code host implements the same interface; gateway and client
  move unchanged.
- **One validation for both transports**: the IPC payload checks move
  into `plugins/tickets/main/commands.ts` (one parser per command);
  IPC handlers and HTTP routes both call them.
- **Network**: off by default. Two modes —
  *loopback* (`127.0.0.1`, the default; HTTPS and reach come from
  Tailscale Serve, outside Drey) and *LAN* (bound to one interface the
  owner picks, never `0.0.0.0` implicitly; plain HTTP, with a warning
  in Settings).
- **Access**: QR pairing with a single-use code (128 bit, 5 minutes)
  exchanged for a per-device token (256 bit); only SHA-256 hashes are
  stored. Device list with revoke and an optional read-only flag.
  `Host` is checked against an allowlist and `Origin` on every write
  (DNS rebinding); pairing and failed auth are rate-limited.
- **What never goes remote**: `permissionMode: bypass` runs (unless a
  separate switch allows them), settings, prompts, column config,
  folder numbering, repository initialization.
- **Audit**: a remote action writes the Log actor `owner@<device>`
  (`owner@ipad`), so the ticket shows where a move came from.
- **Live updates** over Server-Sent Events, not WebSocket — one-way is
  all the board needs, it passes through Tailscale Serve unchanged and
  the browser reconnects on its own.
- **Client**: plain DOM, esbuild-bundled like the plugin renderers,
  served by the gateway as a home-screen web app. No Angular, no
  App Store app.

## Consequences

- Drey must be running for the remote to work. If that becomes the
  limit, the port makes the move to a standalone host small.
- A listening port is a new attack surface; the defaults (off,
  loopback, pairing, Host check) keep it to devices the owner paired.
- LAN mode sends tokens and ticket text unencrypted over the Wi-Fi;
  it is opt-in for that reason.
- Web Push (notifications on the phone) needs HTTPS and Apple's push
  service — a further cloud exception, left to its own decision (R7).
- Refining a ticket that is open and dirty in a Drey tab must not
  write past the tab; until the SDK reaches the open-docs bridge
  (milestone 78), the remote refuses that case.
