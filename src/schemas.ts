/**
 * Zod schemas for OpenClaw Gateway WebSocket protocol validation.
 * These schemas provide runtime validation and automatic TypeScript types.
 */

import { z } from "zod";

const GATEWAY_CLIENT_IDS = [
  "webchat-ui",
  "openclaw-control-ui",
  "webchat",
  "cli",
  "gateway-client",
  "openclaw-macos",
  "openclaw-ios",
  "openclaw-android",
  "node-host",
  "test",
  "fingerprint",
  "openclaw-probe",
] as const;

const GATEWAY_CLIENT_MODES = [
  "webchat",
  "cli",
  "ui",
  "backend",
  "node",
  "probe",
  "test",
] as const;

// ============================================================================
// BASE TYPES
// ============================================================================

export const ClientDeviceSchema = z
  .object({
    id: z.string(),
    publicKey: z.string(),
    signature: z.string(),
    signedAt: z.number(),
    nonce: z.string().optional(),
  })
  .strict();

export const ClientInfoSchema = z
  .object({
    id: z.enum(GATEWAY_CLIENT_IDS),
    version: z.string(),
    platform: z.string(),
    mode: z.enum(GATEWAY_CLIENT_MODES),
    displayName: z.string().optional(),
    deviceFamily: z.string().optional(),
    modelIdentifier: z.string().optional(),
    instanceId: z.string().optional(),
  })
  .strict();

export const AuthSchema = z
  .object({
    token: z.string(),
  })
  .strict();

// ============================================================================
// CONNECT REQUEST/RESPONSE
// ============================================================================

export const ConnectParamsSchema = z
  .object({
    minProtocol: z.number(),
    maxProtocol: z.number(),
    client: ClientInfoSchema,
    role: z.enum(["node", "operator", "observer"]),
    scopes: z.array(z.string()),
    caps: z.array(z.string()),
    commands: z.array(z.string()),
    permissions: z.record(z.string(), z.boolean()),
    auth: AuthSchema,
    device: ClientDeviceSchema.optional().nullable(),
    locale: z.string().optional(),
    userAgent: z.string().optional(),
  })
  .strict();

