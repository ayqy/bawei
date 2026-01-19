import type { ChannelId, ChannelRuntimeState, PublishAction, PublishJob } from './v2-types';

export const V2_START_JOB = 'V2_START_JOB' as const;
export const V2_GET_CONTEXT = 'V2_GET_CONTEXT' as const;
export const V2_CHANNEL_UPDATE = 'V2_CHANNEL_UPDATE' as const;
export const V2_JOB_BROADCAST = 'V2_JOB_BROADCAST' as const;
export const V2_REQUEST_CONTINUE = 'V2_REQUEST_CONTINUE' as const;
export const V2_REQUEST_RETRY = 'V2_REQUEST_RETRY' as const;
export const V2_REQUEST_STOP = 'V2_REQUEST_STOP' as const;

export type StartJobRequest = {
  type: typeof V2_START_JOB;
  action: PublishAction;
  focusChannel: ChannelId;
  channels?: ChannelId[];
  article: PublishJob['article'];
};

export type StartJobResponse = {
  success: boolean;
  jobId?: string;
  error?: string;
};

export type GetContextRequest = {
  type: typeof V2_GET_CONTEXT;
};

export type GetContextResponse =
  | {
      success: true;
      job: PublishJob;
      channelId: ChannelId;
    }
  | {
      success: false;
      error: string;
    };

export type ChannelUpdate = {
  type: typeof V2_CHANNEL_UPDATE;
  jobId: string;
  channelId: ChannelId;
  patch: Partial<ChannelRuntimeState>;
};

export type JobBroadcast = {
  type: typeof V2_JOB_BROADCAST;
  jobId: string;
  channels?: ChannelId[];
  state: Record<ChannelId, ChannelRuntimeState>;
};

export type ContinueRequest = {
  type: typeof V2_REQUEST_CONTINUE;
  jobId: string;
  channelId: ChannelId;
};

export type RetryRequest = {
  type: typeof V2_REQUEST_RETRY;
  jobId: string;
  channelId: ChannelId;
};

export type StopJobRequest = {
  type: typeof V2_REQUEST_STOP;
  jobId: string;
};

export type StopJobResponse = {
  success: boolean;
  error?: string;
};
