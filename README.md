# QUICD — QUIC Distributed

**Serverless, end-to-end-encrypted, one-to-many data delivery over QUIC.**

QUICD (**QUIC D**istributed) lets a group of peers share the same stream of data
with **no central server in the middle**. Every participant both sends and
receives, pulling from many peers at once and relaying to a few — the way a
torrent spreads a file, but tuned for **persistent, real-time connections**.

Its primary goal is **fast delivery of live media**: voice, video, screen
shares, telemetry — anything where everyone in a group wants everyone else's
stream, right now, and a relay server would be a cost, a bottleneck, and a
privacy hole. Because peers relay **ciphertext they may not be able to read**,
the people carrying your packets are not the people who can see them.

The same machinery doubles as a **burst download fabric**: when a crowd all
wants the *same* bytes at the *same* moment — a new app version, a game patch,
a model checkpoint, a popular VOD — QUICD turns that thundering herd into an
advantage. The more peers that want it, the more sources there are to serve it.

> **TL;DR** — Think *"BitTorrent swarm + Tor-style blind relaying, running over
> QUIC, with live-streaming latency and no tracker."* You join a channel by ID,
> you start sending and receiving, and the swarm sorts out who feeds whom.

---

## Why QUICD exists

Group real-time media today almost always flows through a central SFU/MCU
(Zoom, Meet, Discord): every participant uploads to a server, the server fans
the streams back out. That server sees everything, costs money per minute, and
is a single point of failure and surveillance.

QUICD removes it. Participants form a **mesh swarm** over QUIC and disseminate
each other's streams directly, peer to peer:

- **No server to run, scale, or trust.** Any peer can bootstrap any other.
- **End-to-end encrypted by construction.** Content is sealed by the sender for
  the group; relays forward opaque ciphertext.
- **Built for loss.** Live data rides QUIC DATAGRAMs (fast, lossy); missing
  pieces are pulled back reliably over QUIC streams. UDP drops don't mean gaps.
- **Fair by design.** Bandwidth is negotiated tit-for-tat: peers prefer to feed
  peers who have fed others, so freeloading degrades gracefully and contributors
  get served first.

This repository is the protocol **and** the reference implementation, shipped as
an npm package you can drop into any Node, Electron, or browser app.

---

## How it works (in one minute)

