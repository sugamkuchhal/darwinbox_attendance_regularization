// Timeout for waiting for the modal/panel to open and be ready.
const MODAL_OPEN_TIMEOUT_MS = 15000;

// Timeout for the ⋮ context menu button click itself.
const CONTEXT_MENU_CLICK_TIMEOUT_MS = 10000;

const ATTEMPTS_PER_REASON = 2;
const UI_SLEEP_SHORT_MS = 300;
const UI_SLEEP_MENU_MS = 800;
const UI_SLEEP_RETRY_BASE_MS = 500;
const UI_SLEEP_SUBMIT_MS = 3000;
const REASON_OPTION_WAIT_MS = 3000;
const REASON_UI_SLEEP_MS = 300;
const DEFAULT_REASON_PRIORITY = "Forgot To Punch,Outdoor Duty,Work From Home,In / Out Swiping Mistake";

// Exponential backoff for retry delays: attempt 1 -> base, attempt 2 -> base*2, etc.
function retryDelayMs(attempt) {
  return UI_SLEEP_RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt - 1));
}

module.exports = {
  ATTEMPTS_PER_REASON,
  MODAL_OPEN_TIMEOUT_MS,
  CONTEXT_MENU_CLICK_TIMEOUT_MS,
  UI_SLEEP_SHORT_MS,
  UI_SLEEP_MENU_MS,
  UI_SLEEP_RETRY_BASE_MS,
  UI_SLEEP_SUBMIT_MS,
  REASON_OPTION_WAIT_MS,
  REASON_UI_SLEEP_MS,
  DEFAULT_REASON_PRIORITY,
  retryDelayMs,
};
