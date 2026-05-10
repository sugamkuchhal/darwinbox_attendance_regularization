const { chromium } = require("playwright");

// ─── SECRETS (GitHub Actions secrets) ────────────────────────────────────────
const DARWINBOX_URL = process.env.DARWINBOX_URL;
const USERNAME      = process.env.DARWINBOX_USERNAME;
const PASSWORD      = process.env.DARWINBOX_PASSWORD;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPOSITORY;
const EMPLOYEE_ID   = process.env.DARWINBOX_EMPLOYEE_ID;
// ─── ATTENDANCE & TIMING CONFIG (edit here, not in secrets) ─────────────────
// Punch-in:  random minute between 0-30 added to 09:00  => range 09:00-09:30
// Punch-out: random minute between 0-30 added to 18:00  => range 18:00-18:30
// Reason:    selected from Darwinbox dropdown by visible text
const PUNCH_IN_BASE_HOUR  = 9;
const PUNCH_OUT_BASE_HOUR = 18;
const PUNCH_RANDOM_MAX    = 30;  // max random minutes added to base hour
const REASON              = "Forgot To Punch";
const WAIT_MINUTES        = 2;   // minutes to wait per MFA method before falling back
// ─────────────────────────────────────────────────────────────────────────────

// ─── MFA METHOD ORDER ─────────────────────────────────────────────────────────
// Change the order here to change which method is tried first.
// Remove any entry to skip that method entirely.
//
//   "MFA_PUSH"  → Microsoft Authenticator push notification (tap Approve on phone)
//   "MFA_CODE"  → 6-digit code from Microsoft Authenticator app
//   "CALL"      → Voice call to your phone
//   "TEXT"      → SMS to your phone
//
const MFA_METHOD_ORDER = [
  "MFA_PUSH",
  "MFA_CODE",
  "CALL",
  "TEXT",
];
// ─────────────────────────────────────────────────────────────────────────────

const TIMEOUT_MS       = WAIT_MINUTES * 60 * 1000;
const POLL_INTERVAL_MS = 10000; // poll every 10 seconds

// ── Utilities ─────────────────────────────────────────────────────────────────

function getYesterdayDate() {
  const d    = new Date();
  d.setDate(d.getDate() - 1);
  const dd   = String(d.getDate()).padStart(2, "0");
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Returns a time string like "09:17" by adding a random minute (0-max) to baseHour
function randomTime(baseHour, maxMinutes) {
  const minutes = Math.floor(Math.random() * (maxMinutes + 1)); // 0 to maxMinutes inclusive
  const hh = String(baseHour).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  return `${hh}:${mm}`;
}

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function createGitHubIssue(title, body) {
  const res  = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: "POST",
    headers: { Authorization: `token ${GITHUB_TOKEN}`, "Content-Type": "application/json", Accept: "application/vnd.github+json" },
    body: JSON.stringify({ title, body, labels: ["otp-request"] }),
  });
  const data = await res.json();
  console.log(`📋 Issue created: #${data.number} — ${data.html_url}`);
  return data.number;
}

async function getIssueComments(issueNumber) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues/${issueNumber}/comments`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  return await res.json();
}

async function closeGitHubIssue(issueNumber, comment) {
  await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: { Authorization: `token ${GITHUB_TOKEN}`, "Content-Type": "application/json", Accept: "application/vnd.github+json" },
    body: JSON.stringify({ body: comment }),
  });
  await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues/${issueNumber}`, {
    method: "PATCH",
    headers: { Authorization: `token ${GITHUB_TOKEN}`, "Content-Type": "application/json", Accept: "application/vnd.github+json" },
    body: JSON.stringify({ state: "closed" }),
  });
  console.log(`✅ Issue #${issueNumber} closed`);
}

// ── Shared polling helpers ────────────────────────────────────────────────────

// Poll issue comments for a numeric code. Returns code string or null on timeout.
async function pollIssueForCode(issueNumber, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  console.log(`⏳ [${label}] Waiting up to ${WAIT_MINUTES * 60}s for code reply...`);
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const comments = await getIssueComments(issueNumber);
    if (Array.isArray(comments) && comments.length > 0) {
      const code = comments[comments.length - 1].body.trim().replace(/\D/g, "");
      if (code.length >= 4) { console.log(`✅ [${label}] Code received`); return code; }
    }
    const secsLeft = Math.round((deadline - Date.now()) / 1000);
    console.log(`⏳ [${label}] No code yet — ${secsLeft}s remaining`);
  }
  console.warn(`⚠️ [${label}] Timed out after ${WAIT_MINUTES * 60}s`);
  return null;
}

