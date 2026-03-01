/**
 * CLI entry point for the OpenClaw Gateway listener.
 * Uses Zod for validating command-line options.
 */

import type { ListenerOptions } from "./types.js";
import { ListenerOptionsSchema } from "./schemas.js";
import { GatewayListener } from "./listener.js";
import { extractToken } from "./protocol.js";
import { AGENT_STATUS } from "./formatter.js";
import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import { EventEmitter } from "events";
import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";

function parseArgs(argv: string[]): ListenerOptions {
  const url =
    argv.find((a) => !a.startsWith("-")) ||
    process.env.OPENCLAW_WS_ENDPOINT ||
    "ws://10.211.55.3:18789/?token=xyz";
  const json = argv.includes("--json");
  const reconnect = !argv.includes("--no-reconnect");
  const serve = argv.includes("--serve");

  // Validate with Zod to ensure URL is properly formatted and flags are boolean
  const options = ListenerOptionsSchema.parse({ url, json, reconnect, serve });
  return options;
}

function printHelp(): void {
  console.log(`
OpenClaw Gateway WebSocket Listener

Usage:
  node listen.ts [URL] [OPTIONS]

Arguments:
  URL                      Gateway WebSocket endpoint
                          (default: OPENCLAW_WS_ENDPOINT env var or ws://10.211.55.3:18789/?token=xyz)

Options:
  --json                   Pretty-print JSON messages (show all raw data)
  --no-reconnect          Don't reconnect on connection loss
  --serve                  Start built-in HTTP/Socket.IO dashboard on port 3000
  --help                  Show this help message

Environment:
  OPENCLAW_WS_ENDPOINT    Gateway WebSocket URL
  OPENCLAW_API_ENDPOINT   Optional HTTP API URL to fetch list of agents

Examples:
  node listen.ts
  node listen.ts ws://localhost:18789/?token=secret
  node listen.ts --json
  node listen.ts --no-reconnect
  node listen.ts --serve    # run with web dashboard
`);
}


