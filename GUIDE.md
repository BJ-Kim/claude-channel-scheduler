# Claude Code Channel Framework

A channel server framework that delivers external events to Claude Code sessions.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      External Systems                         │
│   curl / CI / cron jobs / monitoring / other servers / etc.   │
└────────────────────────────┬─────────────────────────────────┘
                             │ HTTP Request
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  adapters/ (Interface Adapter Layer)                          │
│  ┌─────────────────────┐  ┌──────────────────────┐           │
│  │  HttpAdapter         │  │  SchedulerAdapter     │           │
│  │  - Receives HTTP     │  │  - Runs periodic jobs │           │
│  │  - Serves SSE stream │  │  - Converts results   │           │
│  │  - Receives verdicts │  │  - Error isolation    │           │
│  └────────┬────────────┘  └──────────┬───────────┘           │
│           │    IEventSource.start(emit)                       │
│           │    emit: EventEmitFn                              │
└───────────┼──────────────────────────┼───────────────────────┘
            ▼                          ▼
┌──────────────────────────────────────────────────────────────┐
│  core/ (Core Layer - No modification needed)                  │
│  ┌──────────────────────────────────────────────────┐        │
│  │  ChannelBridge                                    │        │
│  │  - Creates MCP server + registers claude/channel  │        │
│  │  - Connects to Claude Code via stdio transport    │        │
│  │  - emit() → notifications/claude/channel          │        │
│  │  - reply tool → delegates to IReplyHandler        │        │
│  │  - Permission relay → delegates to IPermissionHandler │    │
│  └──────────────────┬───────────────────────────────┘        │
│                     │ stdio (stdin/stdout)                    │
└─────────────────────┼────────────────────────────────────────┘
                      ▼
            ┌─────────────────┐
            │  Claude Code    │
            │  Session        │
            └────────┬────────┘
                     │ reply tool call
                     ▼
┌──────────────────────────────────────────────────────────────┐
│  app/ (User Implementation Layer - Edit here!)                │
│  ┌─────────────────────┐  ┌──────────────────────┐           │
│  │  ReplyHandler        │  │  *.job.ts files       │           │
│  │  - SSE broadcast     │  │  - System health      │           │
│  │  - (Telegram send)   │  │  - Reminders          │           │
│  │  - (Slack send)      │  │  - (Custom jobs)      │           │
│  └─────────────────────┘  └──────────────────────┘           │
│  ┌─────────────────────┐                                     │
│  │  config.ts           │                                     │
│  │  - Channel name/     │                                     │
│  │    instructions      │                                     │
│  │  - Port/host config  │                                     │
│  └─────────────────────┘                                     │
└──────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
channel-sample/
├── src/
│   ├── core/                           ← No modification needed (reusable)
│   │   ├── types.ts                    # Interface/type definitions
│   │   ├── channel-bridge.ts           # MCP server + stdio connection
│   │   └── index.ts                    # exports
│   │
│   ├── adapters/                       ← Built-in adapters (add as needed)
│   │   ├── http.adapter.ts             # HTTP server adapter
│   │   └── scheduler.adapter.ts        # Scheduler adapter
│   │
│   ├── app/                            ← Edit here only!
│   │   ├── config.ts                   # Channel config (name, port, instructions)
│   │   ├── handlers/
│   │   │   └── reply.handler.ts        # Claude response handling (SSE/Telegram/Slack)
│   │   └── jobs/
│   │       └── *.job.ts                # Scheduled job definitions
│   │
│   └── main.ts                         # Entry point (DI composition)
│
├── package.json
├── mcp.json.example                    # .mcp.json template
└── GUIDE.md                            # This document
```

**Files that need modification are only in `src/app/`.**

## Installation

```bash
cd ~/workspace/cladue-code/channel-sample
bun install
```

## How to Run

### 1. Add .mcp.json to Your Project

Create a `.mcp.json` file in the project directory where you want to use the channel.

**Important: The key name in `.mcp.json` must match the name after `server:`.**

```json
{
  "mcpServers": {
    "sample-channel": {
      "command": "bun",
      "args": ["run", "/path/to/channel-sample/src/main.ts"],
      "env": {
        "CHANNEL_PORT": "7787"
      }
    }
  }
}
```

Name matching rule:
```
.mcp.json key:  "sample-channel"
                       ↕ must match
Run flag:       server:sample-channel
```

If the names don't match, you'll get a `no MCP server configured with that name` error.

### 2. Run Claude Code

```bash
# Must run from the directory containing .mcp.json
cd /your/project
claude --dangerously-load-development-channels server:sample-channel
```

**Notes:**
- Must run from the directory containing `.mcp.json`
- The `--dangerously-load-development-channels` flag is required (Research Preview stage)
- Claude Code automatically runs `main.ts` as a subprocess (do NOT start the server manually!)
- The HTTP server (port 7787) also starts automatically within the subprocess

**Common mistake:**
```bash
# ❌ Starting the server manually and running Claude Code separately
bun run src/main.ts          # stdio connects to terminal, MCP communication impossible
claude ...                   # separate process, not connected

