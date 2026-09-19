const { chromium } = require("playwright");
const { DARWINBOX_URL, USERNAME, PASSWORD } = require("./config");
const { sleep, redactUrl } = require("./utils");
const { getTotpCodes } = require("./mfa");

// ─── Browser setup ────────────────────────────────────────────────────────────

// Headless Chromium has no authenticator, so a passkey prompt can never be
// satisfied — it hangs forever behind an overlay. We make the browser report
// no passkey support at all, and hard-cancel any ceremony that starts anyway.
const KILL_WEBAUTHN = () => {
  try {
    delete Window.prototype.PublicKeyCredential;
    delete window.PublicKeyCredential;
    Object.defineProperty(window, "PublicKeyCredential", {
      get: () => undefined,
      configurable: true,
    });
  } catch (_) {}
  try {
    if (navigator.credentials) {
      const orig = navigator.credentials.get
        ? navigator.credentials.get.bind(navigator.credentials)
        : null;
      navigator.credentials.get = function (options) {
        if (options && options.publicKey) {
          return Promise.reject(
            new DOMException(
              "The operation either timed out or was not allowed.",
              "NotAllowedError"
            )
          );
        }
        return orig ? orig(options) : Promise.resolve(null);
      };
    }
  } catch (_) {}
};

async function launchBrowser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  });
  await context.addInitScript(KILL_WEBAUTHN);
  const page = await context.newPage();
  return { browser, page };
}

// ─── Login steps ──────────────────────────────────────────────────────────────

async function navigateToLogin(page) {
  console.log("🔐 Navigating to Darwinbox...");
  await page.goto(`${DARWINBOX_URL}/user/login`, { waitUntil: "domcontentloaded" });
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
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 });
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
  await page.click('input[type="submit"], button[type="submit"]', { timeout: 5000 }).catch(() => {});
  await page.waitForSelector('input[type="password"], input[name="passwd"], #i0118', { timeout: 15000 });

  console.log("🔑 Entering password...");
  await page.fill('input[type="password"], input[name="passwd"], #i0118', PASSWORD);
  await sleep(500);
  await page.click('input[type="submit"], button[type="submit"]', { timeout: 5000 }).catch(() => {});
  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await sleep(2000);
}

// ─── Page-state helpers ───────────────────────────────────────────────────────

// Click by visible text / aria-label via JS so overlays can't intercept.
async function clickByText(page, preferRe, avoidRe) {
  return page.evaluate(
    ({ preferSrc, avoidSrc }) => {
      const prefer = new RegExp(preferSrc, "i");
      const avoid = avoidSrc ? new RegExp(avoidSrc, "i") : null;
      const nodes = Array.from(
        document.querySelectorAll(
          'button, a, [role="button"], [role="link"], [role="listitem"], li, div[tabindex], input[type="submit"]'
        )
      );
      for (const el of nodes) {
        if (el.offsetParent === null && el.getClientRects().length === 0) continue;
        const t = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
        if (!t || t.length > 200) continue;
        if (!prefer.test(t)) continue;
        if (avoid && avoid.test(t)) continue;
        el.click();
        return t.slice(0, 80);
      }
      return null;
    },
    { preferSrc: preferRe, avoidSrc: avoidRe || null }
  );
}

async function clickById(page, id) {
  return page.evaluate((elId) => {
    const el = document.getElementById(elId);
    if (!el) return false;
    el.click();
    return true;
  }, id);
}

async function dumpPage(page, label) {
  const info = await page
    .evaluate(() => ({
      title: document.title,
      text: (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 600),
      els: Array.from(
        document.querySelectorAll('button, a, [role="button"], input, [role="listitem"], li')
      )
        .filter((el) => el.offsetParent !== null || el.getClientRects().length)
        .map((el) =>
          `${el.tagName}#${el.id || "-"}[${el.getAttribute("name") || el.type || "-"}] "${(
            el.innerText ||
            el.value ||
            el.getAttribute("aria-label") ||
            ""
          )
            .trim()
            .slice(0, 60)}"`
        )
        .slice(0, 40),
    }))
    .catch(() => null);
  if (!info) return;
  console.log(`🔍 [${label}] title="${info.title}"`);
  console.log(`🔍 [${label}] text="${info.text}"`);
  info.els.forEach((e) => console.log(`   ${e}`));
}

const OTC_SEL =
  'input[name="otc"], input#otc, input[autocomplete="one-time-code"], input[inputmode="numeric"]';

