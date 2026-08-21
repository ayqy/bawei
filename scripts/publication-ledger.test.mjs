import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPublicationLedger,
  getLedgerDecision,
  listPendingPublicationEntries,
  loadPublicationLedger,
  savePublicationLedger,
  upsertPublicationOutcome,
} from './publication-ledger.mjs';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bawei-ledger-test-'));
const ledgerPath = path.join(tempDir, 'ledger.json');

try {
  const ledger = createPublicationLedger();
  assert.equal(getLedgerDecision({ ledger, channelId: 'csdn', contentHash: 'a' }).action, 'submit');
  upsertPublicationOutcome(ledger, { channelId: 'csdn', contentHash: 'a', title: 'A', status: 'pending_review' });
  assert.equal(getLedgerDecision({ ledger, channelId: 'csdn', contentHash: 'a' }).action, 'verify_pending');
  assert.equal(listPendingPublicationEntries(ledger).length, 1);
  upsertPublicationOutcome(ledger, { channelId: 'csdn', contentHash: 'a', title: 'A', status: 'success' });
  assert.equal(getLedgerDecision({ ledger, channelId: 'csdn', contentHash: 'a' }).action, 'skip_success');
  upsertPublicationOutcome(ledger, {
    channelId: 'baijiahao',
    contentHash: 'phone',
    title: 'Phone verification',
    status: 'waiting_user',
    technicalFailureReason: 'phone verification required',
  });
  assert.equal(
    getLedgerDecision({ ledger, channelId: 'baijiahao', contentHash: 'phone' }).action,
    'wait_user',
  );
  assert.equal(
    getLedgerDecision({
      ledger,
      channelId: 'baijiahao',
      contentHash: 'phone',
      resumeWaitingUser: true,
    }).action,
    'resume_waiting_user',
  );
  upsertPublicationOutcome(ledger, {
    channelId: 'toutiao',
    contentHash: 'stale',
    title: 'Stale error',
    status: 'failed',
    rejectionReason: 'old technical error',
  });
  const repaired = upsertPublicationOutcome(ledger, {
    channelId: 'toutiao',
    contentHash: 'stale',
    title: 'Stale error',
    status: 'pending_review',
    reviewStatus: 'submitted',
  });
  assert.equal(Object.hasOwn(repaired, 'rejectionReason'), false);
  upsertPublicationOutcome(ledger, { channelId: 'woshipm', contentHash: 'b', title: 'B', status: 'rejected' });
  assert.equal(getLedgerDecision({ ledger, channelId: 'woshipm', contentHash: 'b' }).action, 'skip_rejected');
  savePublicationLedger(ledger, ledgerPath);
  const restored = loadPublicationLedger(ledgerPath);
  assert.equal(restored.entries['csdn:a'].status, 'success');
  assert.equal(restored.entries['woshipm:b'].status, 'rejected');
  console.log('✅ publication ledger unit tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
