/**
 * Message formatting and bot activity tracking.
 * Uses Zod-validated types for full type safety.
 */

import type { GatewayPayload, BotActivitySummary } from "./types.js";
import {
  EventMessageSchema,
  AgentEventPayloadSchema,
  ChatEventPayloadSchema,
  SkillInvokePayloadSchema,
  PresencePayloadSchema,
} from "./schemas.js";

export function formatJson(text: string): string {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

export function now(): string {
  return new Date().toISOString();
}

export function formatBotActivity(msg: GatewayPayload): BotActivitySummary | null {
  if (msg.type !== "event") return null;

  const { event, payload } = msg;
  const p = payload as any; // payload is Record<string, unknown>, cast for flexible access
  const ts = p?.ts ? new Date(p.ts).toISOString() : "?";

  switch (event) {
    case "agent": {
      const agentMsg = p?.message || p?.text || JSON.stringify(p);
      const agentId = p?.agentId || p?.agent || "?";
      return {
        type: "agent",
        timestamp: ts,
        details: `Agent ${agentId}: ${agentMsg}`,
      };
    }

    case "chat": {
      const role = (p?.role || "?") as string;
      const content = p?.content || p?.message || JSON.stringify(p);
      const chatId = p?.sessionKey || p?.channel || "?";
      return {
        type: "chat",
        timestamp: ts,
        details: `[${chatId}] ${role.toUpperCase()}: ${content}`,
      };
    }

    case "node.invoke.request": {
      const skill = p?.method || p?.skill || "?";
      const input = JSON.stringify(p?.params || p?.data || {});
      return {
        type: "skill",
        timestamp: ts,
        details: `Calling ${skill} with ${input}`,
      };
    }

    case "node.invoke.result": {
      const result = JSON.stringify(p?.result || p?.output || {});
      return {
        type: "skill",
        timestamp: ts,
        details: `Skill result: ${result}`,
      };
    }

    case "presence": {
      const presenceText = (p?.text || `${(p?.mode || "?") as string} mode`) as string;
      return {
        type: "presence",
        timestamp: ts,
        details: presenceText,
      };
    }

    case "heartbeat": {
      return {
        type: "heartbeat",
        timestamp: ts,
        details: (p?.prompt || "running") as string,
      };
    }

    case "cron": {
      const cronId = p?.id || "?";
      const status = p?.status || "?";
      return {
        type: "cron",
        timestamp: ts,
        details: `Cron ${cronId}: ${status}`,
      };
    }

    default:
      return null;
  }
}

export const AGENT_STATUS = {
  THINKING:      "agent_thinking",
  START_WORKING: "agent_start_working",
  SEND_RESPONSE: "agent_send_response",
  CALL_TOOL:     "agent_call_tool",
  IDLE:          "agent_idle",
  UNKNOWN:       "agent_unknown",
} as const;

type AgentStatusKind = typeof AGENT_STATUS[keyof typeof AGENT_STATUS];

export type AgentStatus = {
  status: AgentStatusKind;
  timestamp: string;
  details?: string;
  runId?: string;
  agentId?: string; // included when available to help UI bind to a specific agent
  images?: string[];
};

function jsonBlock(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) {
    return undefined;
  }
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

// Extract agentId from sessionKey format "agent:<agentId>:<session>"
function agentFromKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const parts = sessionKey.split(":");
  return parts[0] === "agent" && parts[1] ? parts[1] : undefined;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)(?:$|[?#])/i;
const IMAGE_QUERY_HINT_RE = /[?&](?:format|fm|ext|mime|content_type)=?(?:image|png|jpe?g|gif|webp|bmp|svg|avif)/i;
const IMAGE_MARKDOWN_RE = /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const URL_RE = /\bhttps?:\/\/[^\s<>()"'`]+/gi;
const WINDOWS_IMAGE_PATH_RE = /^[a-z]:\\.+\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const POSIX_IMAGE_PATH_RE = /^\/.+\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

function normalizeImageCandidate(value: string, force = false): string | undefined {
  const trimmed = value.trim().replace(/^["'(<\[]+|[)"'>\]]+$/g, "");
  if (!trimmed) return undefined;
  if (/^data:image\//i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    if (force || IMAGE_EXT_RE.test(trimmed) || IMAGE_QUERY_HINT_RE.test(trimmed)) return trimmed;
    return undefined;
  }
  if (force && /^file:\/\//i.test(trimmed)) return trimmed;
  if (WINDOWS_IMAGE_PATH_RE.test(trimmed) || POSIX_IMAGE_PATH_RE.test(trimmed)) return trimmed;
  return undefined;
}

function pushImageRef(out: Set<string>, value: unknown, force = false): void {
  if (typeof value !== "string") return;
  const normalized = normalizeImageCandidate(value, force);
  if (!normalized) return;
  if (out.size < 12) out.add(normalized);
}

function extractImageRefsFromText(text: string, out: Set<string>): void {
  for (const match of text.matchAll(IMAGE_MARKDOWN_RE)) {
    const candidate = match?.[1];
    if (candidate) pushImageRef(out, candidate, true);
  }
  for (const match of text.matchAll(URL_RE)) {
    const candidate = match?.[0];
    if (candidate) pushImageRef(out, candidate, false);
  }
}

function extractImageRefsDeep(value: unknown, out: Set<string>, depth = 0): void {
  if (value === null || value === undefined || depth > 6 || out.size >= 12) return;
  if (typeof value === "string") {
    extractImageRefsFromText(value, out);
    pushImageRef(out, value, false);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      extractImageRefsDeep(item, out, depth + 1);
      if (out.size >= 12) break;
    }
    return;
  }
  if (typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const typed = String(record.type ?? "").toLowerCase();
  const forceByType = typed.includes("image") || typed.includes("photo") || typed.includes("screenshot");

  const imageKeys = [
    "image",
    "imageUrl",
    "image_url",
    "screenshot",
    "screenshotUrl",
    "screenshot_url",
    "photo",
    "thumbnail",
    "thumb",
    "preview",
  ] as const;

  const genericKeys = [
    "url",
    "uri",
    "src",
    "href",
    "path",
    "file",
    "filePath",
    "file_path",
  ] as const;

  for (const key of imageKeys) {
    pushImageRef(out, record[key], true);
  }
  for (const key of genericKeys) {
    pushImageRef(out, record[key], forceByType);
  }

  const source = record.source;
  if (source && typeof source === "object") {
    const src = source as Record<string, unknown>;
    const data = typeof src.data === "string" ? src.data.trim() : "";
    const mediaType = String(src.mediaType ?? src.mimeType ?? src.type ?? "").toLowerCase();
    if (data && mediaType.startsWith("image/")) {
      if (/^data:image\//i.test(data)) {
        pushImageRef(out, data, true);
      } else {
        pushImageRef(out, `data:${mediaType};base64,${data}`, true);
      }
    }
  }

  for (const nested of Object.values(record)) {
    extractImageRefsDeep(nested, out, depth + 1);
    if (out.size >= 12) break;
  }
}

function extractImageRefs(value: unknown): string[] {
  const out = new Set<string>();
  extractImageRefsDeep(value, out, 0);
  return Array.from(out).slice(0, 8);
}

export function formatAgentStatus(msg: GatewayPayload): AgentStatus | null {
  const ev = EventMessageSchema.safeParse(msg);
  if (!ev.success) return null;

  const { event, payload: rawPayload } = ev.data;
  const raw = rawPayload ?? {};

  // node.invoke.request -> agent calling a tool/skill
  if (event === "node.invoke.request" || event === "node.invoke.requested") {
    const parsed = SkillInvokePayloadSchema.safeParse(raw);
    const p = parsed.success ? parsed.data : (raw as any);
    const ts = p.ts ? new Date(p.ts).toISOString() : now();
    const agentId = agentFromKey(p.sessionKey);
    const runId = p.runId ?? p.sessionKey;
    const skill = p.method ?? p.skill ?? p.name ?? "unknown";
    const params = p.params ?? p.data ?? p.input;
    const paramStr = jsonBlock(params);
    const images = extractImageRefs(raw);
    return {
      status: AGENT_STATUS.CALL_TOOL,
      timestamp: ts,
      details: `**${skill}**${paramStr}`,
      runId,
      agentId,
      images: images.length ? images : undefined,
    };
  }

  // node.invoke.result -> tool returned
  if (event === "node.invoke.result" || event === "node.invoke.resulted") {
    const parsed = SkillInvokePayloadSchema.safeParse(raw);
    const p = parsed.success ? parsed.data : (raw as any);
    const ts = p.ts ? new Date(p.ts).toISOString() : now();
    const agentId = agentFromKey(p.sessionKey);
    const runId = p.runId ?? p.sessionKey;
    const result = p.result ?? p.output ?? p.data;
    const resultStr = jsonBlock(result);
    const images = extractImageRefs(raw);
    return {
      status: AGENT_STATUS.SEND_RESPONSE,
      timestamp: ts,
      details: resultStr,
      runId,
      agentId,
      images: images.length ? images : undefined,
    };
  }

  // presence updates signal agent start/stop or mode changes
  if (event === "presence") {
    const p = PresencePayloadSchema.parse(raw);
    const ts = p.ts ? new Date(p.ts).toISOString() : now();
    const mode = (p.mode ?? "").toLowerCase();
    const text = (p.text ?? "").toLowerCase();
    if (mode.includes("work") || text.includes("working")) {
      return { status: AGENT_STATUS.START_WORKING, timestamp: ts, details: p.text };
    }
    if (mode.includes("idle") || text.includes("idle")) {
      return { status: AGENT_STATUS.IDLE, timestamp: ts, details: p.text };
    }
    return null;
  }

  // chat events — only use the final state; deltas are covered by agent assistant stream
  if (event === "chat") {
    const p = ChatEventPayloadSchema.parse(raw);
    if (p.state !== "final") return null;
    const ts = p.ts ? new Date(p.ts).toISOString() : now();
    const agentId = agentFromKey(p.sessionKey);
    const runId = p.runId ?? p.sessionKey;
    const role = (p.message?.role ?? p.role ?? "").toLowerCase();
    if (role === "assistant" || role === "agent") {
      const content = p.message?.content ?? p.content;
      const images = extractImageRefs(content ?? raw);
      if (Array.isArray(content)) {
        for (const block of content as Array<any>) {
          const type = String(block?.type ?? "").toLowerCase();
          if (type === "toolcall" || type === "tool_use") {
            const tool = String(block?.name ?? block?.toolName ?? block?.tool ?? "tool");
            const args = block?.arguments ?? block?.input ?? block?.params;
            const details = args !== undefined
              ? `**${tool}**\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``
              : `**${tool}**`;
            return {
              status: AGENT_STATUS.CALL_TOOL,
              timestamp: ts,
              details,
              runId,
              agentId,
              images: images.length ? images : undefined,
            };
          }
        }
      }
      const text = Array.isArray(content)
        ? content.map((c: any) => c?.text ?? "").join("")
        : String(content ?? "");
      const toolLineMatch = text.match(/^(?:🛠️\s*)?([A-Za-z][A-Za-z0-9_. -]{0,50})\s*:\s*([\s\S]+)$/m);
      if (toolLineMatch) {
        const tool = toolLineMatch[1].trim();
        const rawArgs = toolLineMatch[2].trim();
        const [commandPart, ...resultParts] = rawArgs.split(/\n{2,}/);
        const command = commandPart?.trim() ?? "";
        const result = resultParts.join("\n\n").trim();
        const details = command.length > 0
          ? `**${tool}**\n\`\`\`txt\n${command}\n\`\`\`${result ? `\nResult:\n\`\`\`txt\n${result}\n\`\`\`` : ""}`
          : `**${tool}**`;
        return {
          status: AGENT_STATUS.CALL_TOOL,
          timestamp: ts,
          details,
          runId,
          agentId,
          images: images.length ? images : undefined,
        };
      }
      return {
        status: AGENT_STATUS.SEND_RESPONSE,
        timestamp: ts,
        details: text || undefined,
        runId,
        agentId,
        images: images.length ? images : undefined,
      };
    }
    return null;
  }

  // generic agent event
  if (event === "agent") {
    const p = AgentEventPayloadSchema.parse(raw);
    const ts = p.ts ? new Date(p.ts).toISOString() : now();
    const agentId = p.agentId ?? p.agent ?? agentFromKey(p.sessionKey);
    const runId = p.runId ?? p.sessionKey;
    const images = extractImageRefs(raw);

    if (p.stream === "lifecycle" && p.data?.phase) {
      const phase = String(p.data.phase).toLowerCase();
      if (phase === "start") {
        return { status: AGENT_STATUS.START_WORKING, timestamp: ts, runId, agentId, images: images.length ? images : undefined };
      }
      if (phase === "end") {
        return { status: AGENT_STATUS.SEND_RESPONSE, timestamp: ts, runId, agentId, images: images.length ? images : undefined };
      }
    }

    if (p.stream === "assistant" && p.data) {
      const delta = String(p.data.delta ?? "").trim();
      if (delta) {
        return {
          status: AGENT_STATUS.THINKING,
          timestamp: ts,
          details: delta,
          runId,
          agentId,
          images: images.length ? images : undefined,
        };
      }
    }

    const txt = (p.message ?? p.text ?? "").toLowerCase();
    if (txt.includes("start") || txt.includes("started") || txt.includes("working")) {
      return {
        status: AGENT_STATUS.START_WORKING,
        timestamp: ts,
        details: p.message ?? p.text,
        agentId,
        images: images.length ? images : undefined,
      };
    }
    if (txt.includes("thinking") || txt.includes("processing") || txt.includes("...")) {
      return {
        status: AGENT_STATUS.THINKING,
        timestamp: ts,
        details: p.message ?? p.text,
        agentId,
        images: images.length ? images : undefined,
      };
    }
    if (txt.includes("call") || txt.includes("invoke") || txt.includes("skill")) {
      return {
        status: AGENT_STATUS.CALL_TOOL,
        timestamp: ts,
        details: p.message ?? p.text,
        agentId,
        images: images.length ? images : undefined,
      };
    }
    if (txt.length > 0) {
      return {
        status: AGENT_STATUS.SEND_RESPONSE,
        timestamp: ts,
        details: p.message ?? p.text,
        agentId,
        images: images.length ? images : undefined,
      };
    }
  }

  return null;
}

export function renderActivityLine(activity: BotActivitySummary): string {
  const icons: Record<BotActivitySummary["type"], string> = {
    agent: "🤖",
    chat: "💬",
    skill: "⚙️",
    presence: "📍",
    heartbeat: "💓",
    cron: "⏰",
    unknown: "❓",
  };

  return `${icons[activity.type] || "•"} [${activity.timestamp}] ${activity.details}`;
}
