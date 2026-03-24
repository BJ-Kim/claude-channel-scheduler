// =============================================================================
// Mon-Fri 7:30 AM Morning Reminder
// =============================================================================

import type { ScheduleJob } from "../../adapters/scheduler.adapter.js";

const job: ScheduleJob = {
  name: "morning-reminder",
  cron: "30 7 * * 1-5",
  timezone: "Asia/Seoul",
  execute: async () => {
    return "[Morning Reminder] Review your tasks for today.";
  },
};

export default job;
