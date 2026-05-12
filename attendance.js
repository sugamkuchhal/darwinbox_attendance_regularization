const { DARWINBOX_URL, EMPLOYEE_ID, PUNCH_IN_BASE_HOUR, PUNCH_OUT_BASE_HOUR, PUNCH_RANDOM_MAX } = require("./config");
const { sleep, randomTime } = require("./utils");

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
      const tds = [...row.querySelectorAll("td")];
      if (tds.length < 2) continue;
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
  await sleep(2000); // wait for modal to render
}

// ─── Form filling ─────────────────────────────────────────────────────────────

async function getReasonDropdownBox(page) {
  // Reason is the second dbx-ds-dropdown (index 1) in the modal
  // Scroll into view first so the options list opens downward
  await page.evaluate(() => {
    document.querySelector("dbx-ds-modal")
      .querySelectorAll("dbx-ds-dropdown")[1]
      .scrollIntoView({ block: "center" });
  });
  await sleep(500);

  return page.evaluate(() => {
    const r = document.querySelector("dbx-ds-modal")
      .querySelectorAll("dbx-ds-dropdown")[1]
      .getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

async function selectReason(page, date) {
  const box = await getReasonDropdownBox(page);
  console.log(`   🔍 Reason dropdown: ${JSON.stringify(box)}`);

  // Open the dropdown
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(800);
  await page.screenshot({ path: `reason_open_${date}.png` });

  // "Forgot To Punch" is first option — confirmed from screenshots, ~25px below dropdown bottom
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 25);
  await sleep(500);

  // Verify via shadow DOM chain — confirmed working
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
    throw new Error(`Reason not selected — shows "${selected}". Check reason_open_${date}.png`);
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

// ─── Per-date orchestration ───────────────────────────────────────────────────

async function processDate(page, date) {
  const punchInTime  = randomTime(PUNCH_IN_BASE_HOUR,  PUNCH_RANDOM_MAX);
  const punchOutTime = randomTime(PUNCH_OUT_BASE_HOUR, PUNCH_RANDOM_MAX);
  console.log(`\n📝 Processing: ${date} | in=${punchInTime} out=${punchOutTime}`);

  try {
    const btn = await openContextMenu(page, date);
    await selectTimeCorrectionItem(page, btn);
    await selectReason(page, date);
    await page.screenshot({ path: `before_submit_${date}.png` });
    await clickSubmit(page);
    await page.screenshot({ path: `submitted_${date}.png` });
    console.log(`   ✅ Done: ${date}`);
  } catch (err) {
    console.warn(`   ⚠️ Failed: ${date} — ${err.message}`);
    await page.screenshot({ path: `error_${date}.png` });
    try { await page.keyboard.press("Escape"); } catch (_) {}
  }

  // Always reload after each date — clean DOM, no lingering modal
  await reloadAttendancePage(page);
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function regularizeAttendance(page) {
  await reloadAttendancePage(page);
  await page.screenshot({ path: "list_view.png" });

  const absentDates = await findAbsentDates(page);

  if (absentDates.length === 0) {
    console.log("✅ No absent days to regularize");
    await page.screenshot({ path: "regularization_result.png" });
    return;
  }

  console.log("─".repeat(50));
  console.log(`📋 ${absentDates.length} absent day(s) to regularize:`);
  absentDates.forEach((d, i) => console.log(`   ${i + 1}. ${d}`));
  console.log("─".repeat(50));

  for (const date of absentDates) {
    await processDate(page, date);
  }

  console.log(`\n✅ All done — processed ${absentDates.length} day(s)`);
  await page.screenshot({ path: "regularization_result.png" });
}

module.exports = { regularizeAttendance };
