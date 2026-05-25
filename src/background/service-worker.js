import {
  createEmptyDiagnostics,
  createId,
  createSnapshot,
  detectWorkspaceMode,
  isBlankWorkspaceSnapshot,
  isRecoverableUrl,
  isRestrictedUrl,
  makeStatusPayload,
  shouldReplacePendingSnapshot,
  snapshotForBackup,
  validateSnapshot
} from "../shared/core.js";
import {
  CAPTURE_REASONS,
  DEFAULT_SETTINGS,
  MESSAGE_TYPES,
  RESTORE_STATES,
  STORAGE_KEYS
} from "../shared/protocol.js";

const SNAPSHOT_EVENT_NAMES = [
  "tabs.onCreated",
  "tabs.onUpdated",
  "tabs.onMoved",
  "tabs.onAttached",
  "tabs.onDetached",
  "tabs.onRemoved",
  "tabs.onActivated",
  "windows.onCreated",
  "windows.onRemoved",
  "windows.onBoundsChanged",
  "tabGroups.onCreated",
  "tabGroups.onUpdated",
  "tabGroups.onRemoved"
];

let debounceTimer = null;

async function getStorage(keys) {
  return chrome.storage.local.get(keys);
}

async function setStorage(value) {
  return chrome.storage.local.set(value);
}

async function removeStorage(keys) {
  return chrome.storage.local.remove(keys);
}

async function getState() {
  const state = await getStorage(Object.values(STORAGE_KEYS));
  return {
    latestStableSnapshot: state[STORAGE_KEYS.LATEST_STABLE_SNAPSHOT] || null,
    lastWindowClosingSnapshot: state[STORAGE_KEYS.LAST_WINDOW_CLOSING_SNAPSHOT] || null,
    preRestoreBackup: state[STORAGE_KEYS.PRE_RESTORE_BACKUP] || null,
    pendingRestore: state[STORAGE_KEYS.PENDING_RESTORE] || null,
    restoreTransaction: state[STORAGE_KEYS.RESTORE_TRANSACTION] || null,
    diagnostics: state[STORAGE_KEYS.DIAGNOSTICS] || createEmptyDiagnostics(),
    settings: { ...DEFAULT_SETTINGS, ...(state[STORAGE_KEYS.SETTINGS] || {}) }
  };
}

