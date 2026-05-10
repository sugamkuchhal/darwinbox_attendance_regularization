const { chromium } = require("playwright");

// ─── CONFIG (set these as GitHub Secrets) ───────────────────────────────────
const DARWINBOX_URL = process.env.DARWINBOX_URL;       // e.g. https://yourcompany.darwinbox.in
const USERNAME      = process.env.DARWINBOX_USERNAME;  // your login email/ID
const PASSWORD      = process.env.DARWINBOX_PASSWORD;  // your password
const PUNCH_IN_TIME = process.env.PUNCH_IN_TIME || "09:00";   // e.g. "09:00"
const PUNCH_OUT_TIME= process.env.PUNCH_OUT_TIME || "18:00";  // e.g. "18:00"
const REASON        = process.env.REGULARIZE_REASON || "Worked from office - system missed punch";
// ────────────────────────────────────────────────────────────────────────────

function getTodayDate() {
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, "0");
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const yyyy = today.getFullYear();
  return `${dd}/${mm}/${yyyy}`; // adjust format if your Darwinbox uses MM/DD/YYYY
}

function getYesterdayDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

  try {
    // ── Step 1: Login ──────────────────────────────────────────────────────
    console.log("🔐 Logging in...");
    await page.goto(`${DARWINBOX_URL}/user/login`, { waitUntil: "networkidle" });
    await sleep(1500);

    // Fill username
    await page.fill('input[name="username"], input[type="email"], #username', USERNAME);
    await sleep(500);

    // Fill password
    await page.fill('input[name="password"], input[type="password"], #password', PASSWORD);
    await sleep(500);

    // Click login button
    await page.click('button[type="submit"], input[type="submit"], .login-btn, #login-btn');
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 });
    console.log("✅ Logged in successfully");

    // ── Step 2: Navigate to Attendance ────────────────────────────────────
    console.log("📅 Navigating to attendance section...");
    await page.goto(`${DARWINBOX_URL}/attendance/index`, { waitUntil: "networkidle" });
    await sleep(2000);

    // ── Step 3: Find regularization option ────────────────────────────────
    // Try clicking "Regularize" or "Attendance Regularization" link
    const regularizeSelectors = [
      'a[href*="regulariz"]',
      'a:has-text("Regularize")',
      'a:has-text("Regularisation")',
      'button:has-text("Regularize")',
      '.regularize-btn',
    ];

    let clicked = false;
    for (const sel of regularizeSelectors) {
      try {
        await page.click(sel, { timeout: 3000 });
        clicked = true;
        console.log(`✅ Clicked regularize using selector: ${sel}`);
        break;
      } catch (_) {}
    }

    if (!clicked) {
      // Try navigating directly to the regularization URL
      await page.goto(`${DARWINBOX_URL}/attendance/regularization`, { waitUntil: "networkidle" });
      await sleep(2000);
    }

    await sleep(2000);

    // ── Step 4: Click "Apply Regularization" or "+" button ────────────────
    const applySelectors = [
      'button:has-text("Apply")',
      'a:has-text("Apply")',
      'button:has-text("Add")',
      '.apply-regularization',
      '#applyRegularization',
    ];

    for (const sel of applySelectors) {
      try {
        await page.click(sel, { timeout: 3000 });
        console.log(`✅ Clicked apply using: ${sel}`);
        break;
      } catch (_) {}
    }

    await sleep(1500);

    // ── Step 5: Fill in the regularization form ────────────────────────────
    const targetDate = getYesterdayDate(); // regularize previous day's attendance
    console.log(`📝 Filling form for date: ${targetDate}`);

    // Date field
    try {
      await page.fill('input[name*="date"], input[placeholder*="date"], input[placeholder*="Date"]', targetDate, { timeout: 3000 });
    } catch (_) {
      console.warn("⚠️  Could not auto-fill date — may need manual selector update");
    }

    // Punch-in time
    try {
      await page.fill(
        'input[name*="in_time"], input[placeholder*="In Time"], input[placeholder*="in time"]',
        PUNCH_IN_TIME,
        { timeout: 3000 }
      );
    } catch (_) {
      console.warn("⚠️  Could not auto-fill punch-in time");
    }

    // Punch-out time
    try {
      await page.fill(
        'input[name*="out_time"], input[placeholder*="Out Time"], input[placeholder*="out time"]',
        PUNCH_OUT_TIME,
        { timeout: 3000 }
      );
    } catch (_) {
      console.warn("⚠️  Could not auto-fill punch-out time");
    }

    // Reason / remarks
    try {
      await page.fill(
        'textarea[name*="reason"], textarea[name*="remark"], input[name*="reason"]',
        REASON,
        { timeout: 3000 }
      );
    } catch (_) {
      console.warn("⚠️  Could not auto-fill reason");
    }

    await sleep(1000);

    // ── Step 6: Submit ─────────────────────────────────────────────────────
    const submitSelectors = [
      'button[type="submit"]:has-text("Submit")',
      'button:has-text("Submit")',
      'button:has-text("Save")',
      'input[type="submit"]',
    ];

    for (const sel of submitSelectors) {
      try {
        await page.click(sel, { timeout: 3000 });
        console.log("✅ Regularization submitted!");
        break;
      } catch (_) {}
    }

    await sleep(2000);

    // Screenshot for verification (saved as artifact in GitHub Actions)
    await page.screenshot({ path: "regularization_result.png", fullPage: false });
    console.log("📸 Screenshot saved: regularization_result.png");

  } catch (err) {
    console.error("❌ Error during automation:", err.message);
    await page.screenshot({ path: "error_screenshot.png", fullPage: true });
    console.log("📸 Error screenshot saved");
    process.exit(1);
  } finally {
    await browser.close();
    console.log("🏁 Done.");
  }
}

run();
