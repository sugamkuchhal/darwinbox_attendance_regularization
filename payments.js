// OneArvind consultant + intern payment approvals.
//
// onearvind.com is intermittently unreachable from GitHub runners, so this
// runs several times a day and stops for the day as soon as one run gets
// through. "Got through" is recorded by writing a dated marker file that the
// workflow persists in the Actions cache; later slots restore it and skip.
const fs = require("fs");
const path = require("path");
const { USERNAME, PASSWORD } = require("./config");
const { launchBrowser } = require("./browser");
const { approveAllConsultants } = require("./consultant-approval");
const { approveAllExpenses } = require("./expense-approval");
const { sendPaymentsEmail } = require("./email");

const MARKER_DIR = path.join(__dirname, ".payments-state");

// IST date — the schedule is expressed in IST, so the marker must be too.
function istDate() {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, "0")}-${String(ist.getDate()).padStart(2, "0")}`;
}

function markerPath() {
  return path.join(MARKER_DIR, `done-${istDate()}`);
}

function alreadyDoneToday() {
  try { return fs.existsSync(markerPath()); } catch (_) { return false; }
}

function markDoneToday() {
  try {
    fs.mkdirSync(MARKER_DIR, { recursive: true });
    fs.writeFileSync(markerPath(), new Date().toISOString());
    console.log(`📌 Marked complete for ${istDate()} — later slots today will skip`);
  } catch (err) {
    console.warn(`⚠️ Could not write marker: ${err.message}`);
  }
}

// The workflow sets IS_LAST_RUN on the final slot of the day.
const isLastRun = String(process.env.IS_LAST_RUN || "").toLowerCase() === "true";

async function run() {
  if (!USERNAME || !PASSWORD) {
    console.error("❌ Missing DARWINBOX_USERNAME / DARWINBOX_PASSWORD");
    process.exit(1);
  }

  console.log(`\n${"═".repeat(40)}`);
  console.log(`ONEARVIND · PAYMENTS · ${istDate()}${isLastRun ? " (last slot)" : ""}`);
  console.log(`${"═".repeat(40)}`);

  if (alreadyDoneToday()) {
    console.log("✅ Already completed earlier today — nothing to do");
    return;
  }

  const { browser, page } = await launchBrowser();
  let result = null;
  let expenses = null;

  try {
    result = await approveAllConsultants(page);

    // Expenses live on a different host but behind the same sign-in, so only
    // attempt them once OneArvind has actually been reached.
    if (result?.loginOk) {
      console.log(`\n${"\u2500".repeat(40)}`);
      console.log("EXPENSES");
      console.log(`${"\u2500".repeat(40)}`);
      try {
        expenses = await approveAllExpenses(page);
      } catch (err) {
        console.error("❌ Expenses step failed:", err.message);
        expenses = { error: err.message };
      }
    }
  } catch (err) {
    console.error("❌ Payments step failed:", err.message);
    result = { loginOk: false, error: err.message };
  } finally {
    await browser.close();
  }

  // Reaching OneArvind is what counts as done for the day — whether or not
  // there was anything to approve.
  if (result?.loginOk) markDoneToday();

  await sendPaymentsEmail({ result, expenses, isLastRun });
}

run();
