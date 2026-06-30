const ATTEMPTS_PER_REASON = 2;
const MODAL_OPEN_TIMEOUT_MS = 5000;
const UI_SLEEP_SHORT_MS = 300;
const UI_SLEEP_MENU_MS = 800;
const UI_SLEEP_RETRY_BASE_MS = 500;
const UI_SLEEP_SUBMIT_MS = 3000;
const REASON_OPTION_WAIT_MS = 1500;
const REASON_OPTION_CLICK_MS = 2000;
const REASON_UI_SLEEP_MS = 300;
const DEFAULT_REASON_PRIORITY = "Forgot To Punch,Outdoor Duty,Work From Home,In / Out Swiping Mistake";

// Exponential backoff for retry delays: attempt 1 -> base, attempt 2 -> base*2, etc.
// Keeps behavior identical to the old fixed-delay constant for the first retry,
// but gives transient UI/network hiccups more room to clear on later attempts.
function retryDelayMs(attempt) {
  return UI_SLEEP_RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt - 1));
}

module.exports = {
  ATTEMPTS_PER_REASON,
  MODAL_OPEN_TIMEOUT_MS,
  UI_SLEEP_SHORT_MS,
  UI_SLEEP_MENU_MS,
  UI_SLEEP_RETRY_BASE_MS,
  UI_SLEEP_SUBMIT_MS,
  REASON_OPTION_WAIT_MS,
  REASON_OPTION_CLICK_MS,
  REASON_UI_SLEEP_MS,
  DEFAULT_REASON_PRIORITY,
  retryDelayMs,
};
