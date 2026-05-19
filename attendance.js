const { sleep } = require("./utils");
const { selectReason, getReasonPriority } = require("./reason");
const { reloadInMonthContext } = require("./attendance-page");
const { findAbsentDates, verifySubmission, findContextMenuIndex } = require("./attendance-scan");

async function takeStepScreenshot(page, path, note = "") {
  await page.screenshot({ path });
  console.log(`   📸 Screenshot saved: ${path}${note ? ` — ${note}` : ""}`);
}

// ─── Context menu ─────────────────────────────────────────────────────────────

async function openContextMenu(page, date) {
  const idx = await findContextMenuIndex(page, date);
  console.log(`   🔍 Context menu btn index: ${idx}`);
  const btn = page.locator("DBX-DS-BUTTON.row_context_menu").nth(idx);
  await btn.scrollIntoViewIfNeeded();
  await sleep(300);
  await btn.click({ timeout: 5000 });
  console.log(`   ✅ ⋮ clicked`);
  await sleep(800);
  return btn;
}

async function selectTimeCorrectionItem(page, btn) {
  // "Time Correction" is the first dropdown item — confirmed from screenshots
  // Rendered ~20px below the button bottom as a floating popover
  const box = await btn.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 20);
  console.log(`   ✅ Clicked Time Correction`);

  // Wait for modal — poll for reason dropdown to appear (up to 5s)
  await page.waitForFunction(() => {
    const modal = document.querySelector("dbx-ds-modal");
    return modal && modal.querySelectorAll("dbx-ds-dropdown").length >= 2;
  }, { timeout: 5000 });
  console.log(`   ✅ Modal ready`);
}

// ─── Form filling delegated to reason.js ───────────────────────────────────────

async function clickSubmit(page) {
  // Submit is the last dbx-ds-button in the modal footer shadow root
  try {
    const box = await page.evaluate(() => {
      const btns = document.querySelector("dbx-ds-modal").shadowRoot.querySelectorAll(".footer dbx-ds-button");
      const r    = btns[btns.length - 1].getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(3000);
    await takeStepScreenshot(page, "step_7_submitted.png", "submitted");
    console.log(`   ✅ Submitted`);
  } catch (err) {
    await takeStepScreenshot(page, "step_7_submitted_failed.png", "submit failed");
    throw err;
  }
}

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
    for (let attempt = 1; attempt <= 2; attempt++) {
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
        await sleep(500);
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
