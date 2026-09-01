// Entry point for the leave approval flow.
// Validates env, logs in, approves all pending leave requests.
const { DARWINBOX_URL, USERNAME, PASSWORD } = require("./config");
const { launchBrowser, login } = require("./browser");
const { approveAllLeaveRequests } = require("./leave-approval");

async function run() {
  if (!DARWINBOX_URL || !USERNAME || !PASSWORD) {
    console.error("❌ Missing required env vars: DARWINBOX_URL, DARWINBOX_USERNAME, DARWINBOX_PASSWORD");
    process.exit(1);
  }

  const { browser, page } = await launchBrowser();

  try {
    await login(page);
    const { approved, failed } = await approveAllLeaveRequests(page);
    console.log(`\n✅ Done. Approved: ${approved}  |  Failed: ${failed}`);
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    await page.screenshot({ path: "leave_error.png", fullPage: true }).catch(() => {});
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();
