# QUICD Product Specification

**Status:** Draft v0.1 · **Owner:** VoiceCert · **Last updated:** 2026-05-28

QUICD (**QUIC Distributed**) is a protocol and reference library for
**serverless, end-to-end-encrypted, one-to-many data delivery** over QUIC. This
document defines *what* QUICD is for and *what it must do*. The *how* — wire
format, algorithms, state machines — lives in [`PROTOCOL.md`](PROTOCOL.md).

---

## 1. Problem

Whenever many people need the same live or bulk data at the same time, the
default answer is a central server: an SFU for video calls, a CDN for downloads,
a relay for game state. That server is expensive (bandwidth scales with the
crowd), a bottleneck (it caps fan-out and adds a hop of latency), a single point
of failure, and a privacy hazard (it sees, and can be compelled to log,
everything that passes through).

The peers themselves already have the upstream bandwidth and a direct interest
in the data. QUICD's premise: let them serve each other, over QUIC, with the
content sealed so the peers doing the relaying cannot read it — and with a
fairness mechanism so the system doesn't collapse into freeloading.

## 2. Goals & non-goals

### Goals
1. **No central server.** Any peer can bootstrap, discover, and serve any other.
   Liveness must not depend on infrastructure the app operator runs.
2. **One-to-many and many-to-many.** Efficiently disseminate one source to a
   crowd *and* a crowd of sources to each other (a conference).
3. **Real-time first.** Optimized for persistent connections and low-latency
   live media; bulk download is the same machinery with a different access
   pattern.
4. **End-to-end encrypted by construction.** Relays forward ciphertext. The
   transport library never requires plaintext.
5. **Loss-tolerant.** Built on the assumption that UDP datagrams are dropped;
   lost pieces are recoverable without stalling the live stream.
6. **Fair / incentive-compatible.** Bandwidth allocation rewards contribution
   (tit-for-tat) while still admitting newcomers.
7. **Embeddable.** Ships as an npm package with a stable, typed API that runs in
   Node, Electron, and the browser without app-code changes.

### Non-goals (v1)
- **Not a full anonymity network.** v1 provides content confidentiality and
  decentralized relaying, not traffic-analysis resistance or sender/receiver
  unlinkability. (Roadmap, §9.)
- **Not a media codec or jitter buffer.** QUICD moves opaque chunks; encode,
  decode, FEC payload shaping, and playout timing belong to the application.
- **Not a consensus/ledger system.** Reputation is local and gossip-assisted,
  not globally agreed. There is no blockchain and no token.
- **Not a guaranteed-delivery bus.** Live data is best-effort with pull-repair;
  applications needing total ordering or exactly-once must layer it on top.

## 3. Target use cases

### A. Serverless group call (primary — the maskord case)
A 2–50 person voice/video room. Each participant is a **source**; everyone wants
every other source. Media is encrypted with a group key (e.g. MLS) before it
ever touches QUICD. Each peer uploads to ≤4 others and downloads from up to 50,
so each stream reaches everyone through a few relay hops with redundant paths.
Losses are concealed by pulling missing chunks from alternate holders. When a
participant joins or leaves, the swarm re-negotiates slots; no server is involved
at any point.

### B. Flash-crowd download distribution
A publisher releases a new app version / game patch / model checkpoint. Thousands
of clients want the identical bytes within the same window. The publisher is one
source; every client that has fetched a chunk immediately becomes a server for
it. Download throughput *rises* with demand instead of melting the origin. This
is BitTorrent's classic win, but over QUIC, with the same library and identity
system as the live path.

### C. Live broadcast / one-to-many streaming
A single source (a streamer, a sensor, a market feed) to a large audience that
only consumes. Same swarm, asymmetric: most peers are pure consumers who relay to
a handful of others to earn the bandwidth they're using.

## 4. Users & integrators

- **App developers** embedding real-time media or distribution without standing
  up an SFU/CDN (maskord is the first; the API and Claude skill target this
  audience broadly).
- **Peers / end users** — implicit; they run the app, contribute upload, and get
  faster, cheaper, more private delivery.

## 5. Functional requirements

The protocol MUST let a peer:

- **R1 — Join / leave a channel** by Channel ID at will, any number at once.
- **R2 — Send data** into a channel as one or more sources.
- **R3 — Receive** all (or a selected subset of) sources in a channel.
- **R4 — Discover peers** by asking any connected peer for others in a channel
  (Peer Exchange), with optional DHT and bootstrap-list discovery.
- **R5 — Request previous chunks** by `(source, sequence)` reliably, to recover
  data lost to UDP, from any peer that advertises holding them.
- **R6 — Advertise availability** (HAVE maps) over a sliding window.
- **R7 — Negotiate bandwidth**: grant/revoke its ≤4 upload slots and choose
  recipients based on their contribution.
- **R8 — Query reputation**: ask peers how much a given peer has delivered to
  them, and present/collect signed receipts as proof of its own contribution.
