/**
 * V2 Job Data Manager
 * Manages publish job data and runtime state using chrome.storage.local
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from './v2-types';

export interface StoredJobData extends PublishJob {}

export type StoredJobState = Record<ChannelId, ChannelRuntimeState>;

const JOB_KEY_PREFIX = 'bawei_v2_job_';
const STATE_KEY_PREFIX = 'bawei_v2_state_';

const EXPIRY_TIME = 24 * 60 * 60 * 1000; // 24 hours
const MAX_STORED_JOBS = 20;

/**
 * Generates a unique ID for article data
 * @returns Unique identifier string
 */
function jobKey(jobId: string) {
  return `${JOB_KEY_PREFIX}${jobId}`;
}

function stateKey(jobId: string) {
  return `${STATE_KEY_PREFIX}${jobId}`;
}

/**
 * Stores a publish job.
 */
export async function storeJobData(job: PublishJob): Promise<void> {
  try {
    await chrome.storage.local.set({ [jobKey(job.jobId)]: job });
    await cleanExpiredData();
    await limitStoredJobs();
  } catch (error) {
    console.error('[V2 Job Data Manager] ❌ Failed to store job data:', error);
    throw new Error(`Failed to store job data: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Gets a publish job.
 */
export async function getJobData(jobId: string): Promise<PublishJob | null> {
  try {
    const result = await chrome.storage.local.get(jobKey(jobId));
    return (result[jobKey(jobId)] as PublishJob) || null;
  } catch (error) {
    console.error('[V2 Job Data Manager] ❌ Failed to get job data:', error);
    throw new Error(`Failed to get job data: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Stores per-channel job runtime state snapshot.
 */
export async function storeJobState(jobId: string, state: StoredJobState): Promise<void> {
  try {
    await chrome.storage.local.set({ [stateKey(jobId)]: state });
  } catch (error) {
    console.error('[V2 Job Data Manager] ❌ Failed to store job state:', error);
  }
}

/**
 * Gets per-channel job runtime state snapshot.
 */
export async function getJobState(jobId: string): Promise<StoredJobState | null> {
  try {
    const result = await chrome.storage.local.get(stateKey(jobId));
    return (result[stateKey(jobId)] as StoredJobState) || null;
  } catch (error) {
    console.error('[V2 Job Data Manager] ❌ Failed to get job state:', error);
    return null;
  }
}

/**
 * Deletes job and state.
 */
export async function deleteJob(jobId: string): Promise<void> {
  try {
    await chrome.storage.local.remove([jobKey(jobId), stateKey(jobId)]);
  } catch (error) {
    console.error('[V2 Job Data Manager] ❌ Failed to delete job:', error);
  }
}

/**
 * Marks a job as stopped by writing stoppedAt timestamp back to stored job data.
 */
export async function markJobStopped(jobId: string, stoppedAt: number): Promise<void> {
  const job = await getJobData(jobId);
  if (!job) throw new Error('Job not found');
  await storeJobData({ ...job, stoppedAt });
}

/**
 * Cleans expired job data (older than 24 hours).
 * Returns number of removed keys.
 */
export async function cleanExpiredData(): Promise<number> {
  try {
    const now = Date.now();
    const allData = await chrome.storage.local.get(null);

    const expiredKeys: string[] = [];
    for (const [key, value] of Object.entries(allData)) {
      if (key.startsWith(JOB_KEY_PREFIX)) {
        const job = value as PublishJob;
        const createdAt = typeof job?.createdAt === 'number' ? job.createdAt : 0;
        if (createdAt && now - createdAt > EXPIRY_TIME) {
          expiredKeys.push(key);
          const jobId = key.slice(JOB_KEY_PREFIX.length);
          expiredKeys.push(stateKey(jobId));
        }
      }
    }

    if (expiredKeys.length > 0) {
      await chrome.storage.local.remove(expiredKeys);
    }
    return expiredKeys.length;
  } catch (error) {
    console.error('[V2 Job Data Manager] ❌ Failed to clean expired data:', error);
    return 0;
  }
}

async function limitStoredJobs(): Promise<void> {
  try {
    const allData = await chrome.storage.local.get(null);
    const jobs = Object.entries(allData)
      .filter(([key]) => key.startsWith(JOB_KEY_PREFIX))
      .map(([key, value]) => ({ key, job: value as PublishJob }))
      .sort((a, b) => (b.job.createdAt || 0) - (a.job.createdAt || 0));

    if (jobs.length <= MAX_STORED_JOBS) return;
    const toRemove: string[] = [];
    for (const entry of jobs.slice(MAX_STORED_JOBS)) {
      toRemove.push(entry.key);
      const jobId = entry.key.slice(JOB_KEY_PREFIX.length);
      toRemove.push(stateKey(jobId));
    }
    await chrome.storage.local.remove(toRemove);
  } catch (error) {
    console.error('[V2 Job Data Manager] ❌ Failed to limit stored jobs:', error);
  }
}
