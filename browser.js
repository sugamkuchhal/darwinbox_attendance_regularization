const { chromium } = require("playwright");
const { DARWINBOX_URL, USERNAME, PASSWORD } = require("./config");
const { sleep } = require("./utils");
const { handleMFA } = require("./mfa");

// ─── Browser setup ────────────────────────────────────────────────────────────

async function launchBrowser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  return { browser, page };
}

// ─── Login flow ───────────────────────────────────────────────────────────────
// Navigates through Darwinbox → Microsoft SSO → MFA → Darwinbox home.

async function login(page) {
  // Step 1: Navigate to Darwinbox login
  console.log("🔐 Navigating to Darwinbox...");
  await page.goto(`${DARWINBOX_URL}/user/login`, { waitUntil: "networkidle" });
  await sleep(2000);

  // Step 2: Click SSO / Microsoft button if present
  const ssoSelectors = [
    'a:has-text("Microsoft")',
    'button:has-text("Microsoft")',
    'a:has-text("SSO")',
    '.sso-btn',
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

  // Step 3: Enter Microsoft email
  console.log("📧 Entering email...");
  await page.fill('input[type="email"], input[name="loginfmt"]', USERNAME);
  await sleep(500);
  await page.click('input[type="submit"], button[type="submit"]');
  await page.waitForNavigation({ waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
  await sleep(2000);

  // Step 4: Enter Microsoft password
  console.log("🔑 Entering password...");
  await page.fill('input[type="password"], input[name="passwd"]', PASSWORD);
  await sleep(500);
  await page.click('input[type="submit"], button[type="submit"]');
  await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
  await sleep(2000);

  // Step 5: Handle MFA if present
  const onMicrosoftPage = page.url().includes("login.microsoftonline");
  const mfaVisible =
    (await page.$('text="Verify your identity"').catch(() => null)) ||
    (await page.$('text="Enter code"').catch(() => null))           ||
    (await page.$('input[name="otc"]').catch(() => null));

  if (onMicrosoftPage && mfaVisible) {
    const code = await handleMFA(page);
    if (code) {
      // Enter the code — not needed for push/call (page already moved forward)
      await page.fill('input[name="otc"], input[placeholder*="code"], input[placeholder*="Code"]', code);
      await sleep(500);
      await page.click('input[type="submit"], button[type="submit"]');
      await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
      await sleep(2000);
      console.log("✅ MFA code submitted");
    }
  } else {
    console.log("ℹ️  No MFA prompt — continuing");
  }

  // Step 6: Handle "Stay signed in?" prompt
  try {
    await page.click('input[value="Yes"], button:has-text("Yes")', { timeout: 5000 });
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
    await sleep(2000);
    console.log("✅ Clicked 'Stay signed in'");
  } catch (_) {}

  // Step 7: Verify we landed on Darwinbox
  const postLoginUrl = page.url();
  console.log(`✅ Post-login URL: ${postLoginUrl}`);
  if (!postLoginUrl.includes(new URL(DARWINBOX_URL).hostname)) {
    await page.screenshot({ path: "post_login_check.png" });
    throw new Error(`Login failed — still not on Darwinbox after MFA. URL: ${postLoginUrl}`);
  }

  console.log("✅ Logged in to Darwinbox");
}

module.exports = { launchBrowser, login };
