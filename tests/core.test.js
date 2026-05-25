import test from "node:test";
import assert from "node:assert/strict";

import {
  detectWorkspaceMode,
  isBlankWorkspaceSnapshot,
  isRecoverableUrl,
  isRestrictedUrl,
  makeStatusPayload,
  shouldReplacePendingSnapshot,
  validateSnapshot
} from "../src/shared/core.js";
import {
  CAPTURE_REASONS,
  RESTORE_STATES,
  SCHEMA_VERSION
} from "../src/shared/protocol.js";

test("restricted urls are filtered", () => {
  assert.equal(isRestrictedUrl("edge://settings"), true);
  assert.equal(isRestrictedUrl("chrome-extension://abc/page.html"), true);
  assert.equal(isRestrictedUrl("https://example.com"), false);
});

test("file urls require permission", () => {
  assert.equal(isRecoverableUrl("file:///tmp/a.txt", false), false);
  assert.equal(isRecoverableUrl("file:///tmp/a.txt", true), true);
});

test("blank workspace detection allows empty startup windows", () => {
  assert.equal(detectWorkspaceMode([]), RESTORE_STATES.BLANK_START_DETECTED);
  assert.equal(
    detectWorkspaceMode([
      {
        type: "normal",
        tabs: [{ url: "edge://newtab/" }]
      }
    ]),
    RESTORE_STATES.BLANK_START_DETECTED
  );
  assert.equal(
    detectWorkspaceMode([
      {
        type: "normal",
        tabs: [{ url: "https://example.com" }]
      }
    ]),
    RESTORE_STATES.BLOCKED_BY_ACTIVE_WORKSPACE
  );
});

test("blank workspace snapshots are not treated as stable sessions", () => {
  assert.equal(
    isBlankWorkspaceSnapshot({
      windows: [
        {
          type: "normal",
          tabs: [{ url: "edge://newtab/" }]
        }
      ]
    }),
    true
  );
  assert.equal(
    isBlankWorkspaceSnapshot({
      windows: [
        {
          type: "normal",
          tabs: [{ url: "https://example.com" }]
        }
      ]
    }),
    false
  );
});

test("newer stable snapshots can replace stale pending restore snapshots", () => {
  const oldPending = {
    capturedAt: 100,
    windows: [{ tabs: [{ url: "https://old.example" }], groups: [] }]
  };
  const newerStable = {
    capturedAt: 200,
    windows: [{ tabs: [{ url: "https://new.example" }], groups: [] }]
  };
  const olderStable = {
    capturedAt: 50,
    windows: [{ tabs: [{ url: "https://older.example" }], groups: [] }]
  };

  assert.equal(shouldReplacePendingSnapshot(newerStable, oldPending), true);
  assert.equal(shouldReplacePendingSnapshot(olderStable, oldPending), false);
  assert.equal(shouldReplacePendingSnapshot(newerStable, null), true);
  assert.equal(shouldReplacePendingSnapshot({ capturedAt: 300, windows: [] }, oldPending), false);
});

test("status payload reflects blocked workspace", () => {
  const payload = makeStatusPayload({
    pendingRestore: { active: true },
    lastWindowClosingSnapshot: {
      snapshotId: "snapshot_debug_123",
      schemaVersion: SCHEMA_VERSION,
      captureReason: CAPTURE_REASONS.LAST_WINDOW_CLOSING,
      capturedAt: 1,
      summary: { windowCount: 1, tabCount: 2, groupCount: 0, recoverableTabCount: 2, unrecoverableTabCount: 0 }
    },
    workspaceState: RESTORE_STATES.BLOCKED_BY_ACTIVE_WORKSPACE
  });

  assert.equal(payload.state, RESTORE_STATES.BLOCKED_BY_ACTIVE_WORKSPACE);
  assert.deepEqual(payload.snapshotMeta, {
    snapshotId: "snapshot_debug_123",
    schemaVersion: SCHEMA_VERSION,
    captureReason: CAPTURE_REASONS.LAST_WINDOW_CLOSING,
    capturedAt: 1
  });
});

test("snapshot validation catches bad shapes", () => {
  assert.deepEqual(validateSnapshot(null), { ok: false, reason: "missing_snapshot" });
  assert.deepEqual(
    validateSnapshot({ schemaVersion: SCHEMA_VERSION + 1, windows: [{}] }),
    { ok: false, reason: "unsupported_schema" }
  );
  assert.deepEqual(
    validateSnapshot({ schemaVersion: SCHEMA_VERSION, windows: [] }),
    { ok: false, reason: "empty_windows" }
  );
  assert.deepEqual(
    validateSnapshot({ schemaVersion: SCHEMA_VERSION, windows: [{}] }),
    { ok: true }
  );
});
