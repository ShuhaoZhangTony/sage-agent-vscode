/**
 * Chat Panel — connects to sage-studio /api/chat/v1/runs and renders
 * a chat UI using SSE streaming with AgentStep rendering.
 */
import * as vscode from "vscode";
import {
  AgentStep,
  ChatMessage,
  StudioConnectionError,
  checkHealth,
  streamChat,
} from "./studioClient";

export class ChatPanel implements vscode.Disposable {
  public static currentPanel: ChatPanel | undefined;
  private static readonly viewType = "sageAgent.chatPanel";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private history: ChatMessage[] = [];
  private abortController: AbortController | null = null;
  private disposables: vscode.Disposable[] = [];

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
    this._initChat();
  }

  // ── Static factory ─────────────────────────────────────────────────────────

  public static createOrShow(
    extensionUri: vscode.Uri,
    selectedText?: string
  ): void {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel.panel.reveal(column);
      if (selectedText) {
        ChatPanel.currentPanel._sendToWebview({ type: "insertText", text: selectedText });
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      "SAGE Studio Chat",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    ChatPanel.currentPanel = new ChatPanel(panel, extensionUri);
    if (selectedText) {
      ChatPanel.currentPanel._sendToWebview({ type: "insertText", text: selectedText });
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  private async _initChat(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("sageAgent");
    const systemPrompt = cfg.get<string>(
      "chat.systemPrompt",
      "You are a helpful AI assistant integrated into VS Code via SAGE Studio."
    );
    this.history = [{ role: "system", content: systemPrompt }];

    const healthy = await checkHealth();
    this._sendToWebview({ type: "init", studioConnected: healthy });
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private async _handleMessage(message: {
    type: string;
    text?: string;
  }): Promise<void> {
    switch (message.type) {
      case "send":
        await this._handleChatMessage(message.text ?? "");
        break;
      case "abort":
        this.abortController?.abort();
        break;
      case "clear":
        await this._initChat();
        break;
    }
  }

  private async _handleChatMessage(text: string): Promise<void> {
    if (!text.trim()) return;

    this.history.push({ role: "user", content: text });
    this._sendToWebview({ type: "userMessage", text });

    this.abortController = new AbortController();
    this._sendToWebview({ type: "streamStart" });

    let assistantText = "";

    try {
      for await (const step of streamChat(this.history, this.abortController.signal)) {
        if (step.type === "delta") {
          assistantText += step.content;
          this._sendToWebview({ type: "delta", content: step.content });
        } else if (step.type === "response") {
          assistantText = step.content;
          this._sendToWebview({ type: "response", content: step.content });
        } else {
          // Forward all other step types (thinking, tool_call, etc.)
          this._sendToWebview({ type: "agentStep", step });
        }
      }
    } catch (err) {
      if (!this.abortController.signal.aborted) {
        const msg =
          err instanceof StudioConnectionError
            ? err.message
            : "Unknown error communicating with sage-studio";
        this._sendToWebview({ type: "error", message: msg });
      }
    } finally {
      if (assistantText) {
        this.history.push({ role: "assistant", content: assistantText });
      }
      this._sendToWebview({ type: "streamEnd" });
      this.abortController = null;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _sendToWebview(data: Record<string, unknown>): void {
    void this.panel.webview.postMessage(data);
  }

  // ── HTML ───────────────────────────────────────────────────────────────────

  private _buildHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SAGE Studio Chat</title>
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

    #toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }

    #status-dot {
      width: 9px; height: 9px;
      border-radius: 50%;
      background: #666;
      flex-shrink: 0;
    }
    #status-dot.online  { background: #4ec9b0; }
    #status-dot.offline { background: #f48771; }

    #status-label {
      flex: 1;
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground);
    }

    #clear-btn {
      background: none;
      border: none;
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      cursor: pointer;
      font-size: 0.75em;
      padding: 2px 6px;
      border-radius: 3px;
    }
    #clear-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .msg {
      max-width: 90%;
      border-radius: 8px;
      padding: 8px 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg.user {
      align-self: flex-end;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .msg.assistant {
      align-self: flex-start;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border);
    }
    .msg.system-note {
      align-self: center;
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground);
      background: none;
      border: none;
      padding: 0;
    }

    .step-card {
      align-self: flex-start;
      max-width: 90%;
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 0.82em;
      color: var(--vscode-descriptionForeground);
      border-left: 3px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    }
    .step-card.thinking    { border-color: #9cdcfe; }
    .step-card.tool_call   { border-color: #ce9178; }
    .step-card.tool_result { border-color: #4ec9b0; }
    .step-card.retrieval   { border-color: #dcdcaa; }
    .step-card.error       { border-color: #f48771; }

    #input-row {
      display: flex;
      gap: 6px;
      padding: 8px 10px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }

    #input-box {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 6px 8px;
      font-family: inherit;
      font-size: inherit;
      resize: none;
      min-height: 38px;
      max-height: 120px;
    }
    #input-box:focus { outline: 1px solid var(--vscode-focusBorder); }

    #send-btn, #abort-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 0 12px;
      cursor: pointer;
      font-size: 0.88em;
      align-self: flex-end;
      height: 32px;
    }
    #send-btn:hover  { background: var(--vscode-button-hoverBackground); }
    #abort-btn       { background: var(--vscode-button-secondaryBackground); display: none; }
    #abort-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

    .spinner {
      display: inline-block;
      width: 12px; height: 12px;
      border: 2px solid var(--vscode-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      vertical-align: middle;
      margin-right: 4px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="toolbar">
    <span id="status-dot"></span>
    <span id="status-label">Connecting…</span>
    <button id="clear-btn">Clear</button>
  </div>
  <div id="messages"></div>
  <div id="input-row">
    <textarea id="input-box" rows="1" placeholder="Message sage-studio…"></textarea>
    <button id="send-btn">Send</button>
    <button id="abort-btn">Stop</button>
  </div>

  <script>
    const vscode  = acquireVsCodeApi();
    const msgs    = document.getElementById('messages');
    const inputBox = document.getElementById('input-box');
    const sendBtn  = document.getElementById('send-btn');
    const abortBtn = document.getElementById('abort-btn');
    const dot      = document.getElementById('status-dot');
    const lbl      = document.getElementById('status-label');

    let streaming  = false;
    let assistantEl = null;

    // ── recv ──────────────────────────────────────────────────────────────────
    window.addEventListener('message', ({ data }) => {
      switch (data.type) {
        case 'init':
          setStatus(data.studioConnected);
          appendNote('Connected to SAGE Studio. Start chatting!');
          break;
        case 'insertText':
          inputBox.value = data.text;
          inputBox.focus();
          break;
        case 'userMessage':
          appendMsg('user', data.text);
          break;
        case 'streamStart':
          streaming = true;
          assistantEl = appendMsg('assistant', '');
          sendBtn.style.display  = 'none';
          abortBtn.style.display = '';
          break;
        case 'delta':
          if (assistantEl) {
            assistantEl.textContent += data.content;
            scrollBottom();
          }
          break;
        case 'response':
          if (assistantEl) {
            assistantEl.textContent = data.content;
            scrollBottom();
          }
          break;
        case 'agentStep':
          appendStep(data.step);
          break;
        case 'streamEnd':
          streaming = false;
          sendBtn.style.display  = '';
          abortBtn.style.display = 'none';
          assistantEl = null;
          break;
        case 'error':
          appendNote('⚠ ' + data.message);
          streaming = false;
          sendBtn.style.display  = '';
          abortBtn.style.display = 'none';
          break;
      }
    });

    // ── send ──────────────────────────────────────────────────────────────────
    function send() {
      const text = inputBox.value.trim();
      if (!text || streaming) return;
      vscode.postMessage({ type: 'send', text });
      inputBox.value = '';
      inputBox.style.height = '';
    }

    sendBtn.addEventListener('click', send);
    abortBtn.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));
    document.getElementById('clear-btn').addEventListener('click', () => {
      msgs.innerHTML = '';
      vscode.postMessage({ type: 'clear' });
    });

    inputBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    inputBox.addEventListener('input', () => {
      inputBox.style.height = '';
      inputBox.style.height = Math.min(inputBox.scrollHeight, 120) + 'px';
    });

    // ── helpers ───────────────────────────────────────────────────────────────
    function appendMsg(role, text) {
      const el = document.createElement('div');
      el.className = 'msg ' + role;
      el.textContent = text;
      msgs.appendChild(el);
      scrollBottom();
      return el;
    }

    function appendNote(text) {
      const el = document.createElement('div');
      el.className = 'msg system-note';
      el.textContent = text;
      msgs.appendChild(el);
      scrollBottom();
    }

    function appendStep(step) {
      const el = document.createElement('div');
      el.className = 'step-card ' + (step.type || '');
      const icon = { thinking: '💭', tool_call: '🔧', tool_result: '📋', retrieval: '🔍' }[step.type] || '•';
      el.textContent = icon + ' ' + (step.tool_name ? '[' + step.tool_name + '] ' : '') + step.content;
      msgs.appendChild(el);
      scrollBottom();
    }

    function setStatus(online) {
      dot.className = online ? 'online' : 'offline';
      lbl.textContent = online ? 'sage-studio connected' : 'sage-studio offline';
    }

    function scrollBottom() {
      msgs.scrollTop = msgs.scrollHeight;
    }
  </script>
</body>
</html>`;
  }

  // ── Dispose ────────────────────────────────────────────────────────────────

  dispose(): void {
    this.abortController?.abort();
    ChatPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
