// Shared reporting utilities (screenshots + standardized log messages).

// Generate a run-scoped timestamp prefix once per process start.
// Format: YYYYMMDD_HHMMSS (IST)
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
  return `${RUN_PREFIX}_${filename}`;
}

// Silent by default — step screenshots saved without cluttering the log.
// Pass { log: true } to emit a line (used for error screenshots).
async function takeStepScreenshot(page, filename, note = "", { log = false } = {}) {
  const filePath = screenshotPath(filename);
  await page.screenshot({ path: filePath });
  if (log) {
    console.log(`   📸 ${filePath}${note ? ` — ${note}` : ""}`);
  }
}

module.exports = { takeStepScreenshot };
