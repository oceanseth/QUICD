/**
 * Browser transport adapter for QUICD.
 * Uses WebTransport for datagram-capable endpoints and WebRTC DataChannels for
 * browser-to-browser peer paths WebTransport cannot dial. Lands in milestone M4.
 *
 * See docs/PROTOCOL.md §3.3 and §9 (NAT traversal).
 */
import type { Transport } from "../transport.js";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface WebTransportOptions {
  /** ICE servers for WebRTC peer paths (peers can also act as reflectors). */
  iceServers?: IceServer[];
}

/** Construct the browser (WebTransport + WebRTC) transport adapter. */
export function webTransport(_options: WebTransportOptions = {}): Transport {
  throw new Error("QUICD: webTransport is not implemented yet (lands in M4). See docs/PRODUCT_SPEC.md §9.");
}
