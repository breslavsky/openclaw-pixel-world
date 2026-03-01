/**
 * Type definitions derived from Zod schemas.
 * Import actual types from src/schemas.ts for runtime validation.
 */

import type { z } from "zod";
import type {
  EventMessageSchema,
  ResponseMessageSchema,
  GatewayPayloadSchema,
  ConnectParamsSchema,
  ListenerOptionsSchema,
} from "./schemas.js";

export type EventMessage = z.infer<typeof EventMessageSchema>;
export type ResponseMessage = z.infer<typeof ResponseMessageSchema>;
export type GatewayPayload = z.infer<typeof GatewayPayloadSchema>;
export type ConnectParams = z.infer<typeof ConnectParamsSchema>;
export type ListenerOptions = z.infer<typeof ListenerOptionsSchema>;

export interface BotActivitySummary {
  type: "agent" | "chat" | "skill" | "presence" | "heartbeat" | "cron" | "unknown";
  timestamp: string;
  details: string;
}

export interface WsInstance {
  addEventListener?: (type: string, listener: (event: any) => void) => void;
  on?: (type: string, listener: (...args: any[]) => void) => void;
  close: () => void;
  send?: (...args: any[]) => void;
  terminate?: () => void;
  readyState?: number;
}

export interface WsCtor {
  new (url: string, options?: { headers?: Record<string, string> }): WsInstance;
}
