export type ChannelId =
  | 'csdn'
  | 'tencent-cloud-dev'
  | 'cnblogs'
  | 'oschina'
  | 'woshipm'
  | 'mowen'
  | 'sspai'
  | 'baijiahao'
  | 'toutiao'
  | 'feishu-docs';

export type PublishAction = 'draft' | 'publish';

export type ChannelStage =
  | 'init'
  | 'openEntry'
  | 'detectLogin'
  | 'fillSourceUrl'
  | 'fillTitle'
  | 'fillContent'
  | 'saveDraft'
  | 'submitPublish'
  | 'confirmSuccess'
  | 'waitingUser'
  | 'done';

export type ChannelResultStatus = 'not_started' | 'running' | 'success' | 'failed' | 'waiting_user';

export interface ArticlePayload {
  title: string;
  contentHtml: string;
  sourceUrl: string;
  author?: string;
  publishTime?: string;
  coverUrl?: string;
}

export interface PublishJob {
  jobId: string;
  createdAt: number;
  action: PublishAction;
  article: ArticlePayload;
  channels?: ChannelId[];
  sourceTabId?: number;
  stoppedAt?: number;
}

export interface ChannelRuntimeState {
  channelId: ChannelId;
  status: ChannelResultStatus;
  stage?: ChannelStage;
  userMessage?: string;
  userSuggestion?: string;
  devDetails?:
    | unknown
    | {
        publishedUrl?: string;
        listUrl?: string;
        verified?: { listVisible?: boolean; sourceUrlPresent?: boolean };
        message?: string;
      };
  updatedAt: number;
  tabId?: number;
}
