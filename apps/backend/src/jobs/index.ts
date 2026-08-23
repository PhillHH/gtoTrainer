/**
 * Job-Queue und Worker (AP2.T2.5).
 *
 * Der Worker laeuft im Backend-Prozess (ADR-0026) und kennt nur die
 * `JobHandlerRegistry`. Wie ein Folge-AP einen eigenen Job-Typ registriert,
 * steht in docs/INTERFACES.md Abschnitt 10.
 */
export { JobWorker } from './worker.js';
export type { WorkerOptions } from './worker.js';
export { JobEventBus } from './events.js';
export type { JobEventListener } from './events.js';
export { JobHandlerRegistry, JobPayloadError, UnknownJobTypeError } from './types.js';
export type { ClaimedJob, JobContext, JobOutcome, JobType } from './types.js';
export {
  claimNextJob,
  enqueueJob,
  findJob,
  listRecentJobs,
  markDead,
  markDone,
  requeueDeadJob,
  scheduleRetry,
} from './queue.js';
export type { EnqueueOptions, EnqueuedJob, JobRow } from './queue.js';
export { registerJobRoutes } from './routes.js';
export type { JobRoutesOptions } from './routes.js';
export { LLM_COMPLETE_JOB, createLlmCompleteJob } from './handlers/llm-complete.js';
export type { LlmCompletePayload } from './handlers/llm-complete.js';
