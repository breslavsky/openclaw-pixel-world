/**
 * OpenClaw Gateway protocol utilities.
 * Uses Zod for runtime validation and type safety.
 */

import type { WsInstance } from "./types.js";
import { ConnectParamsSchema } from "./schemas.js";
import { parseGatewayPayload } from "./schemas.js";

const PROTOCOL_VERSION = 3;
const DEFAULT_OPERATOR_SCOPES = [
  "operator.read",
  "operator.write",
  "operator.admin",
  "operator.approvals",
  "operator.pairing",
];

export interface ConnectClientOptions {
  id: string;
  version: string;
  platform: string;
  mode: string;
  displayName?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  instanceId?: string;
}

const DEFAULT_CONNECT_CLIENT: ConnectClientOptions = {
  id: "gateway-client",
  version: "1.0.0",
  platform: process.platform,
  mode: "backend",
};

/**
 * Create a connect request with validated parameters.
 * When not yet paired, connect as role="node" so that node.pair.request
 * can be called without requiring operator.pairing scope.
 * After pairing approval, reconnect as role="operator" with device credentials.
 */
export function createConnectRequest(
  token: string,
  devicePayload?: { id: string; publicKey: string; signature: string; signedAt: number; nonce?: string } | null,
  role: "operator" | "node" = "operator",
  options?: {
    client?: Partial<ConnectClientOptions>;
    scopes?: string[];
  },
) {
  const client = { ...DEFAULT_CONNECT_CLIENT, ...(options?.client ?? {}) };
  const scopes = options?.scopes ?? (role === "node" ? [] : DEFAULT_OPERATOR_SCOPES);

  const params = ConnectParamsSchema.parse({
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client,
    role,
    scopes,
    caps: [],
    commands: [],
    permissions: {},
    auth: { token },
    ...(devicePayload ? { device: devicePayload } : {}),
  });

  return {
    type: "req" as const,
    id: `connect-${Date.now()}`,
    method: "connect",
    params,
  };
}

/**
 * Create a node pairing request (registers our public key with the gateway).
 * Must be called when connected as role="node".
 * silent:true requests auto-approval if the gateway supports it.
 */
export function createPairRequest(deviceId: string, publicKey: string) {
  return {
    type: "req" as const,
    id: `pair-${Date.now()}`,
    method: "node.pair.request",
    params: { id: deviceId, publicKey, silent: true },
  };
}

/**
 * Create a request to list all agents
 */
export function createAgentsListRequest() {
  return {
    type: "req" as const,
    id: `agents-list-${Date.now()}`,
    method: "agents.list",
    params: {},
  };
}

/**
 * Create a request to fetch all available tools
 */
export function createToolsCatalogRequest() {
  return {
    type: "req" as const,
    id: `tools-catalog-${Date.now()}`,
    method: "tools.catalog",
    params: {},
  };
}

/**
 * Create a subscription request for agent events
 */
export function createSubscriptionRequest() {
  return {
    type: "req" as const,
    id: `sub-${Date.now()}`,
    method: "events.subscribe",
    params: {
      filter: { agents: "*" },
    },
  };
}

/**
 * Send a request through the WebSocket
 */
export function sendRequest(ws: WsInstance | undefined, request: any): void {
  if (!ws?.send) {
    console.error("WebSocket not ready");
    return;
  }
  ws.send(JSON.stringify(request));
}

/**
 * Extract authentication token from gateway URL
 */
export function extractToken(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.searchParams.get("token") || "";
  } catch {
    return "";
  }
}

/**
 * Extract origin from gateway URL for CORS headers
 */
export function extractOrigin(url: string): string {
  try {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${urlObj.host}`;
  } catch {
    return "http://localhost";
  }
}

/**
 * Validate incoming gateway message
 */
export function validateGatewayMessage(data: unknown) {
  return parseGatewayPayload(data);
}

/**
 * Re-export type guards from schemas
 */
export { isConnectChallenge, isConnectionSuccess } from "./schemas.js";

/**
 * Type guard: response to an agents.list request
 */
export const isAgentsListResponse = (msg: any): boolean =>
  msg?.type === "res" && msg?.ok === true && String(msg?.id ?? "").startsWith("agents-list-");

/**
 * Type guard: response to a tools.catalog request
 */
export const isToolsCatalogResponse = (msg: any): boolean =>
  msg?.type === "res" && msg?.ok === true && String(msg?.id ?? "").startsWith("tools-catalog-");

/**
 * Type guard: health event (contains agents array)
 */
export const isHealthEvent = (msg: any): boolean =>
  msg?.type === "event" && msg?.event === "health";

/**
 * Type guard: gateway is requesting pairing approval
 */
export const isPairRequested = (msg: any): boolean =>
  msg?.type === "event" && msg?.event === "node.pair.requested";

/**
 * Type guard: pairing was approved or rejected
 */
export const isPairResolved = (msg: any): boolean =>
  msg?.type === "event" && msg?.event === "node.pair.resolved";

/**
 * Extract agents from hello-ok snapshot or health event payload.
 * Returns an array of { agentId, status } objects.
 */
export function extractAgentsFromPayload(msg: any): Array<{ agentId: string; status: string; details?: string }> {
  // hello-ok snapshot path
  const snapshotAgents = msg?.payload?.snapshot?.health?.agents;
  // health event path
  const healthAgents = msg?.payload?.agents;
  const list = snapshotAgents ?? healthAgents;
  if (!Array.isArray(list)) return [];
  return list
    .filter((a: any) => a?.agentId)
    .map((a: any) => ({
      agentId: a.agentId,
      status: a.isDefault ? "default" : "known",
      details: a.agentId,
    }));
}
