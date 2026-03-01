/**
 * Main WebSocket listener implementation.
 * Uses Zod for runtime validation of all incoming messages.
 */

import type { WsInstance, ListenerOptions, GatewayPayload } from "./types.js";
import { appendFile } from "fs/promises";
import { WebSocket } from "ws";
import { asText } from "./data.js";
import { formatJson, now, formatAgentStatus, AGENT_STATUS, type AgentStatus } from "./formatter.js";
import { EventEmitter } from "events";
import {
  createConnectRequest,
  createSubscriptionRequest,
  createAgentsListRequest,
  createToolsCatalogRequest,
  sendRequest,
  extractToken,
  extractOrigin,
  isConnectChallenge,
  isConnectionSuccess,
  isAgentsListResponse,
  isToolsCatalogResponse,
  isHealthEvent,
  isPairRequested,
  isPairResolved,
  extractAgentsFromPayload,
  validateGatewayMessage,
} from "./protocol.js";
import { loadOrCreateDevice, buildDevicePayload, markDevicePaired, type DeviceIdentity } from "./device.js";

export class GatewayListener {
  private stopped = false;
  private attempt = 0;
  private ws: WsInstance | undefined;
  private backoffMs = 0;
  private defaultAgentId: string | undefined;
  private logTailCursor: number | undefined;
  private logTailReady = false;
  private logTailPollingTimer: NodeJS.Timeout | undefined;
  private logTailInFlight = false;
  private pendingUserInputs: Array<{ text: string; timestamp: number; channel?: string }> = [];
  private pendingToolImages: Array<{ tool?: string; images: string[]; timestamp: number }> = [];
  private gatewayHttpBase: string;
  private device: DeviceIdentity;
  private connectRole: "operator" | "node" = "operator";
  private connectSentForSocket = false;
  private signatureVersion: "v2" | "v3" = process.env.OPENCLAW_DEVICE_SIG_VERSION === "v2" ? "v2" : "v3";

  constructor(private options: ListenerOptions, private emitter?: EventEmitter) {
    this.device = loadOrCreateDevice();
    this.gatewayHttpBase = this.toHttpBase(options.url);
  }

  start(): void {
    this.setupSignalHandlers();
    this.connect();
  }

  private setupSignalHandlers(): void {
    process.once("SIGINT", () => this.stop());
    process.once("SIGTERM", () => this.stop());
  }

  private emitAgents(msg: any): void {
    if (!this.emitter) return;
    const agents = extractAgentsFromPayload(msg);
    agents.forEach((agent) => {
      this.emitter!.emit("status", {
        status: { ...agent, timestamp: new Date().toISOString() },
        payload: { payload: msg?.payload },
      });
    });
  }