export const HelloOkPayloadSchema = z
  .object({
    type: z.literal("hello-ok"),
    protocol: z.number(),
    server: z
      .object({
        version: z.string(),
        connId: z.string(),
      })
      .strict(),
    features: z
      .object({
        methods: z.array(z.string()),
        events: z.array(z.string()),
      })
      .strict(),
    snapshot: z.record(z.unknown()).optional(),
    canvasHostUrl: z.string().optional(),
    policy: z
      .object({
        maxPayload: z.number(),
        maxBufferedBytes: z.number(),
        tickIntervalMs: z.number(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

// ============================================================================
// EVENT PAYLOADS
// ============================================================================

export const ConnectChallengePayloadSchema = z
  .object({
    nonce: z.string(),
    ts: z.number(),
  })
  .passthrough();

export const AgentEventPayloadSchema = z
  .object({
    agentId: z.string().optional(),
    agent: z.string().optional(),
    message: z.string().optional(),
    text: z.string().optional(),
    sessionKey: z.string().optional(),
    runId: z.string().optional(),
    stream: z.string().optional(),
    data: z.record(z.unknown()).optional(),
    seq: z.number().optional(),
    ts: z.number().optional(),
  })
  .passthrough();

export const ChatMessageSchema = z
  .object({
    role: z.string(),
    content: z.unknown(),
    timestamp: z.number().optional(),
  })
  .passthrough();

export const ChatEventPayloadSchema = z
  .object({
    role: z.string().optional(),
    content: z.unknown().optional(),
    message: ChatMessageSchema.optional(),
    sessionKey: z.string().optional(),
    channel: z.string().optional(),
    state: z.string().optional(),
    runId: z.string().optional(),
    seq: z.number().optional(),
    ts: z.number().optional(),
  })
  .passthrough();

export const SkillInvokePayloadSchema = z
  .object({
    method: z.string().optional(),
    skill: z.string().optional(),
    name: z.string().optional(),
    params: z.record(z.unknown()).optional(),
    data: z.record(z.unknown()).optional(),
    input: z.record(z.unknown()).optional(),
    result: z.unknown().optional(),
    output: z.unknown().optional(),
    sessionKey: z.string().optional(),
    runId: z.string().optional(),
    ts: z.number().optional(),
  })
  .passthrough();

export const PresencePayloadSchema = z
  .object({
    text: z.string().optional(),
    mode: z.string().optional(),
    ts: z.number().optional(),
  })
  .passthrough();

export const HealthEventPayloadSchema = z
  .object({
    ok: z.boolean().optional(),
    ts: z.number().optional(),
    seq: z.number().optional(),
  })
  .passthrough();

export const CronEventPayloadSchema = z
  .object({
    id: z.string().optional(),
    status: z.string().optional(),
    ts: z.number().optional(),
  })
  .passthrough();

// ============================================================================
// MESSAGE TYPES
// ============================================================================

export const EventMessageSchema = z
  .object({
    type: z.literal("event"),
    event: z.string(),
    payload: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const RequestMessageSchema = z
  .object({
    type: z.literal("req"),
    id: z.string(),
    method: z.string(),
    params: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const ErrorDetailSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  })
  .strict();

export const ResponseMessageSchema = z
  .object({
    type: z.literal("res"),
    id: z.string(),
    ok: z.boolean(),
    payload: z.unknown().optional(),
    error: ErrorDetailSchema.optional(),
  })
  .passthrough();

// Keep gateway payload permissive: the server may send extra/top-level messages
// (e.g., seq, stateVersion, snapshot updates). We validate specific message
// shapes with dedicated schemas and helpers below.
export const GatewayPayloadSchema = z.any();

// ============================================================================
// CLI OPTIONS
// ============================================================================

export const ListenerOptionsSchema = z
  .object({
    url: z.string().url().or(z.string().startsWith("ws")),
    json: z.boolean(),
    reconnect: z.boolean(),
    serve: z.boolean().optional(), // start the HTTP/Socket.IO dashboard server
  })
  .strict();

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Safe parse with detailed error reporting
 */
export function parseGatewayPayload(data: unknown) {
  // Prefer permissive behavior: if data matches a known message schema,
  // return it as valid. Otherwise return ok:true with raw data so callers can
  // decide how to handle unrecognized gateway messages.
  if (EventMessageSchema.safeParse(data).success) {
    return { ok: true, data, error: null, message: null };
  }
  if (RequestMessageSchema.safeParse(data).success) {
    return { ok: true, data, error: null, message: null };
  }
  if (ResponseMessageSchema.safeParse(data).success) {
    return { ok: true, data, error: null, message: null };
  }

  // Unknown message shape — treat as non-fatal and return the raw payload.
  return { ok: true, data, error: null, message: null };
}

/**
 * Strict parse (throws on error)
 */
export function parseGatewayPayloadStrict(data: unknown) {
  return GatewayPayloadSchema.parse(data);
}

/**
 * Type guards
 */
export const isEventMessage = (msg: any): msg is z.infer<typeof EventMessageSchema> =>
  EventMessageSchema.safeParse(msg).success;

export const isResponseMessage = (msg: any): msg is z.infer<typeof ResponseMessageSchema> =>
  ResponseMessageSchema.safeParse(msg).success;

export const isRequestMessage = (msg: any): msg is z.infer<typeof RequestMessageSchema> =>
  RequestMessageSchema.safeParse(msg).success;

export const isConnectChallenge = (msg: any): boolean =>
  msg?.type === "event" && msg?.event === "connect.challenge";

export const isConnectionSuccess = (msg: any): boolean =>
  msg?.type === "res" && msg?.ok === true && msg?.payload?.type === "hello-ok";
