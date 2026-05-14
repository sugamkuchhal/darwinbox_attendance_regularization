const { DARWINBOX_URL, EMPLOYEE_ID } = require("./config");
const { sleep } = require("./utils");

// ─── Page navigation ──────────────────────────────────────────────────────────

async function activateListView(page) {
  try {
    const listSvg = page.locator('svg[viewBox="0 0 12 10"]').first();
    if (await listSvg.count() > 0) {
      await listSvg.locator("..").click({ timeout: 3000 });
      await sleep(1500);
      console.log("✅ List view activated");
    }
  } catch (err) {
    console.warn(`⚠️ List view toggle failed: ${err.message}`);
  }
}

async function reloadAttendancePage(page) {
  await page.goto(`${DARWINBOX_URL}/ms/time/${EMPLOYEE_ID}/attendance`, { waitUntil: "networkidle" });
  await sleep(2000);
  await activateListView(page);
}

async function clickPreviousMonth(page) {
  const leftChevronPath = 'path[d="M15 18L9.70711 12.7071C9.31658 12.3166 9.31658 11.6834 9.70711 11.2929L15 6"]';
  const path = page.locator(leftChevronPath).first();
  if (await path.count() === 0) {
    throw new Error("Previous month chevron path not found");
  }

  const clickableParent = path.locator("xpath=ancestor::*[self::button or @role='button' or contains(@class,'btn')][1]").first();
  if (await clickableParent.count() > 0) {
    await clickableParent.click({ timeout: 4000 });
  } else {
    await path.click({ timeout: 4000 });
  }
  await sleep(1500);
  console.log("✅ Switched to previous month");
}

async function reloadInMonthContext(page, monthContext) {
  await reloadAttendancePage(page);
  if (monthContext === "previous") {
    await clickPreviousMonth(page);
  }
}

// ─── Row scanning ─────────────────────────────────────────────────────────────