async function submitTotp(page) {
  let codes;
  try {
    codes = getTotpCodes();
  } catch (err) {
    console.warn(`⚠️ TOTP unavailable: ${err.message}`);
    return false;
  }
  for (const [i, code] of [codes.code, codes.retryCode].entries()) {
    if (i > 0) {
      console.log("🔄 Retrying with next TOTP window (waiting 30s)...");
      await sleep(30000);
    }
    const box = await page.$(OTC_SEL);
    if (!box) return false;
    await box.fill("").catch(() => {});
    await box.type(code, { delay: 40 }).catch(() => {});
    await sleep(300);
    const clicked =
      (await clickById(page, "idSIButton9")) ||
      (await clickByText(page, "verify|sign in|submit|next|continue"));
    if (!clicked) await page.keyboard.press("Enter").catch(() => {});
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await sleep(2500);
    const stillOtc = await page.$(OTC_SEL);
    if (!stillOtc) {
      console.log("✅ TOTP accepted");
      return true;
    }
    console.warn("⚠️ TOTP not accepted on this attempt");
  }
  return false;
}

// ─── Auth resolver ────────────────────────────────────────────────────────────
// Microsoft's new sign-in can present these pages in any order and any
// combination. Rather than assume one sequence, look at what's on screen each
// round and act, until Darwinbox is reached.
async function resolveAuth(page) {
  const host = new URL(DARWINBOX_URL).hostname;
  const deadline = Date.now() + 4 * 60 * 1000;
  let round = 0;
  let lastSignature = "";
  let stuckRounds = 0;
  let totpTried = 0;

  while (Date.now() < deadline) {
    round++;
    const url = page.url();
    if (url.includes(host)) {
      console.log(`✅ Reached Darwinbox after ${round} round(s)`);
      return;
    }

    const state = await page
      .evaluate(
        ({ otcSel }) => ({
          otc: !!document.querySelector(otcSel),
          pwd: !!document.querySelector('input[type="password"]'),
          title: document.title,
          text: (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300),
        }),
        { otcSel: OTC_SEL }
      )
      .catch(() => ({ otc: false, pwd: false, title: "", text: "" }));

    const signature = `${url}|${state.title}|${state.text.slice(0, 120)}`;
    stuckRounds = signature === lastSignature ? stuckRounds + 1 : 0;
    lastSignature = signature;

    console.log(`↻ [round ${round}] ${redactUrl(url)} — "${state.title}"`);

    // 1. Code entry screen
    if (state.otc) {
      if (totpTried >= 2) {
        throw new Error("TOTP rejected repeatedly — check DARWINBOX_TOTP_SECRET");
      }
      totpTried++;
      console.log("🔢 Code entry detected — submitting TOTP");
      await submitTotp(page);
      continue;
    }

    // 2. Passkey / security key screen — leave it
    if (url.includes("bridge/fido") || /face, fingerprint|security key|passkey/i.test(state.title + " " + state.text)) {
      console.log("🔑 Passkey screen — switching to another method");
      const left =
        (await clickByText(page, "other ways to sign in|different method|another way|use a code|can't use")) ||
        (await clickById(page, "idA_PWD_SwitchToCredPicker")) ||
        (await clickById(page, "idBtn_Back"));
      if (!left) {
        await dumpPage(page, "fido-stuck");
        await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      }
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      await sleep(2000);
      continue;
    }

    // 3. Method picker — choose authenticator-app code
    const picked = await clickByText(
      page,
      "authenticator app|verification code|use a code|enter a code|totp|authenticator",
      "face|fingerprint|security key|passkey|text|call|sms|email|password"
    );
    if (picked) {
      console.log(`📲 Picked method: "${picked}"`);
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      await sleep(2000);
      continue;
    }

    // 4. Stay signed in / consent
    if (/stay signed in|keep me signed in|reduce the number of times/i.test(state.text)) {
      console.log("💾 'Stay signed in' — confirming");
      (await clickById(page, "idSIButton9")) || (await clickByText(page, "^yes$|stay signed in"));
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      await sleep(2000);
      continue;
    }

    // 5. Generic continue on an interstitial
    if (stuckRounds >= 1) {
      const advanced =
        (await clickById(page, "idSIButton9")) ||
        (await clickByText(page, "^next$|^continue$|^sign in$|^yes$|^ok$"));
      if (advanced) {
        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
        await sleep(2000);
        continue;
      }
    }

    // 6. Nothing recognised
    if (stuckRounds >= 3) {
      await dumpPage(page, "unrecognised");
      throw new Error(`Stuck on unrecognised page: ${redactUrl(url)} — "${state.title}"`);
    }
    await sleep(2500);
  }
  await dumpPage(page, "timeout");
  throw new Error("Timed out resolving Microsoft sign-in");
}

async function verifyLogin(page) {
  const url = page.url();
  const safeUrl = redactUrl(url);
  console.log(`✅ Post-login URL: ${safeUrl}`);
  if (!url.includes(new URL(DARWINBOX_URL).hostname)) {
    await page.screenshot({ path: "post_login_check.png" });
    throw new Error(`Login failed — not on Darwinbox. URL: ${safeUrl}`);
  }
  console.log("✅ Logged in to Darwinbox");
}

// ─── Login orchestrator ───────────────────────────────────────────────────────

async function login(page) {
  await navigateToLogin(page);
  await clickSsoButton(page);
  await enterCredentials(page);
  await resolveAuth(page);
  await verifyLogin(page);
}

module.exports = { launchBrowser, login };
