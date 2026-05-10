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
//  "MFA_PUSH",
//  "MFA_CODE",
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

    // Find the list view button by its unique SVG viewBox "0 0 12 10" (3-line descending icon)
    let listViewClicked = false;
    try {
      // Use Playwright's locator to find the SVG and click its button parent
      // page.locator finds the element; .click() dispatches a real browser event
      const listSvg = page.locator('svg[viewBox="0 0 12 10"]').first();
      const count = await listSvg.count();
      console.log(`🔍 Found ${count} SVG(s) with viewBox="0 0 12 10"`);
      if (count > 0) {
        // Click the button that contains this SVG
        await listSvg.locator("..").click({ timeout: 3000 }); // ".." = parent element
        console.log("✅ List view toggled via SVG locator");
        listViewClicked = true;
      }
    } catch (err) {
      console.warn(`⚠️ SVG locator click failed: ${err.message}`);
    }

    if (!listViewClicked) {
      // Last resort: use dispatchEvent to simulate a real click on the SVG button
      try {
        const clicked = await page.evaluate(() => {
          const svg = document.querySelector('svg[viewBox="0 0 12 10"]');
          if (!svg) return false;
          const btn = svg.closest("button") || svg.parentElement;
          if (!btn) return false;
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return true;
        });
        if (clicked) {
          console.log("✅ List view toggled via dispatchEvent");
          listViewClicked = true;
        }
      } catch (_) {}
    }

    if (!listViewClicked) {
      console.warn("⚠️ Could not toggle list view — proceeding anyway");
    }

    await sleep(2000);
    await page.screenshot({ path: "list_view.png" });

    // ── Step 8: Find all absent rows with no pending request ──────────────
    // Strategy: read each table row individually, check ONLY the specific cells
    // for Attendance status and Request Status — not the full row text.
    // This prevents false positives from child elements or hidden DOM text.
    console.log("🔍 Scanning for absent days with no pending request...");

    const absentDates = await page.evaluate(() => {
      const results = [];
      const seen = new Set(); // deduplicate dates

      // Target the main attendance table rows
      // Each row has cells: checkbox | date | attendance | ⋮ | request-status | time-in | time-out | ...
      const rows = [...document.querySelectorAll("tr.db-table-row, tr[class*='table-row'], div.db-table-row")];

      for (const row of rows) {
        // Get all direct cell children (td or div cells)
        const cells = [...row.querySelectorAll("td, .db-table-cell, [class*='table-cell']")];
        if (cells.length < 3) continue;

        // Find the cell that contains ONLY the attendance status (Present/Absent/Weekly Off)
        // It contains an icon + text, no date
        let attendanceText = "";
        let dateText = "";
        let requestStatusText = "";

        for (const cell of cells) {
          const text = (cell.innerText || "").trim();
          // Date cell: matches DD-MM-YYYY exactly
          if (/^\d{2}-\d{2}-\d{4}$/.test(text)) {
            dateText = text;
          }
          // Attendance cell: contains exactly one of these statuses (with possible icon prefix)
          if (text.includes("Absent") && !text.includes("-")) {
            attendanceText = "Absent";
          }
          // Request status cell
          if (text.includes("Request Pending") || text.includes("Time Correction")) {
            requestStatusText = text;
          }
        }

        if (!dateText || attendanceText !== "Absent") continue;
        if (requestStatusText) continue; // already has a pending request
        if (seen.has(dateText)) continue; // deduplicate
        seen.add(dateText);
        results.push(dateText);
      }

      return results;
    });

    if (absentDates.length === 0) {
      console.log("✅ No absent days found needing regularization — nothing to do!");
      await page.screenshot({ path: "regularization_result.png" });
      return;
    }

    console.log("─".repeat(50));
    console.log(`📋 Found ${absentDates.length} absent day(s) to regularize:`);
    absentDates.forEach((d, i) => console.log(`   ${i + 1}. ${d}`));
    console.log("─".repeat(50));

    // ── Step 9: Regularize each absent day ────────────────────────────────
    for (const date of absentDates) {
      console.log(`
📝 Processing: ${date}`);

      const punchInTime  = randomTime(PUNCH_IN_BASE_HOUR,  PUNCH_RANDOM_MAX);
      const punchOutTime = randomTime(PUNCH_OUT_BASE_HOUR, PUNCH_RANDOM_MAX);
      const [inHour, inMin]   = punchInTime.split(":");
      const [outHour, outMin] = punchOutTime.split(":");
      console.log(`   Punch-in: ${punchInTime} | Punch-out: ${punchOutTime}`);

      // ── Ensure no modal is open before starting ─────────────────────────
      // Close any leftover panel from a previous iteration
      try {
        const modal = await page.$("dbx-ds-modal");
        if (modal) {
          await page.click('dbx-ds-modal button:has-text("Cancel"), dbx-ds-modal [aria-label*="close"], dbx-ds-modal .close', { timeout: 2000 });
          await sleep(1000);
          console.log("   🔄 Closed leftover panel from previous row");
        }
      } catch (_) {}

      // ── Click ⋮ on the correct row ──────────────────────────────────────
      try {
        // Find the row whose date cell exactly matches our target date
        const clicked = await page.evaluate((targetDate) => {
          const rows = [...document.querySelectorAll("tr.db-table-row, div.db-table-row, tr[class*='table-row']")];
          for (const row of rows) {
            const cells = [...row.querySelectorAll("td, .db-table-cell, [class*='table-cell']")];
            const hasDate = cells.some(c => (c.innerText || "").trim() === targetDate);
            if (!hasDate) continue;
            // Find and click the ⋮ button in this row
            const btn = row.querySelector("button");
            if (btn) { btn.click(); return true; }
          }
          return false;
        }, date);

        if (!clicked) {
          console.warn(`   ⚠️ Could not find/click ⋮ for ${date} — skipping`);
          await page.screenshot({ path: `error_${date}.png` });
          continue;
        }
        await sleep(1000);

        // Click "Time Correction" from the dropdown
        await page.click('text="Time Correction"', { timeout: 3000 });
        await sleep(2000);
        console.log(`   ✅ Time Correction panel opened`);

      } catch (err) {
        console.warn(`   ⚠️ Could not open panel for ${date}: ${err.message}`);
        await page.screenshot({ path: `error_${date}.png` });
        // Ensure panel is closed before next iteration
        try { await page.keyboard.press("Escape"); } catch (_) {}
        await sleep(1000);
        continue;
      }

      // ── Fill form — scoped to the modal panel ───────────────────────────
      try {
        // Wait for modal to be fully visible
        await page.waitForSelector("dbx-ds-modal", { timeout: 5000 });

        // Get all spinners SCOPED to the modal only
        const modal = page.locator("dbx-ds-modal");
        const spinners = modal.locator('input[type="number"]');
        const spinnerCount = await spinners.count();
        console.log(`   🔢 Found ${spinnerCount} spinner inputs in modal`);

        if (spinnerCount >= 4) {
          // Order in form: ClockIn-Hour [0], ClockIn-Min [1], ClockOut-Hour [2], ClockOut-Min [3]
          // (Break Duration spinners [4],[5] are left as 00)
          await spinners.nth(0).click({ clickCount: 3 }); await spinners.nth(0).fill(inHour);  await sleep(300);
          await spinners.nth(1).click({ clickCount: 3 }); await spinners.nth(1).fill(inMin);   await sleep(300);
          await spinners.nth(2).click({ clickCount: 3 }); await spinners.nth(2).fill(outHour); await sleep(300);
          await spinners.nth(3).click({ clickCount: 3 }); await spinners.nth(3).fill(outMin);  await sleep(300);
          console.log(`   ✅ Times filled`);
        } else {
          console.warn(`   ⚠️ Expected ≥4 spinners, found ${spinnerCount}`);
        }

        // Reason dropdown — scoped to modal
        await modal.locator('text="Select Reason"').click({ timeout: 3000 });
        await sleep(500);
        await page.click(`text="${REASON}"`, { timeout: 3000 });
        console.log(`   ✅ Reason selected: "${REASON}"`);
        await sleep(500);

        await page.screenshot({ path: `before_submit_${date}.png` });

        // Submit — scoped to modal
        await modal.locator('button:has-text("Submit")').click({ timeout: 5000 });
        await sleep(3000);
        console.log(`   ✅ Submitted for ${date}`);
        await page.screenshot({ path: `submitted_${date}.png` });

        // Wait for modal to close
        await page.waitForSelector("dbx-ds-modal", { state: "hidden", timeout: 5000 }).catch(() => {});
        await sleep(1000);

      } catch (err) {
        console.warn(`   ⚠️ Error filling form for ${date}: ${err.message}`);
        await page.screenshot({ path: `form_error_${date}.png` });
        // Force close modal before next row
        try { await page.keyboard.press("Escape"); await sleep(500); } catch (_) {}
        try { await page.click('dbx-ds-modal button:has-text("Cancel")', { timeout: 2000 }); } catch (_) {}
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
