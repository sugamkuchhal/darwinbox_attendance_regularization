const { DARWINBOX_URL, WAIT_MINUTES, TIMEOUT_MS, POLL_INTERVAL_MS, MFA_METHOD_ORDER } = require("./config");
const { sleep } = require("./utils");
const { createGitHubIssue, closeGitHubIssue, pollIssueForCode } = require("./github");

// ─── Shared MFA helpers ───────────────────────────────────────────────────────

// Click an element trying multiple selectors, return true if any succeeded.
async function clickOption(page, selectors, label) {
  for (const sel of selectors) {
    try {
      await page.click(sel, { timeout: 2000 });
      console.log(`✅ Clicked [${label}]: ${sel}`);
      return true;
    } catch (_) {}
  }
  console.warn(`⚠️ Could not click [${label}]`);
  return false;
}

// Navigate back to the method picker screen between MFA attempts.
async function goToMethodPicker(page) {
  try {
    await page.click(
      'a:has-text("Sign in another way"), a:has-text("other way"), a:has-text("different")',
      { timeout: 3000 }
    );
    await sleep(1500);
    console.log("✅ Back to method picker");
  } catch (_) {
    console.warn("⚠️ Could not navigate to method picker — may already be there");
  }
}

// Poll the page until it reaches Darwinbox. Returns true if approved, false on timeout.
async function pollPageForApproval(page, label) {
  const deadline      = Date.now() + TIMEOUT_MS;
  const darwinboxHost = new URL(DARWINBOX_URL).hostname;
  console.log(`⏳ [${label}] Waiting up to ${WAIT_MINUTES * 60}s for approval (watching for ${darwinboxHost})...`);
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const currentUrl  = page.url();
    const onDarwinbox = currentUrl.includes(darwinboxHost);
    const secsLeft    = Math.round((deadline - Date.now()) / 1000);
    console.log(`⏳ [${label}] Current URL: ${currentUrl} — ${secsLeft}s remaining`);
    if (onDarwinbox) {
      console.log(`✅ [${label}] Reached Darwinbox — approved!`);
      await page.screenshot({ path: `approved_${label}.png` });
      return true;
    }
  }
  console.warn(`⚠️ [${label}] Did not reach Darwinbox within ${WAIT_MINUTES * 60}s`);
  await page.screenshot({ path: `timeout_${label}.png` });
  return false;
}

// ─── MFA method functions ─────────────────────────────────────────────────────
// Each returns: { success: true, code: string|null } on success
//               { success: false }                   on timeout/failure
// code is null for push/call (page navigates automatically), string for code-based methods.

async function tryMfaPush(page) {
  const LABEL = "MFA_PUSH";
  console.log(`\n🔔 [${LABEL}] Sending push notification via Microsoft Authenticator...`);

  await clickOption(page, [
    'div[data-value="PhoneAppNotification"]',
    '[data-bind*="PhoneAppNotification"]',
    'div:has-text("Approve a request")',
    'li:has-text("Approve a request")',
  ], LABEL);
  await sleep(2000);

  const issueNumber = await createGitHubIssue(
    "🔐 [MFA Push] Approve the Authenticator notification on your phone",
    `## Darwinbox automation: MFA Push approval needed\n\n` +
    `A push notification has been sent to your **Microsoft Authenticator app**.\n\n` +
    `**👉 Open your Authenticator app and tap Approve.**\n\n` +
    `⏰ You have **${WAIT_MINUTES * 60} seconds**. No reply needed here — just approve on your phone.\n\n` +
    `_This issue will close automatically. If you miss it, the next method will be tried._`
  );

  const approved = await pollPageForApproval(page, LABEL);

  if (approved) {
    await closeGitHubIssue(issueNumber, "✅ Push approved! Continuing with login...");
    return { success: true, code: null };
  }

  await closeGitHubIssue(issueNumber, `⏰ Push not approved in ${WAIT_MINUTES * 60}s. Trying next method...`);
  return { success: false };
}

async function tryMfaCode(page) {
  const LABEL = "MFA_CODE";
  console.log(`\n🔢 [${LABEL}] Requesting 6-digit code from Microsoft Authenticator...`);

  await clickOption(page, [
    'div[data-value="PhoneAppOTP"]',
    '[data-bind*="PhoneAppOTP"]',
    'div:has-text("Use a verification code")',
    'li:has-text("verification code")',
  ], LABEL);
  await sleep(2000);

  const issueNumber = await createGitHubIssue(
    "🔐 [MFA Code] Enter your Authenticator app code",
    `## Darwinbox automation: Authenticator app code needed\n\n` +
    `Open your **Microsoft Authenticator app** and find the 6-digit code for your Arvind account.\n\n` +
    `**👉 Reply to this issue with just the code** (e.g. \`123456\`)\n\n` +
    `⏰ You have **${WAIT_MINUTES * 60} seconds** to respond.\n\n` +
    `_Authenticator codes rotate every 30 seconds — reply quickly._`
  );

  const code = await pollIssueForCode(issueNumber, LABEL);

  if (code) {
    await closeGitHubIssue(issueNumber, "✅ Code received. Submitting now...");
    return { success: true, code };
  }

  await closeGitHubIssue(issueNumber, `⏰ No code received in ${WAIT_MINUTES * 60}s. Trying next method...`);
  return { success: false };
}