- A **Channel** is the unit everyone subscribes to — a 32-byte **Channel ID**.
  (This is what an early brief called a *"connection ID";* see the
  [glossary](docs/PROTOCOL.md#1-terminology) for why we renamed it.)
- Inside a channel there are **Sources**. In a 5-person call there are 5 sources
  (one per camera/mic); for a software update there is 1 source (the publisher).
- Each source's data is split into hashed, signed, encrypted **Chunks**
  addressed by `(source, sequence)`. Anyone holding a chunk can serve it.
- You **download from up to 50 peers** at once but **upload to at most 4** — a
  deliberate asymmetry that keeps any one peer's obligations small while giving
  every consumer wide, redundant coverage.
- Peers continuously swap **HAVE** maps (what they hold) and pull missing pieces
  with **WANT** requests, so packets lost to UDP are simply re-fetched from
  whoever else has them.
- Who gets one of your 4 upload slots is decided by **contribution**: signed
  receipts prove a peer has uploaded to others, and you can **query the swarm**
  about any peer's track record before allocating bandwidth. Newcomers still get
  in via **optimistic unchoking** (a rotating free slot) so they can earn a
  reputation from zero.

The long version, including the wire format and state machines, is in
[`docs/PROTOCOL.md`](docs/PROTOCOL.md).

---

## Install

Not yet published to npm — install from git (the `prepare` hook builds it on
install):

```bash
npm install github:oceanseth/QUICD
```

Then add the Claude skill to your project so your agent knows how to use it:

```bash
npx quicd-install-skill        # writes ./.claude/skills/quicd/SKILL.md
```

Requires Node.js ≥ 20. The native QUIC transport targets Node / Electron-main;
browser code uses the WebTransport/WebRTC adapter (see [Transports](#transports)).

> **Status: alpha / design-complete — does not move bytes yet.** The protocol,
> public API, and types are stable enough to build against, and the Claude skill
> will produce correct integration code. But transport wiring (milestone **M1**)
> is not implemented: calls like `QUICD.create`/`channel.push` currently throw
> `NotImplementedError` tagged with the milestone they land in. Integrate and
> typecheck now; runtime delivery arrives with M1. See the
> [roadmap](docs/PRODUCT_SPEC.md#9-roadmap).

---

## Quick start

```ts
import { QUICD, generateIdentity } from "quicd";
import { nodeTransport } from "quicd/transports/node";

// 1. Create a node with a stable cryptographic identity (your PeerID).
const node = await QUICD.create({
  identity: generateIdentity(),       // persist this to keep the same PeerID
  transport: nodeTransport(),         // native QUIC (Node/Electron main)
  bootstrap: ["quicd://boot.example:4400/<peerid>"], // any reachable peer
});

// 2. Join a channel. The cipher seals content end-to-end; relays never see it.
const channel = await node.join(CHANNEL_ID, { cipher: myGroupCipher });

// 3. Produce: push live media as a source. It's chunked, signed, encrypted,
//    and disseminated to your downstream peers automatically.
const mic = channel.createSource();
audioFrames.on("frame", (buf) => mic.push(buf));

// 4. Consume: receive every other source in the channel.
channel.on("chunk", ({ source, seq, data }) => playout(source, seq, data));
channel.on("source", (id) => console.log("new participant:", id));

// 5. Backfill anything lost to packet loss, reliably, from whoever has it.
await channel.requestRange(someSource, fromSeq, toSeq);

// ...and leave whenever you like.
await channel.leave();
await node.close();
```

A burst-download publisher looks almost identical — one source, consumers call
`requestRange` over the whole content instead of subscribing to a live tail. See
[`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md#3-target-use-cases) for both
patterns end to end.

---

## Transports

QUICD separates *what to send* (the protocol) from *how bytes move* (the
transport adapter), so it runs anywhere QUIC — or a QUIC-like datagram channel —
is available:

| Environment | Adapter | Underlying transport |
|---|---|---|
| Node.js / Electron main | `quicd/transports/node` | Native QUIC (RFC 9000) + DATAGRAM (RFC 9221) |
| Browser / Electron renderer | `quicd/transports/webtransport` | WebTransport, with WebRTC DataChannel fallback for peer↔peer |

Both expose the same channel API; your application code does not change between
desktop and web. See [Protocol §3 Transport](docs/PROTOCOL.md#3-transport-layer).

---

## Using it with Claude

QUICD ships a **Claude skill** so you can integrate it by just asking. Point any
Claude Code project at this package and say *"use QUICD to deliver this media
peer-to-peer"* — the skill in [`skill/`](skill/SKILL.md) teaches Claude the API,
the channel/source/chunk model, the security boundary, and the common
integration patterns. Install instructions are in the skill's header.

---

## Documentation

- **[Product Spec](docs/PRODUCT_SPEC.md)** — problem, goals, use cases, requirements, roadmap.
- **[Protocol Design](docs/PROTOCOL.md)** — terminology, wire format, swarm membership, tit-for-tat, repair, security.
- **[Claude Skill](skill/SKILL.md)** — how to integrate QUICD with Claude's help.

## Security & honesty

QUICD gives you **end-to-end content confidentiality** (relays carry data they
can't read) and **decentralized, server-free dissemination**. It is *not* — in
v1 — a full anonymity network: it does not yet defeat global traffic analysis,
and a relay still learns *that* it relayed *something* for you. Metadata-privacy
hardening (cover traffic, padding, mixing) is on the roadmap and called out
explicitly in [Protocol §8 Security](docs/PROTOCOL.md#8-security-model). Don't
ship it as "anonymous" until that work lands.

## License

**CPAL-1.0** (Common Public Attribution License 1.0) © 2026 VoiceCert, Inc.
See [LICENSE](LICENSE).

You're free to use, modify, and distribute QUICD — including commercially — but
two obligations apply:

1. **Attribution must stay visible.** Any app or service that runs QUICD must
   display *"Powered by QUICD — a VoiceCert, Inc. project"* and the attribution
   URL in its user interface (splash/about/login or equivalent), per CPAL §14
   and Exhibit B. This requirement extends to larger works that embed QUICD.
2. **Source stays open.** CPAL is a per-file copyleft with a network-use clause:
   modifications to QUICD's own files must be made available in source form, and
   **deploying QUICD as a network service counts as distribution** (CPAL §15) —
   there's no private-SaaS-fork exemption. Your own separate code that merely
   uses QUICD is not affected.
