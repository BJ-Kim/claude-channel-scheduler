// =============================================================================
// src/app/jobs/index.ts - Auto Job Collection + Hot Reload
// =============================================================================
//
// [Features]
//   1. On startup: Auto-scan and load *.job.ts files
//   2. At runtime: Watch directory for file changes and auto-reload
//
// [Hot Reload Behavior]
//   - File added → Register new job (no Claude Code restart needed!)
//   - File modified → Remove old job and replace with new version
//   - File deleted → Remove corresponding job
//
// [Note]
//   Bun uses import cache, so file modifications need cache bypass.
//   Query parameter (?t=timestamp) is appended for fresh imports each time.
//
// =============================================================================

import { readdirSync, watch, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import type { ScheduleJob } from "../../adapters/scheduler.adapter.js";
import type { SchedulerAdapter } from "../../adapters/scheduler.adapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// =============================================================================
// Load Single Job File
// =============================================================================
async function loadJobFile(filePath: string): Promise<ScheduleJob | null> {
  try {
    // Bypass import cache: fresh load via query parameter each time
    const fileUrl = pathToFileURL(filePath).href + `?t=${Date.now()}`;
    const mod = await import(fileUrl);
    const job: ScheduleJob = mod.default;

    if (!job || !job.name || !job.cron || !job.execute) {
      console.error(`[jobs] ${filePath}: not a valid ScheduleJob`);
      return null;
    }

    return job;
  } catch (err) {
    console.error(`[jobs] Failed to load ${filePath}: ${err}`);
    return null;
  }
}

// Extract job name from filename (remove extension)
function fileToJobId(filename: string): string {
  return filename.replace(/\.job\.ts$/, "");
}

// =============================================================================
// loadJobs() - Batch Load Initial Jobs
// =============================================================================
export async function loadJobs(): Promise<ScheduleJob[]> {
  const jobs: ScheduleJob[] = [];
  const files = readdirSync(__dirname).filter((f) => f.endsWith(".job.ts"));

  for (const file of files) {
    const job = await loadJobFile(join(__dirname, file));
    if (job) {
      jobs.push(job);
      console.error(`[jobs] Loaded: "${job.name}" (${job.cron}) ← ${file}`);
    }
  }

  console.error(`[jobs] Total ${jobs.length} jobs loaded`);
  return jobs;
}

// =============================================================================
// watchJobs() - File Watch + Hot Reload
// =============================================================================
//
// Watches the jobs directory for *.job.ts file changes.
// When changes are detected, dynamically adds/removes jobs in SchedulerAdapter.
//
// [Debounce]
// Editors may trigger multiple events on file save,
// so 300ms debounce is applied to prevent duplicate reloads.
//
// =============================================================================
export function watchJobs(scheduler: SchedulerAdapter): void {
  // Per-file debounce timers
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const watcher = watch(__dirname, async (eventType, filename) => {
    // Only process *.job.ts files (ignore index.ts, etc.)
    if (!filename || !filename.endsWith(".job.ts")) return;

    // Debounce: ignore duplicate events within 300ms
    const existing = debounceTimers.get(filename);
    if (existing) clearTimeout(existing);

    debounceTimers.set(
      filename,
      setTimeout(async () => {
        debounceTimers.delete(filename);

        const filePath = join(__dirname, filename);
        const jobId = fileToJobId(filename);

        // File was deleted
        if (!existsSync(filePath)) {
          const removed = scheduler.removeJob(jobId);
          if (removed) {
            console.error(`[jobs-watcher] Job removed ← ${filename} deleted`);
          }
          return;
        }

        // File was added or modified
        const job = await loadJobFile(filePath);
        if (job) {
          // addJob auto-replaces if same name exists
          scheduler.addJob(job);
          console.error(`[jobs-watcher] Job ${eventType === "rename" ? "added" : "reloaded"}: "${job.name}" (${job.cron}) ← ${filename}`);
        }
      }, 300)
    );
  });

  // Clean up watcher on process exit
  process.on("SIGINT", () => watcher.close());
  process.on("SIGTERM", () => watcher.close());

  console.error(`[jobs-watcher] Watching directory: ${__dirname}`);
  console.error(`[jobs-watcher] *.job.ts file additions/modifications/deletions will auto-apply`);
}