function promiseFromCallback(fn) {
  return new Promise((resolve, reject) => {
    fn((result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

async function getFileAccessAllowed() {
  if (!chrome.extension?.isAllowedFileSchemeAccess) {
    return false;
  }

  try {
    return await promiseFromCallback((done) => chrome.extension.isAllowedFileSchemeAccess(done));
  } catch {
    return false;
  }
}

async function listNormalWindows() {
  const windows = await chrome.windows.getAll({ populate: true });
  return windows.filter((windowItem) => windowItem.type === "normal" && !windowItem.incognito);
}

async function buildWindowSnapshot(windowItem, allowFileAccess) {
  const tabs = [...(windowItem.tabs || [])].sort((left, right) => left.index - right.index);
  const groupIds = [...new Set(tabs.map((tab) => tab.groupId).filter((groupId) => groupId >= 0))];
  const groups = [];
  const groupById = new Map();

  for (const groupId of groupIds) {
    try {
      const group = await chrome.tabGroups.get(groupId);
      const groupKey = `${windowItem.id}:${groupId}`;
      const normalized = {
        groupKey,
        title: group.title || "",
        color: group.color,
        collapsed: Boolean(group.collapsed),
        tabKeys: []
      };
      groups.push(normalized);
      groupById.set(groupId, normalized);
    } catch {
      // Ignore transient group fetch failures.
    }
  }

  const normalizedTabs = tabs.map((tab) => {
    const url = tab.url || "";
    const pendingUrl = tab.pendingUrl || "";
    const effectiveUrl = pendingUrl || url;
    const group = tab.groupId >= 0 ? groupById.get(tab.groupId) : null;
    const tabKey = `${windowItem.id}:${tab.id}`;
    const recoverable = isRecoverableUrl(effectiveUrl, allowFileAccess);

    if (group) {
      group.tabKeys.push(tabKey);
    }

    return {
      tabKey,
      url,
      pendingUrl,
      title: tab.title || "",
      index: tab.index,
      active: Boolean(tab.active),
      pinned: Boolean(tab.pinned),
      groupKey: group?.groupKey || null,
      recoverable
    };
  });

  return {
    windowKey: `window_${windowItem.id}`,
    type: "normal",
    state: windowItem.state || "normal",
    focused: Boolean(windowItem.focused),
    left: Number.isFinite(windowItem.left) ? windowItem.left : null,
    top: Number.isFinite(windowItem.top) ? windowItem.top : null,
    width: Number.isFinite(windowItem.width) ? windowItem.width : null,
    height: Number.isFinite(windowItem.height) ? windowItem.height : null,
    tabs: normalizedTabs,
    groups
  };
}

async function buildCurrentSnapshot(captureReason = CAPTURE_REASONS.STEADY_STATE) {
  const allowFileAccess = await getFileAccessAllowed();
  const normalWindows = await listNormalWindows();
  const snapshotWindows = [];

  for (const windowItem of normalWindows) {
    snapshotWindows.push(await buildWindowSnapshot(windowItem, allowFileAccess));
  }

  return createSnapshot(snapshotWindows, captureReason);
}

async function updateBadge(pendingRestore) {
  if (pendingRestore?.active && !pendingRestore?.dismissedAt) {
    await chrome.action.setBadgeBackgroundColor({ color: "#7a3e00" });
    await chrome.action.setBadgeText({ text: "恢复" });
    return;
  }

  await chrome.action.setBadgeText({ text: "" });
}

async function updateDiagnostics(partial) {
  const state = await getState();
  const nextDiagnostics = {
    ...state.diagnostics,
    ...partial
  };
  await setStorage({
    [STORAGE_KEYS.DIAGNOSTICS]: nextDiagnostics
  });
  return nextDiagnostics;
}

async function clearErrorDiagnostics() {
  await updateDiagnostics({
    lastErrorCode: null,
    lastErrorStage: null
  });
}

async function setErrorDiagnostics(code, stage) {
  await updateDiagnostics({
    lastErrorCode: code,
    lastErrorStage: stage
  });
}

async function persistSnapshotState(triggerName) {
  const state = await getState();
  const snapshot = await buildCurrentSnapshot(CAPTURE_REASONS.STEADY_STATE);

  if (snapshot.windows.length > 0) {
    if (isBlankWorkspaceSnapshot(snapshot)) {
      return;
    }

    await setStorage({
      [STORAGE_KEYS.LATEST_STABLE_SNAPSHOT]: snapshot
    });
    await updateDiagnostics({
      lastSnapshotAt: snapshot.capturedAt
    });

    if (!state.pendingRestore?.active) {
      await updateBadge(state.pendingRestore);
    }

    return;
  }

  const sourceSnapshot = state.latestStableSnapshot;
  const shouldKeepPending =
    state.pendingRestore?.active &&
    !state.pendingRestore?.dismissedAt &&
    !shouldReplacePendingSnapshot(sourceSnapshot, state.lastWindowClosingSnapshot);
  if (shouldKeepPending) {
    return;
  }

  if (!sourceSnapshot?.windows?.length) {
    return;
  }

  const closingSnapshot = {
    ...sourceSnapshot,
    snapshotId: createId("snapshot"),
    captureReason: CAPTURE_REASONS.LAST_WINDOW_CLOSING,
    capturedAt: Date.now()
  };

  const pendingRestore = {
    active: true,
    createdAt: Date.now(),
    dismissedAt: null,
    sourceSnapshotId: closingSnapshot.snapshotId,
    lastTrigger: triggerName
  };

  await setStorage({
    [STORAGE_KEYS.LAST_WINDOW_CLOSING_SNAPSHOT]: closingSnapshot,
    [STORAGE_KEYS.PENDING_RESTORE]: pendingRestore
  });
  await clearErrorDiagnostics();
  await updateBadge(pendingRestore);
}

async function promoteSnapshotToPending(sourceSnapshot, triggerName) {
  if (!sourceSnapshot?.windows?.length) {
    return false;
  }

  const closingSnapshot = {
    ...sourceSnapshot,
    snapshotId: createId("snapshot"),
    captureReason: CAPTURE_REASONS.LAST_WINDOW_CLOSING,
    capturedAt: Date.now()
  };

  const pendingRestore = {
    active: true,
    createdAt: Date.now(),
    dismissedAt: null,
    sourceSnapshotId: closingSnapshot.snapshotId,
    lastTrigger: triggerName
  };

  await setStorage({
    [STORAGE_KEYS.LAST_WINDOW_CLOSING_SNAPSHOT]: closingSnapshot,
    [STORAGE_KEYS.PENDING_RESTORE]: pendingRestore
  });
  await clearErrorDiagnostics();
  await updateBadge(pendingRestore);
  return true;
}

async function maybePersistLastWindowClose(triggerName) {
  const state = await getState();
  const shouldKeepPending =
    state.pendingRestore?.active &&
    !state.pendingRestore?.dismissedAt &&
    !shouldReplacePendingSnapshot(state.latestStableSnapshot, state.lastWindowClosingSnapshot);
  if (shouldKeepPending) {
    return;
  }

  const snapshotWindowCount = state.latestStableSnapshot?.summary?.windowCount || 0;
  if (snapshotWindowCount === 1) {
    await promoteSnapshotToPending(state.latestStableSnapshot, `${triggerName}:snapshot_count`);
    return;
  }

  const normalWindows = await listNormalWindows();
  if (normalWindows.length > 0) {
    return;
  }

  const sourceSnapshot = state.latestStableSnapshot;
  await promoteSnapshotToPending(sourceSnapshot, `${triggerName}:no_windows`);
}

function scheduleSnapshot(triggerName) {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    persistSnapshotState(triggerName).catch(async (error) => {
      await setErrorDiagnostics(error.message || "snapshot_failed", "persist_snapshot");
    });
  }, DEFAULT_SETTINGS.debounceMs);
}

async function handleStartupRecovery() {
  const state = await getState();

  if (state.pendingRestore?.active && !state.pendingRestore?.dismissedAt) {
    return;
  }

  const source = state.latestStableSnapshot;
  if (!source?.windows?.length) {
    return;
  }

  await promoteSnapshotToPending(source, "startup_recovery");
}

async function initializeState() {
  const state = await getState();
  const rawState = await chrome.storage.local.get([
    STORAGE_KEYS.DIAGNOSTICS,
    STORAGE_KEYS.SETTINGS
  ]);
  const payload = {};

  if (!rawState[STORAGE_KEYS.DIAGNOSTICS]) {
    payload[STORAGE_KEYS.DIAGNOSTICS] = createEmptyDiagnostics();
  }

  if (!rawState[STORAGE_KEYS.SETTINGS]) {
    payload[STORAGE_KEYS.SETTINGS] = DEFAULT_SETTINGS;
  }

  if (Object.keys(payload).length > 0) {
    await setStorage(payload);
  }

  await repairOrAuditTransaction();
  await updateBadge((await getState()).pendingRestore);
}

async function repairOrAuditTransaction() {
  const state = await getState();
  const transaction = state.restoreTransaction;
  if (!transaction) {
    return;
  }

  if (transaction.stage === "finished") {
    await removeStorage([STORAGE_KEYS.RESTORE_TRANSACTION]);
    await clearErrorDiagnostics();
    return;
  }

  const startedAt = Number.isFinite(transaction.startedAt) ? transaction.startedAt : 0;
  const isStale = startedAt > 0 && Date.now() - startedAt > 2 * 60 * 1000;
  if (!isStale) {
    return;
  }

  await bestEffortRollback(transaction);
  await removeStorage([STORAGE_KEYS.RESTORE_TRANSACTION]);
  await setErrorDiagnostics("stale_restore_transaction", transaction.stage || "unknown");
}

async function getWorkspaceState() {
  const normalWindows = await listNormalWindows();
  return detectWorkspaceMode(normalWindows);
}

async function getStatusPayload() {
  await repairOrAuditTransaction();
  const state = await getState();
  const workspaceState = await getWorkspaceState();
  return makeStatusPayload({
    pendingRestore: state.pendingRestore,
    lastWindowClosingSnapshot: state.lastWindowClosingSnapshot,
    diagnostics: state.diagnostics,
    workspaceState,
    restoreTransaction: state.restoreTransaction
  });
}

function getRecoverableWindowBlueprints(snapshot) {
  return snapshot.windows
    .map((windowItem) => ({
      ...windowItem,
      tabs: windowItem.tabs.filter((tab) => tab.recoverable !== false && !isRestrictedUrl(tab.pendingUrl || tab.url))
    }))
    .filter((windowItem) => windowItem.tabs.length > 0);
}

function buildWindowCreateData(windowItem, initialUrl) {
  const base = {
    focused: false,
    url: initialUrl || "about:blank",
    type: "normal"
  };

  if (windowItem.state === "normal") {
    return {
      ...base,
      left: Number.isFinite(windowItem.left) ? windowItem.left : undefined,
      top: Number.isFinite(windowItem.top) ? windowItem.top : undefined,
      width: Number.isFinite(windowItem.width) ? windowItem.width : undefined,
      height: Number.isFinite(windowItem.height) ? windowItem.height : undefined
    };
  }

  return base;
}

async function applyWindowGeometry(windowId, windowItem) {
  const updateInfo = {};

  if (windowItem.state === "normal") {
    if (Number.isFinite(windowItem.left)) {
      updateInfo.left = windowItem.left;
    }
    if (Number.isFinite(windowItem.top)) {
      updateInfo.top = windowItem.top;
    }
    if (Number.isFinite(windowItem.width)) {
      updateInfo.width = windowItem.width;
    }
    if (Number.isFinite(windowItem.height)) {
      updateInfo.height = windowItem.height;
    }
  } else {
    updateInfo.state = windowItem.state;
  }

  if (Object.keys(updateInfo).length > 0) {
    await chrome.windows.update(windowId, updateInfo);
  }
}

async function updateTabFromSnapshot(tabId, tab) {
  await chrome.tabs.update(tabId, {
    url: tab.pendingUrl || tab.url,
    pinned: Boolean(tab.pinned),
    active: Boolean(tab.active)
  });
}

async function findReusableCurrentWindow(sender) {
  if (!sender?.tab?.windowId) {
    return null;
  }

  const windowId = sender.tab.windowId;
  const [windowItem] = await chrome.windows.getAll({ populate: true }).then((windows) => windows.filter((item) => item.id === windowId));
  if (!windowItem || windowItem.type !== "normal" || windowItem.incognito) {
    return null;
  }

  const workspaceState = detectWorkspaceMode([windowItem]);
  if (workspaceState !== RESTORE_STATES.BLANK_START_DETECTED) {
    return null;
  }

  return windowItem;
}

async function recordTransaction(transaction) {
  await setStorage({
    [STORAGE_KEYS.RESTORE_TRANSACTION]: transaction
  });
}

async function bestEffortRollback(transaction) {
  const tabIds = [...new Set(transaction.createdTabIds || [])];
  if (tabIds.length > 0) {
    try {
      await chrome.tabs.remove(tabIds);
    } catch {
      // Ignore cleanup failures.
    }
  }

  const windowIds = [...new Set(transaction.createdWindowIds || [])];
  for (const windowId of windowIds) {
    try {
      await chrome.windows.remove(windowId);
    } catch {
      // Ignore cleanup failures.
    }
  }
}

async function finishRestore(transaction) {
  transaction.stage = "finished";
  await recordTransaction(transaction);
  await removeStorage([STORAGE_KEYS.RESTORE_TRANSACTION]);
}

async function restoreLastSession({ force = false, sender = null } = {}) {
  await repairOrAuditTransaction();
  const state = await getState();
  if (state.restoreTransaction) {
    return {
      ok: false,
      error: "restore_in_progress"
    };
  }

  const snapshot = state.lastWindowClosingSnapshot;
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) {
    await setErrorDiagnostics(validation.reason, "validate_snapshot");
    return {
      ok: false,
      error: validation.reason
    };
  }

  const workspaceState = await getWorkspaceState();
  if (workspaceState !== RESTORE_STATES.BLANK_START_DETECTED && !force) {
    return {
      ok: false,
      error: "workspace_blocked",
      requiresForce: true
    };
  }

  const windowsToRestore = getRecoverableWindowBlueprints(snapshot);
  if (windowsToRestore.length === 0) {
    await setErrorDiagnostics("no_recoverable_tabs", "prepare_restore");
    return {
      ok: false,
      error: "no_recoverable_tabs"
    };
  }

  const transaction = {
    transactionId: createId("restore"),
    startedAt: Date.now(),
    sourceSnapshotId: snapshot.snapshotId,
    createdWindowIds: [],
    createdTabIds: [],
    stage: "start"
  };

  await setStorage({
    [STORAGE_KEYS.PRE_RESTORE_BACKUP]: snapshotForBackup(snapshot),
    [STORAGE_KEYS.RESTORE_TRANSACTION]: transaction
  });
  await updateDiagnostics({
    lastRestoreStartedAt: Date.now(),
    lastCreatedWindowCount: 0,
    lastCreatedTabCount: 0
  });
  await clearErrorDiagnostics();

  try {
    const tabKeyToId = new Map();
    const reusableWindow = workspaceState === RESTORE_STATES.BLANK_START_DETECTED ? await findReusableCurrentWindow(sender) : null;
    let activeWindowId = null;

    for (let windowIndex = 0; windowIndex < windowsToRestore.length; windowIndex += 1) {
      const windowItem = windowsToRestore[windowIndex];
      const sortedTabs = [...windowItem.tabs].sort((left, right) => left.index - right.index);
      const [firstTab, ...restTabs] = sortedTabs;
      let targetWindow;
      let seedTabId = null;
      let createdWindow = false;

      transaction.stage = `window_${windowIndex}_create`;
      await recordTransaction(transaction);

      if (windowIndex === 0 && reusableWindow) {
        targetWindow = reusableWindow;
        const placeholderTabs = [...(reusableWindow.tabs || [])].sort((left, right) => left.index - right.index);
        const placeholder = placeholderTabs[0];
        if (!placeholder) {
          throw new Error("missing_placeholder_tab");
        }
        seedTabId = placeholder.id;
        await updateTabFromSnapshot(seedTabId, firstTab);
      } else {
        const created = await chrome.windows.create(buildWindowCreateData(windowItem, firstTab.pendingUrl || firstTab.url));
        targetWindow = created;
        createdWindow = true;
        transaction.createdWindowIds.push(created.id);
        const createdTabs = created.tabs || [];
        seedTabId = createdTabs[0]?.id || null;
        if (!seedTabId) {
          throw new Error("missing_seed_tab");
        }
        await updateTabFromSnapshot(seedTabId, firstTab);
      }

      if (createdWindow) {
        await updateDiagnostics({
          lastCreatedWindowCount: transaction.createdWindowIds.length
        });
      }

      tabKeyToId.set(firstTab.tabKey, seedTabId);
      transaction.createdTabIds.push(seedTabId);

      for (const tab of restTabs) {
        transaction.stage = `window_${windowIndex}_tab_${tab.index}`;
        await recordTransaction(transaction);
        const createdTab = await chrome.tabs.create({
          windowId: targetWindow.id,
          url: tab.pendingUrl || tab.url,
          index: tab.index,
          active: Boolean(tab.active),
          pinned: Boolean(tab.pinned)
        });
        tabKeyToId.set(tab.tabKey, createdTab.id);
        transaction.createdTabIds.push(createdTab.id);
      }

      for (const group of windowItem.groups) {
        const tabIds = group.tabKeys.map((tabKey) => tabKeyToId.get(tabKey)).filter(Boolean);
        if (tabIds.length === 0) {
          continue;
        }
        transaction.stage = `window_${windowIndex}_group_${group.groupKey}`;
        await recordTransaction(transaction);
        const groupId = await chrome.tabs.group({
          tabIds
        });
        await chrome.tabGroups.update(groupId, {
          title: group.title || "",
          color: group.color,
          collapsed: Boolean(group.collapsed)
        });
      }

      const activeTab = sortedTabs.find((tab) => tab.active) || firstTab;
      const activeTabId = tabKeyToId.get(activeTab.tabKey);
      if (activeTabId) {
        await chrome.tabs.update(activeTabId, { active: true });
      }

      await applyWindowGeometry(targetWindow.id, windowItem);

      if (windowItem.focused) {
        activeWindowId = targetWindow.id;
      }
    }

    if (activeWindowId) {
      await chrome.windows.update(activeWindowId, { focused: true });
    }

    transaction.stage = "finished";
    await finishRestore(transaction);

    const clearedPending = {
      active: false,
      createdAt: state.pendingRestore?.createdAt || null,
      dismissedAt: null,
      sourceSnapshotId: snapshot.snapshotId
    };

    await setStorage({
      [STORAGE_KEYS.PENDING_RESTORE]: clearedPending
    });
    await removeStorage([STORAGE_KEYS.LAST_WINDOW_CLOSING_SNAPSHOT]);
    await updateDiagnostics({
      lastRestoreFinishedAt: Date.now(),
      lastCreatedWindowCount: transaction.createdWindowIds.length,
      lastCreatedTabCount: transaction.createdTabIds.length
    });
    await clearErrorDiagnostics();
    await updateBadge(clearedPending);

    return {
      ok: true
    };
  } catch (error) {
    await setErrorDiagnostics(error.message || "restore_failed", transaction.stage || "restore");
    await bestEffortRollback(transaction);
    await updateDiagnostics({
      lastRestoreFinishedAt: Date.now(),
      lastCreatedWindowCount: transaction.createdWindowIds.length,
      lastCreatedTabCount: transaction.createdTabIds.length
    });
    await setStorage({
      [STORAGE_KEYS.PENDING_RESTORE]: {
        ...(state.pendingRestore || {}),
        active: true,
        sourceSnapshotId: snapshot.snapshotId
      }
    });
    await removeStorage([STORAGE_KEYS.RESTORE_TRANSACTION]);
    await updateBadge({ active: true, dismissedAt: null });
    return {
      ok: false,
      error: error.message || "restore_failed"
    };
  }
}

async function dismissPendingRestore() {
  const state = await getState();
  if (!state.pendingRestore?.active) {
    await updateBadge(null);
    return {
      ok: true
    };
  }

  const nextPending = {
    ...(state.pendingRestore || { active: true }),
    active: true,
    dismissedAt: Date.now()
  };
  await setStorage({
    [STORAGE_KEYS.PENDING_RESTORE]: nextPending
  });
  await removeStorage([STORAGE_KEYS.LAST_WINDOW_CLOSING_SNAPSHOT]);
  await updateBadge(nextPending);
  return {
    ok: true
  };
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case MESSAGE_TYPES.GET_RESTORE_STATUS:
      return getStatusPayload();
    case MESSAGE_TYPES.RESTORE_LAST_SESSION:
      return restoreLastSession({
        force: Boolean(message.force),
        sender
      });
    case MESSAGE_TYPES.DISMISS_PENDING_RESTORE:
      return dismissPendingRestore();
    case MESSAGE_TYPES.OPEN_RESTORE_PAGE:
      return { ok: true };
    default:
      return { ok: false, error: "unknown_message" };
  }
}

function bindSnapshotListeners() {
  chrome.tabs.onCreated.addListener(() => scheduleSnapshot(SNAPSHOT_EVENT_NAMES[0]));
  chrome.tabs.onUpdated.addListener(() => scheduleSnapshot(SNAPSHOT_EVENT_NAMES[1]));
  chrome.tabs.onMoved.addListener(() => scheduleSnapshot(SNAPSHOT_EVENT_NAMES[2]));
  chrome.tabs.onAttached.addListener(() => scheduleSnapshot(SNAPSHOT_EVENT_NAMES[3]));
  chrome.tabs.onDetached.addListener(() => scheduleSnapshot(SNAPSHOT_EVENT_NAMES[4]));
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (removeInfo?.isWindowClosing) {
      maybePersistLastWindowClose("tabs.onRemoved.windowClosing").catch(async (error) => {
        await setErrorDiagnostics(error.message || "close_detection_failed", "tabs.onRemoved.windowClosing");
      });
    }
    scheduleSnapshot(SNAPSHOT_EVENT_NAMES[5]);
  });
  chrome.tabs.onActivated.addListener(() => scheduleSnapshot(SNAPSHOT_EVENT_NAMES[6]));
  chrome.windows.onCreated.addListener(() => scheduleSnapshot(SNAPSHOT_EVENT_NAMES[7]));
  chrome.windows.onRemoved.addListener(() => {
    maybePersistLastWindowClose("windows.onRemoved").catch(async (error) => {
      await setErrorDiagnostics(error.message || "close_detection_failed", "windows.onRemoved");
    });
    scheduleSnapshot(SNAPSHOT_EVENT_NAMES[8]);
  });
  chrome.windows.onBoundsChanged.addListener(() => scheduleSnapshot(SNAPSHOT_EVENT_NAMES[9]));
  chrome.tabGroups.onCreated.addListener(() => scheduleSnapshot(SNAPSHOT_EVENT_NAMES[10]));
  chrome.tabGroups.onUpdated.addListener(() => scheduleSnapshot(SNAPSHOT_EVENT_NAMES[11]));
  chrome.tabGroups.onRemoved.addListener(() => scheduleSnapshot(SNAPSHOT_EVENT_NAMES[12]));
}

chrome.runtime.onInstalled.addListener(() => {
  initializeState().catch(() => {
    // Ignore startup failures.
  });
  scheduleSnapshot("runtime.onInstalled");
});

chrome.runtime.onStartup.addListener(() => {
  handleStartupRecovery()
    .then(() => initializeState())
    .then(() => scheduleSnapshot("runtime.onStartup"))
    .catch(() => {
      initializeState().catch(() => {});
      scheduleSnapshot("runtime.onStartup");
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(async (error) => {
      await setErrorDiagnostics(error.message || "message_failed", "runtime.onMessage");
      sendResponse({
        ok: false,
        error: error.message || "message_failed"
      });
    });
  return true;
});

bindSnapshotListeners();
initializeState().catch(() => {
  // Ignore bootstrap failures.
});
scheduleSnapshot("bootstrap");
