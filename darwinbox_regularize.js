const { chromium } = require("playwright");

// ─── CONFIG (set these as GitHub Secrets) ───────────────────────────────────
const DARWINBOX_URL  = process.env.DARWINBOX_URL;
const USERNAME       = process.env.DARWINBOX_USERNAME;
const PASSWORD       = process.env.DARWINBOX_PASSWORD;
const PUNCH_IN_TIME  = process.env.PUNCH_IN_TIME  || "09:00";
const PUNCH_OUT_TIME = process.env.PUNCH_OUT_TIME || "18:00";
const REASON         = process.env.REGULARIZE_REASON || "Worked from office - system missed punch";

// GitHub details — auto-provided by GitHub Actions, no secrets needed
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_REPO    = process.env.GITHUB_REPOSITORY;  // format: "owner/repo"

// OTP polling config
const OTP_POLL_INTERVAL_MS = 15000;        // check every 15 seconds
const OTP_TIMEOUT_MS       = 15 * 60 * 1000; // wait up to 15 minutes
// ────────────────────────────────────────────────────────────────────────────

function getYesterdayDate() {
  const d  = new Date();
  d.setDate(d.getDate() - 1);
  const dd   = String(d.getDate()).padStart(2, "0");
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── GitHub Issue helpers ──────────────────────────────────────────────────────

async function createGitHubIssue(title, body) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ title, body, labels: ["otp-request"] }),
  });
  const data = await res.json();
  console.log(`📋 GitHub Issue created: #${data.number} — ${data.html_url}`);
  return data.number;
}

async function getIssueComments(issueNumber) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/issues/${issueNumber}/comments`,
    {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    }
  );
  return await res.json();
}

async function closeGitHubIssue(issueNumber, closingComment) {
  await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ body: closingComment }),
  });
  await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues/${issueNumber}`, {
    method: "PATCH",
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ state: "closed" }),
  });
  console.log(`✅ GitHub Issue #${issueNumber} closed`);
}

