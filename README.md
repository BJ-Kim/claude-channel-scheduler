# Claude Code Channel Sample

A sample implementation of the **Claude Code Channel** framework — push external events (HTTP requests, cron jobs) into a live Claude Code session via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

> **Status**: Claude Code Channels are in **Research Preview**. The `--dangerously-load-development-channels` flag is required.

## What is a Claude Code Channel?

Normal MCP servers expose tools that Claude *calls*. A **Channel** flips the direction — it *pushes* events into Claude's conversation in real time:

```
External world ──HTTP/cron──▶ Channel Server ──MCP push──▶ Claude Code session
                                    ◀──reply tool──
```

This enables use cases like:

- **Webhook handler** — CI/CD alerts, monitoring events, or API callbacks delivered straight to Claude
- **Scheduled jobs** — periodic health checks, reminders, or reports that Claude processes automatically
- **Remote control** — send instructions to Claude from your phone via Telegram, Slack, or any HTTP client
- **Permission relay** — approve/deny Claude's tool usage remotely without terminal access

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      External Systems                         │
│   curl / CI / cron jobs / monitoring / other servers / etc.   │
└────────────────────────────┬─────────────────────────────────┘
                             │ HTTP Request
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  adapters/                                                    │
│  ┌─────────────────────┐  ┌──────────────────────┐           │
│  │  HttpAdapter         │  │  SchedulerAdapter     │           │
│  │  - Receives HTTP     │  │  - Runs periodic jobs │           │
│  │  - Serves SSE stream │  │  - Converts results   │           │
│  │  - Receives verdicts │  │  - Error isolation    │           │
│  └────────┬────────────┘  └──────────┬───────────┘           │
│           │    IEventSource.start(emit)                       │
└───────────┼──────────────────────────┼───────────────────────┘
            ▼                          ▼
┌──────────────────────────────────────────────────────────────┐
│  core/  (reusable, no modification needed)                    │
│  ┌──────────────────────────────────────────────────┐        │
│  │  ChannelBridge                                    │        │
│  │  - Creates MCP server + registers claude/channel  │        │
│  │  - Connects to Claude Code via stdio transport    │        │
│  │  - emit() → notifications/claude/channel          │        │
│  │  - reply tool → delegates to IReplyHandler        │        │
│  │  - Permission relay → IPermissionHandler          │        │
│  └──────────────────┬───────────────────────────────┘        │
│                     │ stdio (stdin/stdout)                    │
└─────────────────────┼────────────────────────────────────────┘
                      ▼
            ┌─────────────────┐
            │  Claude Code    │
            │  Session        │
            └────────┬────────┘
                     │ reply tool
                     ▼
┌──────────────────────────────────────────────────────────────┐
│  app/  (your code goes here)                                  │
│  ┌─────────────────────┐  ┌──────────────────────┐           │
│  │  ReplyHandler        │  │  *.job.ts files       │           │
│  │  - SSE broadcast     │  │  - System health      │           │
│  │  - Telegram/Slack    │  │  - Reminders          │           │
│  └─────────────────────┘  └──────────────────────┘           │
│  ┌─────────────────────┐                                     │
│  │  config.ts           │  Channel name, instructions,       │
│  │                      │  port, feature flags               │
│  └─────────────────────┘                                     │
└──────────────────────────────────────────────────────────────┘
```

The project follows **Clean Architecture** with three layers:

| Layer | Directory | Role | Edit? |
|-------|-----------|------|-------|
| **Core** | `src/core/` | MCP protocol, stdio connection, event emission | No |
| **Adapters** | `src/adapters/` | Convert external input (HTTP, cron) to `ChannelEvent` | Only when adding new adapters |
| **App** | `src/app/` | Config, response handling, job definitions | **Yes — this is where you customize** |

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) runtime
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI

### 1. Clone & Install

```bash
git clone https://github.com/BJ-Kim/claude-channel-scheduler.git
cd claude-channel-scheduler
bun install
```

### 2. Configure `.mcp.json`

Copy the example and edit the path to match your clone location:

```bash
cp mcp.json.example /path/to/your/project/.mcp.json
```

```json
{
  "mcpServers": {
    "sample-channel": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/claude-channel-scheduler/src/main.ts"],
      "env": {
        "CHANNEL_PORT": "7787"
      }
    }
  }
}
```

> **Important**: The key name (`sample-channel`) must match the channel name in `src/app/config.ts`.

### 3. Run Claude Code

```bash
# Must run from the directory containing .mcp.json
cd /your/project
claude --dangerously-load-development-channels server:sample-channel
```

Claude Code will automatically spawn the channel server as a subprocess. **Do NOT start the server manually** — stdout is reserved for MCP communication.

### 4. Test It

Open two more terminals:

```bash
# Terminal 2: Monitor responses via SSE
curl -N http://localhost:7787/events
```

```bash
# Terminal 3: Send events
curl -d "Hello Claude" http://localhost:7787/test

