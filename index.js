const { DARWINBOX_URL, USERNAME, PASSWORD, EMPLOYEE_ID } = require("./config");
const { launchBrowser, login } = require("./browser");
const { regularizeAttendance } = require("./attendance-orchestrator");
const { sendRegularizationEmail } = require("./email");

function shouldSkipToday() {
  const now          = new Date();
  const day          = now.getDay();   // 0=Sun, 6=Sat
  const date         = now.getDate();  // 1–31
  if (day == 0) {
    console.log(`⏭️  Logging — today is Sunday (holiday)`);
    return false;         // not Sunday — never skip
  }
  if (day !== 6) return false;         // not Saturday — never skip

  // Which Saturday of the month?
  const nthSaturday = Math.ceil(date / 7);
  if (nthSaturday === 2 || nthSaturday === 3) {
    console.log(`⏭️  Logging — today is the ${nthSaturday === 2 ? "2nd" : "3rd"} Saturday (holiday)`);
    return false;
  }
  return false;
}

async function run() {
  if (!DARWINBOX_URL || !USERNAME || !PASSWORD || !EMPLOYEE_ID) {
    console.error("❌ Missing required env vars: DARWINBOX_URL, DARWINBOX_USERNAME, DARWINBOX_PASSWORD, DARWINBOX_EMPLOYEE_ID");
    process.exit(1);
  }

  if (shouldSkipToday()) process.exit(0);

  const { browser, page } = await launchBrowser();

  try {
    await login(page);
    const summary = await regularizeAttendance(page);
    await sendRegularizationEmail(summary);
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    await page.screenshot({ path: "error_screenshot.png", fullPage: true }).catch(() => {});
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();
