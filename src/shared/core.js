import {
  CAPTURE_REASONS,
  MESSAGE_TYPES,
  RESTORE_STATES,
  SCHEMA_VERSION
} from "./protocol.js";

export const INTERNAL_PROTOCOL_PREFIXES = [
  "edge://",
  "chrome://",
  "about:",
  "devtools://",
  "javascript:",
  "chrome-extension://",
  "edge-extension://"
];

export function createId(prefix = "id") {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${randomPart}`;
}

export function isRestrictedUrl(url) {
  if (!url || typeof url !== "string") {
    return true;
  }

  return INTERNAL_PROTOCOL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export function isRecoverableUrl(url, allowFileAccess = false) {
  if (!url || typeof url !== "string") {
    return false;
  }

  if (url.startsWith("file://")) {
    return allowFileAccess;
  }

  return !isRestrictedUrl(url);
}

export function summarizeSnapshotWindows(windows) {
  let tabCount = 0;
  let groupCount = 0;
  let recoverableTabCount = 0;
  let unrecoverableTabCount = 0;

  for (const windowItem of windows) {
    tabCount += windowItem.tabs.length;
    groupCount += windowItem.groups.length;

    for (const tab of windowItem.tabs) {
      if (tab.recoverable === false) {
        unrecoverableTabCount += 1;
      } else {
        recoverableTabCount += 1;
      }
    }
  }

  return {
    windowCount: windows.length,
    tabCount,
    groupCount,
    recoverableTabCount,
    unrecoverableTabCount
  };
}

export function createEmptyDiagnostics() {
  return {
    lastSnapshotAt: null,
    lastRestoreStartedAt: null,
    lastRestoreFinishedAt: null,
    lastErrorCode: null,
    lastErrorStage: null,
    lastCreatedWindowCount: 0,
    lastCreatedTabCount: 0
  };
}

export function createSnapshot(windows, captureReason) {
  return {
    snapshotId: createId("snapshot"),
    schemaVersion: SCHEMA_VERSION,
    capturedAt: Date.now(),
    captureReason,
    summary: summarizeSnapshotWindows(windows),
    windows
  };
}

export function isBlankTabUrl(url) {
  return url === "edge://newtab/" || url === "chrome://newtab/" || url === "about:blank";
}

export function isExtensionRestoreUrl(url) {
  return typeof url === "string" && /restore\.html(?:[#?].*)?$/.test(url);
}

export function isBlankWorkspaceWindow(windowItem) {
  if (!windowItem || windowItem.type !== "normal" || !Array.isArray(windowItem.tabs)) {
    return false;
  }

  if (windowItem.tabs.length !== 1) {
    return false;
  }

  const [tab] = windowItem.tabs;
  const url = tab.pendingUrl || tab.url || "";
  return isBlankTabUrl(url) || isExtensionRestoreUrl(url);
}

export function detectWorkspaceMode(normalWindows) {
  if (!Array.isArray(normalWindows) || normalWindows.length === 0) {
    return RESTORE_STATES.BLANK_START_DETECTED;
  }

  if (normalWindows.length === 1 && isBlankWorkspaceWindow(normalWindows[0])) {
    return RESTORE_STATES.BLANK_START_DETECTED;
  }

  return RESTORE_STATES.BLOCKED_BY_ACTIVE_WORKSPACE;
}

export function makeStatusPayload({
  pendingRestore = null,
  lastWindowClosingSnapshot = null,
  diagnostics = createEmptyDiagnostics(),
  workspaceState = RESTORE_STATES.IDLE,
  restoreTransaction = null
} = {}) {
  const hasPending = Boolean(pendingRestore?.active && lastWindowClosingSnapshot);
  const summary = lastWindowClosingSnapshot?.summary || null;
  let state = RESTORE_STATES.IDLE;

  if (restoreTransaction) {
    state = RESTORE_STATES.RESTORING;
  } else if (hasPending && pendingRestore?.dismissedAt) {
    state = RESTORE_STATES.DISMISSED;
  } else if (hasPending && workspaceState === RESTORE_STATES.BLANK_START_DETECTED) {
    state = RESTORE_STATES.RESTORE_PROMPT_SHOWN;
  } else if (hasPending && workspaceState === RESTORE_STATES.BLOCKED_BY_ACTIVE_WORKSPACE) {
    state = RESTORE_STATES.BLOCKED_BY_ACTIVE_WORKSPACE;
  } else if (hasPending) {
    state = RESTORE_STATES.PENDING_RESTORE;
  } else if (summary) {
    state = RESTORE_STATES.SNAPSHOT_READY;
  }

  return {
    ok: true,
    state,
    summary,
    pendingRestore,
    diagnostics,
    restoreTransaction,
    lastCapturedAt: lastWindowClosingSnapshot?.capturedAt || null,
    messageTypes: MESSAGE_TYPES
  };
}

export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return { ok: false, reason: "missing_snapshot" };
  }

  if (snapshot.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: "unsupported_schema" };
  }

  if (!Array.isArray(snapshot.windows) || snapshot.windows.length === 0) {
    return { ok: false, reason: "empty_windows" };
  }

  return { ok: true };
}

export function filterRecoverableTabs(tabs) {
  return tabs.filter((tab) => tab.recoverable !== false && isRecoverableUrl(tab.pendingUrl || tab.url, true));
}

export function snapshotForBackup(snapshot) {
  return {
    ...snapshot,
    snapshotId: createId("snapshot"),
    capturedAt: Date.now(),
    captureReason: CAPTURE_REASONS.PRE_RESTORE_BACKUP
  };
}