  private extractAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
    if (!sessionKey) return undefined;
    const parts = sessionKey.split(":");
    return parts[0] === "agent" && parts[1] ? parts[1] : undefined;
  }

  private toText(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      return value
        .map((entry) => this.toText(entry))
        .filter((entry) => entry.length > 0)
        .join(" ")
        .trim();
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const textValue = this.toText(record.text ?? record.content ?? record.message ?? record.value);
      if (textValue) return textValue;
    }
    return "";
  }

  private enqueueUserInput(text: string, timestamp: number, channel?: string): void {
    const normalized = text.trim();
    if (!normalized) return;
    this.pendingUserInputs.push({ text: normalized, timestamp, channel });
    if (this.pendingUserInputs.length > 50) {
      this.pendingUserInputs = this.pendingUserInputs.slice(-50);
    }
  }

  private consumeUserInput(channel?: string, timestamp?: number): string | undefined {
    if (this.pendingUserInputs.length === 0) return undefined;
    const ts = timestamp ?? Date.now();
    const windowMs = 180_000;
    for (let index = this.pendingUserInputs.length - 1; index >= 0; index -= 1) {
      const item = this.pendingUserInputs[index];
      const sameChannel = !channel || !item.channel || item.channel === channel;
      if (!sameChannel) continue;
      const inWindow = Math.abs(ts - item.timestamp) <= windowMs;
      if (!inWindow) continue;
      this.pendingUserInputs.splice(index, 1);
      return item.text;
    }
    return undefined;
  }

  private toHttpBase(url: string): string {
    try {
      const parsed = new URL(url);
      const protocol = parsed.protocol === "wss:" ? "https:" : "http:";
      return `${protocol}//${parsed.host}`;
    } catch {
      return "";
    }
  }

  private normalizeImagePath(pathLike: string): string {
    return pathLike.trim().replace(/^["']+|["']+$/g, "");
  }

  private buildGatewayMediaUrls(pathLike: string): string[] {
    const normalized = this.normalizeImagePath(pathLike);
    if (!normalized) return [];
    const basename = normalized.split(/[/\\]+/).pop() ?? "";
    const mediaMatch = normalized.match(/[\\/]\\.openclaw[\\/]media[\\/](.+)$/i);
    const mediaRelative = mediaMatch?.[1]?.replace(/\\/g, "/") ?? "";
    const urls: string[] = [];
    if (this.gatewayHttpBase && mediaRelative) {
      urls.push(`${this.gatewayHttpBase}/media/${mediaRelative}`);
    }
    if (this.gatewayHttpBase && basename) {
      urls.push(`${this.gatewayHttpBase}/media/browser/${basename}`);
    }
    if (normalized.startsWith("http://") || normalized.startsWith("https://") || normalized.startsWith("data:image/")) {
      urls.push(normalized);
    }
    return Array.from(new Set(urls));
  }

  private queueToolImages(tool: string | undefined, images: string[], timestamp: number): void {
    const dedup = Array.from(new Set(images.map((item) => item.trim()).filter(Boolean))).slice(0, 8);
    if (dedup.length === 0) return;
    this.pendingToolImages.push({ tool: tool?.toLowerCase(), images: dedup, timestamp });
    if (this.pendingToolImages.length > 80) {
      this.pendingToolImages = this.pendingToolImages.slice(-80);
    }
  }

  private consumeToolImages(tool: string | undefined, timestamp: number): string[] | undefined {
    if (this.pendingToolImages.length === 0) return undefined;
    const targetTool = tool?.toLowerCase();
    const maxAgeMs = 120_000;
    const collected: string[] = [];
    const kept: Array<{ tool?: string; images: string[]; timestamp: number }> = [];
    for (const entry of this.pendingToolImages) {
      const age = Math.abs(timestamp - entry.timestamp);
      const freshEnough = age <= maxAgeMs;
      const toolMatch = !targetTool || !entry.tool || entry.tool === targetTool;
      if (freshEnough && toolMatch) {
        collected.push(...entry.images);
        continue;
      }
      if (freshEnough) kept.push(entry);
    }
    this.pendingToolImages = kept;
    const dedup = Array.from(new Set(collected)).slice(0, 8);
    return dedup.length ? dedup : undefined;
  }

  private emitTaskFromMessage(msg: any): void {
    if (!this.emitter) return;
    if (msg?.type !== "event" || msg?.event !== "chat") return;

    const payload = (msg as any)?.payload ?? {};
    const state = String(payload?.state ?? "").toLowerCase();
    if (state && state !== "final") return;

    const role = String(payload?.message?.role ?? payload?.role ?? "").toLowerCase();
    if (role !== "user" && role !== "human") return;

    const text = this.toText(payload?.message?.content ?? payload?.content);
    if (!text) return;

    const runId = String(payload?.runId ?? payload?.sessionKey ?? "").trim();
    const sessionKey = String(payload?.sessionKey ?? "").trim();
    const agentId = this.extractAgentIdFromSessionKey(sessionKey) ?? this.defaultAgentId;
    const ts = typeof payload?.ts === "number" ? payload.ts : Date.now();

    this.emitter.emit("task", {
      runId,
      sessionKey,
      agentId,
      text,
      timestamp: new Date(ts).toISOString(),
      payload,
    });
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    process.stdout.write(`\n[${now()}] stopping\n`);

    this.stopLogTailPolling();

    try {
      this.ws?.close();
    } catch {
      this.ws?.terminate?.();
    }

    // give the WebSocket close handshake a moment, then exit
    setTimeout(() => process.exit(0), 300).unref();
  }

  private connect(): void {
    if (this.stopped) return;

    this.attempt += 1;
    this.backoffMs = Math.min(10_000, 250 * Math.pow(1.6, Math.max(0, this.attempt - 1)));

    console.log(`[${now()}] connecting: ${this.options.url} (attempt ${this.attempt})`);

    const origin = extractOrigin(this.options.url);
    this.ws = new WebSocket(this.options.url, { headers: { origin } }) as unknown as WsInstance;
    this.connectSentForSocket = false;

    this.attachHandlers();
  }

  private attachHandlers(): void {
    if (!this.ws) return;

    const onOpen = () => {
      this.attempt = 0;
      console.log(`[${now()}] open`);
    };

    const onClose = (code?: number, reason?: string) => {
      const details = code !== undefined ? ` code=${code}` : "";
      const reasonText = reason ? ` reason=${JSON.stringify(reason)}` : "";
      console.log(`[${now()}] close${details}${reasonText}`);
      this.stopLogTailPolling();
      this.logTailCursor = undefined;
      this.logTailReady = false;
      this.connectSentForSocket = false;
      if (!this.stopped && this.options.reconnect) {
        setTimeout(() => this.connect(), this.backoffMs);
      }
    };

    const onError = (e: any) => {
      const msg = e?.message ?? e?.error?.message ?? e?.toString?.() ?? String(e);
      console.error(`[${now()}] error: ${msg}`);
    };

    const onMessage = (payload: unknown) => {
      this.handleMessage(payload);
    };

    // Browser/Deno/Bun-style
    if (typeof this.ws.addEventListener === "function") {
      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("close", (evt: any) => onClose(evt?.code, evt?.reason));
      this.ws.addEventListener("error", onError);
      this.ws.addEventListener("message", (evt: any) => onMessage(evt?.data));
      return;
    }

    // Node ws-style
    if (typeof this.ws.on === "function") {
      this.ws.on("open", onOpen);
      this.ws.on("close", (code: number, reason: any) =>
        onClose(code, typeof reason === "string" ? reason : reason?.toString?.()),
      );
      this.ws.on("error", onError);
      this.ws.on("message", onMessage);
    }
  }

  private handleMessage(payload: unknown): void {
    const text = asText(payload);
    const formatted = formatJson(text);

    // Persist every incoming raw message from the gateway for auditing/debugging
    // Append asynchronously so we don't block the message loop.
    appendFile("messages.txt", text + "\n").catch(() => {});

    try {
      // Parse and validate message with Zod
      const validation = validateGatewayMessage(JSON.parse(text));

      let msg: GatewayPayload | null = null;

      if (!validation.ok) {
        const errMsg = String(validation.message || "");
        const isUnrecognizedKeys = errMsg.includes("Unrecognized key(s)");
        if (isUnrecognizedKeys) {
          // Gateway may add top-level fields like `seq` or `stateVersion`.
          // Treat these unrecognized-keys errors as non-fatal and continue
          // using the raw parsed payload.
          try {
            msg = JSON.parse(text) as GatewayPayload;
          } catch {
            console.error(`[${now()}] validation error:`, validation.message, validation.error);
            return;
          }
        } else {
          console.error(
            `[${now()}] validation error:`,
            validation.message,
            validation.error,
          );
          return;
        }
      } else {
        msg = validation.data;
      }
      
      if (!msg) {
        console.error(`[${now()}] received null message after validation`);
        return;
      }

      // User chat requests become kanban task cards.
      this.emitTaskFromMessage(msg);

      // Only surface user-friendly agent status changes in the terminal.
      const status = formatAgentStatus(msg);
      // Emit status to external listeners (e.g., Socket.IO server)
      if (status && this.emitter) {
        try {
          const statusWithFallbackAgent =
            status.agentId || !this.defaultAgentId
              ? status
              : { ...status, agentId: this.defaultAgentId };
          // send both status and original payload so server can build agent records
          this.emitter.emit("status", { status: statusWithFallbackAgent, payload: msg });
        } catch {}
      }
      if (status) {
        // Suppress streaming delta noise in terminal; keep meaningful state changes.
        if (status.status !== AGENT_STATUS.THINKING) {
          const line = status.details ? `${status.status}: ${status.details}` : status.status;
          console.log(`[${status.timestamp}] ${line}`);
        }
      } else if (this.options.json) {
        // If user explicitly requested JSON mode, still show raw messages.
        console.log(`[${now()}] message:\n${formatted}`);
      }

      // Handle authentication:
      // - role="node" + unknown device → gateway creates pending pairing request
      // - role="node" + approved device → gateway completes node hello-ok
      // - role="operator" + paired device → gateway grants operator scopes
      if (isConnectChallenge(msg)) {
        if (this.connectSentForSocket) return;
        const token = extractToken(this.options.url);
        const nonce = (msg as any)?.payload?.nonce as string | undefined;
        // Use the gateway's timestamp from the challenge to avoid clock-skew rejection.
        const gatewayTs = (msg as any)?.payload?.ts as number | undefined;
        const connectRole = this.device.paired ? "operator" : "node";
        this.connectRole = connectRole;
        const connectReq = createConnectRequest(token, null, connectRole);
        if (nonce) {
          const connectParams = connectReq.params;
          connectReq.params.device = buildDevicePayload(this.device, nonce, {
            clientId: connectParams.client.id,
            clientMode: connectParams.client.mode,
            role: connectParams.role,
            scopes: connectParams.scopes,
            token: connectParams.auth?.token ?? "",
            platform: connectParams.client.platform,
            deviceFamily: connectParams.client.deviceFamily,
            signedAt: gatewayTs,
            signatureVersion: this.signatureVersion,
          });
        }
        this.connectSentForSocket = true;
        sendRequest(this.ws, connectReq);
      }
      // After hello-ok: subscribe (operator+paired) or wait for pairing approval (node role)
      else if (isConnectionSuccess(msg)) {
        const helloDefaultAgent = (msg as any)?.payload?.snapshot?.health?.defaultAgentId
          ?? (msg as any)?.payload?.snapshot?.defaultAgentId;
        if (typeof helloDefaultAgent === "string" && helloDefaultAgent.length > 0) {
          this.defaultAgentId = helloDefaultAgent;
        }
        const auth = (msg as any)?.payload?.auth;
        if (auth) {
          const role = typeof auth.role === "string" ? auth.role : "unknown";
          const scopes = Array.isArray(auth.scopes) ? auth.scopes.join(", ") : "";
          console.log(`[${now()}] auth role=${role} scopes=${scopes}`);
        }
        const supportedEvents = (msg as any)?.payload?.features?.events;
        if (Array.isArray(supportedEvents)) {
          const toolCallEventsEnabled = supportedEvents.includes("node.invoke.request");
          console.log(`[${now()}] tool-call events: ${toolCallEventsEnabled ? "node.invoke.request enabled" : "not supported"}`);
        }
        // If node hello succeeds, gateway already accepts this device identity.
        // Persist paired state locally and reconnect as operator to get scopes.
        if (!this.device.paired && this.connectRole === "node") {
          markDevicePaired(this.device);
          this.connectRole = "operator";
          console.log(`\n[${now()}] device accepted by gateway — reconnecting as operator`);
          this.ws?.close();
          if (!this.options.reconnect) {
            setTimeout(() => this.connect(), 0);
          }
          return;
        }
        if (this.device.paired && this.connectRole === "operator") {
          const methods = (msg as any)?.payload?.features?.methods;
          if (Array.isArray(methods) && methods.includes("events.subscribe")) {
            sendRequest(this.ws, createSubscriptionRequest());
          } else {
            console.log(`[${now()}] events.subscribe unavailable; using default gateway event stream`);
          }
          if (Array.isArray(methods) && methods.includes("logs.tail")) {
            this.startLogTailPolling();
          }
          if (Array.isArray(methods) && methods.includes("tools.catalog")) {
            sendRequest(this.ws, createToolsCatalogRequest());
          } else {
            console.log(`[${now()}] tools.catalog unavailable; tool registry list is not exposed by gateway`);
          }
          sendRequest(this.ws, createAgentsListRequest());
        } else {
          console.log(`\n[${now()}] waiting for pairing approval (device id: ${this.device.id})`);
          console.log(`[${now()}] run: npx openclaw devices approve`);
        }
        this.emitAgents(msg);
      }
      // Populate agents map from agents.list response
      else if (isAgentsListResponse(msg)) {
        const defaultId = (msg as any)?.payload?.defaultId;
        if (typeof defaultId === "string" && defaultId.length > 0) {
          this.defaultAgentId = defaultId;
        }
        this.emitAgents(msg);
      }
      // Receive full tool catalog (if gateway supports tools.catalog)
      else if (isToolsCatalogResponse(msg)) {
        if (this.emitter) {
          this.emitter.emit("tools", (msg as any)?.payload ?? null);
        }
      }
      // Update agents map on health events
      else if (isHealthEvent(msg)) {
        const defaultId = (msg as any)?.payload?.defaultAgentId;
        if (typeof defaultId === "string" && defaultId.length > 0) {
          this.defaultAgentId = defaultId;
        }
        this.emitAgents(msg);
      }
      // Pairing requested — user must approve in Control UI
      else if (isPairRequested(msg)) {
        console.log(`\n[${now()}] *** PAIRING REQUESTED — open Control UI and approve device: ${this.device.id} ***`);
      }
      // Signature compatibility fallback:
      // some gateways only verify v2 payloads; switch once if v3 is rejected.
      else if (
        (msg as any)?.type === "res" &&
        (msg as any)?.ok === false &&
        (msg as any)?.error?.details?.code === "DEVICE_AUTH_INVALID" &&
        (msg as any)?.error?.details?.reason === "device-signature" &&
        this.signatureVersion === "v3"
      ) {
        this.signatureVersion = "v2";
        console.warn(`[${now()}] v3 signature rejected, retrying with v2 compatibility payload`);
        this.ws?.close();
      }
      // Log any failed response we don't specifically handle
      else if ((msg as any)?.type === "res" && (msg as any)?.ok === false) {
        console.error(`[${now()}] failed response id=${(msg as any)?.id}: ${JSON.stringify((msg as any)?.error ?? msg)}`);
      }
      // logs.tail polling response (WS-only fallback for tool start/end visibility)
      else if ((msg as any)?.type === "res" && String((msg as any)?.id ?? "").startsWith("logs-tail-")) {
        this.logTailInFlight = false;
        if ((msg as any)?.ok !== true) {
          return;
        }
        const payload = (msg as any)?.payload ?? {};
        if (typeof payload.cursor === "number") {
          this.logTailCursor = payload.cursor;
        }
        const lines = Array.isArray(payload.lines) ? payload.lines : [];
        // First read can include huge backlog. Use it only to initialize cursor.
        if (!this.logTailReady) {
          this.logTailReady = true;
          return;
        }
        for (const line of lines) {
          this.handleLogTailLine(line);
        }
      }
      // Pairing resolved — mark paired and reconnect to pick up scopes
      else if (isPairResolved(msg)) {
        const approved = (msg as any)?.payload?.approved ?? (msg as any)?.payload?.status === "approved";
        if (approved) {
          markDevicePaired(this.device);
          this.connectRole = "operator";
          console.log(`\n[${now()}] pairing approved — reconnecting with device credentials`);
          this.ws?.close();
        } else {
          console.log(`\n[${now()}] pairing rejected`);
        }
      }
    } catch (error) {
      // Fallback for non-JSON messages
      if (this.options.json) {
        console.log(`[${now()}] message:\n${formatted}`);
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[${now()}] parse error: ${msg}`);
      }
    }
  }

  private startLogTailPolling(): void {
    if (this.logTailPollingTimer) return;
    this.pollLogsTail();
    this.logTailPollingTimer = setInterval(() => this.pollLogsTail(), 1200);
  }

  private stopLogTailPolling(): void {
    if (this.logTailPollingTimer) {
      clearInterval(this.logTailPollingTimer);
      this.logTailPollingTimer = undefined;
    }
    this.logTailInFlight = false;
  }

  private pollLogsTail(): void {
    if (!this.ws || this.logTailInFlight) return;
    this.logTailInFlight = true;
    const requestId = `logs-tail-${Date.now()}`;
    const params = this.logTailCursor !== undefined ? { cursor: this.logTailCursor } : {};
    sendRequest(this.ws, {
      type: "req",
      id: requestId,
      method: "logs.tail",
      params,
    });
  }

  private emitDerivedStatus(status: AgentStatus, payload: any): void {
    const statusWithFallbackAgent =
      status.agentId || !this.defaultAgentId
        ? status
        : { ...status, agentId: this.defaultAgentId };
    if (this.emitter) {
      try {
        this.emitter.emit("status", { status: statusWithFallbackAgent, payload });
      } catch {}
    }
    if (statusWithFallbackAgent.status !== AGENT_STATUS.THINKING) {
      const line = statusWithFallbackAgent.details
        ? `${statusWithFallbackAgent.status}: ${statusWithFallbackAgent.details}`
        : statusWithFallbackAgent.status;
      console.log(`[${statusWithFallbackAgent.timestamp}] ${line}`);
    }
  }

  private handleLogTailLine(rawLine: unknown): void {
    if (typeof rawLine !== "string" || rawLine.length === 0) return;

    let ts: number | undefined;
    let text = rawLine;
    let parsedLog: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(rawLine);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedLog = parsed as Record<string, unknown>;
        const logParts = Object.keys(parsed)
          .filter((key) => /^\d+$/.test(key))
          .sort((a, b) => Number(a) - Number(b))
          .map((key) => String((parsed as any)[key] ?? ""));
        if (logParts.length > 0) {
          text = logParts.join(" ");
        }
        const iso = (parsed as any)?.time ?? (parsed as any)?._meta?.date;
        if (typeof iso === "string") {
          const parsedTs = Date.parse(iso);
          if (Number.isFinite(parsedTs)) ts = parsedTs;
        }
      }
    } catch {}

    const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    const eventTs = ts ?? Date.now();

    const subsystemFromLine = (() => {
      const rawSubsystem = parsedLog?.["0"];
      if (typeof rawSubsystem === "string") {
        try {
          const parsedSubsystem = JSON.parse(rawSubsystem);
          const value = parsedSubsystem?.subsystem;
          if (typeof value === "string" && value.trim()) return value.trim();
        } catch {}
      }
      const match = clean.match(/"subsystem"\s*:\s*"([^"]+)"/i);
      if (match?.[1]) return match[1];
      return "";
    })();

    if (subsystemFromLine === "agents/tool-images") {
      const detailRaw = parsedLog?.["1"];
      const detail =
        detailRaw && typeof detailRaw === "object"
          ? (detailRaw as Record<string, unknown>)
          : null;
      const label = String(detail?.label ?? "").toLowerCase();
      const tool = label.includes(":") ? label.split(":")[0] : (label || "browser");
      const fileName = String(detail?.fileName ?? "").trim();
      const resizedInfo = typeof parsedLog?.["2"] === "string" ? String(parsedLog["2"]) : "";
      const resizedPathMatch = resizedInfo.match(/fit limits:\s*([^\s]+\.((png|jpe?g|gif|webp|bmp|svg|avif)))/i);
      const resizedPath = resizedPathMatch?.[1] ?? "";
      const candidates = [
        ...this.buildGatewayMediaUrls(fileName),
        ...this.buildGatewayMediaUrls(resizedPath),
      ];
      this.queueToolImages(tool || "browser", candidates, eventTs);
      return;
    }

    // Capture raw incoming Telegram user messages and temporarily queue them.
    // We'll attach text to the next runId once we see `embedded run start`.
    const telegramUpdateMatch = clean.match(/telegram update:\s*(\{[\s\S]*\})/i);
    if (telegramUpdateMatch) {
      try {
        const update = JSON.parse(telegramUpdateMatch[1]);
        const textCandidate =
          update?.message?.text ??
          update?.message?.caption ??
          update?.edited_message?.text ??
          update?.edited_message?.caption;
        if (typeof textCandidate === "string" && textCandidate.trim()) {
          this.enqueueUserInput(textCandidate, eventTs, "telegram");
        }
      } catch {}
    }

    // Bind queued user input to runId as soon as the embedded run starts.
    const runStartMatch = clean.match(/embedded run start:\s*runId=([0-9a-f-]+)/i);
    if (runStartMatch && this.emitter) {
      const runId = runStartMatch[1];
      const channelMatch = clean.match(/\bmessageChannel=([a-z0-9_-]+)/i);
      const channel = channelMatch?.[1]?.toLowerCase();
      const textInput = this.consumeUserInput(channel, eventTs);
      if (textInput) {
        this.emitter.emit("task", {
          runId,
          text: textInput,
          agentId: this.defaultAgentId,
          timestamp: new Date(eventTs).toISOString(),
          source: `log-tail${channel ? `:${channel}` : ""}`,
        });
      }
    }

    const startMatch = clean.match(/embedded run tool start:\s*runId=([0-9a-f-]+)\s+tool=([^\s]+)(?:\s+toolCallId=([^\s]+))?/i);
    if (startMatch) {
      const runId = startMatch[1];
      const tool = startMatch[2];
      const toolCallId = startMatch[3];
      const details = `**${tool}** started`;
      this.emitDerivedStatus(
        {
          status: AGENT_STATUS.CALL_TOOL,
          timestamp: new Date(eventTs).toISOString(),
          details,
          runId,
          agentId: this.defaultAgentId,
        },
        { type: "event", event: "tool.log", payload: { runId, tool, phase: "start", toolCallId } },
      );
      return;
    }

    const endMatch = clean.match(/embedded run tool end:\s*runId=([0-9a-f-]+)\s+tool=([^\s]+)(?:\s+toolCallId=([^\s]+))?/i);
    if (endMatch) {
      const runId = endMatch[1];
      const tool = endMatch[2];
      const toolCallId = endMatch[3];
      const details = `**${tool}** finished`;
      const images = this.consumeToolImages(tool, eventTs);
      this.emitDerivedStatus(
        {
          status: AGENT_STATUS.CALL_TOOL,
          timestamp: new Date(eventTs).toISOString(),
          details,
          runId,
          agentId: this.defaultAgentId,
          images,
        },
        { type: "event", event: "tool.log", payload: { runId, tool, phase: "end", toolCallId, images } },
      );
    }
  }
}
