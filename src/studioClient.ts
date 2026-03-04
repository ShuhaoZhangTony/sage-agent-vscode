/**
 * Studio API client for sage-agent-vscode.
 *
 * Connects to the sage-studio FastAPI backend (default port 8765).
 *
 * The actual API is a two-step protocol:
 *   1. POST /api/chat/v1/runs   { model, session_id, message }
 *      → { runtime_request_id, run.request_id, model }
 *   2. GET  /api/chat/v1/runs/{runtime_request_id}/events?model=X&request_id=Y
 *      → SSE stream of AgentStep JSON objects
 *
 * Both chat and agent-task modes reuse the same endpoint; the AgentOrchestrator
 * inside sage-studio routes to the appropriate agent based on the message content.
 */
import * as http from "http";
import * as https from "https";
import * as vscode from "vscode";
import { getCachedPorts } from "./sagePortsResolver";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** One step yielded by the AgentOrchestrator. Mirrors sage-studio AgentStep. */
export interface AgentStep {
  type:
    | "thinking"
    | "reasoning"
    | "tool_call"
    | "tool_result"
    | "retrieval"
    | "response"
    | "delta"
    | "error"
    | "done";
  content: string;
  status?: "running" | "completed" | "failed";
  tool_name?: string;
  metadata?: Record<string, unknown>;
}

export class StudioConnectionError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "StudioConnectionError";
  }
}

// ── Config ─────────────────────────────────────────────────────────────────────

export function getStudioConfig(): {
  baseUrl: string;
  port: number;
} {
  const cfg = vscode.workspace.getConfiguration("sageAgent");
  const host = cfg.get<string>("studio.host", "localhost");
  const tls = cfg.get<boolean>("studio.tls", false);
  // 0 means "auto-detect from SagePorts" — resolved at activation via resolveSagePorts()
  const cfgPort = cfg.get<number>("studio.port", 0);
  const port = cfgPort > 0 ? cfgPort : getCachedPorts().STUDIO_BACKEND;
  const baseUrl = `${tls ? "https" : "http"}://${host}:${port}`;
  return { baseUrl, port };
}

// ── Low-level HTTP helper ──────────────────────────────────────────────────────

function rawRequest(
  method: string,
  url: string,
  body?: string
): Promise<{ statusCode: number; data: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, data }));
    });

    req.on("error", (err) =>
      reject(new StudioConnectionError(`Network error: ${err.message}`))
    );
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new StudioConnectionError("Request timed out after 30s"));
    });

    if (body) req.write(body);
    req.end();
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Return true when sage-studio /health responds with 200. */
export async function checkHealth(): Promise<boolean> {
  const { baseUrl } = getStudioConfig();
  try {
    const { statusCode } = await rawRequest("GET", `${baseUrl}/health`);
    return statusCode === 200;
  } catch {
    return false;
  }
}

// ── Chat run response shape ────────────────────────────────────────────────────

interface ChatRunAccepted {
  runtime_request_id: string;
  run: { request_id: string };
  model: string;
}

// ── Two-step chat/agent helpers ───────────────────────────────────────────────

/**
 * Step 1 – POST /api/chat/v1/runs to submit a message and get back the IDs
 * needed to open the SSE events stream.
 */
async function _createChatRun(
  baseUrl: string,
  message: string,
  sessionId: string
): Promise<ChatRunAccepted> {
  const body = JSON.stringify({ model: "", session_id: sessionId, message });
  const { statusCode, data } = await rawRequest(
    "POST",
    `${baseUrl}/api/chat/v1/runs`,
    body
  );
  if (statusCode !== 200 && statusCode !== 201 && statusCode !== 202) {
    throw new StudioConnectionError(
      `chat/runs returned HTTP ${statusCode}: ${data}`,
      statusCode
    );
  }
  return JSON.parse(data) as ChatRunAccepted;
}

