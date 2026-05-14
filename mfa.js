const crypto = require("crypto");
const { DARWINBOX_URL, WAIT_MINUTES, TIMEOUT_MS, POLL_INTERVAL_MS, MFA_METHOD_ORDER, DARWINBOX_TOTP_SECRET } = require("./config");
const { sleep } = require("./utils");
const { createGitHubIssue, closeGitHubIssue, pollIssueForCode } = require("./github");

function base32ToBuffer(base32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = (base32 || "").toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = "";
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character "${ch}"`);
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotp(secret, timestampMs = Date.now(), stepSeconds = 30, digits = 6) {
  const key = base32ToBuffer(secret);
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  const otp = (binCode % (10 ** digits)).toString().padStart(digits, "0");
  return otp;
}

function getTotpCodes() {
  const rawSecret = (DARWINBOX_TOTP_SECRET || "").trim();
  if (!rawSecret || rawSecret === "123456") {
    throw new Error("DARWINBOX_TOTP_SECRET is missing/placeholder");
  }
  return {
    code: generateTotp(rawSecret),
    retryCode: generateTotp(rawSecret, Date.now() + 30_000),
  };
}

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

async function tryMfaCode(page) {
  const LABEL = "MFA_CODE";
  console.log(`\n🔢 [${LABEL}] Requesting 6-digit code from Microsoft Authenticator...`);

  const clicked = await clickOption(page, [
    'div[data-value="PhoneAppOTP"]',
    '[data-bind*="PhoneAppOTP"]',
    'div:has-text("Use a verification code")',
    'li:has-text("verification code")',
  ], LABEL);
  if (!clicked) {
    console.warn(`⚠️ [${LABEL}] Verification code option not available on this challenge screen`);
    return { success: false };
  }
  await sleep(2000);

  try {
    const { code, retryCode } = getTotpCodes();
    console.log(`✅ [${LABEL}] Generated TOTP for current and next window`);
    return { success: true, code, retryCode };
  } catch (err) {
    console.warn(`⚠️ [${LABEL}] TOTP generation failed: ${err.message}`);
    return { success: false };
  }
}

async function tryCall(page) {
  const LABEL = "CALL";
  console.log(`\n📞 [${LABEL}] Triggering voice call to registered phone number...`);

  const clicked = await clickOption(page, [
    '[data-value*="Voice"]',
    '[data-bind*="OneWayVoiceMobile"]',
    '[data-value*="voice"]',
  ], LABEL);
  if (!clicked) {
    console.warn(`⚠️ [${LABEL}] Voice call option not available on this challenge screen`);
    return { success: false };
  }
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

  const clicked = await clickOption(page, [
    'div[data-value="OneWaySMS"]',
    '[data-bind*="OneWaySMS"]',
    'div:has-text("Text +")',
    'li:has-text("Text +")',
  ], LABEL);
  if (!clicked) {
    console.warn(`⚠️ [${LABEL}] SMS option not available on this challenge screen`);
    return { success: false };
  }
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
  MFA_CODE: tryMfaCode,
  CALL:     tryCall,
  TEXT:     tryText,
};

// ─── MFA pipeline ─────────────────────────────────────────────────────────────
// Iterates MFA_METHOD_ORDER, tries each in sequence.
// Returns MFA result object ({ success, code?, retryCode? }) or throws if all fail.
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
      return result;
    }

    console.log(`↩️  [${methodName}] failed — moving to next method`);
  }

  throw new Error(`All MFA methods exhausted (${MFA_METHOD_ORDER.join(", ")}) — no response received`);
}

module.exports = { handleMFA, getTotpCodes };
