/**
 * Native QUIC transport adapter for Node.js / Electron main process.
 * Uses QUIC (RFC 9000) + DATAGRAM (RFC 9221). Lands in milestone M1.
 *
 * Backend selection (node:quic vs. a userspace msquic/quiche binding) is an
 * open question tracked in docs/PRODUCT_SPEC.md §10.
 */
import type { Transport } from "../transport.js";

export interface NodeTransportOptions {
  /** UDP port to bind. 0 = ephemeral. */
  port?: number;
  /** Bind address. Default "0.0.0.0". */
  host?: string;
}

/** Construct the native QUIC transport adapter. */
export function nodeTransport(_options: NodeTransportOptions = {}): Transport {
  throw new Error("QUICD: nodeTransport is not implemented yet (lands in M1). See docs/PRODUCT_SPEC.md §9.");
}