async function getTodayStr(page) {
  return page.evaluate(() => {
    const d  = new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}-${mm}-${d.getFullYear()}`;
  });
}

async function findAbsentDates(page) {
  console.log("🔍 Scanning attendance rows...");
  const todayStr = await getTodayStr(page);
  console.log(`📅 Today: ${todayStr} — skipping today and future`);

  const { results, skipped, totalRows } = await page.evaluate((today) => {
    const results = [];
    const skipped = [];
    const seen    = new Set();

    function toNum(s) {
      const [dd, mm, yyyy] = s.split("-");
      return parseInt(yyyy + mm + dd, 10);
    }
    const todayNum = toNum(today);
    let totalRows  = 0;

    for (const row of document.querySelectorAll("table tr")) {
      if ([...row.querySelectorAll("td")].length < 2) continue;
      totalRows++;

      // Date — confirmed: td.primary-cell > span[dir="auto"]
      const dateSpan = row.querySelector('td.primary-cell span[dir="auto"]');
      if (!dateSpan) continue;
      const dateStr = (dateSpan.innerText || "").trim();
      if (!/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) continue;

      if (seen.has(dateStr))         { skipped.push({ date: dateStr, reason: "duplicate" }); continue; }
      if (toNum(dateStr) >= todayNum){ skipped.push({ date: dateStr, reason: "today or future" }); continue; }
      seen.add(dateStr);

      // Attendance status — confirmed: td.primary-cell.sorting_1 > span#dbx-overflow-span
      const attendanceSpan   = row.querySelector('td.primary-cell.sorting_1 span#dbx-overflow-span');
      const attendanceStatus = (attendanceSpan?.innerText || "").trim();

      // Request badge — confirmed: dbx-ds-status-tag presence means request exists (Shadow DOM)
      const hasRequestBadge = !!row.querySelector('dbx-ds-status-tag');

      if (attendanceStatus !== "Absent") {
        skipped.push({ date: dateStr, reason: `not absent: ${attendanceStatus || "unknown"}` });
        continue;
      }
      if (hasRequestBadge) {
        skipped.push({ date: dateStr, reason: "request already exists" });
        continue;
      }

      results.push(dateStr);
    }

    return { results, skipped, totalRows };
  }, todayStr);

  console.log(`🔍 Scanned ${totalRows} rows`);
  skipped.forEach(s => console.log(`   ⏭️  ${s.date} — ${s.reason}`));
  return results;
}

// ─── Success verification ─────────────────────────────────────────────────────

async function verifySubmission(page, date) {
  // After reload, check that the row now has a dbx-ds-status-tag (request badge)
  const verified = await page.evaluate((targetDate) => {
    const row = [...document.querySelectorAll("table tr")].find(r => {
      const span = r.querySelector('td.primary-cell span[dir="auto"]');
      return span && (span.innerText || "").trim() === targetDate;
    });
    if (!row) return { ok: false, reason: "row not found after reload" };
    const hasBadge = !!row.querySelector('dbx-ds-status-tag');
    return { ok: hasBadge, reason: hasBadge ? "badge present" : "no badge found — request may not have gone through" };
  }, date);

  if (verified.ok) {
    console.log(`   ✅ Verified: ${date} — request badge confirmed`);
  } else {
    console.warn(`   ⚠️ Verification failed: ${date} — ${verified.reason}`);
  }
  return verified.ok;
}

// ─── Context menu ─────────────────────────────────────────────────────────────

async function findContextMenuIndex(page, date) {
  const idx = await page.evaluate((targetDate) => {
    const targetRow = [...document.querySelectorAll("table tr")].find(r => {
      const span = r.querySelector('td.primary-cell span[dir="auto"]');
      return span && (span.innerText || "").trim() === targetDate;
    });
    if (!targetRow) return -1;
    return [...document.querySelectorAll("DBX-DS-BUTTON.row_context_menu")]
      .findIndex(btn => targetRow.contains(btn));
  }, date);

  if (idx === -1) throw new Error(`Row not found for date ${date}`);
  return idx;
}

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

// ─── Form filling ─────────────────────────────────────────────────────────────

async function getReasonDropdownBox(page) {
  // Deterministically find the Reason dropdown by label text, then scroll it into view.
  const result = await page.evaluate(() => {
    const modal = document.querySelector("dbx-ds-modal");
    if (!modal) return { ok: false, reason: "modal not found" };

    const labels = [...modal.querySelectorAll("*")].filter((el) => {
      const text = (el.textContent || "").trim();
      return /^Reason\b/i.test(text);
    });
    if (labels.length === 0) return { ok: false, reason: "Reason label not found" };

    const label = labels[0];
    const dropdown = label.closest("div")?.querySelector("dbx-ds-dropdown")
      || label.parentElement?.querySelector("dbx-ds-dropdown")
      || label.parentElement?.nextElementSibling?.querySelector?.("dbx-ds-dropdown");
    if (!dropdown) return { ok: false, reason: "Reason dropdown not found near label" };

    dropdown.scrollIntoView({ block: "center" });
    const r = dropdown.getBoundingClientRect();
    return { ok: true, box: { x: r.x, y: r.y, width: r.width, height: r.height } };
  });

  if (!result.ok) throw new Error(result.reason);
  await sleep(500);
  return result.box;
}

async function selectReason(page) {
  const box = await getReasonDropdownBox(page);
  console.log(`   🔍 Reason dropdown: ${JSON.stringify(box)}`);

  // Step 1: open reason dropdown by clicking its center.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(400);

  // Step 2: deterministic diagnostics for visible "Forgot To Punch" candidates.
  const candidates = await page.evaluate(() => {
    const text = "Forgot To Punch";
    const nodes = [...document.querySelectorAll("body *")].filter((el) => {
      const t = (el.textContent || "").trim();
      if (t !== text) return false;
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }).map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, tag: el.tagName, className: el.className || "" };
    });
    return nodes;
  });
  console.log(`   🧭 Reason option visible candidates: ${candidates.length}`);
  candidates.slice(0, 3).forEach((c, i) => console.log(`      [${i}] ${c.tag} (${Math.round(c.x)},${Math.round(c.y)}) ${Math.round(c.width)}x${Math.round(c.height)}`));

  // Step 3: click deterministic target if visible candidate exists.
  if (candidates.length > 0) {
    const target = candidates[0];
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
    await sleep(400);
  } else {
    await page.screenshot({ path: "reason_option_not_visible.png" });
    throw new Error("Reason option 'Forgot To Punch' not visible after opening dropdown");
  }

  // Step 4: verify via confirmed shadow DOM chain.
  await sleep(300);

  // Verify via confirmed shadow DOM chain
  const selected = await page.evaluate(() => {
    try {
      return document.querySelector("dbx-ds-modal")
        .querySelectorAll("dbx-ds-dropdown")[1]
        .shadowRoot.querySelector("dbx-internal-dropdown")
        .shadowRoot.querySelector("dbx-dropdown-head")
        .shadowRoot.querySelector("#dbx-overflow-span span")
        .innerText.trim();
    } catch (e) { return "error: " + e.message; }
  });

  console.log(`   🔍 Reason selected: "${selected}"`);
  if (selected === "Select Reason" || selected.startsWith("error")) {
    await page.screenshot({ path: "reason_selection_verification_failed.png" });
    throw new Error(`Reason not selected — shows "${selected}"`);
  }
}

async function clickSubmit(page) {
  // Submit is the last dbx-ds-button in the modal footer shadow root
  const box = await page.evaluate(() => {
    const btns = document.querySelector("dbx-ds-modal").shadowRoot.querySelectorAll(".footer dbx-ds-button");
    const r    = btns[btns.length - 1].getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(3000);
  console.log(`   ✅ Submitted`);
}

// ─── Per-date orchestration (with retry) ─────────────────────────────────────

async function attemptDate(page, date) {
  const btn = await openContextMenu(page, date);
  await selectTimeCorrectionItem(page, btn);
  await selectReason(page);
  await clickSubmit(page);
}

async function processDate(page, date, reloadView) {
  console.log(`\n📝 Processing: ${date}`);

  let succeeded = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`   🔄 Retry attempt ${attempt}...`);
        await reloadView();
      }
      await attemptDate(page, date);
      succeeded = true;
      break;
    } catch (err) {
      console.warn(`   ⚠️ Attempt ${attempt} failed: ${err.message}`);
      await page.screenshot({ path: `error_${date}_attempt${attempt}.png` });
      try { await page.keyboard.press("Escape"); } catch (_) {}
      await sleep(500);
    }
  }

  // Reload and verify regardless of outcome
  await reloadView();

  if (succeeded) {
    const verified = await verifySubmission(page, date);
    if (!verified) {
      await page.screenshot({ path: `unverified_${date}.png` });
    }
  } else {
    console.warn(`   ❌ All attempts failed for ${date}`);
  }

  return succeeded;
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
}

module.exports = { regularizeAttendance };
