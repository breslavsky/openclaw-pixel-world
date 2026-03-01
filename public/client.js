"use strict";

const { createApp, ref, reactive, computed } = Vue;

const AgentStatus = Object.freeze({
  THINKING:      "agent_thinking",
  START_WORKING: "agent_start_working",
  SEND_RESPONSE: "agent_send_response",
  CALL_TOOL:     "agent_call_tool",
  IDLE:          "agent_idle",
});

const STATUS_MAP = {
  [AgentStatus.THINKING]:      { border: "border-violet-600", dot: "bg-violet-600 animate-pulse", text: "text-violet-400" },
  [AgentStatus.START_WORKING]: { border: "border-blue-600",   dot: "bg-blue-600 animate-pulse",   text: "text-blue-400"   },
  [AgentStatus.SEND_RESPONSE]: { border: "border-emerald-600",dot: "bg-emerald-500",              text: "text-emerald-400"},
  [AgentStatus.CALL_TOOL]:     { border: "border-amber-500",  dot: "bg-amber-500 animate-pulse",  text: "text-amber-400"  },
  [AgentStatus.IDLE]:          { border: "border-gray-800",   dot: "bg-gray-500",                 text: "text-gray-500"   },
};
const DEFAULT_STATUS =         { border: "border-gray-800",   dot: "bg-gray-700",                 text: "text-gray-400"   };

function statusMap(status) { return STATUS_MAP[status] || DEFAULT_STATUS; }

function extractToolName(details) {
  if (!details) return "";
  const text = String(details);
  const mdMatch = text.match(/\*\*([^*]+)\*\*/);
  if (mdMatch?.[1]) return mdMatch[1].trim();
  const plain = text.split("\n")[0]?.trim() || "";
  return plain.slice(0, 42);
}

