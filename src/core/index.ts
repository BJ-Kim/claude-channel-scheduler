// =============================================================================
// src/core/index.ts - Core Layer Public API
// =============================================================================
//
// This file is the entry point for the core layer.
// External code (adapters, app) only needs to import from this file.
//
// [Barrel Export Pattern]
// Even if internal file structure changes, external import paths remain unchanged.
// Example: import { ChannelBridge } from '../core' (index.ts can be omitted)
//
// =============================================================================

// Core bridge class
export { ChannelBridge } from "./channel-bridge.js"

// All interfaces and types
export type {
  ChannelEvent,
  EventEmitFn,
  IEventSource,
  IReplyHandler,
  IPermissionHandler,
  PermissionRequest,
  ChannelBridgeConfig,
} from "./types.js"
