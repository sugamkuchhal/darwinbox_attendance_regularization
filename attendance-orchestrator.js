// Coordinates month/date processing and reason-based retries.
const { sleep } = require("./utils");
const { selectReason, getReasonPriority } = require("./reason");
const { reloadInMonthContext } = require("./attendance-page");
const { getTodayStrIST, findAbsentDates, verifySubmission, findContextMenuIndex } = require("./attendance-scan");
const { openContextMenu, selectTimeCorrectionItem, closePanelIfOpen, clickSubmit } = require("./attendance-actions");
const { ATTEMPTS_PER_REASON, retryDelayMs } = require("./attendance-constants");
const { loadOutdoorDutyDates, buildReasonPriorityForDate } = require("./outdoor-duty-dates");

// Use IST to decide whether to include the previous month (days 1–4).
function buildMonthContexts() {
  const todayStr   = getTodayStrIST();           // "DD-MM-YYYY"
  const dayOfMonth = parseInt(todayStr.slice(0, 2), 10);
  return (dayOfMonth >= 1 && dayOfMonth <= 4)
    ? ["previous", "current"]
    : ["current"];
}

function sanitizeReason(reason) {
  return reason.replace(/[^a-z0-9]+/gi, "_");
}

function buildErrorScreenshotName(date, reason, attempt) {
  return `error_${date}_${sanitizeReason(reason)}_attempt${attempt}.png`;
}

function buildUnverifiedScreenshotName(date, reason) {
  return `unverified_${date}_${sanitizeReason(reason)}.png`;
}

function logMonthSummary(monthContext, results) {
  console.log(`✅ ${monthContext} month succeeded (${results.succeeded.length}): ${results.succeeded.join(", ") || "none"}`);
  if (results.failed.length > 0) {
    console.warn(`❌ ${monthContext} month failed    (${results.failed.length}): ${results.failed.join(", ")}`);
  }
}

function logOverallSummary(overall) {
  console.log("\n" + "─".repeat(50));
  console.log(`✅ Total succeeded (${overall.succeeded.length}): ${overall.succeeded.join(", ") || "none"}`);
  if (overall.failed.length > 0) {
    console.warn(`❌ Total failed    (${overall.failed.length}): ${overall.failed.join(", ")}`);
  } else {
    console.log("✅ Total failed    (0): none");
  }
}

async function runMonthContext(page, monthContext, outdoorDutyDates) {
  const reloadForContext = () => reloadInMonthContext(page, monthContext);
  console.log("\n" + "=".repeat(60));
  console.log(`📆 Month context: ${monthContext.toUpperCase()}`);
  console.log("=".repeat(60));
  await reloadForContext();
  const absentDates = await findAbsentDates(page);
  if (absentDates.length === 0) {
    console.log(`✅ No absent days to regularize in ${monthContext} month`);
    return { succeeded: [], failed: [] };
  }
  console.log(`📋 ${absentDates.length} absent day(s): ${absentDates.join(", ")}`);

  const results = { succeeded: [], failed: [] };
  for (const date of absentDates) {
    const ok = await processDate(page, date, reloadForContext, outdoorDutyDates, monthContext);
    (ok ? results.succeeded : results.failed).push(date);
  }
  logMonthSummary(monthContext, results);
  return results;
}

// Executes one end-to-end submit attempt for a specific date/reason.
async function attemptDate(page, date, forcedReason, monthContext) {
  await openContextMenu(page, date, monthContext);
  await selectTimeCorrectionItem(page);
  await selectReason(page, forcedReason);
  await clickSubmit(page);
}

// Retries a single reason path before moving to next reason.
async function attemptReasonWithRetries(page, date, reason, reloadView, monthContext) {
  for (let attempt = 1; attempt <= ATTEMPTS_PER_REASON; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`   🔄 Retry attempt ${attempt} (reason: ${reason})...`);
        await reloadView();
      }
      await attemptDate(page, date, reason, monthContext);
      return true;
    } catch (err) {
      console.warn(`   ⚠️ Attempt ${attempt} failed (reason: ${reason}): ${err.message}`);
      await page.screenshot({ path: buildErrorScreenshotName(date, reason, attempt) });
      await closePanelIfOpen(page);
      await sleep(retryDelayMs(attempt));
    }
  }
  return false;
}

async function processDate(page, date, reloadView, outdoorDutyDates, monthContext = "") {
  console.log(`\n📝 Processing: ${date}`);
  const reasons = buildReasonPriorityForDate(date, outdoorDutyDates, getReasonPriority());
  if (outdoorDutyDates.has(date)) {
    console.log(`   🌤️ Outdoor Duty date — prioritizing Outdoor Duty reason`);
  }

  for (let rIdx = 0; rIdx < reasons.length; rIdx++) {
    const reason = reasons[rIdx];
    console.log(`   🧾 Trying reason (${rIdx + 1}/${reasons.length}): ${reason}`);

    const submitted = await attemptReasonWithRetries(page, date, reason, reloadView, monthContext);

    // Only reload for verification if a submit was actually attempted —
    // avoids a wasted page load when the whole attempt failed before submit.
    if (submitted) {
      await reloadView();
      const verified = await verifySubmission(page, date);
      if (verified) return true;
      await page.screenshot({ path: buildUnverifiedScreenshotName(date, reason) });
      console.warn(`   ⚠️ Verification failed with reason "${reason}". Trying next reason...`);
    } else {
      console.warn(`   ⚠️ Submit flow never completed for reason "${reason}". Trying next reason...`);
    }

    // Reload between reasons so the list view is ready for the next attempt.
    if (rIdx < reasons.length - 1) await reloadView();
  }

  console.warn(`   ❌ All reasons exhausted for ${date}`);
  return false;
}

// Public entrypoint for attendance regularization.
async function regularizeAttendance(page) {
  const outdoorDutyDates = loadOutdoorDutyDates();
  const monthContexts    = buildMonthContexts();
  const overall          = { succeeded: [], failed: [] };

  for (const monthContext of monthContexts) {
    const results = await runMonthContext(page, monthContext, outdoorDutyDates);
    overall.succeeded.push(...results.succeeded.map(d => `${d} (${monthContext})`));
    overall.failed.push(...results.failed.map(d => `${d} (${monthContext})`));
  }

  logOverallSummary(overall);
  await page.screenshot({ path: "regularization_result.png" });
  return overall;
}

module.exports = { regularizeAttendance };
