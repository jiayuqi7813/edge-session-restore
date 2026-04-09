export const MESSAGE_TYPES = Object.freeze({
  GET_RESTORE_STATUS: "GET_RESTORE_STATUS",
  RESTORE_LAST_SESSION: "RESTORE_LAST_SESSION",
  DISMISS_PENDING_RESTORE: "DISMISS_PENDING_RESTORE",
  OPEN_RESTORE_PAGE: "OPEN_RESTORE_PAGE"
});

export const RESTORE_STATES = Object.freeze({
  IDLE: "idle",
  SNAPSHOT_READY: "snapshot_ready",
  PENDING_RESTORE: "pending_restore",
  BLANK_START_DETECTED: "blank_start_detected",
  RESTORE_PROMPT_SHOWN: "restore_prompt_shown",
  RESTORING: "restoring",
  RESTORE_DONE: "restore_done",
  DISMISSED: "dismissed",
  BLOCKED_BY_ACTIVE_WORKSPACE: "blocked_by_active_workspace",
  RESTORE_FAILED_PARTIAL: "restore_failed_partial"
});

export const CAPTURE_REASONS = Object.freeze({
  STEADY_STATE: "steady_state",
  LAST_WINDOW_CLOSING: "last_window_closing",
  PRE_RESTORE_BACKUP: "pre_restore_backup"
});

export const STORAGE_KEYS = Object.freeze({
  LATEST_STABLE_SNAPSHOT: "latestStableSnapshot",
  LAST_WINDOW_CLOSING_SNAPSHOT: "lastWindowClosingSnapshot",
  PRE_RESTORE_BACKUP: "preRestoreBackup",
  PENDING_RESTORE: "pendingRestore",
  RESTORE_TRANSACTION: "restoreTransaction",
  DIAGNOSTICS: "diagnostics",
  SETTINGS: "settings"
});

export const SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  debounceMs: 500,
  maxSnapshots: 3
});
