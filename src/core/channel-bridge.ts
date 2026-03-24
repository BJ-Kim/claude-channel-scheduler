// =============================================================================
// src/core/channel-bridge.ts - MCP Channel Bridge (Reusable Core Module)
// =============================================================================
//
// [Role]
// This file is the core layer that should NOT be modified.
// It handles MCP protocol and Claude Code stdio connection.
//
// [Position in Clean Architecture]
// Corresponds to the Use Case Layer.
// - Depends on external framework (@modelcontextprotocol/sdk)
// - Business logic (response handling, permission handling) is abstracted via interfaces
// - Actual I/O implementation (SSE, Telegram, etc.) is delegated to app layer
//
// [Responsibilities]
//   1. Create and configure MCP server
//   2. Establish stdio connection with Claude Code
//   3. Event emission (emit): Adapter → Claude Code
//   4. Response delegation: Claude Code → IReplyHandler
//   5. Permission delegation: Claude Code → IPermissionHandler
//
// [Important]
//   - DO NOT use console.log()! stdout is reserved for MCP communication
//   - All logs must use console.error() (stderr is independent from MCP)
//
// =============================================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type {
  ChannelBridgeConfig,
  ChannelEvent,
  EventEmitFn,
  IReplyHandler,
  IPermissionHandler,
  PermissionRequest,
} from "./types.js"

// =============================================================================
// ChannelBridge Class
// =============================================================================
//
// [Facade Pattern]
// Wraps the complex MCP SDK setup and event handling behind a simple interface.
// Adapters and app code only need to know about the emit() method.
//
// [Dependency Injection]
// Reply handler and permission handler are injected from outside.
// This allows flexible swapping - inject mock handlers for testing,
// or Telegram handlers for production, etc.
//
// =============================================================================
export class ChannelBridge {
  // MCP SDK server instance
  // All MCP protocol communication happens through this object
  private mcp: Server

  // Externally injected handlers (optional - null if feature not used)
  private replyHandler: IReplyHandler | null
  private permissionHandler: IPermissionHandler | null

  // Bridge configuration (name, version, instructions, etc.)
  private config: ChannelBridgeConfig

  // =============================================================================
  // Constructor
  // =============================================================================
  //
  // Dependency injection pattern:
  //   - config: Required. Channel name, version, Claude instructions
  //   - replyHandler: Optional. Needed when enableReplyTool=true. Handles Claude responses
  //   - permissionHandler: Optional. Needed when enablePermissionRelay=true. Handles permissions
  //
  // Only creates the MCP server object in constructor; does NOT connect.
  // Actual connection happens in connect() method. (Explicit initialization pattern)
  //
  // =============================================================================
  constructor(
    config: ChannelBridgeConfig,
    replyHandler?: IReplyHandler,
    permissionHandler?: IPermissionHandler
  ) {
    this.config = config
    this.replyHandler = replyHandler ?? null
    this.permissionHandler = permissionHandler ?? null

    // ─────────────────────────────────────────────────────────────
    // Create MCP Server
    //
    // [capabilities.experimental]
    //
    // 'claude/channel'
    //   → Required! This is what makes Claude Code recognize this server as a "channel."
    //   → Normal MCP servers are "called by" Claude,
    //     but channels add a "push to" Claude direction.
    //   → Events are published via the notifications/claude/channel method.
    //
    // 'claude/channel/permission'
    //   → Optional. Enables the permission relay feature.
    //   → When Claude needs approval to use tools like Bash/Write,
    //     approval requests are sent to this channel as well as the terminal.
    //   → Enables remote approval/denial (from phone, chat app, etc.).
    //
    // [capabilities.tools]
    //   → Allows Claude to call this server's tools (reply, etc.).
    //   → Only activated when enableReplyTool=true (unnecessary for one-way)
    //
    // [instructions]
    //   → Instructions added to Claude's system prompt.
    //   → Clearly describe "what events arrive" and "how to respond"!
    //   → These instructions determine Claude's behavior, so they are critical.
    //
    // ─────────────────────────────────────────────────────────────
    const experimental: Record<string, object> = {
      // [Required] Register as channel - without this, treated as a normal MCP server
      "claude/channel": {},
    }

    // Add permission relay only if enabled in config
    if (config.enablePermissionRelay) {
      experimental["claude/channel/permission"] = {}
    }

    this.mcp = new Server(
      // Server identification (displayed in Claude Code UI)
      { name: config.name, version: config.version },
      {
        capabilities: {
          experimental,
          // Only enable tools capability if reply tool is provided
          ...(config.enableReplyTool ? { tools: {} } : {}),
        },
        instructions: config.instructions,
      }
    )
  }

