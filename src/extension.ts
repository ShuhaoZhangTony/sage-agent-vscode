/**
 * sage-agent-vscode — main extension entry point.
 *
 * Manages:
 *   - Studio backend process (start / stop via shell)
 *   - Status bar indicator
 *   - Chat panel  (sage-studio /api/chat/v1 SSE)
 *   - Agent panel (sage-studio /api/agent/v1 SSE)
 *   - Periodic health checks
 */
import * as cp from "child_process";
import * as vscode from "vscode";
import { AgentPanel } from "./agentPanel";
import { ChatPanel } from "./chatPanel";
import { StudioConnectionError, checkHealth, getStudioConfig } from "./studioClient";
import { StatusBarManager } from "./statusBar";

let studioProcess: cp.ChildProcess | null = null;
let statusBar: StatusBarManager | null = null;
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

// ── Activation ─────────────────────────────────────────────────────────────────

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  // Status bar
  statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  // Register commands
  context.subscriptions.push(
    // ── Open Chat panel ────────────────────────────────────────────────────────
    vscode.commands.registerCommand("sageAgent.openChat", () => {
      const editor = vscode.window.activeTextEditor;
      const selectedText = editor?.document.getText(editor.selection) ?? "";
      ChatPanel.createOrShow(
        context.extensionUri,
        selectedText || undefined
      );
    }),

    // ── Open Agent panel ────────────────────────────────────────────────────────
    vscode.commands.registerCommand("sageAgent.openAgentPanel", () => {
      const editor = vscode.window.activeTextEditor;
      const selectedText = editor?.document.getText(editor.selection) ?? "";
      AgentPanel.createOrShow(
        context.extensionUri,
        selectedText || undefined
      );
    }),

    // ── Start studio ───────────────────────────────────────────────────────────
    vscode.commands.registerCommand("sageAgent.startStudio", () => {
      startStudio(statusBar!);
    }),

    // ── Stop studio ────────────────────────────────────────────────────────────
    vscode.commands.registerCommand("sageAgent.stopStudio", () => {
      stopStudio(statusBar!);
    }),

    // ── Check connection ───────────────────────────────────────────────────────
    vscode.commands.registerCommand("sageAgent.checkConnection", async () => {
      statusBar?.setConnecting();
      const healthy = await checkHealth();
      statusBar?.setStudioStatus(healthy);
      if (healthy) {
        vscode.window.showInformationMessage("SAGE Studio: connected ✓");
      } else {
        const { baseUrl } = getStudioConfig();
        const action = await vscode.window.showWarningMessage(
          `SAGE Studio not reachable at ${baseUrl}`,
          "Start Studio",
          "Install Guide"
        );
        if (action === "Start Studio") {
          startStudio(statusBar!);
        } else if (action === "Install Guide") {
          vscode.commands.executeCommand("sageAgent.showInstallGuide");
        }
      }
    }),

    // ── Install guide ──────────────────────────────────────────────────────────
    vscode.commands.registerCommand("sageAgent.showInstallGuide", () => {
      showInstallGuide(context.extensionUri);
    })
  );

  // Initial health check
  void statusBar.refresh();

  // Periodic health refresh every 30 s
  healthCheckInterval = setInterval(async () => {
    const healthy = await checkHealth();
    statusBar?.setStudioStatus(healthy);
  }, 30_000);

  context.subscriptions.push({
    dispose: () => {
      if (healthCheckInterval) clearInterval(healthCheckInterval);
    },
  });
}

// ── Deactivation ───────────────────────────────────────────────────────────────

export function deactivate(): void {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  stopStudio(null);
}

// ── Studio process management ──────────────────────────────────────────────────

function startStudio(bar: StatusBarManager | null): void {
  if (studioProcess && !studioProcess.killed) {
    vscode.window.showInformationMessage(
      "SAGE Studio is already running."
    );
    return;
  }

  const cfg = vscode.workspace.getConfiguration("sageAgent");
  const startCmd = cfg.get<string>("studio.startCommand", "sage studio start");

  const terminal = vscode.window.createTerminal({
    name: "SAGE Studio",
    isTransient: true,
  });

  // Also spawn a background process for tracking
  studioProcess = cp.spawn("sh", ["-c", startCmd], {
    detached: false,
    stdio: "ignore",
  });

  studioProcess.on("exit", (code) => {
    studioProcess = null;
    bar?.setStudioStatus(false);
    if (code !== 0 && code !== null) {
      vscode.window.showWarningMessage(
        `SAGE Studio exited with code ${code}.`
      );
    }
  });

  terminal.sendText(startCmd);
  terminal.show(true);

  bar?.setConnecting();

  // Poll until the studio is ready (up to 60 s)
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    const healthy = await checkHealth();
    if (healthy) {
      clearInterval(poll);
      bar?.setStudioStatus(true);
      vscode.window.showInformationMessage(
        "SAGE Studio started and ready ✓"
      );
    } else if (attempts >= 60) {
      clearInterval(poll);
      bar?.setStudioStatus(false);
      vscode.window.showWarningMessage(
        "SAGE Studio did not respond within 60 seconds."
      );
    }
  }, 1_000);
}