async function startServer(options: ListenerOptions) {
  const PORT = Number(process.env.PORT || 3000);
  const app = express();
  const server = http.createServer(app);
  const io = new IOServer(server, {
    cors: { origin: true },
  });
  app.use(express.json());

  // optional external API for agent list
  const apiEndpoint = process.env.OPENCLAW_API_ENDPOINT || "";
  const token = extractToken(options.url) || "";

  // Store latest info about agents
  interface AgentRecord {
    agentId: string;
    displayName: string;
    lastStatus: string;
    details?: string;
    timestamp: string;
    avatarUrl: string;
  }
  const agents = new Map<string, AgentRecord>();
  interface ToolRecord {
    name: string;
    description?: string;
    provider?: string;
    kind?: string;
    raw?: unknown;
  }
  interface TaskComment {
    id: string;
    timestamp: string;
    status: string;
    details?: string;
    agentId?: string;
    displayName?: string;
    images?: string[];
  }
  interface TaskRecord {
    id: string;
    runId: string;
    sessionKey?: string;
    title: string;
    agentId?: string;
    displayName?: string;
    createdAt: string;
    updatedAt: string;
    column: "todo" | "doing" | "done";
    comments: TaskComment[];
  }
  let toolsCatalog: ToolRecord[] = [];
  let toolsUpdatedAt: string | null = null;
  const agentAliasesPath = resolve(process.cwd(), "agent-aliases.json");
  let agentAliases: Record<string, string> = {};
  const tasks = new Map<string, TaskRecord>();

  const loadAgentAliases = async (): Promise<void> => {
    try {
      const raw = await readFile(agentAliasesPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        agentAliases = {};
        return;
      }
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const agentId = String(key).trim();
        const name = typeof value === "string" ? value.trim() : "";
        if (agentId && name) {
          next[agentId] = name;
        }
      }
      agentAliases = next;
    } catch {
      agentAliases = {};
    }
  };

  const saveAgentAliases = async (): Promise<void> => {
    const json = JSON.stringify(agentAliases, null, 2);
    await writeFile(agentAliasesPath, `${json}\n`, "utf8");
  };

  const displayNameFor = (agentId: string): string =>
    agentAliases[agentId]?.trim() || agentId;

  const withDisplayName = (payload: any) => {
    const status = payload?.status;
    const agentId =
      status?.agentId ||
      payload?.payload?.payload?.agentId ||
      payload?.payload?.payload?.agent;
    if (!agentId) return payload;
    return {
      ...payload,
      displayName: displayNameFor(String(agentId)),
    };
  };

  const normalizeTimestamp = (value: unknown): string => {
    if (typeof value === "string") {
      const ts = Date.parse(value);
      if (Number.isFinite(ts)) return new Date(ts).toISOString();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return new Date(value).toISOString();
    }
    return new Date().toISOString();
  };

  const normalizeImages = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const dedup = Array.from(
      new Set(
        value
          .map((entry) => String(entry ?? "").trim())
          .filter((entry) => entry.length > 0),
      ),
    ).slice(0, 8);
    return dedup.length > 0 ? dedup : undefined;
  };

  const taskColumnFromStatus = (status: string): "todo" | "doing" | "done" => {
    if (status === AGENT_STATUS.SEND_RESPONSE) return "done";
    if (
      status === AGENT_STATUS.THINKING ||
      status === AGENT_STATUS.START_WORKING ||
      status === AGENT_STATUS.CALL_TOOL
    ) {
      return "doing";
    }
    return "todo";
  };

  const taskSort = (items: TaskRecord[]): TaskRecord[] =>
    items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const listTasks = (): TaskRecord[] => taskSort(Array.from(tasks.values()));

  const emitTaskUpsert = (task: TaskRecord): void => {
    io.emit("taskUpsert", task);
  };

  await loadAgentAliases();

  const avatarFor = (id: string) =>
    `https://api.dicebear.com/5.x/identicon/svg?seed=${encodeURIComponent(id)}`;

  const normalizeToolCatalog = (payload: any): ToolRecord[] => {
    const groupedTools = Array.isArray(payload?.groups)
      ? payload.groups.flatMap((group: any) => {
          const tools = Array.isArray(group?.tools) ? group.tools : [];
          return tools.map((tool: any) => ({
            ...(tool && typeof tool === "object" ? tool : {}),
            __groupId: group?.id,
            __groupLabel: group?.label,
            __groupSource: group?.source,
          }));
        })
      : [];
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.tools)
      ? payload.tools
      : Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload?.catalog)
      ? payload.catalog
      : Array.isArray(payload?.data)
      ? payload.data
      : groupedTools.length > 0
      ? groupedTools
      : [];
    const dedup = new Map<string, ToolRecord>();
    for (const item of list) {
      if (typeof item === "string") {
        const key = item.trim();
        if (key.length > 0 && !dedup.has(key)) {
          dedup.set(key, { name: key, raw: item });
        }
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const name =
        String(
          record.name ??
          record.id ??
          record.tool ??
          record.method ??
          record.key ??
          record.label ??
          "",
        ).trim();
      if (!name) continue;
      if (dedup.has(name)) continue;
      const description = String(record.description ?? record.desc ?? record.summary ?? "").trim() || undefined;
      const provider = String(
        record.provider ??
        record.source ??
        record.owner ??
        record.namespace ??
        record.__groupSource ??
        "",
      ).trim() || undefined;
      const kind = String(
        record.type ??
        record.kind ??
        record.category ??
        record.__groupId ??
        record.__groupLabel ??
        "",
      ).trim() || undefined;
      dedup.set(name, { name, description, provider, kind, raw: item });
    }
    return Array.from(dedup.values()).sort((a, b) => a.name.localeCompare(b.name));
  };

  app.get("/agents", (req, res) => {
    res.json(Array.from(agents.values()));
  });
  app.get("/tasks", (req, res) => {
    res.json({ items: listTasks() });
  });
  app.get("/agent-aliases", (req, res) => {
    res.json({ items: agentAliases });
  });
  app.post("/agent-aliases", async (req, res) => {
    const agentId = String(req.body?.agentId ?? "").trim();
    const name = String(req.body?.name ?? "").trim();
    if (!agentId) {
      res.status(400).json({ ok: false, error: "agentId is required" });
      return;
    }
    if (name) {
      agentAliases[agentId] = name;
    } else {
      delete agentAliases[agentId];
    }
    try {
      await saveAgentAliases();
      const displayName = displayNameFor(agentId);
      const existing = agents.get(agentId);
      if (existing) {
        existing.displayName = displayName;
        agents.set(agentId, existing);
      }
      for (const task of tasks.values()) {
        let changed = false;
        if (task.agentId === agentId) {
          task.displayName = displayName;
          changed = true;
        }
        for (const comment of task.comments) {
          if (comment.agentId === agentId) {
            comment.displayName = displayName;
            changed = true;
          }
        }
        if (changed) {
          emitTaskUpsert(task);
        }
      }
      io.emit("agentAliasUpdated", { agentId, displayName });
      res.json({ ok: true, agentId, displayName });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ ok: false, error: message });
    }
  });
  app.get("/tools", (req, res) => {
    res.json({ items: toolsCatalog, updatedAt: toolsUpdatedAt });
  });

  app.use(express.static("public"));

  const emitter = new EventEmitter();

  emitter.on("task", (taskEvent: any) => {
    const runId = String(taskEvent?.runId ?? "").trim();
    const sessionKey = String(taskEvent?.sessionKey ?? "").trim();
    const taskId = runId || sessionKey || `task-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const text = String(taskEvent?.text ?? "").trim();
    const agentId = String(taskEvent?.agentId ?? "").trim() || undefined;
    const displayName = agentId ? displayNameFor(agentId) : undefined;
    const ts = normalizeTimestamp(taskEvent?.timestamp);
    const taskImages = normalizeImages(taskEvent?.images);

    let task = tasks.get(taskId);
    if (!task) {
      task = {
        id: taskId,
        runId: runId || taskId,
        sessionKey: sessionKey || undefined,
        title: text || `Task ${taskId.slice(0, 8)}`,
        agentId,
        displayName,
        createdAt: ts,
        updatedAt: ts,
        column: "todo",
        comments: [],
      };
      tasks.set(taskId, task);
    } else {
      task.updatedAt = ts;
      if (
        text &&
        (
          !task.title ||
          task.title.startsWith("Run ") ||
          task.title.startsWith("Task ")
        )
      ) {
        task.title = text;
      }
      if (!task.agentId && agentId) {
        task.agentId = agentId;
        task.displayName = displayName;
      }
    }

    const last = task.comments[task.comments.length - 1];
    const shouldAppend =
      !last ||
      last.status !== "user_request" ||
      String(last.details ?? "") !== text ||
      JSON.stringify(last.images ?? []) !== JSON.stringify(taskImages ?? []);

    if (shouldAppend) {
      task.comments.push({
        id: `${task.id}-user-${task.comments.length + 1}`,
        timestamp: ts,
        status: "user_request",
        details: text,
        agentId,
        displayName,
        images: taskImages,
      });
      if (task.comments.length > 250) {
        task.comments = task.comments.slice(-250);
      }
    }

    emitTaskUpsert(task);
  });

  emitter.on("status", (obj: any) => {
    const status: any = obj.status;
    const payload: any = obj.payload;
    const agentIdRaw = status.agentId || (payload?.payload?.agentId || payload?.payload?.agent);
    const agentId = agentIdRaw ? String(agentIdRaw) : "";
    const displayName = agentId ? displayNameFor(agentId) : undefined;
    const ts = normalizeTimestamp(status?.timestamp);
    const statusImages = normalizeImages(status?.images);

    if (agentId) {
      const rec: AgentRecord = {
        agentId,
        displayName: displayNameFor(agentId),
        lastStatus: status.status,
        details: status.details,
        timestamp: ts,
        avatarUrl: avatarFor(agentId),
      };
      agents.set(agentId, rec);
    }

    const runId = String(status?.runId ?? "").trim();
    if (!runId) return;

    let task = tasks.get(runId);
    if (!task) {
      task = {
        id: runId,
        runId,
        title: `Run ${runId.slice(0, 8)}`,
        agentId: agentId || undefined,
        displayName,
        createdAt: ts,
        updatedAt: ts,
        column: taskColumnFromStatus(String(status?.status ?? "")),
        comments: [],
      };
      tasks.set(runId, task);
    }

    if (agentId && !task.agentId) {
      task.agentId = agentId;
      task.displayName = displayName;
    }

    const statusCode = String(status?.status ?? "");
    const statusDetails = typeof status?.details === "string" ? status.details : "";
    const lastComment = task.comments[task.comments.length - 1];

    if (statusCode === AGENT_STATUS.THINKING && lastComment?.status === AGENT_STATUS.THINKING) {
      const merged = `${String(lastComment.details ?? "")}${statusDetails}`.trim();
      lastComment.details = merged;
      lastComment.timestamp = ts;
      lastComment.displayName = displayName ?? lastComment.displayName;
      lastComment.agentId = agentId || lastComment.agentId;
      if (statusImages?.length) {
        const mergedImages = Array.from(new Set([...(lastComment.images ?? []), ...statusImages])).slice(0, 8);
        lastComment.images = mergedImages;
      }
    } else {
      task.comments.push({
        id: `${task.id}-${task.comments.length + 1}`,
        timestamp: ts,
        status: statusCode,
        details: statusDetails || undefined,
        agentId: agentId || undefined,
        displayName,
        images: statusImages,
      });
      if (task.comments.length > 250) {
        task.comments = task.comments.slice(-250);
      }
    }

    task.updatedAt = ts;
    const nextColumn = taskColumnFromStatus(statusCode);
    if (nextColumn === "done") {
      task.column = "done";
    } else if (task.column !== "done" && nextColumn === "doing") {
      task.column = "doing";
    } else if (task.column === "todo") {
      task.column = nextColumn;
    }

    emitTaskUpsert(task);
  });
  emitter.on("tools", (payload: any) => {
    toolsCatalog = normalizeToolCatalog(payload);
    toolsUpdatedAt = new Date().toISOString();
    io.emit("toolsCatalog", { items: toolsCatalog, updatedAt: toolsUpdatedAt });
  });

  io.on("connection", (socket) => {
    console.log("client connected", socket.id);

    const onStatus = (s: any) => {
      socket.emit("agentStatus", withDisplayName(s));
    };
    emitter.on("status", onStatus);
    socket.emit("agentAliases", { items: agentAliases });
    socket.emit("tasksSnapshot", { items: listTasks() });
    socket.emit("toolsCatalog", { items: toolsCatalog, updatedAt: toolsUpdatedAt });

    socket.on("disconnect", () => {
      emitter.off("status", onStatus);
    });
  });

  // refresh agent list from API if configured
  async function refreshAgentsFromApi() {
    if (!apiEndpoint) return;
    try {
      const res = await fetch(apiEndpoint, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        console.error("failed to fetch agents from API", res.status, res.statusText);
        return;
      }
      const list = await res.json();
      if (Array.isArray(list)) {
        list.forEach((a: any) => {
          if (a.agentId) {
            agents.set(a.agentId, {
              agentId: a.agentId,
              displayName: displayNameFor(a.agentId),
              lastStatus: a.lastStatus || "",
              details: a.details,
              timestamp: a.timestamp || new Date().toISOString(),
              avatarUrl: avatarFor(a.agentId),
            });
          }
        });
      }
    } catch (err) {
      console.error("error fetching agents from API", err);
    }
  }

  // initial fetch and periodic refresh every 30s
  refreshAgentsFromApi();
  const refreshTimer = setInterval(refreshAgentsFromApi, 30_000);

  // close HTTP server + Socket.IO before the listener calls process.exit()
  const onShutdown = () => {
    clearInterval(refreshTimer);
    io.close();
    (server as any).closeAllConnections?.();
    server.close();
  };
  process.once("SIGINT", onShutdown);
  process.once("SIGTERM", onShutdown);

  const listener = new GatewayListener(options, emitter);
  listener.start();

  server.listen(PORT, () => {
    console.log(`server listening http://localhost:${PORT}`);
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const options = parseArgs(args);

  console.log(`OpenClaw Gateway Listener Started`);
  console.log(`Endpoint: ${options.url}`);
  console.log(`Mode: ${options.json ? "JSON (raw messages)" : "Activity (bot activity only)"}`);
  console.log(`Auto-reconnect: ${options.reconnect}`);
  if (options.serve) console.log(`HTTP Dashboard: enabled`);
  console.log(`Press Ctrl+C to exit\n`);

  if (options.serve) {
    await startServer(options);
  } else {
    const listener = new GatewayListener(options);
    try {
      listener.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
