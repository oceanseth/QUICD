/**
 * QUICD — shared types for the public API surface.
 *
 * This file defines the contract that application code and transport adapters
 * build against. See docs/PROTOCOL.md for the protocol these types model.
 */
import type { Transport } from "./transport.js";

/** Base32 multibase PeerID = multibase(SHA-256(Ed25519 public key)). */
export type PeerId = string;

/** 32-byte channel identifier, hex/base32 encoded. The swarm everyone joins. */
export type ChannelId = string;

/** Identifier of a producer within a channel (usually a PeerId, optionally `${peerId}/${index}`). */
export type SourceId = string;

/** A long-term cryptographic identity. Persist `privateKey` to keep a stable PeerId. */
export interface Identity {
  readonly peerId: PeerId;
  /** Ed25519 public key bytes. */
  readonly publicKey: Uint8Array;
  /** Ed25519 private key bytes. Keep secret; persist to retain identity. */
  readonly privateKey: Uint8Array;
}

/**
 * End-to-end content cipher, supplied by the application. QUICD never sees
 * plaintext: sources `seal` before chunking, consumers `open` after receipt.
 * Relays forward sealed bytes and never call either method.
 *
 * The recommended implementation is an MLS (RFC 9420) group cipher; see
 * docs/PROTOCOL.md §8.2.
 */
export interface Cipher {
  /** Encrypt+authenticate plaintext for the channel group. */
  seal(plaintext: Uint8Array, ctx: ChunkContext): Promise<Uint8Array> | Uint8Array;
  /** Decrypt+verify ciphertext, or throw if it cannot be opened. */
  open(ciphertext: Uint8Array, ctx: ChunkContext): Promise<Uint8Array> | Uint8Array;
}

/** Addressing context bound into chunk signatures and passed to the Cipher. */
export interface ChunkContext {
  readonly chid: ChannelId;
  readonly source: SourceId;
  readonly epoch: number;
  readonly seq: number;
}

/** A signed, self-describing way to reach a peer (PEX / bootstrap unit). */
export interface PeerDescriptor {
  readonly peerId: PeerId;
  /** Reachable addresses, e.g. "quicd://host:port" or ICE candidates. */
  readonly addresses: string[];
  /** Transport identifiers the peer supports, e.g. ["quic", "webtransport"]. */
  readonly transports: string[];
  /** Channels the peer advertises membership in (optional hint). */
  readonly channels?: ChannelId[];
  /** Ed25519 signature over the descriptor, verifiable against peerId. */
  readonly signature: Uint8Array;
}

/** A received chunk handed to the application after `open`. */
export interface ChunkEvent {
  readonly chid: ChannelId;
  readonly source: SourceId;
  readonly seq: number;
  readonly epoch: number;
  /** Plaintext, after the Cipher opened it. */
  readonly data: Uint8Array;
}

/** Local + gossip-derived view of a peer's contribution. See PROTOCOL.md §7. */
export interface Reputation {
  readonly peerId: PeerId;
  /** Bytes this node directly observed the peer deliver (most trusted). */
  readonly directBytesDelivered: number;
  /** Bytes reported by other peers via REP_REPLY (hearsay, weighted lower). */
  readonly reportedBytesDelivered: number;
  /** Count of distinct receipt issuers backing the peer's contribution. */
  readonly attestations: number;
  readonly lastSeen?: number;
}

/** Node-level configuration. */
export interface QUICDOptions {
  readonly identity: Identity;
  readonly transport: Transport;
  /** Addresses of any reachable peers to bootstrap discovery. Not servers. */
  readonly bootstrap?: string[];
  /** Max peers this node will proactively push to, per channel. Default 4. */
  readonly uploadSlots?: number;
  /** Max peers this node will pull from, per channel. Default 50. */
  readonly downloadSlots?: number;
}

/** Per-channel options. */
export interface JoinOptions {
  /** End-to-end content cipher. Required for confidential channels. */
  readonly cipher?: Cipher;
  /** Subscribe to specific sources, or all (default). */
  readonly sources?: SourceId[] | "all";
  /** Sliding-window size in chunks a live source retains. */
  readonly windowSize?: number;
}

// --- Transport adapter contract (see src/transport.ts for the full interface) ---
export type { Transport, PeerConnection, DatagramHandler } from "./transport.js";