function stopStudio(bar: StatusBarManager | null): void {
  const cfg = vscode.workspace.getConfiguration("sageAgent");
  const stopCmd = cfg.get<string>("studio.stopCommand", "sage studio stop");

  if (studioProcess && !studioProcess.killed) {
    studioProcess.kill("SIGTERM");
    studioProcess = null;
  }

  // Also run the configured stop command in case studio is managed externally
  cp.exec(stopCmd, (err) => {
    if (err) {
      // Non-fatal – studio might not have been running
    }
  });

  bar?.setStudioStatus(false);
}

// ── Install guide ──────────────────────────────────────────────────────────────

function showInstallGuide(extensionUri: vscode.Uri): void {
  const panel = vscode.window.createWebviewPanel(
    "sageAgent.installGuide",
    "SAGE Studio — Install Guide",
    vscode.ViewColumn.Active,
    { enableScripts: false }
  );

  const { baseUrl } = getStudioConfig();

  panel.webview.html = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Install Guide</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      max-width: 720px;
      margin: 32px auto;
      padding: 0 16px;
      line-height: 1.6;
    }
    h1 { font-size: 1.5em; margin-bottom: 0.4em; }
    h2 { font-size: 1.1em; margin-top: 1.6em; margin-bottom: 0.4em; }
    pre {
      background: var(--vscode-textCodeBlock-background, #1e1e1e);
      padding: 10px 14px;
      border-radius: 6px;
      overflow-x: auto;
    }
    code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; }
    a { color: var(--vscode-textLink-foreground); }
    .badge {
      display: inline-block;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 10px;
      padding: 1px 8px;
      font-size: 0.78em;
    }
    .tip {
      border-left: 3px solid var(--vscode-infoBar-background, #0078d4);
      padding: 6px 12px;
      margin: 12px 0;
      background: var(--vscode-editorWidget-background);
    }
  </style>
</head>
<body>
  <h1>🤖 SAGE Studio Agent — Installation Guide</h1>
  <p>This extension connects to the <strong>sage-studio</strong> backend
  running at <code>${baseUrl}</code>.</p>

  <h2>1 · Install SAGE</h2>
  <pre><code>pip install isage isage-studio</code></pre>

  <h2>2 · Start the studio backend</h2>
  <pre><code>sage studio start</code></pre>
  <p>Or use the <strong>SAGE Agent: Start Studio Backend</strong> command from the Command Palette.</p>

  <div class="tip">
    The backend listens on port <strong>8765</strong> by default.
    Change it in <em>Settings → SAGE Studio Agent → Studio Port</em>.
  </div>

  <h2>3 · Verify connection</h2>
  <pre><code>curl http://localhost:8765/health</code></pre>
  <p>Expected: <code>{"status": "ok", "service": "sage-studio"}</code></p>

  <h2>4 · Optional — configure LLM endpoint</h2>
  <p>sage-studio requires a running LLM endpoint. Start sageLLM gateway or configure an external endpoint:</p>
  <pre><code>sage-llm serve --model Qwen/Qwen2.5-7B-Instruct</code></pre>

  <h2>Commands</h2>
  <ul>
    <li><strong>SAGE Agent: Open Chat</strong> — open the chat panel</li>
    <li><strong>SAGE Agent: Open Agent Task Panel</strong> — submit multi-step agent tasks</li>
    <li><strong>SAGE Agent: Start Studio Backend</strong> — launch <code>sage studio start</code></li>
    <li><strong>SAGE Agent: Stop Studio Backend</strong> — stop the backend</li>
    <li><strong>SAGE Agent: Check Connection</strong> — probe <code>/health</code></li>
  </ul>

  <h2>Links</h2>
  <ul>
    <li><a href="https://github.com/intellistream/sage-agent-vscode">Extension repo</a></li>
    <li><a href="https://github.com/intellistream/sage-studio">sage-studio repo</a></li>
    <li><a href="https://github.com/intellistream/SAGE">SAGE mono-repo</a></li>
  </ul>
</body>
</html>`;
}
