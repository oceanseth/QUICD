/**
 * QUICD identity: Ed25519 keypair → self-certifying PeerId.
 * PeerId = base32(multibase) of SHA-256(SPKI public key). See PROTOCOL.md §2.
 */
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { Identity, PeerId } from "./types.js";

const MULTIBASE_BASE32_PREFIX = "b"; // RFC 4648 base32, lowercase, multibase code 'b'

function base32(bytes: Uint8Array): string {
  const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Derive the PeerId for a raw Ed25519 public key (SPKI DER bytes hashed). */
export function peerIdFromPublicKey(spki: Uint8Array): PeerId {
  const digest = createHash("sha256").update(spki).digest();
  return MULTIBASE_BASE32_PREFIX + base32(digest);
}

function rawKeys(pub: KeyObject, priv: KeyObject): { publicKey: Uint8Array; privateKey: Uint8Array } {
  return {
    publicKey: new Uint8Array(pub.export({ type: "spki", format: "der" })),
    privateKey: new Uint8Array(priv.export({ type: "pkcs8", format: "der" })),
  };
}

/** Generate a fresh identity. Persist `privateKey` to keep this PeerId stable. */
export function generateIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keys = rawKeys(publicKey, privateKey);
  return {
    peerId: peerIdFromPublicKey(keys.publicKey),
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
}

/** Reconstruct an identity from persisted SPKI/PKCS8 DER key bytes. */
export function identityFromKeys(publicKey: Uint8Array, privateKey: Uint8Array): Identity {
  return { peerId: peerIdFromPublicKey(publicKey), publicKey, privateKey };
}
