// =============================================================================
// Work Hours Health Check Every 30 Min (Mon-Fri 09:00-18:00)
// =============================================================================

import type { ScheduleJob } from "../../adapters/scheduler.adapter.js";

const job: ScheduleJob = {
  name: "work-hours-check",
  cron: "*/30 9-18 * * 1-5",
  timezone: "Asia/Seoul",
  execute: async () => {
    const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    if (heapMB > 100) {
      return `[Warning] High heap memory usage: ${heapMB}MB`;
    }
    return ""; // Skip if normal
  },
};

export default job;