- **R9 — Drop a slot or a connection** unilaterally and have the swarm heal.
- **R10 — Operate without any server**, given at least one reachable peer.

## 6. Non-functional requirements

- **Caps:** upload fan-out default **4** peers/channel; download fan-in up to
  **50** peers/channel. Both configurable; 4/50 are the defaults.
- **Latency:** live path adds minimal buffering beyond network + relay hops;
  target added latency budget documented per hop in [Protocol §6](PROTOCOL.md#6-data-path-have-want-and-repair).
- **Loss recovery:** a chunk lost on the live path is recoverable via pull while
  it remains in the source's window (window size is configurable).
- **Security:** transport authenticated and encrypted (QUIC/TLS 1.3, raw-public-key
  peer auth); content sealed end-to-end by the application's cipher; chunks
  integrity-checked and source-authenticated. See [Protocol §8](PROTOCOL.md#8-security-model).
- **Portability:** identical channel API across Node, Electron, and browser via
  transport adapters.
- **Footprint:** a peer's obligations are bounded by its slot caps, not by swarm
  size — a 10,000-peer swarm still only asks any peer to feed 4.

## 7. Success metrics

- **Origin offload:** in flash-crowd download, ≥90% of bytes served peer-to-peer
  (origin serves ≤10%) at steady state.
- **Server elimination:** a group call of N≤50 runs to completion with zero media
  bytes through any operator-run server.
- **Loss concealment:** with X% datagram loss, ≥99% of chunks delivered within
  the repair window; measurable, bounded glitch rate.
- **Fairness:** a freeloading peer (uploads nothing) receives strictly worse
  service than a contributing peer under contention, and cannot starve
  contributors.
- **Integration cost:** a developer (or Claude using the skill) can stand up a
  working channel in < 50 lines of app code.

## 8. Constraints & assumptions

- **NAT is everywhere.** Most peers are behind NAT; the protocol must do hole
  punching and fall back to peer-relayed paths. (Protocol §7.)
- **Browsers can't open raw UDP.** The browser transport rides
  WebTransport/WebRTC; pure-relay topologies may be needed where direct
  peer↔peer is impossible.
- **Identity is a keypair, not an account.** A PeerID is the hash of an Ed25519
  public key; there is no registration authority.
- **No global clock / no global truth.** Reputation, membership, and availability
  are eventually-consistent and locally observed.

## 9. Roadmap

| Phase | Theme | Scope |
|---|---|---|
| **M0 — Spec** *(this)* | Design complete | Product spec, protocol design, public API surface, Claude skill. |
| **M1 — Node transport** | It moves bytes | Native QUIC adapter, control stream, DATAGRAM chunk path, HAVE/WANT repair, two-peer then small-swarm. |
| **M2 — Swarm** | It scales | PEX + bootstrap discovery, slot negotiation, optimistic unchoke, sliding-window dissemination across many peers. |
| **M3 — Fairness** | It's fair | Signed receipts, reputation query/gossip, contribution-weighted slot allocation, Sybil mitigations. |
| **M4 — Browser** | It runs everywhere | WebTransport + WebRTC adapter; NAT traversal (ICE-like) and peer-relay fallback. |
| **M5 — Resilience** | It's robust | Optional FEC, connection migration, congestion/rate control tuning, large-swarm hardening. |
| **M6 — Privacy** | It hides more | Metadata-privacy hardening: cover traffic, relay padding, optional mixing toward stronger anonymity. |

## 10. Open questions

- **Node QUIC backend:** `node:quic` (experimental) vs. a vetted userspace stack
  (e.g. an msquic/quiche binding). Decision affects M1.
- **Browser peer↔peer:** raw QUIC is impossible in browsers (no UDP sockets;
  WebTransport is client→server only with no NAT traversal). Resolved direction:
  the browser adapter carries QUICD over **WebRTC DataChannels** (streams +
  unreliable datagram emulation, PeerID bound to the DTLS fingerprint), and
  browsers attach as **leaves** to **bridge** full nodes for the QUIC mesh
  (PROTOCOL.md §3.4–3.5). Resolved for now: all-browser calls run the QUICD
  **slot overlay over WebRTC** (not a full mesh) with **no bridge required** —
  latency-weighted upstream selection, SVC layering, and active-speaker
  prioritization carry audio + active-speaker video past 20 peers (PROTOCOL.md
  §5.6). A bridge / forwarding peer stays an *optional* pressure valve for the
  heavy case (20+ simultaneous full-res video senders with no native participant),
  not a default dependency.
- **DHT vs. PEX-only** for global rendezvous in M2 — start PEX + bootstrap, add
  DHT only if discovery proves insufficient.
- **Group key management** is the app's responsibility, but should QUICD ship a
  recommended MLS (RFC 9420) cipher adapter to make the secure path the default?

These are tracked in [Protocol](PROTOCOL.md) where they touch the wire format.
