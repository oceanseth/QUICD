# QUICD Protocol Design

**Status:** Draft v0.1 · **Wire version:** `quicd/0` · **Last updated:** 2026-05-28

This document specifies the QUICD (**QUIC Distributed**) protocol: how peers
find each other, form a swarm around a channel, disseminate data, recover loss,
negotiate bandwidth fairly, and keep content end-to-end secure — all without a
central server. For *why* and *what for*, see [`PRODUCT_SPEC.md`](PRODUCT_SPEC.md).

QUICD draws directly on well-trodden prior art and cites it rather than
reinventing: BitTorrent's choke/tit-for-tat and PEX (BEP 3, BEP 11), the
Peer-to-Peer Streaming Peer Protocol **PPSPP** (RFC 7574) for live chunk
addressing and HAVE/REQUEST maps, libp2p **gossipsub** for mesh dissemination,
**ICE** (RFC 8445) for NAT traversal, and **QUIC** (RFC 9000) + **QUIC
DATAGRAM** (RFC 9221) for transport.

---

## 1. Terminology

| Term | Meaning |
|---|---|
| **Peer** | A QUICD node, identified by a **PeerID**. |
| **PeerID** | `multibase(base32, SHA-256(Ed25519 public key))` — 32-byte hash, self-certifying. No registrar. |
| **Channel** | The swarm everyone subscribes to, named by a **Channel ID (CHID)**. The unit of join/leave. |
| **Channel ID (CHID)** | 32-byte opaque identifier. Apps derive it however they like (e.g. `SHA-256("room:" + roomId)`). |
| **Source** | A producer of content within a channel, identified by `SourceID` (usually the producer's PeerID, optionally with a stream index for multi-stream peers). |
| **Chunk** | The atomic unit of data: `(CHID, SourceID, seq, epoch)` → signed, hashed, encrypted payload. |
| **Slot** | One unit of upload obligation. A peer offers ≤ `uploadSlots` (default **4**) per channel. |
| **Unchoke / Choke** | Granting / revoking a slot to a specific peer (BitTorrent terminology). |
| **Receipt** | A signed acknowledgment from a receiver attesting how many useful bytes it got from a sender. Proof of contribution. |
| **Window** | The sliding range of `seq` a source currently retains and advertises. Old chunks expire out of the window. |

> **A note on "connection ID."** The original brief called the subscribable
> swarm a *"connection ID."* QUIC already defines a transport-layer *Connection
> ID* (the SCID/DCID that routes packets to a QUIC connection), and overloading
> the term is a footgun. We call the swarm a **Channel (CHID)** throughout. When
> this doc says "Connection ID" it means QUIC's, never the swarm's.

---

## 2. Identity & trust roots

- A peer's long-term identity is an **Ed25519 keypair**. The **PeerID** is the
  base32 multibase encoding of `SHA-256(pubkey)` — self-certifying: anyone can
  verify a PeerID matches the key that signs its messages.
- The QUIC/TLS 1.3 handshake uses **raw public keys** (RFC 7250) bound to the
  PeerID, not a CA-issued certificate chain. Connecting to `peerid@addr` and
  completing the handshake proves you're talking to the holder of that key.
- **Hop identity ≠ content trust.** Authenticating the peer you're connected to
  says nothing about whether content is genuine — content carries its own
  source signature (§8). A relay is authenticated as a relay; it is not trusted
  with plaintext.

---

## 3. Transport layer

### 3.1 One QUIC connection per peer pair
Two peers share a **single QUIC connection**, regardless of how many channels
they have in common. Either side may have initiated it. Everything is
multiplexed over that connection:

- **Control** travels on a single long-lived **bidirectional stream** (reliable,
  ordered): handshake, subscribe, PEX, HAVE/WANT, slot negotiation, receipts.
- **Live chunks** travel as **QUIC DATAGRAMs** (RFC 9221) — unreliable,
  unordered, lowest latency. Loss here is expected and handled by repair.
- **Repair / bulk** chunks travel on **short-lived unidirectional streams**
  (reliable): the response to a WANT, or a bulk download range. A chunk too
  large for one datagram is always sent as a stream.

### 3.2 Why this split
DATAGRAMs give live media the "drop it, don't wait" semantics it wants; streams
give repair and bulk download the "must arrive" semantics they want — over the
*same* connection, sharing congestion control, with no head-of-line blocking
between unrelated chunks.

### 3.3 Transport adapters
The protocol is defined against an abstract transport offering: an authenticated
connection to a PeerID, reliable bidi/uni streams, and an unreliable datagram
channel. Concrete adapters:

- **Node/Electron-main:** native QUIC (RFC 9000) + DATAGRAM. Full peer↔peer.
- **Browser/Electron-renderer:** **WebTransport** to reach datagram-capable
  endpoints; **WebRTC DataChannel** for browser↔browser (where WebTransport
  can't dial a peer). The control protocol is identical; only framing of the
  datagram channel differs.

See [`src/transport.ts`](../src/transport.ts) for the adapter interface.

### 3.4 Browser participation (no raw QUIC in browsers)

A browser cannot speak QUICD-over-QUIC directly, and this is a hard limit of the
web platform, not a QUICD choice:

- Browsers expose **no raw UDP sockets**, so the only QUIC available is
  **WebTransport**, which is **client→server only** — a browser can never *be*
  the QUIC server, *accept* an inbound connection, or do **NAT traversal**
  (WebTransport has no ICE/STUN/TURN and assumes a publicly-reachable server).
- Therefore two browsers cannot establish a direct QUIC connection. Other
  "raw UDP in a browser" routes are all gated: WebExtensions have no UDP API
  (only a **native-messaging helper binary**, i.e. a native component); the
  **Direct Sockets API** exists but only inside **Isolated Web Apps**, not the
  open web. None is a drop-in for a website.

QUICD does **not** require QUIC in the browser, because the protocol is defined
against the abstract transport in §3.3 — *authenticated connection + reliable
streams + unreliable datagrams* — and **WebRTC provides all three**:

| QUICD transport need | WebRTC mapping |
|---|---|
| Authenticated connection to a PeerID | DTLS handshake; **PeerID bound to the DTLS certificate fingerprint** exchanged during signaling, then verified against the PeerID's Ed25519 key. |
| Reliable bidi/uni stream (control, repair, bulk) | `RTCDataChannel` with `ordered: true` (default reliability). |
| Unreliable datagram (live chunks) | `RTCDataChannel` with `ordered: false, maxRetransmits: 0`. |

So the browser adapter (`quicd/transports/webtransport`) wraps **WebRTC** for
peer↔peer paths, reusing an app's existing TURN/STUN/NAT-punching
infrastructure. Everything above the transport — channels, sources, chunks,
slots, tit-for-tat, receipts, and end-to-end sealing — runs **identically** over
QUIC or WebRTC. A browser is a first-class swarm member; it just carries QUICD
frames over DataChannels instead of QUIC streams/datagrams.

### 3.5 Leaf and bridge topology

Because browsers can't form a QUIC mesh among themselves, mixed swarms use two
roles:

- **Full node** — Node/Electron/mobile peer with native QUIC. Meshes with other
  full nodes over QUIC and can accept WebRTC leaf attachments.
- **Leaf** — a browser. Attaches over WebRTC to one or more peers and
  participates in the channel through them.
- **Bridge** — any full node that relays between a leaf and the QUIC mesh,
  forwarding **sealed ciphertext it cannot read** (this is the §9 relay
  fallback; the bridge earns receipts like any other relay, §7.2).

Consequences:

- A call is fully serverless as long as *some reachable peer* is a full node
  (e.g. one participant on desktop/mobile, or a volunteer relay).
- An **all-browser** swarm with **no** full node anywhere cannot form a QUIC
  mesh; those peers fall back to pure WebRTC among themselves (equivalent to a
  classic WebRTC mesh) or rely on at least one bridge.
- A **personal cloud bridge** (a user-provisioned QUIC↔WebTransport relay VM) is
  a valid leaf-attachment option and preserves E2E (it only sees sealed chunks),
  but reintroduces per-user infrastructure and a stable network identity, so it
  is a power-user escape hatch, not the default. Prefer shared/volunteer bridges.

---

## 4. Channels, sources, and chunk addressing

A channel is a set of sources; a source is a sequence of chunks.

```
Channel (CHID)
 ├── Source A (SourceID = peerA)         seq: 0,1,2,3,...  (live tail grows)
 ├── Source B (SourceID = peerB)         seq: 0,1,2,...
 └── Source P (SourceID = publisher)     seq: 0..N         (finite, for downloads)
```

A **chunk** is addressed by `(CHID, SourceID, epoch, seq)`:

- `seq` — monotonically increasing per source. For live media it's the running
  frame/packet index; for a download it's the piece index `0..N-1`.
- `epoch` — bumped when a source restarts/reconfigures (e.g. codec change, key
  rotation) so stale `seq` from a prior epoch are unambiguous.
- Each chunk also carries `hash = SHA-256(ciphertext)` for integrity and dedup,
  and a source **signature** (§8).

Because a chunk is addressed by content coordinates, **any peer holding it can
serve it** and the receiver can verify it regardless of who sent it. This is
what makes downloading from 50 peers safe: overlapping, verifiable coverage.

### 4.1 The sliding window (live) vs. full content (bulk)
- **Live:** a source retains the last `W` chunks (the window); older `seq` fall
  out and are no longer serveable. Repair must happen within the window.
- **Bulk:** the publisher (and seeders) retain all chunks; `requestRange` can
  pull any `seq` at any time. A download is just a channel whose source has a
  fixed, fully-retained sequence.

---

## 5. Swarm membership: discovery, join, and slots

### 5.1 Discovery (no tracker)
A peer finds others in a channel by, in order of preference:

1. **Bootstrap list** — application-supplied addresses of *any* reachable peers.
   These are peers, not servers; they hold no special authority.
2. **Peer Exchange (PEX)** — ask any connected peer `PEER_QUERY{CHID}`; it
   replies `PEER_LIST` with a sampled set of peer descriptors it knows for that
   channel. This is the primary, fully-decentralized mechanism (BEP 11 style).
3. **DHT (optional, M2+)** — a Kademlia DHT keyed by CHID for global rendezvous
   when no bootstrap/PEX path exists, à la BitTorrent mainline DHT.
4. **mDNS (optional)** — local-network discovery for LAN swarms.

A **peer descriptor** is: `{ peerId, addresses[], transports[], channels?[],
signature }` — signed by the peer so it can't be forged in transit.

### 5.2 Join handshake

```
X ──HELLO────────────▶ A   { peerId, wireVersion, transports, caps, receiptsSummary? }
X ◀──HELLO_ACK──────── A   { peerId, wireVersion, caps }
X ──SUBSCRIBE────────▶ A   { chid, sources: "all" | [SourceID...], asConsumer, asSource }
A ──HAVE─────────────▶ X   { chid, perSource: { sourceId: windowRanges } }
```

After `SUBSCRIBE`, X is a *member* of the channel on this connection and may
request data and PEX. Membership is per-connection state and is torn down on
`UNSUBSCRIBE`/`BYE`/disconnect.

### 5.3 Slot negotiation (the ≤4 / ≤50 asymmetry)
Wanting data and being *fed* data are separate. To receive a source's live push
(rather than only pulling repair), X asks A for one of A's upload **slots**:

```
X ──INTEREST─────────▶ A   { chid, sources:[...], wantRate? }
A ──GRANT────────────▶ X   { chid, sources:[...], rate, slotId }    # unchoke
   ─or─
A ──CHOKE────────────▶ X   { chid, reason, suggestedPeers:[...] }   # decline + PEX hint
```

- A grants at most `uploadSlots` (default **4**) GRANTs per channel. When full,
  A either CHOKEs with PEX hints, or **preempts** a lower-value slot (§5.5).
- X may hold up to `downloadSlots` (default **50**) GRANTs per channel across
  many peers — wide, redundant inflow.
- A consumer not holding a slot is not cut off: it can still **pull** any chunk
  via WANT (§6), it just doesn't get the proactive live push. Slots are about
  *push priority under contention*, exactly like BitTorrent unchoke.

### 5.4 Who gets a slot (tit-for-tat)
When choosing which interested peers to GRANT, A ranks by **value to A**:

1. **Reciprocity (primary):** peers that have recently *fed A well* on any
   channel rank highest — measured by A's own delivered-byte counters. This is
   classic tit-for-tat: the peers giving you the best download rate get your
   upload (BEP 3).
2. **Global contribution (secondary):** for peers A hasn't downloaded from, A
   weighs their **reputation** — signed receipts they present, and answers to
   A's `REP_QUERY` gossip (§7). A peer that has demonstrably fed others is a
   better bet than an unknown.
3. **Optimistic unchoke (always):** one slot is reserved on a rotating timer for
   a *random/newcomer* peer with no track record. This is the on-ramp: it lets a
   peer who has uploaded nothing yet earn its first receipts, preventing a
   cold-start deadlock where no one will ever feed a newcomer.

Ranking is re-evaluated periodically (default every few seconds); slots can be
revoked (`CHOKE`) and reassigned as conditions change.

### 5.5 Joining/leaving "at will"
- **Join more channels:** SUBSCRIBE again on the same connection with a new CHID.
- **Leave:** `UNSUBSCRIBE{chid}` (stop membership) or drop a single slot by
  CHOKE/INTEREST-withdraw. `BYE` closes everything gracefully; a hard disconnect
  is detected by QUIC idle timeout and the swarm heals by re-running PEX + slot
  negotiation against other peers.

### 5.6 Scaling live conferences (many sources, real-time deadlines)

A group call where everyone broadcasts is the demanding case: `S` simultaneous
sources, each chunk on a playout deadline (voice targets <~150 ms mouth-to-ear).
The rules below keep load distributed Tor/torrent-style instead of collapsing
into a full mesh.

**Overlay, not full mesh.** Peers always run the slot overlay (§5.3), never an
everyone-to-everyone mesh. A full mesh makes each peer upload its stream `N−1`
times and dies around 8–12 participants — not a transport limit but an *uplink*
limit. The overlay caps fan-out at `uploadSlots` and relays onward, so reaching
`N` peers takes ~`log₄(N)` hops (~2 for 20 peers, ~3 for 50) and no peer uploads
more than 4×. For tiny calls the overlay naturally collapses toward a near-full
mesh (≤4 slots ≈ everyone connected), so there is one code path that degrades
gracefully rather than a cliff at 12.

**Slots are a byte budget, not a peer count.** A GRANT to a downstream forwards
*every source that peer subscribes to*, so "≤4 peers" can mean forwarding `S`
sources' chunks to each. The binding constraint is aggregate uplink, not the
number 4. Implementations MUST account admission by forwarded bytes/sec, not by
slot count alone, and MAY grant fewer than `uploadSlots` when uplink is scarce.

**Latency-weighted selection for trusted calls.** §5.4 optimizes *reciprocity*
(incentive). A call among trusted members has no freeloaders to deter, so the
upstream-selection objective SHOULD shift toward **lowest RTT + most available
throughput per source** — pick the host that delivers a given source quickest,
not the one you owe. This is exposed as a policy knob: fairness-weighted (public
swarms) ↔ latency-weighted (trusted calls). Optimistic unchoke (§5.4.3) is
unnecessary when there is no reputation to bootstrap and MAY be disabled.

**Layered media (SVC / simulcast).** The primary lever for heterogeneous browser
uplinks: sources encode video in layers so a relay can forward only the base
layer (low-res / audio-only) to distant or weak peers and full quality one hop
out. QUICD carries layers as separate sources or as flagged chunks; a relay with
scarce uplink drops enhancement layers first. This lets a weak peer keep relaying
instead of dropping out, which is what keeps deep trees alive.

**Active-speaker prioritization.** Only the 1–2 current speakers need full-rate,
wide fan-out; the other idle cameras can be low-rate/low-priority. Sources signal
voice activity; consumers raise WANT priority and relays raise forward priority
for active speakers, cutting real load by roughly an order of magnitude — the
same trick every SFU uses, here done at the edge.

**Honest ceiling.** Audio + active-speaker video scales well past 20 peers
purely peer-to-peer. A swarm with 20+ *simultaneous full-resolution* video
senders and **no full node anywhere** is the case the overlay alone cannot save
— live deadlines don't tolerate the relay depth a constrained all-browser swarm
forces. There, an optional **bridge / forwarding peer** (a desktop participant or
volunteer node, §3.5) is the pressure valve; it absorbs fan-out the way an SFU
would, while still forwarding only sealed ciphertext.

---

## 6. Data path: HAVE, WANT, and repair

### 6.1 Push (live)
A source emits a chunk → it's signed, hashed, encrypted, and sent as a DATAGRAM
to each peer A is feeding for that channel (A's granted downstreams). Those peers
relay onward to *their* downstreams, forming a multi-hop mesh. Because each
consumer pulls from many uppers (up to 50), the same chunk reaches it via several
paths; duplicates are dropped by `hash`.

### 6.2 HAVE maps
Peers periodically (and on change) send compact **HAVE** updates: per source, the
set of `seq` ranges they currently hold (run-length / bin-encoded over the
window, PPSPP-style). HAVE is how a peer knows where to pull a missing chunk.

### 6.3 WANT / repair (pull)
When a peer detects a gap (an expected `seq` didn't arrive, or it just joined and
wants backfill):

```
X ──WANT─────────────▶ (any peer whose HAVE covers it)  { chid, source, ranges }
peer ──[uni-stream]──▶ X   reliable delivery of the requested chunks
```

- WANT is served over a reliable uni-stream, so repair never drops.
- X spreads WANTs across multiple holders to parallelize and avoid overloading
  one peer; a holder may decline (busy / choked) and X tries the next.
- This is exactly the mechanism behind R5 ("request previous packets lost due to
  UDP"): lost datagrams become WANTs against the window.

### 6.4 Bulk download
A download is WANT at scale: the consumer enumerates `0..N-1` from the
publisher's HAVE, then pulls ranges from the publisher *and* every peer that has
already fetched them, rarest-first (BEP 3) to keep the swarm healthy. No live
push is needed; the same slots/tit-for-tat govern who serves whom.

### 6.5 Loss recovery without round-trips (optional, M5)
Sources MAY add **FEC** (e.g. RaptorQ, RFC 6330) repair symbols to a window so
receivers reconstruct modest loss without a WANT round-trip. Repair-by-pull
remains the backstop. FEC is a source-side payload concern; QUICD just carries
the extra chunks.

---

## 7. Reputation & fairness

The brief's requirement: *peers should be more willing to send to you if you've
sent to others, and a peer should be able to query others about any peer's track
record to decide how much bandwidth to allocate.* QUICD implements this with
**locally-observed counters + cryptographic receipts + gossip queries** — no
global ledger.

### 7.1 What each peer tracks (local truth)
Per remote peer, per channel: `bytesDelivered` (useful, verified chunks it sent
me) and `bytesServed` (what I sent it). A peer's own observations are the most
trustworthy input to its decisions.

### 7.2 Receipts (portable proof of contribution)
When B receives `N` useful, verified bytes from A, B may issue:

```
RECEIPT = sign_B { issuer: B, subject: A, chid, bytes: N, window:[t0,t1], nonce }
```

- A collects receipts as **portable proof it has contributed** — it can present
  them to a stranger C to bootstrap trust ("here are 12 peers attesting I served
  them 40 MB this hour").
- Receipts are **signed by the receiver**, so A cannot forge them: A can only
  hold receipts from peers that actually chose to issue them. Self-claims with no
  receipts carry no weight.

### 7.3 Reputation query (gossip)
Before allocating a slot to an unknown X, A can ask the swarm:

```
A ──REP_QUERY────────▶ peers   { subject: X, chid? }
peer ──REP_REPLY─────▶ A       { subject: X, bytesDelivered, lastSeen, signed }
```

A weighs replies as **hearsay** — strictly below its own direct observation —
and combines them with any receipts X presented. The result informs *whether*
to GRANT and at what `rate`.

### 7.4 Sybil & lying resistance (and its limits)
- **Forgery:** impossible for receipts (receiver-signed) and descriptors
  (self-signed); tampering with relayed content is caught by the source
  signature + hash (§8).
- **Inflation by collusion:** a ring of Sybils can issue each other receipts.
  Mitigations: weight **direct observation ≫ reported reputation**; **decay**
  reputation over time so it must be continually re-earned; rate-limit how much
  unverified reputation can buy; optionally anchor identities (DHT presence,
  proof-of-work, or app-level identity) to make Sybils costly.
- **Honesty about limits:** this raises the cost of freeloading and makes
  contribution pay; it is *not* a Byzantine-proof accounting system, and it
  doesn't try to be. The optimistic-unchoke on-ramp (§5.4) is deliberately small
  precisely because it's the one slot an attacker gets "for free."

---

## 8. Security model

QUICD has **two independent encryption layers**, and conflating them is the
classic mistake — relayed content is *not* protected by hop encryption alone.

### 8.1 Hop security (transport)
Every QUIC connection is TLS 1.3 encrypted and the peer is authenticated by raw
public key = PeerID (§2). This protects against observers *between two directly
connected peers* and proves who you're talking to. It does **not** protect
content from the relaying peers themselves.

### 8.2 End-to-end content security (application-supplied)
Because a chunk may pass through peers who are not channel members (pure relays),
**content is sealed by the source before chunking** with a key only channel
members hold. Relays forward opaque ciphertext — this is the "Tor-like" property:
the peers carrying your packets cannot read them.

- QUICD treats payloads as **opaque ciphertext** and never needs the plaintext.
- The application provides a **`Cipher`** (see [`src/types.ts`](../src/types.ts)):
  `seal(plaintext, ctx) → ciphertext` / `open(ciphertext, ctx) → plaintext`.
- **Recommended default:** **MLS** (Messaging Layer Security, RFC 9420) for group
  key agreement — it gives forward secrecy and efficient rekeying as members
  join/leave, which is exactly the membership churn a call has. QUICD ships an
  MLS cipher adapter so the secure path is the easy path (open question §10 in
  the product spec, leaning yes).

### 8.3 Provenance & integrity
Each chunk is **signed by its source** over `(CHID, SourceID, epoch, seq, hash)`.
Any receiver — member or relay — can verify the chunk came from the claimed
source and wasn't altered, *without* decrypting it. This stops relays from
injecting or tampering, and lets receivers dedup/verify across the 50 senders.

### 8.4 What v1 does NOT provide (stated plainly)
- **No traffic-analysis resistance.** Sizes/timing/patterns of relayed chunks
  leak; a global observer can correlate. v1 is not Tor.
- **No sender/receiver unlinkability.** A relay learns it relayed *for* a peer,
  even if not *what*. Channel membership is visible to peers in the channel.
- **Roadmap (M6):** cover traffic, fixed-size padded chunks, optional mixing
  hops, and decoy WANTs to push toward real metadata privacy. Until then, do not
  market QUICD deployments as "anonymous."

---

## 9. NAT traversal

Peer↔peer over UDP must cross NATs:

- **Candidate gathering (ICE-like, RFC 8445):** each peer collects host,
  server-reflexive, and relayed address candidates. Other **peers act as STUN
  reflectors** (tell me my public address) — no dedicated STUN server required.
- **Hole punching:** simultaneous QUIC open against gathered candidates; QUIC
  **connection migration** lets the path settle on whichever candidate works.
- **Relay fallback (TURN-like):** when direct fails (e.g. symmetric NAT, two
  browsers), a willing peer **relays at the QUICD layer** — forwarding sealed
  chunks it cannot read. This consumes the relay's slots and earns it receipts,
  so the incentive system pays for relaying, just like any other contribution.

---

## 10. Wire format

### 10.1 Framing
- **Control messages** are length-prefixed **CBOR** objects on the control
  bidi-stream: `varint length` ‖ `CBOR map`. CBOR is compact, self-describing,
  and ubiquitous; a tighter binary TLV is a possible later optimization.
- **Chunk frames** (DATAGRAM or uni-stream) use a fixed binary header followed by
  the opaque ciphertext payload:

```
 0        1        2                                              header
+--------+--------+-----------------------------------------------+
| type   | flags  | CHID(32) | SourceID(var) | epoch(varint)      |
+--------+--------+----------+---------------+--------------------+
| seq(varint) | hash(32) | siglen | signature | payload (ciphertext...)
+-------------+----------+--------+-----------+-----------------------+
```

(`type` distinguishes a live CHUNK from a repair CHUNK; `flags` carries
end-of-source, is-FEC, etc. Exact byte layout is pinned per wire version.)

### 10.2 Control message types

| Code | Message | Dir | Purpose | Req |
|---|---|---|---|---|
| `0x01` | `HELLO` / `HELLO_ACK` | ↔ | Handshake, capabilities, PeerID proof | — |
| `0x02` | `SUBSCRIBE` | → | Join a channel, declare sources of interest | R1 |
| `0x03` | `UNSUBSCRIBE` | → | Leave a channel | R1, R9 |
| `0x10` | `PEER_QUERY` | → | Ask for peers in a channel (PEX) | R4 |
| `0x11` | `PEER_LIST` | ← | Sampled peer descriptors | R4 |
| `0x20` | `HAVE` | → | Advertise held `seq` ranges per source | R6 |
| `0x21` | `WANT` | → | Request specific chunks (repair / backfill) | R5 |
| `0x30` | `INTEREST` | → | Request a push slot for sources | R7 |
| `0x31` | `GRANT` | ← | Unchoke: slot granted at a rate | R7 |
| `0x32` | `CHOKE` | ← | Decline/revoke slot, with PEX hints | R7, R9 |
| `0x40` | `RECEIPT` | → | Signed proof of bytes received | R8 |
| `0x41` | `REP_QUERY` | → | Ask about a peer's contribution | R8 |
| `0x42` | `REP_REPLY` | ← | Reputation answer (signed hearsay) | R8 |
| `0x50` | `BYE` | → | Graceful disconnect | R9 |

(Data chunks themselves are not control messages; they ride DATAGRAM/uni-stream
with the binary header above.)

### 10.3 Versioning
`HELLO` carries `wireVersion` (`quicd/0`). Mismatched major versions refuse the
connection; minor capability differences are negotiated via `caps`.

---

## 11. Connection & slot state machine (per peer pair, per channel)

```
            SUBSCRIBE                 INTEREST + GRANT
  DISCOVERED ─────────▶ MEMBER ──────────────────────▶ FED (unchoked)
      ▲                  │  ▲                              │
      │ PEX/bootstrap    │  │ CHOKE / INTEREST-withdraw    │
      │                  │  └──────────────────────────────┘
      │       UNSUBSCRIBE│
      └──────────────────┴── BYE / idle-timeout ──▶ CLOSED
```

- **DISCOVERED:** known via PEX/DHT/bootstrap, maybe not yet connected.
- **MEMBER:** connected + subscribed; can PEX, HAVE/WANT (pull), but no push slot.
- **FED:** holds a GRANT; receives proactive live push. Revocable at any time.
- Repair (WANT) is available in MEMBER and FED alike — slots only gate *push*.

---

## 12. Worked example: a 5-person serverless call

1. Alice creates `CHID = SHA-256("room:standup")`, generates an MLS group, and
   joins QUICD with that CHID. She has Bob's address from the app's invite.
2. Bob joins, HELLO+SUBSCRIBE to Alice, learns of Carol/Dave/Eve via `PEER_QUERY`
   (Alice already knows them) → connects to each.
3. Everyone is both **source** (their cam/mic) and **consumer** (the other four).
   Each peer holds up to 50 download slots — trivially covers 4 sources × a few
   relay paths — and grants ≤4 upload slots, ranked by reciprocity.
4. Alice's mic chunks are MLS-sealed, signed, DATAGRAM-pushed to her ≤4 granted
   downstreams, who relay onward. With 5 peers everyone is usually one hop away,
   but the same code handles 50 where multi-hop relaying matters.
5. A datagram drop → the receiver's expected `seq` is missing → it WANTs it from
   another peer's HAVE → reliable uni-stream backfill. The glitch is concealed.
6. Frank tries to join but has never uploaded. He gets in via someone's
   **optimistic unchoke**, starts relaying, collects RECEIPTs, and earns regular
   slots. A pure freeloader who only ever consumes keeps getting CHOKEd in favor
   of contributors once contention rises.
7. No byte of media ever traversed a server VoiceCert or anyone else runs.

---

## 13. References

- QUIC — RFC 9000; QUIC DATAGRAM — RFC 9221; TLS raw public keys — RFC 7250.
- PPSPP (P2P streaming, chunk maps) — RFC 7574.
- BitTorrent core / PEX — BEP 3, BEP 11.
- ICE (NAT traversal) — RFC 8445.
- MLS (group key agreement) — RFC 9420.
- RaptorQ FEC — RFC 6330.
- libp2p gossipsub — mesh pub/sub dissemination.
