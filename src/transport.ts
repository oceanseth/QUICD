/**
 * QUICD transport adapter contract.
 *
 * QUICD's protocol is defined against this abstract transport, so the same
 * channel/source/chunk logic runs over native QUIC (Node/Electron) or
 * WebTransport/WebRTC (browser). An adapter must provide:
 *   - authenticated connections to a PeerId,
 *   - reliable bidirectional and unidirectional streams,
 *   - an unreliable datagram channel.
 *
 * See docs/PROTOCOL.md §3 (Transport layer).
 */
import type { Identity, PeerId } from "./types.js";

/** Handler invoked for each inbound unreliable datagram on a connection. */
export type DatagramHandler = (data: Uint8Array) => void;

/** A reliable, ordered byte stream (maps to a QUIC stream). */
export interface Stream {
  write(chunk: Uint8Array): Promise<void>;
  /** Async iterable of inbound bytes. */
  readable: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

/** An authenticated connection to exactly one remote peer. */
export interface PeerConnection {
  readonly remotePeerId: PeerId;
  /** Open a bidirectional reliable stream (control). */
  openBidi(): Promise<Stream>;
  /** Open a unidirectional reliable stream (repair / bulk). */
  openUni(): Promise<Stream>;
  /** Inbound streams opened by the remote. */
  readonly incomingStreams: AsyncIterable<Stream>;
  /** Send an unreliable datagram (live chunk). May be dropped. */
  sendDatagram(data: Uint8Array): void;
  /** Register the handler for inbound datagrams. */
  onDatagram(handler: DatagramHandler): void;
  close(reason?: string): Promise<void>;
  readonly closed: Promise<void>;
}

/**
 * A transport adapter: dials peers and accepts inbound connections, with the
 * QUIC/TLS handshake authenticating each side's PeerId (raw public keys).
 */
export interface Transport {
  readonly name: string;
  /** Bind/listen using the node's identity; returns local reachable addresses. */
  listen(identity: Identity): Promise<{ addresses: string[] }>;
  /** Dial a peer at an address; resolves once authenticated. */
  dial(address: string): Promise<PeerConnection>;
  /** Inbound, already-authenticated connections from other peers. */
  readonly incoming: AsyncIterable<PeerConnection>;
  close(): Promise<void>;
}