/**
 * Stream a chat request to sage-studio.
 *
 * Two-step protocol:
 *  1. POST /api/chat/v1/runs → get runtime_request_id + request_id
 *  2. GET  /api/chat/v1/runs/{runtime_request_id}/events?model=X&request_id=Y
 */
export async function* streamChat(
  messages: ChatMessage[],
  signal: AbortSignal
): AsyncGenerator<AgentStep> {
  const { baseUrl } = getStudioConfig();

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return;

  const sessionId = Date.now().toString(16);
  const accepted = await _createChatRun(baseUrl, lastUser.content, sessionId);

  const eventsUrl =
    `${baseUrl}/api/chat/v1/runs/${encodeURIComponent(accepted.runtime_request_id)}/events` +
    `?model=${encodeURIComponent(accepted.model ?? "")}` +
    `&request_id=${encodeURIComponent(accepted.run?.request_id ?? "")}`;

  yield* _sseGetStream(eventsUrl, signal);
}

/**
 * Stream an agent task to sage-studio.
 *
 * Reuses the same POST /api/chat/v1/runs endpoint — the AgentOrchestrator inside
 * sage-studio automatically routes to the appropriate agent (researcher / coder)
 * based on the task content.
 */
export async function* streamAgentTask(
  task: string,
  _workspacePath: string | undefined,
  signal: AbortSignal
): AsyncGenerator<AgentStep> {
  const { baseUrl } = getStudioConfig();

  // Prefix the task so the orchestrator is more likely to route to a coding/
  // research agent rather than the plain chat backend.
  const message = task.trim();
  const sessionId = `agent-${Date.now().toString(16)}`;
  const accepted = await _createChatRun(baseUrl, message, sessionId);

  const eventsUrl =
    `${baseUrl}/api/chat/v1/runs/${encodeURIComponent(accepted.runtime_request_id)}/events` +
    `?model=${encodeURIComponent(accepted.model ?? "")}` +
    `&request_id=${encodeURIComponent(accepted.run?.request_id ?? "")}`;

  yield* _sseGetStream(eventsUrl, signal);
}

// ── SSE GET stream implementation ─────────────────────────────────────────────

/**
 * Open a GET SSE stream and yield AgentStep objects.
 * Used for step 2 of the two-step chat/agent protocol.
 */
async function* _sseGetStream(
  url: string,
  signal: AbortSignal
): AsyncGenerator<AgentStep> {
  const parsed = new URL(url);
  const lib = parsed.protocol === "https:" ? https : http;

  let lineBuffer = "";
  const queue: Array<AgentStep | Error | null> = [];
  let resolve: (() => void) | null = null;

  function enqueue(item: AgentStep | Error | null) {
    queue.push(item);
    if (resolve) {
      const fn = resolve;
      resolve = null;
      fn();
    }
  }

  signal.addEventListener("abort", () => enqueue(null), { once: true });

  const options: http.RequestOptions = {
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.pathname + parsed.search,
    method: "GET",
    headers: { Accept: "text/event-stream" },
  };

  const req = lib.request(options, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const raw = trimmed.slice(5).trim();
        if (raw === "[DONE]") {
          enqueue(null);
          return;
        }
        try {
          const step = JSON.parse(raw) as AgentStep;
          enqueue(step);
          if (step.type === "done" || step.type === "error") {
            enqueue(null);
          }
        } catch {
          // skip malformed lines
        }
      }
    });

    res.on("end", () => enqueue(null));
    res.on("error", (err) => enqueue(new StudioConnectionError(err.message)));
  });

  req.on("error", (err) =>
    enqueue(new StudioConnectionError(`Network error: ${err.message}`))
  );
  req.end();

  while (true) {
    if (signal.aborted) break;
    if (queue.length === 0) {
      await new Promise<void>((r) => {
        resolve = r;
      });
    }
    const item = queue.shift();
    if (item === null || item === undefined) break;
    if (item instanceof Error) throw item;
    yield item;
  }

  if (!req.destroyed) req.destroy();
}
