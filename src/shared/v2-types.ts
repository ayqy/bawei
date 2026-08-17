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

export type ChannelResultStatus =
  | 'not_started'
  | 'running'
  | 'success'
  | 'pending_review'
  | 'rejected'
  | 'failed'
  | 'waiting_user'
  | 'not_logged_in';

export type RichContentToken =
  | {
      kind: 'html';
      html: string;
    }
  | {
      kind: 'image';
      src: string;
      alt?: string;
    };

export interface ArticlePayload {
  title: string;
  contentHtml: string;
  contentTokens?: RichContentToken[];
  sourceUrl?: string;
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
  devDetails?: unknown | ChannelEvidenceDetails;
  updatedAt: number;
  tabId?: number;
}

export interface ChannelEvidenceDetails {
  publishedUrl?: string;
  draftUrl?: string;
  editorUrl?: string;
  listUrl?: string;
  managementUrl?: string;
  candidatePublicUrl?: string;
  reviewStatus?: string;
  rejectionReason?: string;
  expectedImageCount?: number;
  observedImageCount?: number;
  contentHash?: string;
  anonymousEvidence?: unknown;
  verified?: {
    listVisible?: boolean;
    sourceUrlPresent?: boolean;
    savedToCloud?: boolean;
    anonymousPublic?: boolean;
  };
  message?: string;
  [key: string]: unknown;
}
