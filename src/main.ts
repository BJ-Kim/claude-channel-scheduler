#!/usr/bin/env bun

// =============================================================================
// src/main.ts - Entry Point (Composition Root)
// =============================================================================
//
// [Role]
// In clean architecture, this file is the "Composition Root".
// It is the single place where all dependencies are wired and the system starts.
//
// [Dependency Injection (DI) Pattern]
// All objects are created and connected here.
// Each component depends only on interfaces; concrete implementations are decided here.
//
// [Assembly Order]
//   1. Load config
//   2. Create adapters (HttpAdapter, SchedulerAdapter)
//   3. Create handler (ReplyHandler) ← inject adapters
//   4. Create bridge (ChannelBridge) ← inject handlers
//   5. Connect callbacks (permission verdict callback)
//   6. Connect bridge (MCP stdio connection)
//   7. Start adapters (inject emit function)
//   8. Set up Graceful Shutdown
//
// [Why This Order?]
// - Bridge must connect to MCP first for emit() to work
// - Adapters receive the emit function on start, so bridge connection must precede
// - Callbacks require both objects to be created before connecting
//
// =============================================================================

import { ChannelBridge } from "./core/index.js";
import { HttpAdapter } from "./adapters/http.adapter.js";
import { SchedulerAdapter } from "./adapters/scheduler.adapter.js";
import { ReplyHandler } from "./app/handlers/reply.handler.js";
import { loadJobs, watchJobs } from "./app/jobs/index.js";
import { config } from "./app/config.js";
import type { IEventSource } from "./core/index.js";

// =============================================================================
// 1. Create Adapters
// =============================================================================
//
// Adapters are the interface to the external world.
// Each adapter implements IEventSource interface
// to connect with ChannelBridge in a uniform way.
//
// =============================================================================

// HTTP adapter: converts external HTTP requests into channel events
const httpAdapter = new HttpAdapter(config.http.port, config.http.hostname);

// Scheduler adapter: auto-collects *.job.ts files and registers them
const jobs = await loadJobs();
const schedulerAdapter = new SchedulerAdapter(jobs);

// =============================================================================
// 2. Create Handlers
// =============================================================================
//
// Handlers process Claude's responses and permission requests.
// HttpAdapter is injected for SSE broadcast and sync response handling.
//
// To integrate external services like Telegram, modify this handler.
//
// =============================================================================

const replyHandler = new ReplyHandler(httpAdapter);

// =============================================================================
// 3. Create Bridge (Dependency Injection)
// =============================================================================
//
// Inject config and handlers into ChannelBridge.
// The bridge doesn't know the concrete implementation of handlers;
// it only depends on IReplyHandler / IPermissionHandler interfaces.
//
// =============================================================================

const bridge = new ChannelBridge(
  {
    name: config.channel.name,
    version: config.channel.version,
    instructions: config.channel.instructions,
    enablePermissionRelay: config.channel.enablePermissionRelay,
    enableReplyTool: config.channel.enableReplyTool,
  },
  replyHandler, // injected as IReplyHandler
  replyHandler  // also injected as IPermissionHandler (same class implements both)
);

// =============================================================================
// 4. Connect Callbacks (Resolving Circular Dependencies)
// =============================================================================
//
// [Problem] When HttpAdapter receives a permission verdict, it needs to forward
//           it to ChannelBridge, but direct reference could cause circular deps.
//
// [Solution] Indirect connection via callback pattern
//   HttpAdapter.setPermissionVerdictCallback() receives
//   ChannelBridge.sendPermissionVerdict()
//
// This way HttpAdapter doesn't need to import ChannelBridge.
//
// =============================================================================

httpAdapter.setPermissionVerdictCallback(
  (requestId, allow) => bridge.sendPermissionVerdict(requestId, allow)
);

// =============================================================================
// 5. Start System
// =============================================================================
//
// Uses async IIFE to start the system.
//
// [Why Startup Order Matters]
//   1. bridge.connect() first: MCP stdio connection must be established for emit() to work
//   2. Then adapter start(): events can now be emitted
//
// =============================================================================

async function main() {
  console.error("=".repeat(60));
  console.error(`[main] Starting ${config.channel.name} channel server...`);
  console.error("=".repeat(60));

  // ── 5-1. Connect MCP Bridge ──
  // Connects to Claude Code via stdio transport.
  // After this, bridge.emit() can publish events.
  await bridge.connect();

  // ── 5-2. Start Event Sources (Adapters) ──
  // Inject bridge.emit into each adapter to start them.
  // bridge.emit is an EventEmitFn type function;
  // when adapters emit events, they are automatically delivered to Claude Code.

  // List of event sources to activate
  const eventSources: IEventSource[] = [httpAdapter];

  if (config.scheduler.enabled) {
    eventSources.push(schedulerAdapter);
  }

  // Start all event sources
  for (const source of eventSources) {
    await source.start(bridge.emit);
    console.error(`[main] Event source started: ${source.name}`);
  }

  // ── 5-2b. Start Job File Watcher (Hot Reload) ──
  // Watches for *.job.ts file changes in the jobs/ directory.
  // Jobs can be added/modified/deleted without restarting Claude Code.
  if (config.scheduler.enabled) {
    watchJobs(schedulerAdapter);
  }

  // ── 5-3. Startup Complete Log ──
  console.error("=".repeat(60));
  console.error(`[main] Channel server ready!`);
  console.error(`[main] HTTP: http://${config.http.hostname}:${config.http.port}`);
  console.error(`[main] Monitor: curl -N http://localhost:${config.http.port}/events`);
  console.error(`[main] Test: curl -d "hello" http://localhost:${config.http.port}/test`);
  console.error("=".repeat(60));

  // ── 5-4. Graceful Shutdown ──
  // On SIGINT (Ctrl+C) or SIGTERM (process termination),
  // gracefully stop all adapters.
  const shutdown = async (signal: string) => {
    console.error(`\n[main] ${signal} received, shutting down...`);
    for (const source of eventSources) {
      await source.stop();
    }
    console.error("[main] Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[main] Fatal error:", err);
  process.exit(1);
});
