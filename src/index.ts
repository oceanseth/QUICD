/**
 * QUICD — QUIC Distributed.
 * Serverless, end-to-end-encrypted, one-to-many data delivery over QUIC.
 *
 * This is the public API surface. The protocol it implements is specified in
 * docs/PROTOCOL.md. Transport wiring lands incrementally (see roadmap, M1+);
 * methods that require the network throw `NotImplementedError` until their
 * milestone ships, but the types and shape are stable to build against.
 */
import { EventEmitter } from "node:events";
import { generateIdentity, identityFromKeys, peerIdFromPublicKey } from "./identity.js";
import type {
  ChannelId,
  ChunkEvent,
  Cipher,
  Identity,
  JoinOptions,
  PeerDescriptor,
  PeerId,
  QUICDOptions,
  Reputation,
  SourceId,
  Transport,
} from "./types.js";

export class NotImplementedError extends Error {
  constructor(feature: string, milestone: string) {
    super(`QUICD: ${feature} is not wired yet (lands in ${milestone}). See docs/PRODUCT_SPEC.md §9.`);
    this.name = "NotImplementedError";
  }
}

const DEFAULT_UPLOAD_SLOTS = 4;
const DEFAULT_DOWNLOAD_SLOTS = 50;

/**
 * A live producer of chunks within a channel. Data pushed here is chunked,
 * signed, sealed by the channel Cipher, and disseminated to downstream peers.
 */
export class Source {
  readonly id: SourceId;
  #seq = 0;
  #epoch = 0;
  readonly #channel: Channel;

  constructor(channel: Channel, id: SourceId) {
    this.#channel = channel;
    this.id = id;
  }

  /** The next sequence number this source will emit. */
  get seq(): number {
    return this.#seq;
  }

  get epoch(): number {
    return this.#epoch;
  }

  /** Emit one chunk of content. Returns the sequence number assigned. */
  push(_data: Uint8Array): number {
    void this.#channel;
    throw new NotImplementedError("Source.push (chunk dissemination)", "M1");
  }

  /** Bump the epoch (e.g. on codec/key change); resets seq for the new epoch. */
  newEpoch(): number {
    this.#epoch += 1;
    this.#seq = 0;
    return this.#epoch;
  }
}

export interface ChannelEvents {
  /** A verified, decrypted chunk arrived. */
  chunk: (event: ChunkEvent) => void;
  /** A new source (producer) appeared in the channel. */
  source: (source: SourceId) => void;
  /** A peer joined the channel's swarm view. */
  peer: (peer: PeerDescriptor) => void;
  /** A previously-known peer left or timed out. */
  "peer:leave": (peer: PeerId) => void;
  error: (err: Error) => void;
}

/**
 * A subscription to one channel. Produces via `createSource`, consumes via the
 * `chunk` event, and recovers loss via `requestRange`.
 */
export class Channel extends EventEmitter {
  readonly chid: ChannelId;
  readonly #cipher: Cipher | undefined;
  readonly #node: QUICD;

  constructor(node: QUICD, chid: ChannelId, options: JoinOptions) {
    super();
    this.#node = node;
    this.chid = chid;
    this.#cipher = options.cipher;
  }

  get cipher(): Cipher | undefined {
    return this.#cipher;
  }

  /** Begin producing into this channel as a new source. */
  createSource(index = 0): Source {
    const sourceId: SourceId = index === 0 ? this.#node.peerId : `${this.#node.peerId}/${index}`;
    return new Source(this, sourceId);
  }

  /**
   * Reliably pull a range of chunks for a source from any peer that has them.
   * This is the recovery path for datagrams lost to UDP (PROTOCOL.md §6.3) and
   * the access path for bulk downloads (§6.4).
   */
  requestRange(_source: SourceId, _fromSeq: number, _toSeq: number): Promise<void> {
    throw new NotImplementedError("Channel.requestRange (WANT/repair)", "M1");
  }

  /** Peers currently known in this channel's swarm. */
  peers(): Promise<PeerDescriptor[]> {
    throw new NotImplementedError("Channel.peers (PEX)", "M2");
  }

  /** Leave the channel and release all slots associated with it. */
  leave(): Promise<void> {
    throw new NotImplementedError("Channel.leave", "M1");
  }

  // Typed event helpers.
  override on<K extends keyof ChannelEvents>(event: K, listener: ChannelEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof ChannelEvents>(event: K, ...args: Parameters<ChannelEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
}

/**
 * A QUICD node: a single cryptographic identity participating in any number of
 * channels over one transport.
 */
export class QUICD {
  readonly identity: Identity;
  readonly transport: Transport;
  readonly uploadSlots: number;
  readonly downloadSlots: number;
  readonly #channels = new Map<ChannelId, Channel>();

  private constructor(options: QUICDOptions) {
    this.identity = options.identity;
    this.transport = options.transport;
    this.uploadSlots = options.uploadSlots ?? DEFAULT_UPLOAD_SLOTS;
    this.downloadSlots = options.downloadSlots ?? DEFAULT_DOWNLOAD_SLOTS;
  }

  get peerId(): PeerId {
    return this.identity.peerId;
  }

  /** Create and start a node: binds the transport and prepares discovery. */
  static async create(options: QUICDOptions): Promise<QUICD> {
    const node = new QUICD(options);
    await options.transport.listen(options.identity);
    // Bootstrap dialing + accept loop are wired in M1.
    return node;
  }

  /** Join (subscribe to) a channel. Idempotent per CHID. */
  async join(chid: ChannelId, options: JoinOptions = {}): Promise<Channel> {
    const existing = this.#channels.get(chid);
    if (existing) return existing;
    const channel = new Channel(this, chid, options);
    this.#channels.set(chid, channel);
    // SUBSCRIBE + slot negotiation against discovered peers land in M1/M2.
    return channel;
  }

  /** Combined local + gossip view of a peer's contribution (PROTOCOL.md §7). */
  reputation(_peerId: PeerId): Promise<Reputation> {
    throw new NotImplementedError("QUICD.reputation (REP_QUERY)", "M3");
  }

  /** Channels this node is currently subscribed to. */
  channels(): ChannelId[] {
    return [...this.#channels.keys()];
  }

  /** Tear down all channels and the transport. */
  async close(): Promise<void> {
    this.#channels.clear();
    await this.transport.close();
  }
}

export { generateIdentity, identityFromKeys, peerIdFromPublicKey };
export type {
  ChannelId,
  ChunkContext,
  ChunkEvent,
  Cipher,
  Identity,
  JoinOptions,
  PeerDescriptor,
  PeerId,
  QUICDOptions,
  Reputation,
  SourceId,
  Transport,
} from "./types.js";
export type { PeerConnection, Stream, DatagramHandler } from "./transport.js";