async function waitForOTPFromIssue(issueNumber) {
  console.log(`⏳ Polling Issue #${issueNumber} for OTP (up to 15 minutes)...`);
  const deadline = Date.now() + OTP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(OTP_POLL_INTERVAL_MS);
    const comments = await getIssueComments(issueNumber);

    if (Array.isArray(comments) && comments.length > 0) {
      const latest = comments[comments.length - 1].body.trim();
      const otp    = latest.replace(/\D/g, ""); // digits only
      if (otp.length >= 4) {
        console.log(`✅ OTP received: ${otp}`);
        return otp;
      }
    }

    const remaining = Math.round((deadline - Date.now()) / 60000);
    console.log(`⏳ No OTP yet — ${remaining} min remaining...`);
  }

  throw new Error("⏰ OTP timeout — no response within 15 minutes");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  if (!DARWINBOX_URL || !USERNAME || !PASSWORD) {
    console.error("❌ Missing required env vars: DARWINBOX_URL, DARWINBOX_USERNAME, DARWINBOX_PASSWORD");
    process.exit(1);
  }

  console.log("🚀 Launching browser...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  let otpIssueNumber = null;

  try {
    // ── Step 1: Navigate to Darwinbox ────────────────────────────────────
    console.log("🔐 Navigating to Darwinbox...");
    await page.goto(`${DARWINBOX_URL}/user/login`, { waitUntil: "networkidle" });
    await sleep(2000);

    // Click SSO / Microsoft button if present
    const ssoSelectors = [
      'a:has-text("Microsoft")', 'button:has-text("Microsoft")',
      'a:has-text("SSO")', 'a:has-text("Sign in with")', '.sso-btn',
    ];
    for (const sel of ssoSelectors) {
      try {
        await page.click(sel, { timeout: 3000 });
        console.log(`✅ Clicked SSO: ${sel}`);
        await page.waitForNavigation({ waitUntil: "networkidle", timeout: 10000 });
        break;
      } catch (_) {}
    }
    await sleep(2000);

    // ── Step 2: Enter Microsoft email ────────────────────────────────────
    console.log("📧 Entering email...");
    await page.fill('input[type="email"], input[name="loginfmt"]', USERNAME);
    await sleep(500);
    await page.click('input[type="submit"], button[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
    await sleep(2000);

    // ── Step 3: Enter Microsoft password ─────────────────────────────────
    console.log("🔑 Entering password...");
    await page.fill('input[type="password"], input[name="passwd"]', PASSWORD);
    await sleep(500);
    await page.click('input[type="submit"], button[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
    await sleep(2000);

    // ── Step 4: Detect & handle MFA ──────────────────────────────────────
    const onMicrosoftPage = page.url().includes("login.microsoftonline");
    const mfaVisible =
      (await page.$('text="Verify your identity"').catch(() => null)) ||
      (await page.$('text="Enter code"').catch(() => null)) ||
      (await page.$('input[name="otc"]').catch(() => null));

    if (onMicrosoftPage && mfaVisible) {
      console.log("🔐 MFA detected — creating GitHub Issue to request OTP...");
      await page.screenshot({ path: "mfa_screen.png" });

      // Trigger SMS if option is available
      try {
        await page.click('div[data-value="PhoneAppOTP"], text="Text +XX"', { timeout: 3000 });
        await sleep(1000);
      } catch (_) {}

      // Create GitHub Issue — this triggers a notification to you
      otpIssueNumber = await createGitHubIssue(
        "🔐 Action required: Enter your Darwinbox OTP now",
        `## Darwinbox attendance automation needs your OTP\n\n` +
        `Your Microsoft account is asking for MFA verification.\n\n` +
        `**👉 Reply to this issue with just the OTP** (e.g. \`123456\`)\n\n` +
        `⏰ You have **15 minutes** before the session expires.\n\n` +
        `_This issue will auto-close once the OTP is used successfully._`
      );

      // Poll issue comments until OTP arrives
      const otp = await waitForOTPFromIssue(otpIssueNumber);

      // Type OTP into the page
      await page.fill('input[name="otc"], input[placeholder*="code"], input[placeholder*="Code"]', otp);
      await sleep(500);
      await page.click('input[type="submit"], button[type="submit"]');
      await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
      await sleep(2000);
      console.log("✅ OTP submitted successfully");
    } else {
      console.log("ℹ️  No MFA prompt detected — continuing");
    }

    // ── Step 5: Handle "Stay signed in?" ─────────────────────────────────
    try {
      await page.click('input[value="Yes"], button:has-text("Yes")', { timeout: 5000 });
      await page.waitForNavigation({ waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
      await sleep(2000);
      console.log("✅ Clicked 'Stay signed in'");
    } catch (_) {}

    console.log("✅ Logged in — URL:", page.url());

    // ── Step 6: Go to Attendance Regularization ───────────────────────────
    console.log("📅 Navigating to attendance regularization...");
    await page.goto(`${DARWINBOX_URL}/attendance/regularization`, { waitUntil: "networkidle" });
    await sleep(2000);

    // Fallback to attendance index
    if (page.url().includes("login")) {
      await page.goto(`${DARWINBOX_URL}/attendance/index`, { waitUntil: "networkidle" });
      await sleep(2000);
    }

    // ── Step 7: Click Apply / Add Regularization ──────────────────────────
    const applySelectors = [
      'button:has-text("Apply")', 'a:has-text("Apply")',
      'button:has-text("Add")', '.apply-regularization', '#applyRegularization',
    ];
    for (const sel of applySelectors) {
      try {
        await page.click(sel, { timeout: 3000 });
        console.log(`✅ Clicked: ${sel}`);
        break;
      } catch (_) {}
    }
    await sleep(1500);

    // ── Step 8: Fill regularization form ─────────────────────────────────
    const targetDate = getYesterdayDate();
    console.log(`📝 Filling form for: ${targetDate}`);

    try { await page.fill('input[name*="date"], input[placeholder*="ate"]', targetDate, { timeout: 3000 }); } catch (_) { console.warn("⚠️ Could not fill date"); }
    try { await page.fill('input[name*="in_time"], input[placeholder*="In Time"]', PUNCH_IN_TIME, { timeout: 3000 }); } catch (_) { console.warn("⚠️ Could not fill punch-in"); }
    try { await page.fill('input[name*="out_time"], input[placeholder*="Out Time"]', PUNCH_OUT_TIME, { timeout: 3000 }); } catch (_) { console.warn("⚠️ Could not fill punch-out"); }
    try { await page.fill('textarea[name*="reason"], textarea[name*="remark"]', REASON, { timeout: 3000 }); } catch (_) { console.warn("⚠️ Could not fill reason"); }

    await sleep(1000);

    // ── Step 9: Submit ────────────────────────────────────────────────────
    const submitSelectors = [
      'button[type="submit"]:has-text("Submit")',
      'button:has-text("Submit")', 'button:has-text("Save")', 'input[type="submit"]',
    ];
    for (const sel of submitSelectors) {
      try {
        await page.click(sel, { timeout: 3000 });
        console.log("✅ Regularization submitted!");
        break;
      } catch (_) {}
    }

    await sleep(2000);
    await page.screenshot({ path: "regularization_result.png" });
    console.log("📸 Screenshot saved");

    // Close OTP issue with success
    if (otpIssueNumber) {
      await closeGitHubIssue(
        otpIssueNumber,
        "✅ OTP verified and attendance regularized successfully! Closing this issue."
      );
    }

  } catch (err) {
    console.error("❌ Error:", err.message);
    await page.screenshot({ path: "error_screenshot.png", fullPage: true }).catch(() => {});

    if (otpIssueNumber) {
      await closeGitHubIssue(
        otpIssueNumber,
        `❌ Automation failed after OTP: ${err.message}\n\nPlease regularize attendance manually today.`
      );
    }
    process.exit(1);
  } finally {
    await browser.close();
    console.log("🏁 Done.");
  }
}

run();
