// ─── SECRETS (from GitHub Actions secrets) ───────────────────────────────────
const DARWINBOX_URL = process.env.DARWINBOX_URL;
const USERNAME      = process.env.DARWINBOX_USERNAME;
const PASSWORD      = process.env.DARWINBOX_PASSWORD;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPOSITORY;
const EMPLOYEE_ID   = process.env.DARWINBOX_EMPLOYEE_ID;

// ─── ATTENDANCE CONFIG (edit here, not in secrets) ───────────────────────────
// Punch-in:  random minute 0–30 added to 09:00  → range 09:00–09:30
// Punch-out: random minute 0–30 added to 18:00  → range 18:00–18:30
const PUNCH_IN_BASE_HOUR  = 9;
const PUNCH_OUT_BASE_HOUR = 18;
const PUNCH_RANDOM_MAX    = 30;         // max random minutes added to base hour
const REASON              = "Forgot To Punch"; // must match Darwinbox dropdown exactly

// ─── MFA CONFIG ───────────────────────────────────────────────────────────────
const WAIT_MINUTES = 2; // minutes to wait per MFA method before falling back

// ─── MFA METHOD ORDER ─────────────────────────────────────────────────────────
// Change order to reprioritise. Remove an entry to skip it entirely.
//   "MFA_PUSH" → Microsoft Authenticator push (tap Approve on phone)
//   "MFA_CODE" → 6-digit code from Authenticator app
//   "CALL"     → Voice call to your phone
//   "TEXT"     → SMS to your phone
const MFA_METHOD_ORDER = [
//  "MFA_PUSH",
//  "MFA_CODE",
  "CALL",
  "TEXT",
];

// ─── DERIVED CONSTANTS (do not edit) ─────────────────────────────────────────
const TIMEOUT_MS       = WAIT_MINUTES * 60 * 1000;
const POLL_INTERVAL_MS = 10000; // poll every 10 seconds

module.exports = {
  DARWINBOX_URL,
  USERNAME,
  PASSWORD,
  GITHUB_TOKEN,
  GITHUB_REPO,
  EMPLOYEE_ID,
  PUNCH_IN_BASE_HOUR,
  PUNCH_OUT_BASE_HOUR,
  PUNCH_RANDOM_MAX,
  REASON,
  WAIT_MINUTES,
  MFA_METHOD_ORDER,
  TIMEOUT_MS,
  POLL_INTERVAL_MS,
};
