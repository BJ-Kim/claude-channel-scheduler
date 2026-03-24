// =============================================================================
// src/adapters/http.adapter.ts - HTTP Server Adapter
// =============================================================================
//
// [Role]
// Adapter that converts external HTTP requests into channel events.
// Implements IEventSource interface to connect with ChannelBridge.
//
// [Position in Clean Architecture]
// Corresponds to the Interface Adapter Layer.
// - Converts external world (HTTP requests) to internal domain model (ChannelEvent)
// - Uses Bun.serve as external framework
// - Core logic (event conversion, SSE management) is pure business logic
//
// [Features]
//   - All HTTP requests → Convert to ChannelEvent and deliver to Claude Code
//   - GET /events → SSE stream (real-time Claude response monitoring)
//   - GET /health → Server health check
//   - POST /permission → Permission approval/denial handling
//   - ?wait=true → Synchronously return Claude response as HTTP response
//
// =============================================================================

import type { IEventSource, EventEmitFn, ChannelEvent } from "../core/index.js"

// =============================================================================
// HttpAdapter Class
// =============================================================================
//
// [Adapter Pattern]
// Wraps HTTP protocol behind the IEventSource interface.
// ChannelBridge doesn't need to know that HttpAdapter uses HTTP.
// It just needs the emit(event) function.
//
// [SSE (Server-Sent Events)]
// Real-time monitoring is available via the GET /events endpoint.
// Claude's responses, permission requests, etc. are broadcast via SSE stream.
// Usage: curl -N http://localhost:7787/events
//
// =============================================================================
export class HttpAdapter implements IEventSource {
  // IEventSource interface name property
  readonly name = "http"

  // HTTP server config
  private port: number
  private hostname: string

  // Bun HTTP server instance (stopped in stop())
  private server: ReturnType<typeof Bun.serve> | null = null

  // SSE listener set
  // Using Set for duplicate prevention and O(1) deletion
  private listeners = new Set<(chunk: string) => void>()

  // Sync response pending map
  // request_id → resolve function mapping
  // When Claude calls reply tool, finds this resolve to complete HTTP response
  private pendingResponses = new Map<string, (text: string) => void>()

  // Request ID counter (monotonically increasing, starts from 1 on restart)
  private nextId = 1

  // Permission verdict callback (optional)
  // Set from main.ts so ChannelBridge.sendPermissionVerdict() can be called
  private permissionVerdictCallback: ((requestId: string, allow: boolean) => Promise<void>) | null = null

  // Permission response parsing regex
  // Matches "yes abcde" or "no abcde" format
  // ID is 5-char lowercase (excluding 'l' to avoid confusion with 1/I)
  private readonly PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

  // =============================================================================
  // Constructor
  // =============================================================================
  //
  // port: Port to bind HTTP server to
  // hostname: Host to bind to (default: '127.0.0.1' - local only, secure)
  //   → Change to '0.0.0.0' for external access (beware of firewall!)
  //
  // =============================================================================
  constructor(port: number, hostname: string = "127.0.0.1") {
    this.port = port
    this.hostname = hostname
  }

