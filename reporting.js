// Shared reporting utilities (screenshots + standardized log messages).

// Generate a run-scoped timestamp prefix once per process start.
// Format: YYYYMMDD_HHMMSS  (IST)
function makeRunPrefix() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const pad = n => String(n).padStart(2, "0");
  return (
    `${ist.getFullYear()}${pad(ist.getMonth() + 1)}${pad(ist.getDate())}` +
    `_${pad(ist.getHours())}${pad(ist.getMinutes())}${pad(ist.getSeconds())}`
  );
}

const RUN_PREFIX = makeRunPrefix();

function screenshotPath(filename) {
  // Prepend run timestamp so successive runs never overwrite each other's debug screenshots.
  // e.g. "20260707_093045_step_1_panel_open.png"
  return `${RUN_PREFIX}_${filename}`;
}

async function takeStepScreenshot(page, filename, note = "") {
  const path = screenshotPath(filename);
  await page.screenshot({ path });
  console.log(`   📸 Screenshot saved: ${path}${note ? ` — ${note}` : ""}`);
}

module.exports = { RUN_PREFIX, screenshotPath, takeStepScreenshot };
