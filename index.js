// Darwinbox run: attendance regularization + leave / time correction /
// optional holiday approvals. Runs once a day.
// OneArvind payments live in payments.js on their own schedule.
const { DARWINBOX_URL, USERNAME, PASSWORD, EMPLOYEE_ID } = require("./config");
const { launchBrowser, login } = require("./browser");
const { regularizeAttendance } = require("./attendance-orchestrator");
const { approveAllLeaveRequests } = require("./leave-approval");
const { sendAttendanceEmail } = require("./email");

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

  let loginError    = null;
  let summary       = null;
  let taskApprovals = null;

  try {
    step(1, 4, "Login");
    try {
      await login(page);
    } catch (err) {
      loginError = err.message;
      console.error("❌ Login failed:", err.message);
      await page.screenshot({ path: "error_screenshot.png", fullPage: true }).catch(() => {});
    }

    if (!loginError) {
      step(2, 4, "Attendance Regularization");
      try {
        summary = await regularizeAttendance(page);
      } catch (err) {
        console.error("❌ Attendance step failed:", err.message);
        summary = { succeeded: [], failed: [], error: err.message };
      }

      step(3, 4, "Leave & Time Correction Approvals");
      try {
        taskApprovals = await approveAllLeaveRequests(page);
      } catch (err) {
        console.error("❌ Leave/time correction step failed:", err.message);
        taskApprovals = { error: err.message };
      }
    }

    step(4, 4, "Summary Email");
    await sendAttendanceEmail({ loginError, summary, taskApprovals });
  } finally {
    await browser.close();
  }
}

run();