# JSON payload
curl -X POST http://localhost:7787/api/alert \
  -H "Content-Type: application/json" \
  -d '{"service": "web", "error": "DB timeout", "severity": "high"}'

# Synchronous mode — waits for Claude's reply
curl -d "What time is it?" "http://localhost:7787/ask?wait=true"

# Health check
curl http://localhost:7787/health
```

## Telegram Integration

This sample is designed to work with the [Claude Code Telegram channel plugin](https://www.npmjs.com/package/@anthropic-ai/claude-code-telegram). When both channels are loaded together, Claude automatically sends scheduler job results and event responses to your Telegram chat.

### Setup

**1. Add `TELEGRAM_CHAT_ID` to `.mcp.json`:**

```json
{
  "mcpServers": {
    "sample-channel": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/claude-channel-scheduler/src/main.ts"],
      "env": {
        "CHANNEL_PORT": "7787",
        "TELEGRAM_CHAT_ID": "YOUR_CHAT_ID"
      }
    }
  }
}
```

**2. Run Claude Code with both channels:**

```bash
claude \
  --dangerously-load-development-channels server:sample-channel \
  --channels plugin:telegram@claude-plugins-official
```

### How It Works

The channel's `instructions` in `src/app/config.ts` tell Claude:

- **Scheduler events** → process the task, then send results to Telegram using the Telegram channel's reply tool with the configured `chat_id`
- **HTTP events** → respond via sample-channel's reply tool
- **Telegram unavailable** → fall back to sample-channel's reply tool (SSE stream)

This means you can set up cron jobs (health checks, reminders, reports) and have Claude process them and push the results straight to your phone — no terminal needed.

> **Note**: The `TELEGRAM_CHAT_ID` is injected into Claude's instructions at startup. To find your chat ID, message [@userinfobot](https://t.me/userinfobot) on Telegram.

## Project Structure

```
src/
├── core/                              # Reusable core (don't modify)
│   ├── types.ts                       # Interfaces: IEventSource, IReplyHandler, etc.
│   ├── channel-bridge.ts             # MCP server + stdio + event emission
│   └── index.ts                       # Barrel exports
│
├── adapters/                          # Built-in event source adapters
│   ├── http.adapter.ts               # HTTP server (SSE, health, permission, event relay)
│   └── scheduler.adapter.ts          # Cron-based job scheduler with hot reload
│
├── app/                               # ★ Your customization goes here ★
│   ├── config.ts                      # Channel name, instructions, port, feature flags
│   ├── handlers/
│   │   └── reply.handler.ts          # How Claude's replies are delivered (SSE/Telegram/Slack)
│   └── jobs/                          # Scheduled jobs (auto-discovered *.job.ts files)
│       ├── index.ts                   # Job loader + hot reload watcher
│       ├── morning-reminder.job.ts   # Example: weekday morning reminder
│       ├── system-health.job.ts      # Example: system health report
│       └── work-hours-check.job.ts   # Example: work hours memory check
│
└── main.ts                            # Entry point / Composition Root (DI wiring)
```

## Customization Guide

### Adding a Scheduled Job

Create a `*.job.ts` file in `src/app/jobs/`. It will be auto-discovered on startup and hot-reloaded on changes — no restart needed.

```typescript
// src/app/jobs/my-custom.job.ts
import type { ScheduleJob } from "../../adapters/scheduler.adapter.js";

const job: ScheduleJob = {
  name: "my-custom-job",
  cron: "*/5 * * * *",  // every 5 minutes
  timezone: "Asia/Seoul",
  execute: async () => {
    const res = await fetch("https://api.example.com/status");
    const data = await res.json();
    if (data.status !== "ok") {
      return `[Alert] API status: ${data.status}`;
    }
    return "";  // empty string = skip event (nothing sent to Claude)
  },
};