// Poll the page until it reaches Darwinbox (fully off Microsoft).
// "Verify your identity" → "We're calling your phone" is still Microsoft — not approved yet.
// Returns true only when the URL contains DARWINBOX_URL domain, false on timeout.
async function pollPageForApproval(page, label) {
  const deadline     = Date.now() + TIMEOUT_MS;
  const darwinboxHost = new URL(DARWINBOX_URL).hostname;
  console.log(`⏳ [${label}] Waiting up to ${WAIT_MINUTES * 60}s for approval (watching for ${darwinboxHost})...`);
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const currentUrl   = page.url();
    const onDarwinbox  = currentUrl.includes(darwinboxHost);
    const secsLeft     = Math.round((deadline - Date.now()) / 1000);
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

// Click an element trying multiple selectors, return true if any succeeded.
async function clickOption(page, selectors, label) {
  for (const sel of selectors) {
    try { await page.click(sel, { timeout: 2000 }); console.log(`✅ Clicked [${label}]: ${sel}`); return true; } catch (_) {}
  }
  console.warn(`⚠️ Could not click [${label}]`); return false;
}

// Navigate back to the "choose a method" screen between attempts.
async function goToMethodPicker(page) {
  try {
    await page.click('a:has-text("Sign in another way"), a:has-text("other way"), a:has-text("different")', { timeout: 3000 });
    await sleep(1500);
    console.log("✅ Back to method picker");
  } catch (_) {
    console.warn("⚠️ Could not navigate to method picker — may already be there");
  }
}

// ── MFA method functions ──────────────────────────────────────────────────────
// Each function:
//   - Clicks the appropriate option on the MFA screen
//   - Creates a GitHub Issue to notify the user
//   - Waits for the user's response (or page approval for MFA_PUSH)
//   - Closes the issue with a status message
//   - Returns: { success: true, code: "123456" | null } on success
//              { success: false } on timeout/failure
// ─────────────────────────────────────────────────────────────────────────────

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
    `⏰ You have **${WAIT_MINUTES} minute(s)**. No reply needed here — just approve on your phone.\n\n` +
    `_This issue will close automatically. If you miss it, the next method will be tried._`
  );

  const approved = await pollPageForApproval(page, LABEL);

  if (approved) {
    await closeGitHubIssue(issueNumber, "✅ Push approved! Continuing with login...");
    return { success: true, code: null }; // page already moved forward, no code to enter
  }

  await closeGitHubIssue(issueNumber, `⏰ Push not approved in ${WAIT_MINUTES} min. Trying next method...`);
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
    `⏰ You have **${WAIT_MINUTES} minute(s)** to respond.\n\n` +
    `_Authenticator codes rotate every 30 seconds — reply quickly once you have it._`
  );

  const code = await pollIssueForCode(issueNumber, LABEL);

  if (code) {
    await closeGitHubIssue(issueNumber, "✅ Code received. Submitting now...");
    return { success: true, code };
  }

  await closeGitHubIssue(issueNumber, `⏰ No code received in ${WAIT_MINUTES} min. Trying next method...`);
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

  // After clicking Call, Microsoft dials your phone — you answer and press # to confirm.
  // The page then moves forward automatically (no code to enter).
  // We notify you via GitHub Issue and poll the page for navigation, same as MFA_PUSH.
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

  // Screenshot shows two plain rows: row1=Text, row2=Call — target by text content and position
  await clickOption(page, [
    'div[data-value="OneWaySMS"]',
    '[data-bind*="OneWaySMS"]',
    'div.row:nth-child(1)',          // Text is the 1st row on the picker screen
    'li:nth-child(1)',
    ':nth-match(div.row, 1)',
    'div:has(> span:has-text("Text +"))',
    'div:has(> div:has-text("Text +"))',
    'td:has-text("Text +")',
    'a:has-text("Text +")',
    'div >> text=/Text \+/',
  ], LABEL);
  await sleep(2000);

  const issueNumber = await createGitHubIssue(
    "🔐 [SMS] Enter the OTP sent to your phone",
    `## Darwinbox automation: SMS OTP needed\n\n` +
    `An OTP has been sent to your phone via **SMS**.\n\n` +
    `**👉 Reply to this issue with just the OTP** (e.g. \`123456\`)\n\n` +
    `⏰ You have **${WAIT_MINUTES} minute(s)** to respond.`
  );

  const code = await pollIssueForCode(issueNumber, LABEL);

  if (code) {
    await closeGitHubIssue(issueNumber, "✅ OTP received. Submitting now...");
    return { success: true, code };
  }

  await closeGitHubIssue(issueNumber, `⏰ No OTP received in ${WAIT_MINUTES} min. This was the last method.`);
  return { success: false };
}

