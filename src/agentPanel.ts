/**
 * Agent Task Panel — submit a natural-language task to the sage-studio
 * AgentOrchestrator and render the streaming AgentStep progress.
 *
 * Shows:
 *   - Step-by-step reasoning / tool calls
 *   - Final response
 *   - Task history
 */
import * as vscode from "vscode";
import {
  AgentStep,
  StudioConnectionError,
  checkHealth,
  streamAgentTask,
} from "./studioClient";

export class AgentPanel implements vscode.Disposable {
  public static currentPanel: AgentPanel | undefined;
  private static readonly viewType = "sageAgent.agentPanel";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private abortController: AbortController | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = this._buildHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      null,
      this.disposables
    );
    this._init();
  }

  // ── Static factory ─────────────────────────────────────────────────────────

  public static createOrShow(
    extensionUri: vscode.Uri,
    prefillTask?: string
  ): void {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (AgentPanel.currentPanel) {
      AgentPanel.currentPanel.panel.reveal(column);
      if (prefillTask) {
        AgentPanel.currentPanel._send({ type: "prefill", text: prefillTask });
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      AgentPanel.viewType,
      "SAGE Agent Tasks",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    AgentPanel.currentPanel = new AgentPanel(panel, extensionUri);
    if (prefillTask) {
      AgentPanel.currentPanel._send({ type: "prefill", text: prefillTask });
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  private async _init(): Promise<void> {
    const healthy = await checkHealth();
    this._send({ type: "init", studioConnected: healthy });
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private async _handleMessage(msg: {
    type: string;
    text?: string;
  }): Promise<void> {
    switch (msg.type) {
      case "runTask":
        await this._runTask(msg.text ?? "");
        break;
      case "abort":
        this.abortController?.abort();
        break;
    }
  }

  private async _runTask(task: string): Promise<void> {
    if (!task.trim()) return;

    const workspacePath =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    this.abortController = new AbortController();
    this._send({ type: "taskStart", task });

    try {
      for await (const step of streamAgentTask(
        task,
        workspacePath,
        this.abortController.signal
      )) {
        this._send({ type: "step", step });
      }
    } catch (err) {
      if (!this.abortController.signal.aborted) {
        const message =
          err instanceof StudioConnectionError
            ? err.message
            : "Unknown error communicating with sage-studio";
        this._send({ type: "taskError", message });
      }
    } finally {
      this._send({ type: "taskEnd" });
      this.abortController = null;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _send(data: Record<string, unknown>): void {
    void this.panel.webview.postMessage(data);
  }

  // ── HTML ───────────────────────────────────────────────────────────────────

  private _buildHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SAGE Agent Tasks</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Toolbar ── */
    #toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    #status-dot {
      width: 9px; height: 9px;
      border-radius: 50%;
      background: #666;
    }
    #status-dot.online  { background: #4ec9b0; }
    #status-dot.offline { background: #f48771; }
    #status-label {
      flex: 1;
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground);
    }

    /* ── Task feed ── */
    #feed {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .task-block {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      overflow: hidden;
    }

    .task-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      border-bottom: 1px solid var(--vscode-panel-border);
      font-weight: 600;
    }

    .task-header .badge {
      font-size: 0.72em;
      font-weight: normal;
      padding: 1px 6px;
      border-radius: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .task-steps {
      padding: 8px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .step {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      font-size: 0.85em;
      line-height: 1.4;
    }

    .step-icon  { flex-shrink: 0; width: 18px; text-align: center; }
    .step-body  { flex: 1; }
    .step-label { font-weight: 600; font-size: 0.8em; color: var(--vscode-descriptionForeground); }

    .step.thinking    .step-icon { color: #9cdcfe; }
    .step.reasoning   .step-icon { color: #9cdcfe; }
    .step.tool_call   .step-icon { color: #ce9178; }
    .step.tool_result .step-icon { color: #4ec9b0; }
    .step.retrieval   .step-icon { color: #dcdcaa; }
    .step.response    .step-icon { color: #b5cea8; }
    .step.error       .step-icon { color: #f48771; }

    .response-block {
      margin-top: 6px;
      padding: 8px 12px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border-top: 1px solid var(--vscode-panel-border);
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.55;
    }

    /* ── Input row ── */
    #input-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 10px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }

    #task-input {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 8px 10px;
      font-family: inherit;
      font-size: inherit;
      resize: none;
      min-height: 60px;
      max-height: 160px;
    }
    #task-input:focus { outline: 1px solid var(--vscode-focusBorder); }
    #task-input::placeholder { color: var(--vscode-input-placeholderForeground); }

    #btn-row { display: flex; gap: 6px; }

    #run-btn, #stop-btn {
      border: none;
      border-radius: 4px;
      padding: 5px 14px;
      cursor: pointer;
      font-size: 0.88em;
    }
    #run-btn  {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      flex: 1;
    }
    #run-btn:hover  { background: var(--vscode-button-hoverBackground); }
    #run-btn:disabled { opacity: 0.5; cursor: default; }

    #stop-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      display: none;
    }
    #stop-btn:hover  { background: var(--vscode-button-secondaryHoverBackground); }

    .spinner {
      display: inline-block;
      width: 10px; height: 10px;
      border: 2px solid var(--vscode-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="toolbar">
    <span id="status-dot"></span>
    <span id="status-label">Connecting…</span>
  </div>
  <div id="feed"></div>
  <div id="input-row">
    <textarea id="task-input" placeholder="Describe a task for the SAGE agent…&#10;&#10;Examples:&#10;• Research recent papers on KV-cache compression&#10;• Write a Python script to benchmark FAISS index build time&#10;• Summarize the sage-kernel architecture from the codebase"></textarea>
    <div id="btn-row">
      <button id="run-btn">▶ Run Task</button>
      <button id="stop-btn">■ Stop</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const feed   = document.getElementById('feed');
    const input  = document.getElementById('task-input');
    const runBtn  = document.getElementById('run-btn');
    const stopBtn = document.getElementById('stop-btn');
    const dot     = document.getElementById('status-dot');
    const lbl     = document.getElementById('status-label');

    let running = false;
    let currentBlock = null;
    let currentSteps  = null;
    let currentResp   = null;

    // ── recv ──────────────────────────────────────────────────────────────────
    window.addEventListener('message', ({ data }) => {
      switch (data.type) {
        case 'init':
          setStatus(data.studioConnected);
          break;
        case 'prefill':
          input.value = data.text;
          break;
        case 'taskStart':
          running = true;
          startBlock(data.task);
          runBtn.disabled = true;
          stopBtn.style.display = '';
          break;
        case 'step':
          appendStep(data.step);
          break;
        case 'taskError':
          appendErrorStep(data.message);
          finishBlock(false);
          break;
        case 'taskEnd':
          running = false;
          finishBlock(true);
          runBtn.disabled = false;
          stopBtn.style.display = 'none';
          break;
      }
    });

    // ── send ──────────────────────────────────────────────────────────────────
    runBtn.addEventListener('click', () => {
      const task = input.value.trim();
      if (!task || running) return;
      vscode.postMessage({ type: 'runTask', text: task });
    });

    stopBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'abort' });
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        runBtn.click();
      }
    });

    // ── block helpers ─────────────────────────────────────────────────────────
    function startBlock(task) {
      const block = document.createElement('div');
      block.className = 'task-block';

      const header = document.createElement('div');
      header.className = 'task-header';
      header.innerHTML = '<span>🤖</span><span style="flex:1">' + esc(task) + '</span>' +
        '<span class="badge spinner"></span>';
      block.appendChild(header);

      const steps = document.createElement('div');
      steps.className = 'task-steps';
      block.appendChild(steps);

      feed.appendChild(block);
      feed.scrollTop = feed.scrollHeight;

      currentBlock = block;
      currentSteps = steps;
      currentResp  = null;
    }

    function appendStep(step) {
      if (!currentSteps) return;

      if (step.type === 'response' || step.type === 'delta') {
        if (!currentResp) {
          currentResp = document.createElement('div');
          currentResp.className = 'response-block';
          currentBlock.appendChild(currentResp);
        }
        if (step.type === 'delta') {
          currentResp.textContent += step.content;
        } else {
          currentResp.textContent = step.content;
        }
        feed.scrollTop = feed.scrollHeight;
        return;
      }

      const icons = {
        thinking: '💭', reasoning: '💭', tool_call: '🔧', tool_result: '📋',
        retrieval: '🔍', done: '✅', error: '❌',
      };

      const row = document.createElement('div');
      row.className = 'step ' + (step.type || '');

      const icon = document.createElement('span');
      icon.className = 'step-icon';
      icon.textContent = icons[step.type] || '•';

      const body = document.createElement('div');
      body.className = 'step-body';

      if (step.tool_name) {
        const lbl2 = document.createElement('div');
        lbl2.className = 'step-label';
        lbl2.textContent = step.tool_name;
        body.appendChild(lbl2);
      }

      const content = document.createElement('div');
      content.textContent = step.content || '';
      body.appendChild(content);

      row.appendChild(icon);
      row.appendChild(body);
      currentSteps.appendChild(row);
      feed.scrollTop = feed.scrollHeight;
    }

    function appendErrorStep(message) {
      appendStep({ type: 'error', content: message });
    }

    function finishBlock(success) {
      if (!currentBlock) return;
      const badge = currentBlock.querySelector('.badge');
      if (badge) {
        badge.className = 'badge';
        badge.textContent = success ? 'done' : 'error';
        badge.style.background = success
          ? 'var(--vscode-testing-iconPassed, #4ec9b0)'
          : 'var(--vscode-testing-iconFailed, #f48771)';
      }
      currentBlock = null;
      currentSteps = null;
      currentResp  = null;
    }

    function setStatus(online) {
      dot.className = online ? 'online' : 'offline';
      lbl.textContent = online ? 'sage-studio connected' : 'sage-studio offline — start it first';
    }

    function esc(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
  </script>
</body>
</html>`;
  }

  // ── Dispose ────────────────────────────────────────────────────────────────

  dispose(): void {
    this.abortController?.abort();
    AgentPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
