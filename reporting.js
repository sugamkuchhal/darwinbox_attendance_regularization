// Shared reporting utilities (screenshots + standardized log messages).
async function takeStepScreenshot(page, path, note = "") {
  await page.screenshot({ path });
  console.log(`   📸 Screenshot saved: ${path}${note ? ` — ${note}` : ""}`);
}

module.exports = { takeStepScreenshot };