// ── Method registry — maps name → function ────────────────────────────────────

const MFA_METHODS = {
  MFA_PUSH: tryMfaPush,
  MFA_CODE: tryMfaCode,
  CALL:     tryCall,
  TEXT:     tryText,
};

// ── MFA pipeline — iterates MFA_METHOD_ORDER, calls each method function ──────

async function handleMFA(page) {
  console.log(`🔐 MFA detected. Trying: ${MFA_METHOD_ORDER.join(" → ")}`);
  await page.screenshot({ path: "mfa_screen.png" });

  for (let i = 0; i < MFA_METHOD_ORDER.length; i++) {
    const methodName = MFA_METHOD_ORDER[i];
    const methodFn   = MFA_METHODS[methodName];

    if (!methodFn) {
      console.warn(`⚠️ Unknown method "${methodName}" in MFA_METHOD_ORDER — skipping`);
      continue;
    }

    // From the second attempt onward, navigate back to the method picker first
    if (i > 0) await goToMethodPicker(page);

    const result = await methodFn(page);

    if (result.success) {
      return result.code; // null for MFA_PUSH (no code to enter), string for others
    }

    console.log(`↩️  [${methodName}] failed — moving to next method`);
  }

  throw new Error(`All MFA methods exhausted (${MFA_METHOD_ORDER.join(", ")}) — no response received`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  if (!DARWINBOX_URL || !USERNAME || !PASSWORD) {
    console.error("❌ Missing: DARWINBOX_URL, DARWINBOX_USERNAME, DARWINBOX_PASSWORD");
    process.exit(1);
  }

  console.log(`ℹ️  MFA order: ${MFA_METHOD_ORDER.join(" → ")}`);
  console.log(`ℹ️  Wait per method: ${WAIT_MINUTES} minute(s)`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    // ── Step 1: Darwinbox login ───────────────────────────────────────────
    console.log("🔐 Navigating to Darwinbox...");
    await page.goto(`${DARWINBOX_URL}/user/login`, { waitUntil: "networkidle" });
    await sleep(2000);

    for (const sel of ['a:has-text("Microsoft")', 'button:has-text("Microsoft")', 'a:has-text("SSO")', '.sso-btn']) {
      try { await page.click(sel, { timeout: 3000 }); await page.waitForNavigation({ waitUntil: "networkidle", timeout: 10000 }); break; } catch (_) {}
    }
    await sleep(2000);

    // ── Step 2: Microsoft email ───────────────────────────────────────────
    console.log("📧 Entering email...");
    await page.fill('input[type="email"], input[name="loginfmt"]', USERNAME);
    await sleep(500);
    await page.click('input[type="submit"], button[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
    await sleep(2000);

    // ── Step 3: Microsoft password ────────────────────────────────────────
    console.log("🔑 Entering password...");
    await page.fill('input[type="password"], input[name="passwd"]', PASSWORD);
    await sleep(500);
    await page.click('input[type="submit"], button[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
    await sleep(2000);

    // ── Step 4: MFA ───────────────────────────────────────────────────────
    const onMicrosoftPage = page.url().includes("login.microsoftonline");
    const mfaVisible =
      (await page.$('text="Verify your identity"').catch(() => null)) ||
      (await page.$('text="Enter code"').catch(() => null))           ||
      (await page.$('input[name="otc"]').catch(() => null));

    if (onMicrosoftPage && mfaVisible) {
      const code = await handleMFA(page);
      if (code) {
        // Enter the code — not needed for MFA_PUSH (returns null, page already moved)
        await page.fill('input[name="otc"], input[placeholder*="code"], input[placeholder*="Code"]', code);
        await sleep(500);
        await page.click('input[type="submit"], button[type="submit"]');
        await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
        await sleep(2000);
        console.log("✅ Code submitted");
      }
    } else {
      console.log("ℹ️  No MFA prompt — continuing");
    }

    // ── Step 5: Stay signed in ────────────────────────────────────────────
    try {
      await page.click('input[value="Yes"], button:has-text("Yes")', { timeout: 5000 });
      await page.waitForNavigation({ waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
      await sleep(2000);
    } catch (_) {}

    const postLoginUrl = page.url();
    console.log("✅ Post-login URL:", postLoginUrl);
    if (!postLoginUrl.includes(new URL(DARWINBOX_URL).hostname)) {
      console.warn("⚠️ Still not on Darwinbox after MFA — may need to handle an intermediate Microsoft page");
      await page.screenshot({ path: "post_login_check.png" });
    }

    // ── Step 6: Navigate to attendance list ─────────────────────────────
    const ATTENDANCE_URL = `${DARWINBOX_URL}/ms/time/${EMPLOYEE_ID}/attendance`;
    console.log(`📅 Navigating to attendance page: ${ATTENDANCE_URL}`);
    await page.goto(ATTENDANCE_URL, { waitUntil: "networkidle" });
    await sleep(3000);

    // ── Step 7: Switch to list view ───────────────────────────────────────
    console.log("📋 Switching to list view...");
    try {
      // List view toggle is the second icon in the view switcher group
      await page.click('button[aria-label*="list"], button[title*="list"], button[title*="List"]', { timeout: 3000 });
    } catch (_) {
      try {
        // Fallback: click the second toggle button (list icon after calendar icon)
        const toggleBtns = await page.$$('button svg, .view-toggle button, [class*="toggle"] button');
        if (toggleBtns.length >= 2) await toggleBtns[1].click();
      } catch (__) {}
    }
    await sleep(2000);
    await page.screenshot({ path: "list_view.png" });

    // ── Step 8: Find all absent rows with no pending request ──────────────
    console.log("🔍 Scanning for absent days with no pending request...");

    // Collect all rows from the attendance table
    const absentDates = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("tr, [class*='row']:not([class*='header'])")];
      const results = [];
      for (const row of rows) {
        const text = row.innerText || "";
        // Must contain "Absent" 
        if (!text.includes("Absent")) continue;
        // Must NOT have a pending request (no "Request Pending" or "Time Correction" badge)
        if (text.includes("Request Pending") || text.includes("Time Correction")) continue;
        // Extract the date — format DD-MM-YYYY
        const dateMatch = text.match(/\d{2}-\d{2}-\d{4}/);
        if (dateMatch) results.push(dateMatch[0]);
      }
      return results;
    });

    if (absentDates.length === 0) {
      console.log("✅ No absent days found needing regularization — nothing to do!");
      await page.screenshot({ path: "regularization_result.png" });
      return;
    }

    console.log(`📋 Found ${absentDates.length} absent day(s) to regularize: ${absentDates.join(", ")}`);

    // ── Step 9: Regularize each absent day ────────────────────────────────
    for (const date of absentDates) {
      console.log(`
📝 Processing: ${date}`);

      // Generate random punch times for this day
      const punchInTime  = randomTime(PUNCH_IN_BASE_HOUR,  PUNCH_RANDOM_MAX);
      const punchOutTime = randomTime(PUNCH_OUT_BASE_HOUR, PUNCH_RANDOM_MAX);
      console.log(`   Punch-in: ${punchInTime} | Punch-out: ${punchOutTime}`);

      // Find the row for this date and click its ⋮ menu
      try {
        // Click the three-dot menu on the row matching this date
        const rowHandle = await page.evaluateHandle((targetDate) => {
          const rows = [...document.querySelectorAll("tr, [class*='row']")];
          return rows.find(r => (r.innerText || "").includes(targetDate)) || null;
        }, date);

        if (!rowHandle || !(await rowHandle.asElement())) {
          console.warn(`   ⚠️ Could not find row for ${date} — skipping`);
          continue;
        }

        // Click the ⋮ button within that row
        const menuBtn = await rowHandle.$('button, [class*="menu"], [class*="dots"], [aria-label*="more"], [aria-label*="action"]');
        if (menuBtn) {
          await menuBtn.click();
        } else {
          // Fallback: find by text position
          await page.click(`text="${date}" >> .. >> button`, { timeout: 3000 }).catch(() => {});
        }
        await sleep(1000);

        // Click "Time Correction" from the dropdown menu
        await page.click('text="Time Correction"', { timeout: 3000 });
        await sleep(2000);
        console.log(`   ✅ Time Correction panel opened`);

      } catch (err) {
        console.warn(`   ⚠️ Could not open Time Correction for ${date}: ${err.message}`);
        await page.screenshot({ path: `error_${date}.png` });
        continue;
      }

      // ── Fill the Time Correction form ──────────────────────────────────
      try {
        // Clock In Time — hour and minute spinners
        // Clear and set hour spinner for punch-in
        const [inHour, inMin] = punchInTime.split(":");
        const [outHour, outMin] = punchOutTime.split(":");

        // Spinners are input[type="number"] or custom spinners — try both
        const spinners = await page.$$('input[type="number"], [class*="spinner"] input, [class*="time"] input');
        console.log(`   🔢 Found ${spinners.length} spinner inputs`);

        if (spinners.length >= 4) {
          // Expected order: ClockIn-Hour, ClockIn-Min, ClockOut-Hour, ClockOut-Min
          await spinners[0].click({ clickCount: 3 });
          await spinners[0].fill(inHour);
          await sleep(300);
          await spinners[1].click({ clickCount: 3 });
          await spinners[1].fill(inMin);
          await sleep(300);
          await spinners[2].click({ clickCount: 3 });
          await spinners[2].fill(outHour);
          await sleep(300);
          await spinners[3].click({ clickCount: 3 });
          await spinners[3].fill(outMin);
          await sleep(300);
        } else {
          // Try direct triple-click + type approach with labels
          await fillSpinnerByLabel(page, "Clock In Time", inHour, inMin);
          await fillSpinnerByLabel(page, "Clock Out Time", outHour, outMin);
        }

        // Location — should already be "Office", verify
        const locationVal = await page.$eval(
          '[class*="location"] [class*="select__single-value"], [class*="Location"] [class*="value"]',
          el => el.innerText
        ).catch(() => "");
        console.log(`   📍 Location: ${locationVal || "pre-filled"}`);

        // Reason dropdown — custom react-select style
        await page.click('text="Select Reason"', { timeout: 3000 });
        await sleep(500);
        await page.click(`text="${REASON}"`, { timeout: 3000 });
        console.log(`   ✅ Reason: "${REASON}"`);
        await sleep(500);

        // Screenshot before submit
        await page.screenshot({ path: `before_submit_${date}.png` });

        // Submit
        await page.click('button:has-text("Submit")', { timeout: 5000 });
        await sleep(2000);
        console.log(`   ✅ Submitted for ${date}`);
        await page.screenshot({ path: `submitted_${date}.png` });

        // Wait for panel to close before next row
        await sleep(2000);

      } catch (err) {
        console.warn(`   ⚠️ Error filling form for ${date}: ${err.message}`);
        await page.screenshot({ path: `form_error_${date}.png` });
        // Try to close the panel and continue with next date
        try { await page.click('button:has-text("Cancel"), button[aria-label*="close"], .close-btn', { timeout: 2000 }); } catch (_) {}
        await sleep(1000);
      }
    }

    console.log(`
✅ All done — processed ${absentDates.length} day(s)`);
    await page.screenshot({ path: "regularization_result.png" });

  } catch (err) {
    console.error("❌ Error:", err.message);
    await page.screenshot({ path: "error_screenshot.png", fullPage: true }).catch(() => {});
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// Helper: fill hour+minute into a labeled spinner pair
async function fillSpinnerByLabel(page, label, hour, minute) {
  try {
    const labelEl = await page.$(`text="${label}"`);
    if (!labelEl) return;
    // Get the parent container and find inputs within it
    const container = await labelEl.evaluateHandle(el => el.closest('[class*="field"], [class*="group"], [class*="time"]') || el.parentElement);
    const inputs = await container.$$('input');
    if (inputs.length >= 2) {
      await inputs[0].click({ clickCount: 3 });
      await inputs[0].type(hour);
      await inputs[1].click({ clickCount: 3 });
      await inputs[1].type(minute);
    }
  } catch (_) {}
}

run();