  // =============================================================================
  // start() - Start HTTP server (IEventSource implementation)
  // =============================================================================
  //
  // Receives emit function injection and calls it whenever HTTP requests arrive.
  // Uses Bun.serve to start the HTTP server asynchronously.
  //
  // =============================================================================
  async start(emit: EventEmitFn): Promise<void> {
    // Internal function for SSE message broadcast
    const broadcastSSE = (text: string): void => {
      // Convert to SSE format
      // Prefix each line with "data: " and separate events with blank line (\n\n)
      const chunk =
        text
          .split("\n")
          .map((line) => `data: ${line}\n`)
          .join("") + "\n"
      // Broadcast to all connected SSE clients
      for (const listener of this.listeners) listener(chunk)
    }

    // Store SSE broadcast function for external use
    // (Used by ReplyHandler to send responses via SSE)
    this.broadcast = broadcastSSE

    this.server = Bun.serve({
      port: this.port,
      hostname: this.hostname,

      // ────────────────────────────────────────────────────
      // Prevent SSE connections from timing out
      // Default is 10 seconds, but SSE needs long-lived connections
      // ────────────────────────────────────────────────────
      idleTimeout: 0,

      fetch: async (req: Request): Promise<Response> => {
        const url = new URL(req.url)
        console.error(`[http-adapter] ${req.method} ${url.pathname}`)

        // ──────────────────────────────────────────────────
        // GET /events - SSE Stream Endpoint
        //
        // Monitor Claude's responses and system events in real-time.
        //
        // [SSE Mechanism]
        // Opens a ReadableStream and streams data while the request is alive.
        // When client (curl, etc.) disconnects, req.signal aborts.
        //
        // Usage: curl -N http://localhost:7787/events
        //   -N: output immediately without buffering
        // ──────────────────────────────────────────────────
        if (req.method === "GET" && url.pathname === "/events") {
          const stream = new ReadableStream({
            start: (ctrl) => {
              // Send connection confirmation (SSE comment format)
              // Lines starting with ": " are SSE comments (not displayed)
              ctrl.enqueue(`: connected to ${this.hostname}:${this.port}\n\n`)

              // Register listener: called when broadcastSSE() is invoked
              const listener = (chunk: string) => ctrl.enqueue(chunk)
              this.listeners.add(listener)

              // Remove listener when client disconnects
              req.signal.addEventListener("abort", () => {
                this.listeners.delete(listener)
              })
            },
          })

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
            },
          })
        }

        // ──────────────────────────────────────────────────
        // GET /health - Server Health Check Endpoint
        //
        // Used for load balancer health checks, deployment verification, etc.
        // ──────────────────────────────────────────────────
        if (req.method === "GET" && url.pathname === "/health") {
          return Response.json({
            status: "ok",
            adapter: "http",
            port: this.port,
            // Current SSE connection count (monitoring)
            sseConnections: this.listeners.size,
            // Number of requests waiting for response (sync mode)
            pendingResponses: this.pendingResponses.size,
            // Server uptime (ms)
            uptime: process.uptime() * 1000,
          })
        }

        // ──────────────────────────────────────────────────
        // POST /permission - Permission Approval/Denial Endpoint
        //
        // When Claude requests tool usage permission,
        // check the SSE stream and respond via this endpoint.
        //
        // Usage:
        //   curl -d "yes abcde" http://localhost:7787/permission  (approve)
        //   curl -d "no abcde" http://localhost:7787/permission   (deny)
        //
        // request_id can be found in the permission request message on SSE stream
        // ──────────────────────────────────────────────────
        if (req.method === "POST" && url.pathname === "/permission") {
          const body = await req.text()
          const match = this.PERMISSION_REPLY_RE.exec(body)

          if (!match) {
            return new Response(
              'Format error. Correct format: "yes <id>" or "no <id>" (id is 5 lowercase chars)\nExample: yes abcde',
              { status: 400 }
            )
          }

          const requestId = match[2].toLowerCase()
          const allow = match[1].toLowerCase().startsWith("y")

          // Forward to ChannelBridge if verdict callback is registered
          if (this.permissionVerdictCallback) {
            await this.permissionVerdictCallback(requestId, allow)
          } else {
            console.error("[http-adapter] Warning: permissionVerdictCallback not set")
          }

          const verdict = allow ? "approved" : "denied"
          broadcastSSE(`Permission ${verdict} (ID: ${requestId})`)
          return new Response(`Permission ${verdict}`)
        }

        // ──────────────────────────────────────────────────
        // All Other Requests → Convert to ChannelEvent and emit
        //
        // This is the core function of the HTTP adapter.
        // Any HTTP request is forwarded to the Claude Code session.
        //
        // [Conversion Logic]
        //   1. Extract request info (method, path, headers, body, query)
        //   2. Compose into human-readable text format
        //   3. Wrap as ChannelEvent and call emit()
        //   4. Received as <channel> tag in Claude Code
        //
        // [wait=true Mode]
        //   If ?wait=true is in query, waits for Claude's response
        //   and returns it as HTTP response. (Synchronous request-reply pattern)
        // ──────────────────────────────────────────────────
        const body = await req.text()
        const requestId = String(this.nextId++)

        // Compose event body (content Claude will read)
        const contentParts: string[] = [`[HTTP ${req.method} ${url.pathname}]`]

        if (url.search) {
          contentParts.push(`Query params: ${url.search}`)
        }

        const contentType = req.headers.get("content-type")
        if (contentType) {
          contentParts.push(`Content-Type: ${contentType}`)
        }

        if (body) {
          contentParts.push(`\nBody:\n${body}`)
        } else {
          contentParts.push("\n(No body)")
        }

        // Create ChannelEvent object
        const event: ChannelEvent = {
          content: contentParts.join("\n"),
          meta: {
            request_id: requestId,
            method: req.method,
            path: url.pathname,
          },
        }

        // Emit event (forwarded to ChannelBridge.emit())
        await emit(event)

        // Notify SSE listeners of reception
        broadcastSSE(`[Received #${requestId}] ${req.method} ${url.pathname}`)
        console.error(`[http-adapter] Event #${requestId} → delivered to Claude Code`)

        // ── wait=true: Synchronous response mode ──
        // Holds HTTP response until Claude calls reply tool.
        // Timeout: 30 seconds
        if (url.searchParams.get("wait") === "true") {
          const responseText = await Promise.race([
            // Wait for Claude's response
            new Promise<string>((resolve) => {
              this.pendingResponses.set(requestId, resolve)
            }),
            // 30-second timeout
            new Promise<string>((resolve) =>
              setTimeout(() => {
                this.pendingResponses.delete(requestId)
                resolve("[Timeout] Claude did not respond within 30 seconds")
              }, 30_000)
            ),
          ])

          return new Response(responseText, {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          })
        }

        // Immediate response (default mode)
        return Response.json({
          status: "Event delivered",
          request_id: requestId,
          message: "Event has been delivered to the Claude Code session",
        })
      },
    })

    console.error(`[http-adapter] HTTP server started: http://${this.hostname}:${this.port}`)
  }

  // =============================================================================
  // stop() - Stop HTTP server (IEventSource implementation)
  // =============================================================================
  //
  // Graceful Shutdown support:
  //   - Stop accepting new connections
  //   - Wait for in-progress requests to complete
  //   - Clean up SSE listeners
  //
  // =============================================================================
  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop()
      this.server = null
      this.listeners.clear()
      this.pendingResponses.clear()
      console.error("[http-adapter] HTTP server stopped")
    }
  }

  // =============================================================================
  // resolveResponse() - Handle pending HTTP responses
  // =============================================================================
  //
  // When Claude calls reply tool, IReplyHandler.onReply() calls this method.
  // If there's a pending HTTP request with ?wait=true, returns Claude's response to it.
  //
  // requestId: ID of the pending request
  // text: response text generated by Claude
  //
  // =============================================================================
  resolveResponse(requestId: string, text: string): void {
    const resolve = this.pendingResponses.get(requestId)
    if (resolve) {
      resolve(text)
      this.pendingResponses.delete(requestId)
    }
  }

  // =============================================================================
  // setPermissionVerdictCallback() - Set permission verdict callback
  // =============================================================================
  //
  // Connects ChannelBridge.sendPermissionVerdict() to this adapter from main.ts.
  // When POST /permission request arrives, forwards via this callback to ChannelBridge.
  //
  // [Dependency Direction]
  // HttpAdapter → ChannelBridge (no direct reference, indirect via callback)
  // This way the adapter doesn't directly depend on the bridge.
  //
  // =============================================================================
  setPermissionVerdictCallback(cb: (requestId: string, allow: boolean) => Promise<void>): void {
    this.permissionVerdictCallback = cb
  }

  // SSE broadcast function (set internally after start() is called)
  // Exposed as public for direct access from ReplyHandler
  broadcast: ((text: string) => void) | null = null
}