export default job;
```

**Cron expression reference:**
```
┌──────── minute (0-59)
│ ┌────── hour (0-23)
│ │ ┌──── day of month (1-31)
│ │ │ ┌── month (1-12)
│ │ │ │ ┌ day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *

"30 7 * * 1-5"       Mon-Fri 7:30 AM
"0 9,18 * * *"       Daily 9 AM, 6 PM
"*/10 * * * *"       Every 10 minutes
"*/30 9-18 * * 1-5"  Mon-Fri work hours every 30 min
```

### Integrating External Services

Edit `src/app/handlers/reply.handler.ts` to forward Claude's replies:

```typescript
// Inside onReply()
async onReply(requestId: string, text: string): Promise<void> {
  // Default: SSE broadcast (always works)
  if (this.httpAdapter.broadcast) {
    this.httpAdapter.broadcast(`[Reply #${requestId}]\n${text}`);
  }
  this.httpAdapter.resolveResponse(requestId, text);

  // Add Telegram
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
    }),
  });

  // Add Slack
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: process.env.SLACK_CHANNEL_ID,
      text,
    }),
  });
}
```

### Creating a Custom Event Source Adapter

Implement the `IEventSource` interface:

```typescript
// src/adapters/websocket.adapter.ts
import type { IEventSource, EventEmitFn } from "../core/index.js";

export class WebSocketAdapter implements IEventSource {
  readonly name = "websocket";

  async start(emit: EventEmitFn): Promise<void> {
    // Start WebSocket server, call emit() on messages
  }

  async stop(): Promise<void> {
    // Cleanup
  }
}
```

Register in `src/main.ts`:

```typescript
const wsAdapter = new WebSocketAdapter();
eventSources.push(wsAdapter);
```

### Changing Claude's Behavior

Edit the `instructions` field in `src/app/config.ts`. This text is injected into Claude's system prompt and determines how Claude processes incoming events.

## Features

### HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/events` | SSE stream — real-time event & response monitoring |
| `GET` | `/health` | Server health check (SSE connections, uptime, etc.) |
| `POST` | `/permission` | Approve/deny Claude's tool usage (`"yes <id>"` / `"no <id>"`) |
| `*` | `/*` | Any other request is converted to a `ChannelEvent` and pushed to Claude |

Add `?wait=true` to any request to synchronously wait for Claude's reply (30s timeout).

### Permission Relay

When `enablePermissionRelay: true`, Claude's tool approval requests (Bash, Write, etc.) are forwarded via SSE. You can approve/deny remotely:

```bash
# Watch for permission requests
curl -N http://localhost:7787/events

# In another terminal, approve or deny
curl -d "yes abcde" http://localhost:7787/permission
curl -d "no abcde" http://localhost:7787/permission
```

### Hot Reload for Jobs

The scheduler watches `src/app/jobs/` for file changes:

- **Add** a `*.job.ts` file → job is registered immediately
- **Modify** a file → old job removed, new version registered
- **Delete** a file → job is unregistered

No Claude Code restart required.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHANNEL_PORT` | `7787` | HTTP server port |
| `TELEGRAM_CHAT_ID` | _(empty)_ | Telegram chat ID for scheduler result delivery |

Set via the `env` section of `.mcp.json`.

## Design Patterns Used

| Pattern | Where | Why |
|---------|-------|-----|
| **Strategy** | `IEventSource`, `IReplyHandler` | Swap event sources and reply handlers freely |
| **Dependency Injection** | `main.ts` | Loose coupling, all wiring in one place |
| **Adapter** | `HttpAdapter`, `SchedulerAdapter` | Isolate external protocols from core logic |
| **Facade** | `ChannelBridge` | Hide MCP SDK complexity behind `emit()` |
| **Observer** | SSE listeners | Broadcast to multiple monitoring clients |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `no MCP server configured with that name` | `.mcp.json` key doesn't match channel name | Ensure key matches `config.channel.name` |
| Port already in use | Previous server still running | `lsof -i :7787` then `kill <PID>` |
| MCP communication broken | Using `console.log()` in server code | Use `console.error()` — stdout is MCP-only |
| Events not reaching Claude | `emit()` called before `bridge.connect()` | Check startup order in `main.ts` |
| Scheduler jobs not firing | `config.scheduler.enabled` is `false` | Set to `true` in `src/app/config.ts` |
| Hot reload not working | File doesn't end in `.job.ts` | Rename to `*.job.ts` pattern |

## License

MIT
