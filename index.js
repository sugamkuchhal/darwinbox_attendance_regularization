// Bootstraps runtime: validates env, logs in, runs flow, sends summary.
const { DARWINBOX_URL, USERNAME, PASSWORD, EMPLOYEE_ID } = require("./config");
const { launchBrowser, login } = require("./browser");
const { regularizeAttendance } = require("./attendance-orchestrator");
const { approveAllLeaveRequests } = require("./leave-approval");
const { approveAllConsultants } = require("./consultant-approval");
const { sendSummaryEmail } = require("./email");

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

  // Step results — null means "did not run"
  let loginError      = null;
  let summary         = null;  // attendance
  let taskApprovals   = null;  // leave + time correction + optional holiday
  let consultantApprovals = null;

  try {
    step(1, 5, "Login");
    try {
      await login(page);
    } catch (err) {
      loginError = err.message;
      console.error("❌ Login failed:", err.message);
      await page.screenshot({ path: "error_screenshot.png", fullPage: true }).catch(() => {});
    }

    if (!loginError) {
      step(2, 5, "Attendance Regularization");
      try {
        summary = await regularizeAttendance(page);
      } catch (err) {
        console.error("❌ Attendance step failed:", err.message);
        summary = { succeeded: [], failed: [], error: err.message };
      }

      step(3, 5, "Leave & Time Correction Approvals");
      try {
        taskApprovals = await approveAllLeaveRequests(page);
      } catch (err) {
        console.error("❌ Leave/time correction step failed:", err.message);
        taskApprovals = { error: err.message };
      }

      step(4, 5, "Consultant & Intern Approvals");
      try {
        consultantApprovals = await approveAllConsultants(page);
      } catch (err) {
        console.error("❌ Consultant/intern step failed:", err.message);
        consultantApprovals = { error: err.message };
      }
    }

    step(5, 5, "Summary Email");
    await sendSummaryEmail({ loginError, summary, taskApprovals, consultantApprovals });

  } finally {
    await browser.close();
  }
}

run();
