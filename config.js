// ─── SECRETS (from GitHub Actions secrets) ───────────────────────────────────
const DARWINBOX_URL = process.env.DARWINBOX_URL;
const USERNAME      = process.env.DARWINBOX_USERNAME;
const PASSWORD      = process.env.DARWINBOX_PASSWORD;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPOSITORY;
const EMPLOYEE_ID   = process.env.DARWINBOX_EMPLOYEE_ID;

// ─── MFA CONFIG ───────────────────────────────────────────────────────────────
const WAIT_MINUTES = 2; // minutes to wait per MFA method before falling back

// ─── MFA METHOD ORDER ─────────────────────────────────────────────────────────
// Change order to reprioritise. Remove an entry to skip it entirely.
//   "MFA_PUSH" → Microsoft Authenticator push (tap Approve on phone)
//   "MFA_CODE" → 6-digit code from Authenticator app
//   "CALL"     → Voice call to your phone
//   "TEXT"     → SMS to your phone
const MFA_METHOD_ORDER = [
  // "MFA_PUSH",
  // "MFA_CODE",
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
  WAIT_MINUTES,
  MFA_METHOD_ORDER,
  TIMEOUT_MS,
  POLL_INTERVAL_MS,
};