function stripInternalDetails(details) {
  if (!details) return "";
  let text = String(details);
  text = text.replace(/^\s*runId=.*$/gim, "");
  text = text.replace(/^\s*toolCallId=.*$/gim, "");
  text = text.replace(/```txt\s*\n\s*```/gim, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function summarizeAction(status, details) {
  switch (status) {
    case AgentStatus.THINKING:
      return "Thinking…";
    case AgentStatus.START_WORKING:
      return "Working…";
    case AgentStatus.SEND_RESPONSE:
      return "Responded";
    case AgentStatus.CALL_TOOL: {
      const tool = extractToolName(details);
      return tool || "Tool";
    }
    case AgentStatus.IDLE:
      return "Idle";
    default:
      if (status === "default" || status === "known") return "Ready";
      return status ? String(status).replaceAll("_", " ") : "Ready";
  }
}

function statusLabel(status) {
  switch (status) {
    case AgentStatus.THINKING:
      return "Thinking";
    case AgentStatus.START_WORKING:
      return "Working";
    case AgentStatus.SEND_RESPONSE:
      return "Responded";
    case AgentStatus.CALL_TOOL:
      return "Tool Call";
    case AgentStatus.IDLE:
      return "Idle";
    case "default":
      return "Primary Agent";
    case "known":
      return "Agent Online";
    case "user_request":
      return "User Request";
    default:
      return status ? String(status).replaceAll("_", " ") : "Update";
  }
}

createApp({
  setup() {
    const connected      = ref(false);
    const isLoading      = ref(true);
    const agents         = reactive({});   // agentId → AgentState
    const feed           = reactive([]);   // max 150 entries
    const tools          = ref([]);        // available tools from tools.catalog
    const toolsUpdatedAt = ref("");
    const tasks          = ref([]);        // kanban tasks with comments
    const selectedAgent  = ref(null);
    const selectedEvent  = ref(null);
    const selectedTask   = ref(null);
    const showTools      = ref(false);
    const isEditingName  = ref(false);
    const editedName     = ref("");
    const nameSaving     = ref(false);
    const nameError      = ref("");
    const agentPositions = reactive({});   // agentId → {x, y} percent
    const bootState      = reactive({
      agents: false,
      tasks: false,
      tools: false,
      socket: false,
      minDelay: false,
      fallback: false,
    });

    function checkBootReady() {
      const snapshotsReady = bootState.agents && bootState.tasks && bootState.tools;
      const realtimeReady = bootState.socket || bootState.fallback;
      if (snapshotsReady && realtimeReady && bootState.minDelay) {
        isLoading.value = false;
      }
    }

    setTimeout(() => {
      bootState.minDelay = true;
      checkBootReady();
    }, 450);
    setTimeout(() => {
      bootState.fallback = true;
      checkBootReady();
    }, 5000);

    const agentList    = computed(() => Object.values(agents));
    const reversedFeed = computed(() => [...feed].reverse());
    const todoTasks    = computed(() => tasks.value.filter((task) => task.column === "todo"));
    const doingTasks   = computed(() => tasks.value.filter((task) => task.column === "doing"));
    const doneTasks    = computed(() => tasks.value.filter((task) => task.column === "done"));

    const borderCls = (s) => statusMap(s).border;
    const dotCls    = (s) => statusMap(s).dot;
    const textCls   = (s) => statusMap(s).text;

    // CSS animation class per status
    function spriteAnimCls(status) {
      return {
        "agent-thinking": status === AgentStatus.THINKING,
        "agent-working":  status === AgentStatus.START_WORKING,
        "agent-tool":     status === AgentStatus.CALL_TOOL,
      };
    }

    // ── Office zones (percent coordinates) ────────────────────────────────────
    const ZONES = {
      rest: { xMin: 6, xMax: 44, yMin: 12, yMax: 44 },
      library: { xMin: 56, xMax: 94, yMin: 12, yMax: 44 },
      laboratory: { xMin: 6, xMax: 44, yMin: 56, yMax: 90 },
      office: { xMin: 56, xMax: 94, yMin: 56, yMax: 90 },
    };

    function zoneForStatus(status) {
      switch (status) {
        case AgentStatus.THINKING:
          return "library";
        case AgentStatus.CALL_TOOL:
          return "laboratory";
        case AgentStatus.SEND_RESPONSE:
        case AgentStatus.START_WORKING:
          return "office";
        case AgentStatus.IDLE:
          return "rest";
        case "default":
        case "known":
        default:
          return "rest";
      }
    }

    function getZonePos(agentId, status) {
      const zoneId = zoneForStatus(status);
      const zone = ZONES[zoneId];
      const zoneAgents = agentList.value
        .filter((agent) => zoneForStatus(agent.status) === zoneId)
        .map((agent) => agent.agentId)
        .sort((a, b) => String(a).localeCompare(String(b)));
      if (!zoneAgents.includes(agentId)) {
        zoneAgents.push(agentId);
      }
      const idx = Math.max(0, zoneAgents.indexOf(agentId));
      const cols = 3;
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const rows = Math.max(1, Math.ceil(zoneAgents.length / cols));
      const xPad = 7;
      const yPad = 8;
      const xStep = cols > 1 ? (zone.xMax - zone.xMin - xPad * 2) / (cols - 1) : 0;
      const yStep = rows > 1 ? (zone.yMax - zone.yMin - yPad * 2) / (rows - 1) : 0;
      const x = zone.xMin + xPad + col * xStep;
      const y = zone.yMin + yPad + row * yStep;
      return { x, y };
    }

    // ── Formatters ─────────────────────────────────────────────────────────────

    function fmtTime(iso) {
      try { return new Date(iso).toLocaleTimeString(); } catch { return iso || ""; }
    }

    function md(s) {
      if (!s) return "";
      try { return marked.parse(String(s)); } catch { return String(s); }
    }

    function plainText(s) {
      if (!s) return "";
      try {
        const div = document.createElement("div");
        div.innerHTML = marked.parse(String(s));
        return div.textContent || "";
      } catch { return String(s); }
    }

    function avatarUrl(id) {
      return `https://api.dicebear.com/5.x/identicon/svg?seed=${encodeURIComponent(id)}`;
    }

    function getDisplayName(agentId, preferredName = "") {
      const fromState = agents[agentId]?.displayName;
      if (preferredName) return preferredName;
      if (fromState) return fromState;
      return agentId;
    }

    function applyToolsCatalog(data) {
      const items = Array.isArray(data)
        ? data
        : Array.isArray(data?.items)
        ? data.items
        : [];
      tools.value = items;
      toolsUpdatedAt.value = data?.updatedAt || "";
    }

    function normalizeTask(task) {
      if (!task || typeof task !== "object") return null;
      const rawColumn = String(task.column || "todo");
      const column = rawColumn === "doing" || rawColumn === "done" ? rawColumn : "todo";
      const comments = Array.isArray(task.comments)
        ? task.comments.map((comment) => ({
            ...comment,
            images: normalizeImageList(comment?.images),
          }))
        : [];
      const item = {
        ...task,
        id: String(task.id || task.runId || ""),
        runId: String(task.runId || task.id || ""),
        title: String(task.title || ""),
        column,
        comments,
        createdAt: task.createdAt || new Date().toISOString(),
        updatedAt: task.updatedAt || task.createdAt || new Date().toISOString(),
      };
      if (!item.id) return null;
      return item;
    }

    function sortTasks(list) {
      return [...list].sort((left, right) => {
        const leftTs = Date.parse(left.updatedAt || left.createdAt || 0);
        const rightTs = Date.parse(right.updatedAt || right.createdAt || 0);
        return rightTs - leftTs;
      });
    }

    function normalizeImageList(value) {
      const source = Array.isArray(value)
        ? value
        : (typeof value === "string" && value.trim().length > 0)
        ? [value]
        : [];
      const seen = new Set();
      const result = [];
      for (const entry of source) {
        const image = String(entry || "").trim();
        if (!image || seen.has(image)) continue;
        seen.add(image);
        result.push(image);
        if (result.length >= 8) break;
      }
      return result;
    }

    function taskRequestText(task) {
      const comments = Array.isArray(task?.comments) ? task.comments : [];
      const userComment = comments.find((comment) => comment?.status === "user_request" && comment?.details);
      if (userComment?.details) {
        return String(userComment.details);
      }
      return String(task?.title || "Untitled request");
    }

    function applyTasksSnapshot(data) {
      const items = Array.isArray(data)
        ? data
        : Array.isArray(data?.items)
        ? data.items
        : [];
      const normalized = items
        .map((task) => normalizeTask(task))
        .filter((task) => task && task.id);
      tasks.value = sortTasks(normalized);
    }

    function upsertTask(task) {
      const normalized = normalizeTask(task);
      if (!normalized) return;
      const next = [...tasks.value];
      const index = next.findIndex((entry) => entry.id === normalized.id);
      if (index >= 0) {
        next[index] = { ...next[index], ...normalized };
      } else {
        next.push(normalized);
      }
      tasks.value = sortTasks(next);
      if (selectedTask.value?.id === normalized.id) {
        selectedTask.value = tasks.value.find((entry) => entry.id === normalized.id) || normalized;
      }
    }

    // ── State updates ──────────────────────────────────────────────────────────

    function applyStatus(status, agentId, payload, displayName) {
      const isThinking = status.status === AgentStatus.THINKING;
      const isMetaStatus = status.status === "default" || status.status === "known";
      const raw = payload ? JSON.stringify(payload, null, 2) : "";
      const resolvedName = getDisplayName(agentId, displayName);
      const cleanedDetails = stripInternalDetails(status.details || "");
      const statusImages = normalizeImageList(status.images);

      if (!agents[agentId]) {
        agents[agentId] = {
          agentId,
          displayName: resolvedName,
          status: "",
          details: "",
          lastMessage: "",
          avatarUrl: avatarUrl(agentId),
          timestamp: "",
          thinkingText: "",
          actionText: "Ready",
        };
      }
      const a = agents[agentId];
      a.displayName = resolvedName;

      if (isThinking) {
        a.thinkingText = (a.thinkingText || "") + cleanedDetails;
      } else {
        a.thinkingText = "";
      }

      a.status    = status.status;
      a.details   = isThinking ? "" : cleanedDetails;
      a.timestamp = status.timestamp || new Date().toISOString();
      a.actionText = summarizeAction(status.status, cleanedDetails);

      if (status.status === AgentStatus.SEND_RESPONSE && status.details) {
        a.lastMessage = status.details;
      }

      // Move agent on the office canvas
      agentPositions[agentId] = getZonePos(agentId, status.status);

      // Skip noisy metadata-only records in activity feed
      if (isMetaStatus) return;

      // Collapse consecutive thinking deltas into one feed entry
      if (isThinking) {
        const last = feed[feed.length - 1];
        if (last && last.status === AgentStatus.THINKING && last.agentId === agentId) {
          last.details = a.thinkingText;
          last.displayName = a.displayName;
          if (statusImages.length) {
            last.images = normalizeImageList([...(last.images || []), ...statusImages]);
          }
          if (raw) last.raw = raw;
          return;
        }
      }

      feed.push({
        status: status.status,
        details: isThinking ? a.thinkingText : cleanedDetails,
        agentId,
        displayName: a.displayName,
        timestamp: a.timestamp,
        raw,
        images: statusImages,
      });
      if (feed.length > 150) feed.shift();
    }

    function applyAgentAlias(agentId, displayName) {
      if (!agentId) return;
      const normalized = String(displayName || "").trim() || agentId;
      if (agents[agentId]) {
        agents[agentId].displayName = normalized;
      }
      for (const item of feed) {
        if (item.agentId === agentId) {
          item.displayName = normalized;
        }
      }
      if (selectedAgent.value?.agentId === agentId) {
        selectedAgent.value.displayName = normalized;
      }
    }

    function openEditName() {
      if (!selectedAgent.value) return;
      editedName.value = selectedAgent.value.displayName || selectedAgent.value.agentId || "";
      nameError.value = "";
      isEditingName.value = true;
    }

    function cancelEditName() {
      isEditingName.value = false;
      nameError.value = "";
    }

    function selectAgent(agent) {
      selectedAgent.value = agent;
      isEditingName.value = false;
      nameError.value = "";
      editedName.value = "";
    }

    function closeAgentModal() {
      selectedAgent.value = null;
      isEditingName.value = false;
      nameError.value = "";
      editedName.value = "";
    }

    function openActivityEvent(eventItem) {
      selectedEvent.value = eventItem || null;
    }

    function closeActivityEvent() {
      selectedEvent.value = null;
    }

    function openTask(task) {
      selectedTask.value = task || null;
    }

    function closeTask() {
      selectedTask.value = null;
    }

    function openTools() {
      showTools.value = true;
    }

    function closeTools() {
      showTools.value = false;
    }

    async function saveAgentName() {
      if (!selectedAgent.value || nameSaving.value) return;
      const agentId = selectedAgent.value.agentId;
      const name = editedName.value.trim();
      nameSaving.value = true;
      nameError.value = "";
      try {
        const res = await fetch("/agent-aliases", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId, name }),
        });
        let payload = null;
        try {
          payload = await res.json();
        } catch {}
        if (!res.ok || payload?.ok === false) {
          const errMsg = payload?.error || `Failed to save (${res.status})`;
          throw new Error(errMsg);
        }
        const displayName = payload?.displayName || agentId;
        applyAgentAlias(agentId, displayName);
        isEditingName.value = false;
      } catch (err) {
        nameError.value = err instanceof Error ? err.message : String(err);
      } finally {
        nameSaving.value = false;
      }
    }

    // ── Socket.IO ──────────────────────────────────────────────────────────────

    const socket = io();

    socket.on("connect",    () => {
      connected.value = true;
      bootState.socket = true;
      checkBootReady();
    });
    socket.on("disconnect", () => { connected.value = false; });
    socket.io.on("reconnect", () => {
      connected.value = true;
      bootState.socket = true;
      checkBootReady();
    });

    socket.on("agentStatus", (data) => {
      try {
        const status = data?.status;
        if (!status?.status) return;
        const agentId = status.agentId
          || data?.payload?.payload?.agentId
          || data?.payload?.payload?.agent;
        if (!agentId) return;
        applyStatus(status, agentId, data?.payload, data?.displayName);
      } catch (err) {
        console.error("agentStatus error:", err);
      }
    });
    socket.on("agentAliases", (data) => {
      try {
        const items = data?.items || {};
        if (!items || typeof items !== "object") return;
        for (const [agentId, displayName] of Object.entries(items)) {
          applyAgentAlias(String(agentId), String(displayName ?? ""));
        }
      } catch (err) {
        console.error("agentAliases error:", err);
      }
    });
    socket.on("agentAliasUpdated", (data) => {
      try {
        applyAgentAlias(String(data?.agentId || ""), String(data?.displayName || ""));
      } catch (err) {
        console.error("agentAliasUpdated error:", err);
      }
    });
    socket.on("tasksSnapshot", (data) => {
      try {
        applyTasksSnapshot(data);
      } catch (err) {
        console.error("tasksSnapshot error:", err);
      }
    });
    socket.on("taskUpsert", (task) => {
      try {
        upsertTask(task);
      } catch (err) {
        console.error("taskUpsert error:", err);
      }
    });
    socket.on("toolsCatalog", (data) => {
      try {
        applyToolsCatalog(data);
      } catch (err) {
        console.error("toolsCatalog error:", err);
      }
    });

    // ── Initial snapshot ───────────────────────────────────────────────────────

    fetch("/agents")
      .then(r => r.json())
      .then(list => {
        list.forEach((a) => {
          if (!agents[a.agentId]) {
            agents[a.agentId] = {
              ...a,
              displayName: a.displayName || a.agentId,
              thinkingText: "",
              lastMessage: "",
              actionText: summarizeAction(a.status || a.lastStatus || "", a.details || ""),
            };
          } else if (a.displayName) {
            agents[a.agentId].displayName = a.displayName;
          }
          if (!agentPositions[a.agentId]) {
            agentPositions[a.agentId] = getZonePos(
              a.agentId,
              agents[a.agentId].status || a.status || a.lastStatus || "",
            );
          }
        });
      })
      .catch(() => {})
      .finally(() => {
        bootState.agents = true;
        checkBootReady();
      });
    fetch("/tools")
      .then(r => r.json())
      .then(applyToolsCatalog)
      .catch(() => {})
      .finally(() => {
        bootState.tools = true;
        checkBootReady();
      });
    fetch("/tasks")
      .then(r => r.json())
      .then(applyTasksSnapshot)
      .catch(() => {})
      .finally(() => {
        bootState.tasks = true;
        checkBootReady();
      });

    return {
      connected, isLoading, agentList, reversedFeed, feed,
      tasks, todoTasks, doingTasks, doneTasks,
      isEditingName, editedName, nameSaving, nameError,
      tools, toolsUpdatedAt,
      selectedAgent, selectedEvent, selectedTask, agentPositions,
      selectAgent, openEditName, cancelEditName, saveAgentName, closeAgentModal,
      openActivityEvent, closeActivityEvent, openTask, closeTask,
      showTools, openTools, closeTools,
      borderCls, dotCls, textCls, spriteAnimCls,
      fmtTime, md, plainText, statusLabel, stripInternalDetails, taskRequestText,
    };
  }
}).mount("#app");
