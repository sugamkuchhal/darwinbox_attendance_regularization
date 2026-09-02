// Bootstraps runtime: validates env, logs in, runs flow, sends summary.
const { DARWINBOX_URL, USERNAME, PASSWORD, EMPLOYEE_ID } = require("./config");
const { launchBrowser, login } = require("./browser");
const { regularizeAttendance } = require("./attendance-orchestrator");
const { approveAllLeaveRequests } = require("./leave-approval");
const { approveAllConsultants } = require("./consultant-approval");
const { sendRegularizationEmail } = require("./email");

function step(n, total, label) {
  console.log(`\n${"═".repeat(40)}`);
  console.log(`STEP ${n}/${total} · ${label}`);
  console.log(`${"═".repeat(40)}`);
}

async function run() {
  if (!DARWINBOX_URL || !USERNAME || !PASSWORD || !EMPLOYEE_ID) {
    console.error("❌ Missing required env vars: DARWINBOX_URL, DARWINBOX_USERNAME, DARWINBOX_PASSWORD, DARWINBOX_EMPLOYEE_ID");
    process.exit(1);
  }

  const { browser, page } = await launchBrowser();

  try {
    step(1, 5, "Login");
    await login(page);

    step(2, 5, "Attendance Regularization");
    const summary = await regularizeAttendance(page);

    step(3, 5, "Leave & Time Correction Approvals");
    const taskApprovals = await approveAllLeaveRequests(page);

    step(4, 5, "Consultant & Intern Approvals");
    const consultantApprovals = await approveAllConsultants(page);

    step(5, 5, "Summary Email");
    await sendRegularizationEmail(summary, taskApprovals, consultantApprovals);
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    await page.screenshot({ path: "error_screenshot.png", fullPage: true }).catch(() => {});
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();
