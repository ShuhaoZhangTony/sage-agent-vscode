# SAGE Studio Agent — VS Code Extension

VS Code extension for **SAGE Studio**, providing a persistent AI agent workspace directly in your editor.

## Features

- **Chat Panel** — multi-turn chat with SAGE Studio's LLM backend, streaming AgentStep responses with live thinking/tool-call indicators
- **Agent Task Panel** — submit natural-language tasks (research, coding, analysis) and watch the multi-agent swarm (ResearcherAgent, CodingAgent) work step by step
- **Studio Backend Control** — start and stop the sage-studio FastAPI backend from the Command Palette
- **Status Bar** — live connection indicator for sage-studio
- **Context injection** — highlight code, right-click → "SAGE Agent: Open Chat" to ask about the selection

## Requirements

1. **Python environment with SAGE installed**:
   ```bash
   pip install isage isage-studio
   ```

2. **Start the sage-studio backend** (port 8765 by default):
   ```bash
   sage studio start
   ```

3. **Optional** — a running LLM endpoint (sageLLM gateway or OpenAI-compatible):
   ```bash
   sage-llm serve --model Qwen/Qwen2.5-7B-Instruct
   ```

## Usage

| Command | Description |
|---|---|
| `SAGE Agent: Open Chat` | Open the chat panel (streaming) |
| `SAGE Agent: Open Agent Task Panel` | Submit a multi-step agent task |
| `SAGE Agent: Start Studio Backend` | Run `sage studio start` |
| `SAGE Agent: Stop Studio Backend` | Stop the studio backend |
| `SAGE Agent: Check Connection` | Probe `/health` |
| `SAGE Agent: Installation Guide` | Show setup instructions |

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `sageAgent.studio.host` | `localhost` | sage-studio backend host |
| `sageAgent.studio.port` | `8765` | sage-studio backend port |
| `sageAgent.studio.tls` | `false` | Use TLS for the connection |
| `sageAgent.chat.systemPrompt` | (default) | System prompt for the chat panel |
| `sageAgent.studio.startCommand` | `sage studio start` | Shell command to start the backend |
| `sageAgent.studio.stopCommand` | `sage studio stop` | Shell command to stop the backend |

## Architecture

```
sage-agent-vscode
├── src/
│   ├── extension.ts       ← activation, commands, process management
│   ├── studioClient.ts    ← HTTP/SSE client for sage-studio API
│   ├── chatPanel.ts       ← Chat webview (SSE stream → AgentStep rendering)
│   ├── agentPanel.ts      ← Agent Task webview (task submit + step feed)
│   └── statusBar.ts       ← Status bar indicator
└── package.json
```

The extension communicates with **sage-studio** at the following endpoints:

| Endpoint | Usage |
|---|---|
| `GET /health` | Health check |
| `POST /api/chat/v1/runs` | Chat with SSE streaming |
| `POST /api/agent/v1/runs` | Agent task with SSE streaming |

## Development

```bash
git clone https://github.com/intellistream/sage-agent-vscode
cd sage-agent-vscode
npm install
npm run compile      # one-shot build
npm run watch        # watch mode
```

Press **F5** in VS Code to launch the Extension Development Host.

## Build & Package

```bash
npm run package             # production bundle → dist/extension.js
npx vsce package            # create .vsix
```

## Related Projects

- [sage-studio](https://github.com/intellistream/sage-studio) — the backend this extension connects to
- [sagellm-vscode](https://github.com/intellistream/sagellm-vscode) — SageLLM inference engine VS Code extension
- [SAGE](https://github.com/intellistream/SAGE) — SAGE meta-package

## License

MIT © IntelliStream Team
