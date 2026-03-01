/**
 * Device identity management for OpenClaw Gateway pairing.
 * Generates an ED25519 keypair, persists it to .device.json,
 * and signs challenge nonces so the gateway can grant operator scopes.
 */

import { createHash, generateKeyPairSync, sign } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";

const DEVICE_FILE = ".device.json";

export interface DeviceIdentity {
  id: string;
  privateKeyPem: string;
  publicKeyBase64: string;
  paired: boolean;
}

export function markDevicePaired(device: DeviceIdentity): void {
  device.paired = true;
  writeFileSync(DEVICE_FILE, JSON.stringify(device, null, 2));
}

export function loadOrCreateDevice(): DeviceIdentity {
  if (existsSync(DEVICE_FILE)) {
    try {
      return JSON.parse(readFileSync(DEVICE_FILE, "utf-8"));
    } catch {
      // corrupted — regenerate
    }
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });

  // Strip the 12-byte SPKI/ASN.1 header to get the raw 32-byte ED25519 public key
  const rawPublicKey = (publicKey as unknown as Buffer).slice(-32);
  const publicKeyBase64 = rawPublicKey.toString("base64");

  // Device ID must be SHA-256 hex of the raw public key bytes (gateway derives same value)
  const id = createHash("sha256").update(rawPublicKey).digest("hex");

  const device: DeviceIdentity = {
    id,
    privateKeyPem: privateKey as string,
    publicKeyBase64,
    paired: false,
  };

  writeFileSync(DEVICE_FILE, JSON.stringify(device, null, 2));
  console.log(`[device] created new identity: ${device.id}`);
  return device;
}

function normalizeMetadata(value?: string | null): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  // ASCII-only lowercase for cross-runtime determinism (TS/Swift/Kotlin)
  return trimmed.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function decodeBase64Like(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, "base64");
}

function encodeBase64Url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizeBase64Url(input: string): string {
  try {
    return encodeBase64Url(decodeBase64Like(input));
  } catch {
    return input;
  }
}

export interface DevicePayloadParams {
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  token: string;
  platform?: string;
  deviceFamily?: string;
  signedAt?: number; // override timestamp (use gateway's ts to avoid clock skew)
  signatureVersion?: "v2" | "v3";
}

export function buildDevicePayload(device: DeviceIdentity, nonce: string, params: DevicePayloadParams) {
  const signedAt = params.signedAt ?? Date.now();
  const signatureVersion = params.signatureVersion ?? "v3";
  const base = [
    signatureVersion,
    device.id,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(signedAt),
    params.token ?? "",
    nonce,
  ];
  const message = signatureVersion === "v2"
    ? base.join("|")
    : [
        ...base,
        normalizeMetadata(params.platform),
        normalizeMetadata(params.deviceFamily),
      ].join("|");
  const sig = sign(null, Buffer.from(message), device.privateKeyPem);
  return {
    id: device.id,
    publicKey: normalizeBase64Url(device.publicKeyBase64),
    signature: encodeBase64Url(sig),
    signedAt,
    nonce,
  };
}
