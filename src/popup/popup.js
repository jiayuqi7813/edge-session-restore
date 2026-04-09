import { MESSAGE_TYPES, RESTORE_STATES } from "../shared/protocol.js";

const subline = document.querySelector("#subline");
const stateTag = document.querySelector("#stateTag");
const statusLine = document.querySelector("#statusLine");
const statusCopy = document.querySelector("#statusCopy");
const primaryButton = document.querySelector("#primaryButton");
const secondaryButton = document.querySelector("#secondaryButton");
const refreshButton = document.querySelector("#refreshButton");
const windowCount = document.querySelector("#windowCount");
const tabCount = document.querySelector("#tabCount");
const groupCount = document.querySelector("#groupCount");
const unrecoverableCount = document.querySelector("#unrecoverableCount");
const lastCapturedAt = document.querySelector("#lastCapturedAt");
const lastError = document.querySelector("#lastError");
const restoreTransaction = document.querySelector("#restoreTransaction");

let currentPayload = null;
let busy = false;

async function sendMessage(type, payload = {}) {
  return chrome.runtime.sendMessage({
    type,
    ...payload
  });
}

function formatTime(timestamp) {
  if (!timestamp) {
    return "暂无";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(timestamp));
}

function setCounts(summary) {
  windowCount.textContent = String(summary?.windowCount || 0);
  tabCount.textContent = String(summary?.tabCount || 0);
  groupCount.textContent = String(summary?.groupCount || 0);
  unrecoverableCount.textContent = String(summary?.unrecoverableTabCount || 0);
}

function setMeta(payload) {
  lastCapturedAt.textContent = formatTime(payload.lastCapturedAt || payload.diagnostics?.lastSnapshotAt);

  if (payload.diagnostics?.lastErrorCode) {
    lastError.textContent = `${payload.diagnostics.lastErrorCode} @ ${payload.diagnostics.lastErrorStage || "unknown"}`;
    lastError.dataset.error = "true";
  } else {
    lastError.textContent = "无";
    delete lastError.dataset.error;
  }

  restoreTransaction.textContent = payload.restoreTransaction
    ? `${payload.restoreTransaction.stage || "running"} / ${formatTime(payload.restoreTransaction.startedAt)}`
    : "空闲";
}

function setTag(text, tone = "neutral") {
  stateTag.textContent = text;
  stateTag.dataset.tone = tone;
}

function setButtons({ primaryText, secondaryText, showSecondary, primaryDisabled, secondaryDisabled }) {
  primaryButton.textContent = primaryText;
  primaryButton.disabled = primaryDisabled;
  secondaryButton.textContent = secondaryText;
  secondaryButton.hidden = !showSecondary;
  secondaryButton.disabled = secondaryDisabled;
}