  // =============================================================================
  // connect() - Configure MCP server and establish stdio connection
  // =============================================================================
  //
  // [Execution Order]
  //   1. Register reply tool (if enableReplyTool=true)
  //   2. Register permission relay handler (if enablePermissionRelay=true)
  //   3. Create stdio transport and connect
  //
  // After calling this method, the MCP connection with Claude Code is established.
  // Calling emit() afterwards will deliver events to the Claude Code session.
  //
  // =============================================================================
  async connect(): Promise<void> {
    // Register handler if reply tool is enabled
    if (this.config.enableReplyTool && this.replyHandler) {
      this.registerReplyTool()
    }

    // Register handler if permission relay is enabled
    if (this.config.enablePermissionRelay && this.permissionHandler) {
      this.registerPermissionRelay()
    }

    // ─────────────────────────────────────────────────────────────
    // stdio transport connection
    //
    // Claude Code runs this process as a subprocess and
    // communicates via stdin/stdout using JSON-RPC based MCP protocol.
    //
    // StdioServerTransport:
    //   - Reads requests/responses from Claude Code via stdin
    //   - Sends events and responses to Claude Code via stdout
    //
    // MCP communication begins after this connect() call.
    // ─────────────────────────────────────────────────────────────
    const transport = new StdioServerTransport()
    await this.mcp.connect(transport)

    console.error(`[${this.config.name}] MCP connection established`)
  }

  // =============================================================================
  // emit() - Publish events to Claude Code session
  // =============================================================================
  //
  // Adapters (HTTP adapter, scheduler adapter, etc.) call this method
  // to deliver events to the Claude Code session.
  //
  // [Internal Behavior]
  // Calls mcp.notification() with the 'notifications/claude/channel' method.
  //
  // params.content → inner text of <channel> tag (body that Claude reads)
  // params.meta → attributes of <channel> tag (for routing/identification)
  //
  // Claude Code receives it like this:
  //   <channel source="my-channel" request_id="1" method="POST">
  //     Event body content...
  //   </channel>
  //
  // =============================================================================
  readonly emit: EventEmitFn = async (event: ChannelEvent): Promise<void> => {
    await this.mcp.notification({
      // This method name is required for Claude Code to recognize it as a channel event
      method: "notifications/claude/channel",
      params: {
        content: event.content,
        meta: event.meta,
      },
    })
  }

  // =============================================================================
  // getMcp() - Access MCP server instance (internal use)
  // =============================================================================
  //
  // Provided for cases that need direct MCP server access,
  // such as sending permission verdicts.
  // Normally, just use emit().
  //
  // =============================================================================
  getMcp(): Server {
    return this.mcp
  }