async function tryCall(page) {
  const LABEL = "CALL";
  console.log(`\n📞 [${LABEL}] Triggering voice call to registered phone number...`);

  await clickOption(page, [
    '[data-value*="Voice"]',
    '[data-bind*="OneWayVoiceMobile"]',
    '[data-value*="voice"]',
  ], LABEL);
  await sleep(2000);

  // After clicking Call, Microsoft calls your phone — you answer and press #.
  // The page then navigates forward automatically — no code to enter.
  const issueNumber = await createGitHubIssue(
    "📞 [Call] Answer your phone to approve Darwinbox sign-in",
    `## Darwinbox automation: Voice call approval needed\n\n` +
    `Your phone is being called now.\n\n` +
    `**👉 Answer the call and follow the instructions (press # to approve).**\n\n` +
    `⏰ You have **${WAIT_MINUTES * 60} seconds**. No reply needed here — just answer your phone.\n\n` +
    `_This issue will close automatically once approved. If missed, the next method will be tried._`
  );

  const approved = await pollPageForApproval(page, LABEL);

  if (approved) {
    await closeGitHubIssue(issueNumber, "✅ Call approved! Continuing with login...");
    return { success: true, code: null };
  }

  await closeGitHubIssue(issueNumber, `⏰ Call not answered within ${WAIT_MINUTES * 60}s. Trying next method...`);
  return { success: false };
}

async function tryText(page) {
  const LABEL = "TEXT";
  console.log(`\n📱 [${LABEL}] Sending OTP via SMS...`);

  await clickOption(page, [
    'div[data-value="OneWaySMS"]',
    '[data-bind*="OneWaySMS"]',
    'div:has-text("Text +")',
    'li:has-text("Text +")',
  ], LABEL);
  await sleep(2000);

  const issueNumber = await createGitHubIssue(
    "🔐 [SMS] Enter the OTP sent to your phone",
    `## Darwinbox automation: SMS OTP needed\n\n` +
    `An OTP has been sent to your phone via **SMS**.\n\n` +
    `**👉 Reply to this issue with just the OTP** (e.g. \`123456\`)\n\n` +
    `⏰ You have **${WAIT_MINUTES * 60} seconds** to respond.`
  );

  const code = await pollIssueForCode(issueNumber, LABEL);

  if (code) {
    await closeGitHubIssue(issueNumber, "✅ OTP received. Submitting now...");
    return { success: true, code };
  }

  await closeGitHubIssue(issueNumber, `⏰ No OTP received in ${WAIT_MINUTES * 60}s. This was the last method.`);
  return { success: false };
}

// ─── Method registry ──────────────────────────────────────────────────────────
const MFA_METHODS = {
  MFA_PUSH: tryMfaPush,
  MFA_CODE: tryMfaCode,
  CALL:     tryCall,
  TEXT:     tryText,
};

// ─── MFA pipeline ─────────────────────────────────────────────────────────────
// Iterates MFA_METHOD_ORDER, tries each in sequence.
// Returns the OTP code string (or null for push/call), or throws if all fail.
async function handleMFA(page) {
  console.log(`🔐 MFA detected. Trying: ${MFA_METHOD_ORDER.join(" → ")}`);
  await page.screenshot({ path: `mfa_screen_${Date.now()}.png` });

  for (let i = 0; i < MFA_METHOD_ORDER.length; i++) {
    const methodName = MFA_METHOD_ORDER[i];
    const methodFn   = MFA_METHODS[methodName];

    if (!methodFn) {
      console.warn(`⚠️ Unknown method "${methodName}" in MFA_METHOD_ORDER — skipping`);
      continue;
    }

    if (i > 0) await goToMethodPicker(page);

    const result = await methodFn(page);

    if (result.success) {
      return result.code;
    }

    console.log(`↩️  [${methodName}] failed — moving to next method`);
  }

  throw new Error(`All MFA methods exhausted (${MFA_METHOD_ORDER.join(", ")}) — no response received`);
}

module.exports = { handleMFA };
