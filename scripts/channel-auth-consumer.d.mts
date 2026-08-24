export type ChannelAuthState = {
  schema_version: 1;
  channel: string;
  kind: 'oauth2' | 'api_key' | 'service_account' | 'browser_state';
  issuer: string;
  captured_at: string;
  expires_at: string | null;
  payload: Record<string, unknown>;
};

export type ChannelAuthResolution = {
  channel: string;
  status: 'ready' | 'recovery_present' | 'blocked_external';
  selected: string | null;
  state?: ChannelAuthState;
  checkpoint?: string;
  rejected: Array<{ kind: string; reason: string }>;
};

export function resolveChannelAuth(
  channel: string,
  options?: {
    supportedOfficialKinds?: string[];
    allowBrowserState?: boolean;
    allowExpiredRefreshableOAuth?: boolean;
  }
): ChannelAuthResolution;