function renderState(payload) {
  currentPayload = payload;
  setCounts(payload.summary);
  setMeta(payload);

  switch (payload.state) {
    case RESTORE_STATES.RESTORE_PROMPT_SHOWN:
      subline.textContent = "检测到一份待恢复会话";
      setTag("可恢复", "ready");
      statusLine.textContent = "当前处于空白工作区，可以直接恢复。";
      statusCopy.textContent = "如果这就是你刚才关掉的窗口集合，点击“恢复上次会话”即可。";
      setButtons({
        primaryText: "恢复上次会话",
        secondaryText: "不恢复",
        showSecondary: true,
        primaryDisabled: busy,
        secondaryDisabled: busy
      });
      break;
    case RESTORE_STATES.BLOCKED_BY_ACTIVE_WORKSPACE:
      subline.textContent = "当前已有工作区";
      setTag("需确认", "warn");
      statusLine.textContent = "恢复会把旧会话插入当前环境。";
      statusCopy.textContent = "只有你确认要这样做时，才建议继续恢复。";
      setButtons({
        primaryText: "仍然恢复",
        secondaryText: "先不恢复",
        showSecondary: true,
        primaryDisabled: busy,
        secondaryDisabled: busy
      });
      break;
    case RESTORE_STATES.RESTORING:
      subline.textContent = "恢复进行中";
      setTag("处理中", "busy");
      statusLine.textContent = "后台正在重建窗口和标签。";
      statusCopy.textContent = "如果窗口已经弹出，等布局稳定后再点刷新即可。";
      setButtons({
        primaryText: "恢复中",
        secondaryText: "不恢复",
        showSecondary: false,
        primaryDisabled: true,
        secondaryDisabled: true
      });
      break;
    case RESTORE_STATES.DISMISSED:
      subline.textContent = "本次恢复已忽略";
      setTag("已忽略", "neutral");
      statusLine.textContent = "你刚才选择了先不恢复。";
      statusCopy.textContent = "如果反悔了，直接点下面的恢复按钮即可重新尝试。";
      setButtons({
        primaryText: "重新恢复",
        secondaryText: "不恢复",
        showSecondary: false,
        primaryDisabled: busy,
        secondaryDisabled: true
      });
      break;
    case RESTORE_STATES.RESTORE_FAILED_PARTIAL:
      subline.textContent = "上次恢复未完成";
      setTag("异常", "error");
      statusLine.textContent = "可以重试，后台会继续使用之前保留的快照。";
      statusCopy.textContent = "如果错误持续出现，请先看下面的错误字段。";
      setButtons({
        primaryText: "重试恢复",
        secondaryText: "不恢复",
        showSecondary: true,
        primaryDisabled: busy,
        secondaryDisabled: busy
      });
      break;
    case RESTORE_STATES.SNAPSHOT_READY:
    case RESTORE_STATES.PENDING_RESTORE:
      subline.textContent = "存在可恢复快照";
      setTag("待恢复", "ready");
      statusLine.textContent = "你可以立即恢复上次保存的会话。";
      statusCopy.textContent = "如果当前已经有别的工作区，点击后会先做保护性判断。";
      setButtons({
        primaryText: "恢复上次会话",
        secondaryText: "不恢复",
        showSecondary: true,
        primaryDisabled: busy,
        secondaryDisabled: busy
      });
      break;
    default:
      subline.textContent = "当前没有待恢复会话";
      setTag("空闲", "neutral");
      statusLine.textContent = "没有检测到需要恢复的窗口集合。";
      statusCopy.textContent = "等你关闭最后一个普通窗口后，扩展会保存最近一次稳定快照。";
      setButtons({
        primaryText: "刷新状态",
        secondaryText: "不恢复",
        showSecondary: false,
        primaryDisabled: busy,
        secondaryDisabled: true
      });
      break;
  }
}

async function refreshStatus() {
  if (busy) {
    return;
  }

  refreshButton.disabled = true;
  try {
    const payload = await sendMessage(MESSAGE_TYPES.GET_RESTORE_STATUS);
    renderState(payload);
  } catch (error) {
    renderState({
      state: RESTORE_STATES.RESTORE_FAILED_PARTIAL,
      summary: null,
      diagnostics: {
        lastErrorCode: error.message || "popup_refresh_failed",
        lastErrorStage: "popup.js"
      },
      restoreTransaction: null
    });
  } finally {
    refreshButton.disabled = false;
  }
}

async function performPrimaryAction() {
  if (busy) {
    return;
  }

  if (!currentPayload || currentPayload.state === RESTORE_STATES.IDLE) {
    await refreshStatus();
    return;
  }

  busy = true;
  renderState(currentPayload);
  try {
    const force = currentPayload.state === RESTORE_STATES.BLOCKED_BY_ACTIVE_WORKSPACE;
    await sendMessage(MESSAGE_TYPES.RESTORE_LAST_SESSION, { force });
  } finally {
    busy = false;
  }
  await refreshStatus();
}

async function performSecondaryAction() {
  if (busy || secondaryButton.hidden) {
    return;
  }

  busy = true;
  renderState(currentPayload || { state: RESTORE_STATES.DISMISSED, summary: null, diagnostics: {} });
  try {
    await sendMessage(MESSAGE_TYPES.DISMISS_PENDING_RESTORE);
  } finally {
    busy = false;
  }
  await refreshStatus();
}

primaryButton.addEventListener("click", performPrimaryAction);
secondaryButton.addEventListener("click", performSecondaryAction);
refreshButton.addEventListener("click", refreshStatus);
window.addEventListener("focus", refreshStatus);

refreshStatus();