  // =============================================================================
  // Internal: registerReplyTool()
  // =============================================================================
  //
  // Registers the reply tool that Claude uses to respond to events.
  //
  // [Tool Registration]
  //
  // ListToolsRequestSchema handler:
  //   → Called when Claude Code asks "what tools does this server have?"
  //   → Returns tool name, description, input schema (JSON Schema)
  //   → Claude decides when/how to use the tool based on this info
  //
  // CallToolRequestSchema handler:
  //   → Executed when Claude actually calls the reply tool
  //   → Extracts request_id and text from arguments
  //   → Delegates to IReplyHandler.onReply() (actual processing in app layer)
  //   → Returns "sent successfully" result to Claude Code
  //
  // =============================================================================
  private registerReplyTool(): void {
    // Tool list handler
    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "reply",
          description: "Send a response to a channel event",
          inputSchema: {
            type: "object" as const,
            properties: {
              // request_id: key identifying which request this responds to
              // Must match the request_id attribute value of the event tag
              request_id: {
                type: "string",
                description: "ID of the request to respond to (request_id attribute of the event tag)",
              },
              // text: the actual response message generated by Claude
              text: {
                type: "string",
                description: "Response message to send",
              },
            },
            required: ["request_id", "text"],
          },
        },
      ],
    }))

    // Tool execution handler
    this.mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (req.params.name === "reply") {
        const { request_id, text } = req.params.arguments as {
          request_id: string
          text: string
        }

        console.error(`[${this.config.name}] reply tool called: request_id=${request_id}`)

        // Actual response handling is delegated to the injected IReplyHandler.
        // This allows switching response methods (SSE → Telegram → Slack)
        // without modifying core code.
        await this.replyHandler!.onReply(request_id, text)

        // Return success result to Claude Code
        return { content: [{ type: "text", text: "Reply sent successfully" }] }
      }

      throw new Error(`Unknown tool: ${req.params.name}`)
    })
  }

  // =============================================================================
  // Internal: registerPermissionRelay()
  // =============================================================================
  //
  // Registers handlers to relay Claude's tool permission requests.
  //
  // [Permission Relay Mechanism]
  //
  //   When Claude wants to use a tool requiring approval (e.g., Bash):
  //     1. Claude Code shows approval dialog in terminal (always)
  //     2. This handler is called simultaneously → IPermissionHandler.onPermissionRequest()
  //     3. onPermissionRequest() forwards the approval request remotely (SSE, Telegram, etc.)
  //     4. User approves/denies remotely
  //     5. Signal received via HTTP /permission etc. → onPermissionVerdict() called
  //     6. Verdict forwarded to Claude Code via mcp.notification()
  //     7. Whichever responds first (terminal or remote) is applied
  //
  // [permission_request schema]
  // request_id: 5-char lowercase (excluding 'l' to avoid confusion with 1/I)
  // tool_name: tool requiring approval (Bash, Write, etc.)
  // description: what Claude is trying to do
  // input_preview: preview of tool arguments (max 200 chars)
  //
  // =============================================================================
  private registerPermissionRelay(): void {
    // Permission request notification schema (type safety via Zod)
    const PermissionRequestSchema = z.object({
      method: z.literal("notifications/claude/channel/permission_request"),
      params: z.object({
        request_id: z.string(),    // e.g., "abcde" (5-char lowercase)
        tool_name: z.string(),     // e.g., "Bash"
        description: z.string(),   // e.g., "List files"
        input_preview: z.string(), // e.g., "ls -la /home"
      }),
    })

    // Executed when permission request notification arrives from Claude Code
    this.mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
      const req: PermissionRequest = {
        requestId: params.request_id,
        toolName: params.tool_name,
        description: params.description,
        inputPreview: params.input_preview,
      }

      console.error(`[${this.config.name}] Permission request: ${params.tool_name} (${params.request_id})`)

      // Actual handling is delegated to the injected IPermissionHandler
      await this.permissionHandler!.onPermissionRequest(req)
    })
  }

  // =============================================================================
  // sendPermissionVerdict() - Forward permission verdict to Claude Code
  // =============================================================================
  //
  // Called when the user makes an approval/denial decision remotely.
  // The HTTP adapter's /permission endpoint calls this method.
  //
  // requestId: 5-char lowercase ID received during permission request
  // allow: true for approve, false for deny
  //
  // =============================================================================
  async sendPermissionVerdict(requestId: string, allow: boolean): Promise<void> {
    await this.mcp.notification({
      // This method name is required for Claude Code to recognize it as a permission verdict
      method: "notifications/claude/channel/permission" as any,
      params: {
        request_id: requestId,
        behavior: allow ? "allow" : "deny",
      },
    })

    console.error(`[${this.config.name}] Permission verdict sent: ${requestId} → ${allow ? "approved" : "denied"}`)
  }
}
