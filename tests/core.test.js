import test from "node:test";
import assert from "node:assert/strict";

import {
  detectWorkspaceMode,
  isRecoverableUrl,
  isRestrictedUrl,
  makeStatusPayload,
  validateSnapshot
} from "../src/shared/core.js";
import {
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

test("status payload reflects blocked workspace", () => {
  const payload = makeStatusPayload({
    pendingRestore: { active: true },
    lastWindowClosingSnapshot: {
      capturedAt: 1,
      summary: { windowCount: 1, tabCount: 2, groupCount: 0, recoverableTabCount: 2, unrecoverableTabCount: 0 }
    },
    workspaceState: RESTORE_STATES.BLOCKED_BY_ACTIVE_WORKSPACE
  });

  assert.equal(payload.state, RESTORE_STATES.BLOCKED_BY_ACTIVE_WORKSPACE);
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
