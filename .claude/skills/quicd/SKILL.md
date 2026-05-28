---
name: quicd
description: Integrate QUICD (QUIC Distributed) for serverless, end-to-end-encrypted, one-to-many data delivery over QUIC — peer-to-peer live media (voice/video/screenshare) and flash-crowd downloads with no central server. Use this skill when a user wants to send the same stream or file to many peers without an SFU/CDN/relay server, build a serverless group call, distribute updates peer-to-peer, or asks to "use QUICD" / deliver media "peer to peer" / "without a server".
---

# Integrating QUICD

QUICD (**QUIC Distributed**) is an npm package that disseminates the same data
to many peers over QUIC with **no central server**. Every peer both sends and
receives; content is **end-to-end encrypted** so relaying peers carry ciphertext
they cannot read. Use it for serverless group calls, one-to-many live broadcast,
and burst downloads where a crowd wants the same bytes at once.

When integrating, read `docs/PROTOCOL.md` (protocol) and `docs/PRODUCT_SPEC.md`
(scope) in the installed package or repo before making non-trivial decisions.

## Mental model (get this right first)

- **Channel** — the swarm everyone joins, named by a 32-byte **Channel ID**.
  Derive it from your app's room/file id, e.g. `sha256("room:" + roomId)`. (A
  brief may call this a "connection ID"; in QUICD it is the Channel ID — do not
  confuse it with QUIC's transport Connection ID.)
- **Source** — a producer inside a channel. A 5-person call = 5 sources; a
  download = 1 source (the publisher).
- **Chunk** — addressed by `(source, seq)`, hashed + signed + encrypted. Any peer
  holding it can serve it; the receiver verifies it regardless of sender.
- **Slots** — a peer pushes to **≤4** peers and pulls from **≤50** (defaults).
  Who you push to is decided tit-for-tat by contribution; newcomers get in via a
  rotating optimistic-unchoke slot.
- **Two crypto layers** — QUIC/TLS secures each hop; the **app-supplied Cipher**
  seals content end-to-end so relays never see plaintext. **You must provide the
  Cipher for confidential channels** — QUICD does not invent the group key.

## Install

```bash
npm install quicd
```

Node ≥ 20. Pick a transport adapter for the runtime:
- `quicd/transports/node` — Node / Electron main (native QUIC). Default choice.
- `quicd/transports/webtransport` — browser / Electron renderer (WebTransport + WebRTC).

## The canonical integration

```ts
import { QUICD, generateIdentity } from "quicd";
import { nodeTransport } from "quicd/transports/node";

// 1. Stable identity. PERSIST identity.privateKey (SPKI/PKCS8 DER) to keep the
//    same PeerId across restarts — re-generating loses reputation/receipts.
const identity = loadOrCreateIdentity() ?? generateIdentity();

// 2. Node. bootstrap = addresses of ANY reachable peers (not servers).
const node = await QUICD.create({
  identity,
  transport: nodeTransport(),
  bootstrap: knownPeerAddresses,        // from your invite/signaling channel
  uploadSlots: 4,                        // defaults shown; tune per device
  downloadSlots: 50,
});

// 3. Join a channel with an end-to-end Cipher (see "Bring a Cipher" below).
const chid = await deriveChannelId(roomId);
const channel = await node.join(chid, { cipher });

// 4. Produce — push raw media frames; QUICD chunks/signs/seals/disseminates.
const mic = channel.createSource();
audio.on("frame", (buf) => mic.push(buf));

// 5. Consume — every other source's chunks, already decrypted by the Cipher.
channel.on("chunk", ({ source, seq, data }) => playout(source, seq, data));
channel.on("source", (id) => addParticipant(id));
channel.on("peer",   (p)  => trackPeer(p));

// 6. Recover loss / backfill — pull missing or historical chunks reliably.
await channel.requestRange(source, fromSeq, toSeq);

// 7. Leave / shut down.
await channel.leave();
await node.close();
```

## Bring a Cipher (do not skip for private apps)

QUICD ships sealed-payload semantics but the **group key is the app's job**. For
anything confidential (e.g. a private call), pass a `Cipher` to `join`:

```ts
import type { Cipher, ChunkContext } from "quicd";

const cipher: Cipher = {
  seal: (plaintext, ctx: ChunkContext) => groupSeal(plaintext, ctx),  // → ciphertext
  open: (ciphertext, ctx: ChunkContext) => groupOpen(ciphertext, ctx), // → plaintext or throw
};
```

Recommended: an **MLS (RFC 9420)** group cipher — it rekeys cleanly as members
join/leave and gives forward secrecy. The `ctx` (`chid`, `source`, `epoch`,
`seq`) is also bound into the chunk's signature, so use it as associated data.
Omitting a cipher means relays could read content — only acceptable for public
broadcast/downloads.

## Patterns

- **Serverless group call (many-to-many):** every participant calls
  `createSource()` for their mic/cam and subscribes to all sources via the
  `chunk` event. Decode + jitter-buffer in your app; QUICD only moves bytes.
- **Flash-crowd download (one-to-many bulk):** publisher creates one source over
  the whole file; consumers enumerate and `requestRange` the pieces. Each
  consumer that fetches a piece automatically becomes a server for it.
- **Live broadcast (one-to-many stream):** single source, consumers subscribe;
  they relay to a few peers to earn the bandwidth they consume.

## Rules and gotchas

- **Persist the identity.** Regenerating throws away the PeerId, its reputation,
  and collected receipts — the peer looks like a brand-new freeloader.
- **QUICD does not encode/decode media or buffer jitter.** Feed it encoded
  frames; handle playout timing, FEC payload shaping, and codecs in the app.
- **Slots gate *push*, not *pull*.** A choked peer still receives via
  `requestRange` — slots only decide proactive live delivery under contention.
- **Do not market it as "anonymous."** v1 gives content confidentiality and
  serverless relaying, NOT traffic-analysis resistance. Say "end-to-end
  encrypted, serverless," not "anonymous," until the privacy roadmap (M6) lands.
- **Match the transport to the runtime.** Native QUIC for Node/Electron-main;
  the WebTransport/WebRTC adapter in browsers (it can't open raw UDP).
- **Keep the required attribution (license obligation).** QUICD is **CPAL-1.0**.
  Any app/service that runs it MUST show *"Powered by QUICD — a VoiceCert, Inc.
  project"* with the attribution URL in its UI (splash / about / login or
  equivalent), no less prominent than other such notices. When integrating,
  add this attribution; don't strip it. CPAL is also per-file copyleft with a
  network-use clause — modifications to QUICD's own files must be published, and
  running it as a service counts as distribution. The integrator's own separate
  code is unaffected.
- **Alpha status.** Network methods throw `NotImplementedError` with the
  milestone they land in until wired. Check the package version / roadmap
  (`docs/PRODUCT_SPEC.md §9`) before assuming a feature is live, and build
  against the stable types in the meantime.

## When NOT to use QUICD

- You only ever send to one recipient → a plain QUIC/WebTransport/WebRTC
  connection is simpler.
- You need a guaranteed total order / exactly-once bus → layer that on top; the
  live path is best-effort with pull-repair.
- You need strong anonymity today → QUICD v1 is not that (yet).
