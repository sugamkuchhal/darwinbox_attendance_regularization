const { sleep } = require("./utils");
const { selectReason, getReasonPriority } = require("./reason");
const { reloadInMonthContext } = require("./attendance-page");
const { findAbsentDates, verifySubmission } = require("./attendance-scan");
const { takeStepScreenshot, openContextMenu, selectTimeCorrectionItem, clickSubmit } = require("./attendance-actions");
const { ATTEMPTS_PER_REASON, UI_SLEEP_RETRY_MS } = require("./attendance-constants");

// ─── Context menu ─────────────────────────────────────────────────────────────

// ─── Form filling delegated to reason.js ───────────────────────────────────────

// ─── Per-date orchestration (with retry) ─────────────────────────────────────

async function attemptDate(page, date, forcedReason = null) {
  const btn = await openContextMenu(page, date);
  await selectTimeCorrectionItem(page, btn);
  await selectReason(page, forcedReason);
  await clickSubmit(page);
}

async function processDate(page, date, reloadView) {
  console.log(`\n📝 Processing: ${date}`);

  const reasons = getReasonPriority();
  for (let rIdx = 0; rIdx < reasons.length; rIdx++) {
    const reason = reasons[rIdx];
    console.log(`   🧾 Trying reason (${rIdx + 1}/${reasons.length}): ${reason}`);

    let submitted = false;
    for (let attempt = 1; attempt <= ATTEMPTS_PER_REASON; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`   🔄 Retry attempt ${attempt} (reason: ${reason})...`);
          await reloadView();
        }
        await attemptDate(page, date, reason);
        submitted = true;
        break;
      } catch (err) {
        console.warn(`   ⚠️ Attempt ${attempt} failed (reason: ${reason}): ${err.message}`);
        await page.screenshot({ path: `error_${date}_${reason.replace(/[^a-z0-9]+/gi, "_")}_attempt${attempt}.png` });
        try { await page.keyboard.press("Escape"); } catch (_) {}
        await sleep(UI_SLEEP_RETRY_MS);
      }
    }

    // verify this reason attempt
    await reloadView();
    if (submitted) {
      const verified = await verifySubmission(page, date);
      if (verified) return true;

      await page.screenshot({ path: `unverified_${date}_${reason.replace(/[^a-z0-9]+/gi, "_")}.png` });
      console.warn(`   ⚠️ Verification failed with reason "${reason}". Trying next reason...`);
    } else {
      console.warn(`   ⚠️ Submit flow never completed for reason "${reason}". Trying next reason...`);
    }
  }

  console.warn(`   ❌ All reasons exhausted for ${date}`);
  return false;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function regularizeAttendance(page) {
  const dayOfMonth = new Date().getDate();
  const monthContexts = (dayOfMonth >= 1 && dayOfMonth <= 4)
    ? ["previous", "current"]
    : ["current"];

  const overall = { succeeded: [], failed: [] };

  for (const monthContext of monthContexts) {
    const reloadForContext = () => reloadInMonthContext(page, monthContext);

    console.log("\n" + "=".repeat(60));
    console.log(`📆 Month context: ${monthContext.toUpperCase()}`);
    console.log("=".repeat(60));

    await reloadForContext();
  await page.screenshot({ path: "list_view.png" });

    const absentDates = await findAbsentDates(page);

    if (absentDates.length === 0) {
      console.log(`✅ No absent days to regularize in ${monthContext} month view`);
      continue;
    }

    console.log("─".repeat(50));
    console.log(`📋 ${absentDates.length} absent day(s) to regularize (${monthContext}):`);
    absentDates.forEach((d, i) => console.log(`   ${i + 1}. ${d}`));
    console.log("─".repeat(50));

    const results = { succeeded: [], failed: [] };
    for (const date of absentDates) {
      const ok = await processDate(page, date, reloadForContext);
      (ok ? results.succeeded : results.failed).push(date);
    }

    overall.succeeded.push(...results.succeeded.map(d => `${d} (${monthContext})`));
    overall.failed.push(...results.failed.map(d => `${d} (${monthContext})`));

    console.log(`✅ ${monthContext} month succeeded (${results.succeeded.length}): ${results.succeeded.join(", ") || "none"}`);
    if (results.failed.length > 0) {
      console.warn(`❌ ${monthContext} month failed    (${results.failed.length}): ${results.failed.join(", ")}`);
    }
  }

  console.log("\n" + "─".repeat(50));
  console.log(`✅ Total succeeded (${overall.succeeded.length}): ${overall.succeeded.join(", ") || "none"}`);
  if (overall.failed.length > 0) {
    console.warn(`❌ Total failed    (${overall.failed.length}): ${overall.failed.join(", ")}`);
  } else {
    console.log("✅ Total failed    (0): none");
  }
  await page.screenshot({ path: "regularization_result.png" });
  return overall;
}

module.exports = { regularizeAttendance };
