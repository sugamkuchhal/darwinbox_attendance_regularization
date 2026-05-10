const { DARWINBOX_URL, USERNAME, PASSWORD, EMPLOYEE_ID } = require("./config");
const { launchBrowser, login } = require("./browser");
const { regularizeAttendance } = require("./attendance");

async function run() {
  // Validate required secrets
  if (!DARWINBOX_URL || !USERNAME || !PASSWORD || !EMPLOYEE_ID) {
    console.error("❌ Missing required env vars: DARWINBOX_URL, DARWINBOX_USERNAME, DARWINBOX_PASSWORD, DARWINBOX_EMPLOYEE_ID");
    process.exit(1);
  }

  const { browser, page } = await launchBrowser();

  try {
    await login(page);
    await regularizeAttendance(page);
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    await page.screenshot({ path: "error_screenshot.png", fullPage: true }).catch(() => {});
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();