# ✅ Only run Claude Code (server is automatically spawned as subprocess)
claude --dangerously-load-development-channels server:sample-channel
```

### 3. Testing

**Terminal 2 - Monitor responses:**
```bash
curl -N http://localhost:7787/events
```

**Terminal 3 - Send events:**
```bash
# POST request
curl -d "Hello Claude, this is a test" http://localhost:7787/test

# JSON data
curl -X POST http://localhost:7787/api/alert \
  -H "Content-Type: application/json" \
  -d '{"service": "web", "error": "DB timeout", "severity": "high"}'

# Wait for Claude response (sync mode)
curl -d "What time is it?" "http://localhost:7787/ask?wait=true"

# Server health check
curl http://localhost:7787/health
```

## Customization

### Adding Scheduled Jobs

Add a job file in `src/app/jobs/`:

```typescript
// src/app/jobs/my-custom.job.ts
import type { ScheduleJob } from "../../adapters/scheduler.adapter.js";

const job: ScheduleJob = {
  name: "my-custom-job",
  cron: "*/2 * * * *",  // every 2 minutes
  execute: async () => {
    const data = await fetch("https://api.example.com/status");
    const json = await data.json();

    if (json.status !== "ok") {
      return `[Warning] API status abnormal: ${json.status}`;
    }
    return "";  // empty string = skip event
  },
};

export default job;
```

### Integrating Telegram Responses

Modify `onReply()` in `src/app/handlers/reply.handler.ts`:

```typescript
async onReply(requestId: string, text: string): Promise<void> {
  // Existing SSE broadcast
  if (this.httpAdapter.broadcast) {
    this.httpAdapter.broadcast(`[Reply #${requestId}]\n${text}`);
  }
  this.httpAdapter.resolveResponse(requestId, text);

  // Add Telegram integration
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: `[Claude Reply]\n${text}`,
    }),
  });
}
```

### Creating a New Event Source Adapter

Implement the `IEventSource` interface:

```typescript
// src/adapters/websocket.adapter.ts
import type { IEventSource, EventEmitFn } from "../core/index.js";

export class WebSocketAdapter implements IEventSource {
  readonly name = "websocket";

  async start(emit: EventEmitFn): Promise<void> {
    // Start WebSocket server
    // On message received, call emit({ content: msg, meta: { ... } })
  }

  async stop(): Promise<void> {
    // Stop WebSocket server
  }
}
```

Register in `src/main.ts`:

```typescript
const wsAdapter = new WebSocketAdapter();
eventSources.push(wsAdapter);
```

### Changing Port via Environment Variables

Set environment variables in `.mcp.json`:

```json
{
  "mcpServers": {
    "my-channel": {
      "command": "bun",
      "args": ["run", "/path/to/src/main.ts"],
      "env": {
        "CHANNEL_PORT": "8080"
      }
    }
  }
}
```

## Layer Description

| Layer | Directory | Role | Needs Modification? |
|-------|-----------|------|---------------------|
| **Core** | `src/core/` | MCP protocol, stdio connection, event emission | No |
| **Adapters** | `src/adapters/` | Convert external input to ChannelEvent | Only when adding new adapters |
| **App** | `src/app/` | Config, response handling, job definitions | Yes (mainly here!) |
| **Main** | `src/main.ts` | Dependency assembly (Composition Root) | Only when adding adapters |

## Design Patterns

| Pattern | Applied At | Effect |
|---------|-----------|--------|
| **Strategy** | IEventSource, IReplyHandler | Freely swap event source/response handling |
| **Dependency Injection** | main.ts assembly | Loose coupling between components |
| **Adapter** | HttpAdapter, SchedulerAdapter | Convert external protocols to internal interfaces |
| **Facade** | ChannelBridge | Simplify complex MCP SDK setup into a simple API |
| **Observer** | SSE listeners | Real-time broadcast to multiple clients |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Channel not registered | Missing flag | `--dangerously-load-development-channels server:my-channel` |
| Port conflict | Duplicate server running | `lsof -i :7787` then `kill <PID>` |
| MCP communication broken | Using console.log() | Change to `console.error()` |
| Events not delivered | emit before bridge.connect() | Check startup order in main.ts |
| Scheduler not running | config.scheduler.enabled=false | Check `src/app/config.ts` |

# Run Command
claude --dangerously-load-development-channels server:sample-channel
