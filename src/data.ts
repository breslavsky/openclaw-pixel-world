/**
 * Data conversion and parsing utilities.
 */

import { WebSocket as WsWebSocket } from "ws";

export function asText(payload: unknown): string {
  if (typeof payload === "string") return payload;

  if (payload instanceof ArrayBuffer) {
    return new TextDecoder().decode(payload);
  }

  if (ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView;
    const sliced = view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength,
    ) as ArrayBuffer;
    return new TextDecoder().decode(sliced);
  }

  // Node.js ws: Buffer (or Buffer-like)
  const anyPayload = payload as any;
  if (anyPayload?.toString && typeof anyPayload?.toString === "function") {
    try {
      return anyPayload.toString("utf8");
    } catch {
      return anyPayload.toString();
    }
  }

  return String(payload);
}

export function resolveWebSocketCtor(): any {
  return WsWebSocket;
}
