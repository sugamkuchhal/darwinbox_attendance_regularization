const { chromium } = require("playwright");
const { DARWINBOX_URL, USERNAME, PASSWORD } = require("./config");
const { sleep } = require("./utils");
const { handleMFA, getTotpCodes } = require("./mfa");

// ─── Browser setup ────────────────────────────────────────────────────────────

async function launchBrowser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  return { browser, page };
}

// ─── Login steps ──────────────────────────────────────────────────────────────

async function navigateToLogin(page) {
  console.log("🔐 Navigating to Darwinbox...");
  await page.goto(`${DARWINBOX_URL}/user/login`, { waitUntil: "networkidle" });
  await sleep(2000);
}

async function clickSsoButton(page) {
  const selectors = [
    'a:has-text("Microsoft")',
    'button:has-text("Microsoft")',
    'a:has-text("SSO")',
    '.sso-btn',
  ];
  for (const sel of selectors) {
    try {
      await page.click(sel, { timeout: 3000 });
      console.log(`✅ SSO clicked: ${sel}`);
      await page.waitForNavigation({ waitUntil: "networkidle", timeout: 10000 });
      await sleep(2000);
      return;
    } catch (_) {}
  }
  console.warn("⚠️ No SSO button found — may already be on Microsoft login");
}

async function enterCredentials(page) {
  console.log("📧 Entering email...");
  await page.fill('input[type="email"], input[name="loginfmt"]', USERNAME);
  await sleep(500);
  await page.click('input[type="submit"], button[type="submit"]');
  await page.waitForNavigation({ waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
  await sleep(2000);

  console.log("🔑 Entering password...");
  await page.fill('input[type="password"], input[name="passwd"]', PASSWORD);
  await sleep(500);
  await page.click('input[type="submit"], button[type="submit"]');
  await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
  await sleep(2000);
}

async function handleMfaIfPresent(page) {
  const onMicrosoftPage = page.url().includes("login.microsoftonline");
  const mfaVisible =
    (await page.$('text="Verify your identity"').catch(() => null)) ||
    (await page.$('text="Enter code"').catch(() => null))           ||
    (await page.$('input[name="otc"]').catch(() => null));

  if (!onMicrosoftPage || !mfaVisible) {
    console.log("ℹ️  No MFA prompt — continuing");
    return;
  }

  async function submitCodeWithOneRetry(mfaResult) {
    const now = Math.floor(Date.now() / 1000);
    const secsIntoWindow = now % 30;
    const secsToNext = 30 - secsIntoWindow;
    console.log(`🧭 MFA debug: submitting code at ${new Date().toISOString()} (TOTP window +${secsIntoWindow}s, next in ${secsToNext}s)`);

    const codeSelector = 'input[name="otc"], input[placeholder*="code"], input[placeholder*="Code"]';
    const submitSelector = 'input[type="submit"], button[type="submit"]';
    const codeTargets = await page.locator(codeSelector).count();
    const submitTargets = await page.locator(submitSelector).count();
    console.log(`🧭 MFA debug: code fields found=${codeTargets}, submit buttons found=${submitTargets}`);

    await page.fill('input[name="otc"], input[placeholder*="code"], input[placeholder*="Code"]', mfaResult.code);
    await sleep(500);
    await page.click('input[type="submit"], button[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
    await sleep(2000);
    const stillOnMicrosoft = page.url().includes("login.microsoftonline");
    const stillNeedsCode = await page.$('input[name="otc"], input[placeholder*="code"], input[placeholder*="Code"]').catch(() => null);
    if (stillOnMicrosoft && stillNeedsCode && mfaResult.retryCode) {
      console.warn("⚠️ MFA code did not pass. Waiting 30s and retrying once with next TOTP window...");
      await sleep(30000);
      const retryNow = Math.floor(Date.now() / 1000);
      const retryIntoWindow = retryNow % 30;
      const retryToNext = 30 - retryIntoWindow;
      console.log(`🧭 MFA debug: retry submit at ${new Date().toISOString()} (TOTP window +${retryIntoWindow}s, next in ${retryToNext}s)`);
      await page.fill('input[name="otc"], input[placeholder*="code"], input[placeholder*="Code"]', mfaResult.retryCode);
      await sleep(500);
      await page.click('input[type="submit"], button[type="submit"]');
      await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
      await sleep(2000);
      return !(page.url().includes("login.microsoftonline") && await page.$('input[name="otc"], input[placeholder*="code"], input[placeholder*="Code"]').catch(() => null));
    }
    return true;
  }

  const codeInputVisible = await page.$('input[name="otc"], input[placeholder*="code"], input[placeholder*="Code"]').catch(() => null);
  if (codeInputVisible) {
    console.log("🔐 MFA code-entry screen detected first. Attempting direct TOTP flow.");
    try {
      const directTotp = getTotpCodes();
      const codePassed = await submitCodeWithOneRetry(directTotp);
      if (codePassed) {
        console.log("✅ MFA direct TOTP flow completed");
        return;
      }
      console.warn("⚠️ Direct TOTP attempts failed. Trying fallback methods from picker...");
    } catch (err) {
      console.warn(`⚠️ Direct TOTP unavailable: ${err.message}. Falling back to picker methods...`);
    }
    try { await page.click('a:has-text("Sign in another way"), a:has-text("other way"), a:has-text("different")', { timeout: 5000 }); } catch (_) {}
    await sleep(1500);
  }

  const mfaResult = await handleMFA(page);
  if (mfaResult?.code) {
    await submitCodeWithOneRetry(mfaResult);
    console.log("✅ MFA code submitted");
  }
}

async function handleStaySignedIn(page) {
  try {
    await page.click('input[value="Yes"], button:has-text("Yes")', { timeout: 5000 });
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
    await sleep(2000);
    console.log("✅ Clicked 'Stay signed in'");
  } catch (_) {}
}

async function verifyLogin(page) {
  const url = page.url();
  console.log(`✅ Post-login URL: ${url}`);
  if (!url.includes(new URL(DARWINBOX_URL).hostname)) {
    await page.screenshot({ path: "post_login_check.png" });
    throw new Error(`Login failed — not on Darwinbox. URL: ${url}`);
  }
  console.log("✅ Logged in to Darwinbox");
}

// ─── Login orchestrator ───────────────────────────────────────────────────────

async function login(page) {
  await navigateToLogin(page);
  await clickSsoButton(page);
  await enterCredentials(page);
  await handleMfaIfPresent(page);
  await handleStaySignedIn(page);
  await verifyLogin(page);
}

module.exports = { launchBrowser, login };
