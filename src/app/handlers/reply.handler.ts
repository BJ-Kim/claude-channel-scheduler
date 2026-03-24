// =============================================================================
// src/app/handlers/reply.handler.ts - Reply Handler (Edit here!)
// =============================================================================
//
// [Role]
// Handles processing when Claude calls the reply tool or sends permission requests.
//
// [Customize here]
// Default implementation sends responses via SSE stream.
// For production, integrate with Telegram, Slack, Discord, etc.
//
// [IReplyHandler implementation]
// onReply(): Handles Claude's reply tool responses
//
// [IPermissionHandler implementation]
// onPermissionRequest(): Forwards permission requests remotely
// onPermissionVerdict(): Forwards permission verdict to ChannelBridge
//
// =============================================================================

import type {
  IReplyHandler,
  IPermissionHandler,
  PermissionRequest,
} from "../../core/index.js"
import type { HttpAdapter } from "../../adapters/http.adapter.js"

// =============================================================================
// ReplyHandler Class
// =============================================================================
//
// [Dependencies]
// Injects HttpAdapter for SSE broadcast and pending response handling.
// Direct dependency on HttpAdapter exists, but it's within the app layer so it's acceptable.
//
// [Extension]
// To add Telegram, Slack, etc.:
//   1. Inject the corresponding client additionally in the constructor, or
//   2. Add fetch() calls in onReply()
//
// =============================================================================
export class ReplyHandler implements IReplyHandler, IPermissionHandler {
  // HttpAdapter: used for SSE broadcast and sync response handling
  private httpAdapter: HttpAdapter

  // Stores ChannelBridge's sendPermissionVerdict (injected later)
  // Uses setter injection instead of constructor to avoid circular dependencies
  private sendVerdictFn: ((requestId: string, allow: boolean) => Promise<void>) | null = null

  constructor(httpAdapter: HttpAdapter) {
    this.httpAdapter = httpAdapter
  }

  // =============================================================================
  // onReply() - Handle Claude's reply tool response (IReplyHandler implementation)
  // =============================================================================
  //
  // Called by ChannelBridge when Claude invokes the reply tool.
  //
  // [Current: Send via SSE stream]
  // Broadcasts Claude's response to all connected SSE clients.
  //
  // [Additional integration examples]
  // ─────────────────────────────────────────────────────
  // Send to Telegram:
  //   const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN
  //   const CHAT_ID = process.env.TELEGRAM_CHAT_ID
  //   await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({ chat_id: CHAT_ID, text: `[Reply #${requestId}]\n${text}` }),
  //   })
  //
  // Send to Slack:
  //   await fetch('https://slack.com/api/chat.postMessage', {
  //     method: 'POST',
  //     headers: {
  //       'Content-Type': 'application/json',
  //       'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
  //     },
  //     body: JSON.stringify({
  //       channel: process.env.SLACK_CHANNEL_ID,
  //       text: `[Reply #${requestId}] ${text}`,
  //     }),
  //   })
  //
  // Send to Discord webhook:
  //   await fetch(process.env.DISCORD_WEBHOOK_URL!, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({ content: `[Reply #${requestId}] ${text}` }),
  //   })
  // ─────────────────────────────────────────────────────
  //
  // =============================================================================
  async onReply(requestId: string, text: string): Promise<void> {
    const message = `[Reply #${requestId}]\n${text}`

    // ── Default: Broadcast via SSE stream ──
    // Check via: curl -N http://localhost:7787/events
    if (this.httpAdapter.broadcast) {
      this.httpAdapter.broadcast(message)
    }

    // ── Handle pending ?wait=true HTTP responses ──
    // If a request came in sync response mode, return Claude's response as HTTP response
    this.httpAdapter.resolveResponse(requestId, text)

    console.error(`[reply-handler] Reply processed: request_id=${requestId}`)
  }

  // =============================================================================
  // onPermissionRequest() - Handle permission request (IPermissionHandler implementation)
  // =============================================================================
  //
  // Called by ChannelBridge when Claude needs approval to use tools
  // like Bash, Write, etc.
  //
  // [Current: Forward approval request via SSE stream]
  // Displays the approval request message on SSE stream
  // and provides curl commands for approve/deny.
  //
  // [Customization]
  // Can forward approval requests to Telegram, etc.
  // and receive approve/deny via response buttons (inline keyboard).
  //
  // Example (Telegram inline keyboard):
  //   await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({
  //       chat_id: CHAT_ID,
  //       text: `🔐 Permission Request\nTool: ${req.toolName}\nDescription: ${req.description}\nPreview: ${req.inputPreview}`,
  //       reply_markup: {
  //         inline_keyboard: [[
  //           { text: '✅ Approve', callback_data: `permission:yes:${req.requestId}` },
  //           { text: '❌ Deny', callback_data: `permission:no:${req.requestId}` },
  //         ]],
  //       },
  //     }),
  //   })
  //
  // =============================================================================
  async onPermissionRequest(req: PermissionRequest): Promise<void> {
    const message = [
      "",
      "🔐 [Permission Request]",
      `Tool: ${req.toolName}`,
      `Description: ${req.description}`,
      `Preview: ${req.inputPreview}`,
      "",
      `Approve: curl -d "yes ${req.requestId}" http://localhost:7787/permission`,
      `Deny: curl -d "no ${req.requestId}" http://localhost:7787/permission`,
    ].join("\n")

    // Send via SSE stream
    if (this.httpAdapter.broadcast) {
      this.httpAdapter.broadcast(message)
    }

    console.error(`[reply-handler] Permission request forwarded: ${req.toolName} (${req.requestId})`)
  }

  // =============================================================================
  // onPermissionVerdict() - Handle permission verdict (IPermissionHandler implementation)
  // =============================================================================
  //
  // Called when the user makes an approval/denial decision.
  // (Currently HttpAdapter's /permission endpoint forwards directly to ChannelBridge,
  //  so this method is used only for logging purposes)
  //
  // =============================================================================
  async onPermissionVerdict(requestId: string, allow: boolean): Promise<void> {
    const verdict = allow ? "approved" : "denied"
    console.error(`[reply-handler] Permission verdict: ${requestId} → ${verdict}`)

    if (this.httpAdapter.broadcast) {
      this.httpAdapter.broadcast(`Permission ${verdict} (ID: ${requestId})`)
    }
  }

  // =============================================================================
  // setSendVerdictFn() - Inject ChannelBridge's permission verdict function
  // =============================================================================
  //
  // Uses setter injection to avoid circular dependencies.
  // Called from main.ts after ChannelBridge is created.
  //
  // =============================================================================
  setSendVerdictFn(fn: (requestId: string, allow: boolean) => Promise<void>): void {
    this.sendVerdictFn = fn
  }
}
