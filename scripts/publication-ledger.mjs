import fs from 'node:fs';
import path from 'node:path';

export const PUBLICATION_LEDGER_SCHEMA_VERSION = 1;

export function defaultPublicationLedgerPath() {
  return path.resolve(process.cwd(), 'artifacts/live-publish/publication-ledger.json');
}

export function publicationLedgerKey(channelId, contentHash) {
  return `${String(channelId || '').trim()}:${String(contentHash || '').trim()}`;
}

export function createPublicationLedger() {
  return {
    schemaVersion: PUBLICATION_LEDGER_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    entries: {},
  };
}

export function loadPublicationLedger(filePath = defaultPublicationLedgerPath()) {
  if (!fs.existsSync(filePath)) return createPublicationLedger();
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (parsed?.schemaVersion !== PUBLICATION_LEDGER_SCHEMA_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
    throw new Error(`发布台账格式不受支持：${filePath}`);
  }
  return parsed;
}

export function savePublicationLedger(ledger, filePath = defaultPublicationLedgerPath()) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const next = {
    ...ledger,
    schemaVersion: PUBLICATION_LEDGER_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
  ledger.updatedAt = next.updatedAt;
  return next;
}

export function getPublicationEntry(ledger, channelId, contentHash) {
  return ledger.entries[publicationLedgerKey(channelId, contentHash)] || null;
}

export function getLedgerDecision({
  ledger,
  channelId,
  contentHash,
  resumeWaitingUser = false,
}) {
  const entry = getPublicationEntry(ledger, channelId, contentHash);
  if (!entry) return { action: 'submit', entry: null, reason: 'new-content' };
  if (entry.status === 'success') return { action: 'skip_success', entry, reason: 'already-public' };
  if (entry.status === 'pending_review') return { action: 'verify_pending', entry, reason: 'submitted-awaiting-review' };
  if (entry.status === 'rejected') return { action: 'skip_rejected', entry, reason: 'content-hash-rejected' };
  if (entry.status === 'waiting_user') {
    if (resumeWaitingUser) {
      return {
        action: 'resume_waiting_user',
        entry,
        reason: 'human-verification-completed',
      };
    }
    return { action: 'wait_user', entry, reason: 'human-verification-required' };
  }
  return { action: 'submit', entry, reason: 'retry-technical-failure' };
}

export function upsertPublicationOutcome(ledger, input) {
  const key = publicationLedgerKey(input.channelId, input.contentHash);
  const previous = ledger.entries[key] || {};
  const now = new Date().toISOString();
  const next = {
    ...previous,
    ...input,
    channelId: String(input.channelId || previous.channelId || ''),
    contentHash: String(input.contentHash || previous.contentHash || ''),
    title: String(input.title || previous.title || ''),
    status: input.status || previous.status || 'failed',
    submittedAt: input.submittedAt || previous.submittedAt,
    firstSeenAt: previous.firstSeenAt || now,
    lastCheckedAt: now,
  };
  if (next.status !== 'rejected' && !Object.hasOwn(input, 'rejectionReason')) {
    delete next.rejectionReason;
  }
  if (!['failed', 'not_logged_in', 'waiting_user'].includes(next.status) && !Object.hasOwn(input, 'technicalFailureReason')) {
    delete next.technicalFailureReason;
  }
  ledger.entries[key] = next;
  return next;
}

export function listPendingPublicationEntries(ledger) {
  return Object.values(ledger.entries).filter((entry) => entry?.status === 'pending_review');
}
