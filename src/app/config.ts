// =============================================================================
// src/app/config.ts - User Configuration (Edit here!)
// =============================================================================
//
// [Environment Variables]
//   CHANNEL_PORT          : HTTP server port (default: 7787)
//   TELEGRAM_CHAT_ID      : Telegram chat ID (target for scheduler results)
//
// Set these in the env section of .mcp.json.
//
// =============================================================================

// Telegram Chat ID (managed via environment variable)
const telegramChatId = process.env.TELEGRAM_CHAT_ID || "";

export const config = {
  // ─────────────────────────────────────────────────────────────────────────
  // Channel Bridge Settings
  // ─────────────────────────────────────────────────────────────────────────
  channel: {
    name: "sample-channel",
    version: "0.0.1",

    // Instructions delivered to Claude (added to system prompt)
    //
    // These instructions determine Claude's behavior!
    // When a Telegram channel is connected alongside,
    // instructs Claude to send scheduler event results to Telegram.
    instructions: `This channel is sample-channel that delivers scheduler and HTTP events.
Events arrive as <channel source="sample-channel"> tags.

[Event Processing Rules]

1. Scheduler events (source_type="scheduler"):
   - Perform the requested task based on the event content.
   - After completion, use the Telegram channel's reply tool to send results.
   - Use chat_id "${telegramChatId}".
   - If Telegram channel is not connected, respond using sample-channel's reply tool.

2. HTTP events (with method, path attributes):
   - Analyze and respond to external system requests.
   - Respond using sample-channel's reply tool. Include the request_id.

Respond in Korean.`,

    enablePermissionRelay: true,
    enableReplyTool: true,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // HTTP Adapter Settings
  // ─────────────────────────────────────────────────────────────────────────
  http: {
    port: Number(process.env.CHANNEL_PORT) || 7787,
    hostname: "127.0.0.1",
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Scheduler Adapter Settings
  // ─────────────────────────────────────────────────────────────────────────
  scheduler: {
    enabled: true,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Telegram Settings
  // ─────────────────────────────────────────────────────────────────────────
  telegram: {
    chatId: telegramChatId,
  },
};
