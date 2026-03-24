// =============================================================================
// System Health Report (every 1 minute)
// =============================================================================

import type { ScheduleJob } from "../../adapters/scheduler.adapter.js";

const job: ScheduleJob = {
  name: "system-health",
  cron: "*/1 * * * *",
  execute: async () => {
    const mem = process.memoryUsage();
    return [
      "[System Health Report]",
      `Uptime: ${Math.round(process.uptime() / 60)} min`,
      `Heap Memory: ${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
      `Time: ${new Date().toLocaleTimeString("en-US")}`,
    ].join("\n");
  },
};

export default job;
