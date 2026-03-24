// =============================================================================
// src/adapters/scheduler.adapter.ts - Scheduler Adapter (node-cron based)
// =============================================================================
//
// [Role]
// Converts results of periodic jobs defined by cron expressions into channel events.
// Supports runtime job addition/removal (Hot Reload).
//
// [Cron Expression Format]
//
//   ┌──────── minute (0-59)
//   │ ┌────── hour (0-23)
//   │ │ ┌──── day of month (1-31)
//   │ │ │ ┌── month (1-12 or JAN-DEC)
//   │ │ │ │ ┌ day of week (0-7 or SUN-SAT, both 0 and 7 are Sunday)
//   │ │ │ │ │
//   * * * * *
//
// [Examples]
//   "30 7 * * 1-5"       → Mon-Fri 7:30 AM
//   "0 9,18 * * *"       → Daily 9 AM, 6 PM
//   "*/10 * * * *"       → Every 10 minutes
//   "*/30 9-18 * * 1-5"  → Mon-Fri work hours (9-18) every 30 minutes
//
// =============================================================================

import cron from "node-cron";
import type { IEventSource, EventEmitFn } from "../core/index.js";

// =============================================================================
// ScheduleJob Interface
// =============================================================================
export interface ScheduleJob {
  /** Unique job name (for logging/event identification) */
  name: string;

  /**
   * Cron expression (node-cron format)
   *
   * Example:
   *   "30 7 * * 1-5"       Mon-Fri 7:30 AM
   */
  cron: string;

  /**
   * Timezone (optional, default: Asia/Seoul)
   */
  timezone?: string;

  /**
   * Job execution function
   * - Return value (string) is delivered to Claude
   * - Empty string ("") return skips the event
   * - Exceptions result in an error event being sent to Claude
   */
  execute: () => Promise<string>;
}

// =============================================================================
// SchedulerAdapter Class
// =============================================================================
export class SchedulerAdapter implements IEventSource {
  readonly name = "scheduler";

  // Job name → { job definition, cron task } mapping
  private registry = new Map<string, { job: ScheduleJob; task: cron.ScheduledTask }>();

  // Store emit function for use when adding jobs at runtime
  private emit: EventEmitFn | null = null;

  // Initial job list (batch registered on start())
  private initialJobs: ScheduleJob[];

  // Scheduler event ID counter
  private nextId = 1;

  constructor(jobs: ScheduleJob[]) {
    this.initialJobs = jobs;
  }

  async start(emit: EventEmitFn): Promise<void> {
    this.emit = emit;

    // Batch register initial jobs
    for (const job of this.initialJobs) {
      this.addJob(job);
    }

    console.error(`[scheduler] Scheduler started (${this.registry.size} jobs)`);
  }

  async stop(): Promise<void> {
    for (const [name, entry] of this.registry) {
      entry.task.stop();
    }
    this.registry.clear();
    this.emit = null;
    console.error("[scheduler] Scheduler stopped");
  }

  // =============================================================================
  // addJob() - Add job at runtime
  // =============================================================================
  //
  // If a job with the same name exists, removes the old one and registers new.
  // → Safe replacement even when job files are modified.
  //
  // =============================================================================
  addJob(job: ScheduleJob): boolean {
    if (!cron.validate(job.cron)) {
      console.error(`[scheduler] Job "${job.name}": invalid cron "${job.cron}"`);
      return false;
    }

    // Remove existing job with same name first (replacement)
    if (this.registry.has(job.name)) {
      this.removeJob(job.name);
    }

    const timezone = job.timezone ?? "Asia/Seoul";
    const emit = this.emit;

    const task = cron.schedule(
      job.cron,
      async () => {
        if (emit) await this.executeJob(job, emit);
      },
      { timezone }
    );

    this.registry.set(job.name, { job, task });
    console.error(`[scheduler] Job registered: "${job.name}" (${job.cron}, ${timezone})`);
    return true;
  }

  // =============================================================================
  // removeJob() - Remove job at runtime
  // =============================================================================
  removeJob(name: string): boolean {
    const entry = this.registry.get(name);
    if (!entry) return false;

    entry.task.stop();
    this.registry.delete(name);
    console.error(`[scheduler] Job removed: "${name}"`);
    return true;
  }

  // Get list of currently registered job names
  getJobNames(): string[] {
    return Array.from(this.registry.keys());
  }

  // Execute individual job (error isolation)
  private async executeJob(job: ScheduleJob, emit: EventEmitFn): Promise<void> {
    const startTime = Date.now();
    console.error(`[scheduler] Job executing: "${job.name}"`);

    try {
      const result = await job.execute();

      if (!result) {
        console.error(`[scheduler] Job "${job.name}": no result, skipping`);
        return;
      }

      const elapsed = Date.now() - startTime;

      await emit({
        content: result,
        meta: {
          request_id: String(this.nextId++),
          source_type: "scheduler",
          job_name: job.name,
          cron: job.cron,
          timestamp: new Date().toISOString(),
          elapsed_ms: String(elapsed),
        },
      });

      console.error(`[scheduler] Job "${job.name}" completed (${elapsed}ms)`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[scheduler] Job "${job.name}" failed: ${errorMessage}`);

      await emit({
        content: `[Job Error] "${job.name}" failed during execution\n${errorMessage}`,
        meta: {
          request_id: String(this.nextId++),
          source_type: "scheduler",
          job_name: job.name,
          status: "error",
          timestamp: new Date().toISOString(),
        },
      }).catch((e) => {
        console.error(`[scheduler] Error event emission failed: ${e}`);
      });
    }
  }
}
