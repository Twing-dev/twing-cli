/**
 * Processes queued jobs one at a time. A job that throws is currently just
 * logged and dropped -- there's no retry behavior yet.
 */
export interface Job {
  id: string;
  run: () => Promise<void>;
}

export async function processJob(job: Job): Promise<void> {
  try {
    await job.run();
  } catch (err) {
    console.error(`job ${job.id} failed:`, err);
  }
}
