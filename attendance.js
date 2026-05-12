const { DARWINBOX_URL, EMPLOYEE_ID, PUNCH_IN_BASE_HOUR, PUNCH_OUT_BASE_HOUR, PUNCH_RANDOM_MAX, REASON } = require("./config");
const { sleep, randomTime } = require("./utils");

// ─── Navigate to attendance page and switch to list view ─────────────────────

async function openAttendanceListView(page) {
  const ATTENDANCE_URL = `${DARWINBOX_URL}/ms/time/${EMPLOYEE_ID}/attendance`;
  console.log(`📅 Navigating to: ${ATTENDANCE_URL}`);
  await page.goto(ATTENDANCE_URL, { waitUntil: "networkidle" });
  await sleep(3000);

  // Switch to list view — identified by SVG with viewBox="0 0 12 10" (3-line icon)
  console.log("📋 Switching to list view...");
  try {
    const listSvg = page.locator('svg[viewBox="0 0 12 10"]').first();
    const count   = await listSvg.count();
    console.log(`🔍 Found ${count} list-view SVG(s)`);
    if (count > 0) {
      await listSvg.locator("..").click({ timeout: 3000 });
      console.log("✅ List view activated");
    } else {
      console.warn("⚠️ List view SVG not found — proceeding with current view");
    }
  } catch (err) {
    console.warn(`⚠️ List view toggle failed: ${err.message}`);
  }

  await sleep(2000);
  await page.screenshot({ path: "list_view.png" });
}

// ─── Scan rows for absent days with no pending request ────────────────────────
// Uses confirmed HTML structure:
//   Row:    <tr> in attendance table
//   Date:   td.primary-cell > span[dir="auto"]  → "DD-MM-YYYY"
//   Status: span (excluding hover panel) with text "Absent" / "Present" / "Weekly Off"
//   Badge:  td containing "Request Pending" or "Time Correction"

async function findAbsentDates(page) {
  console.log("🔍 Scanning attendance rows...");

  const todayStr = await page.evaluate(() => {
    const d  = new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}-${mm}-${d.getFullYear()}`;
  });
  console.log(`📅 Today: ${todayStr} — skipping future dates`);

  const scanResult = await page.evaluate((today) => {
    const results = [];
    const skipped = [];
    const seen    = new Set();

    function toNum(s) {
      const [dd, mm, yyyy] = s.split("-");
      return parseInt(yyyy + mm + dd, 10);
    }
    const todayNum = toNum(today);

    const rows      = [...document.querySelectorAll("table tr")];
    let   totalRows = 0;

    for (const row of rows) {
      const tds = [...row.querySelectorAll("td")];
      if (tds.length < 2) continue;
      totalRows++;

      // Date: confirmed from inspected HTML — td.primary-cell > span[dir="auto"]
      const dateSpan = row.querySelector('td.primary-cell span[dir="auto"]');
      if (!dateSpan) continue;
      const dateStr = (dateSpan.innerText || "").trim();
      if (!/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) continue;

      if (seen.has(dateStr))         { skipped.push({ date: dateStr, reason: "duplicate" }); continue; }
      if (toNum(dateStr) >= todayNum){ skipped.push({ date: dateStr, reason: "today or future — skip" }); continue; }
      seen.add(dateStr);

      // Attendance status: confirmed from HTML — td.primary-cell.sorting_1 contains
      // <span id="dbx-overflow-span"> with text "Absent", "Present", "Weekly Off" etc.
      const attendanceTd = row.querySelector('td.primary-cell.sorting_1');
      const attendanceSpan = attendanceTd
        ? attendanceTd.querySelector('span#dbx-overflow-span')
        : null;
      const attendanceStatus = attendanceSpan
        ? (attendanceSpan.innerText || "").trim()
        : "";

      // Request status: confirmed from HTML — when a request exists, the row contains
      // <dbx-ds-status-tag> inside a td.dt-left (without primary-cell).
      // The text is in Shadow DOM so we detect presence of the element, not its text.
      const hasRequestBadge = !!row.querySelector('dbx-ds-status-tag');

      if (attendanceStatus !== "Absent") {
        skipped.push({ date: dateStr, reason: `not absent: ${attendanceStatus || "no status found"}` });
        continue;
      }
      if (hasRequestBadge) {
        skipped.push({ date: dateStr, reason: "request badge exists (dbx-ds-status-tag present)" });
        continue;
      }

      results.push(dateStr);
    }

    return { results, skipped, totalRows };
  }, todayStr);

  console.log(`🔍 Scanned ${scanResult.totalRows} table rows`);
  if (scanResult.skipped.length > 0) {
    console.log("⏭️  Skipped:");
    scanResult.skipped.forEach(s => console.log(`   ${s.date} — ${s.reason}`));
  }

  return scanResult.results;
}

// ─── Open Time Correction panel for a given date ──────────────────────────────

async function openTimeCorrectionPanel(page, date) {
  // Close any leftover modal from a previous iteration
  try {
    const modal = await page.$("dbx-ds-modal");
    if (modal) {
      await page.click('dbx-ds-modal button:has-text("Cancel")', { timeout: 2000 }).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(1000);
      console.log("   🔄 Closed leftover panel");
    }
  } catch (_) {}

  // CONFIRMED DOM STRUCTURE (from DevTools):
  // Each row has a DBX-DS-BUTTON.row_context_menu element containing the ⋮
  // After clicking it, dbx-ds-menu-item[0] = "Time Correction", [1] = "Attendance Register"
  // These are in the LIGHT DOM of the button — directly queryable

  // Step 1: find the index of DBX-DS-BUTTON.row_context_menu that belongs to the target row
  const btnIndex = await page.evaluate((targetDate) => {
    const rows = [...document.querySelectorAll("table tr")];
    const targetRow = rows.find(r => {
      const span = r.querySelector('td.primary-cell span[dir="auto"]');
      return span && (span.innerText || "").trim() === targetDate;
    });
    if (!targetRow) return -1;
    const allBtns = [...document.querySelectorAll("DBX-DS-BUTTON.row_context_menu")];
    for (let i = 0; i < allBtns.length; i++) {
      if (targetRow.contains(allBtns[i])) return i;
    }
    return -1;
  }, date);

  console.log(`   🔍 row_context_menu btn index for ${date}: ${btnIndex}`);
  if (btnIndex === -1) throw new Error(`Could not find row_context_menu button for ${date}`);

  // Step 2: click the ⋮ button to open dropdown
  const contextBtn = page.locator("DBX-DS-BUTTON.row_context_menu").nth(btnIndex);
  await contextBtn.scrollIntoViewIfNeeded();
  await sleep(300);
  await contextBtn.click({ timeout: 5000 });
  console.log(`   ✅ ⋮ clicked (btn index ${btnIndex})`);

  // Step 3: poll until dbx-ds-menu-item appears inside the button (injected after dropdown opens)
  // From DevTools: btn.querySelectorAll("dbx-ds-menu-item")[0].textContent === "Time Correction"
  let clicked = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(500);
    const result = await page.evaluate((idx) => {
      const btn = [...document.querySelectorAll("DBX-DS-BUTTON.row_context_menu")][idx];
      if (!btn) return { ok: false, reason: "btn not found" };
      const items = btn.querySelectorAll("dbx-ds-menu-item");
      if (items.length === 0) return { ok: false, reason: `empty after poll (innerHTML len: ${btn.innerHTML.length})` };
      const text = items[0].textContent.trim();
      items[0].click();
      return { ok: true, text };
    }, btnIndex);
    console.log(`   🔍 Poll ${attempt + 1}: ${JSON.stringify(result)}`);
    if (result.ok) { clicked = true; break; }
  }
  if (!clicked) throw new Error("Time Correction menu item never appeared after 10 polls");
  await sleep(2000);
  console.log(`   ✅ Time Correction clicked`);
}

// ─── Fill and submit the Time Correction form ─────────────────────────────────

async function fillAndSubmitForm(page, date, punchInTime, punchOutTime) {
  const [inHour, inMin]   = punchInTime.split(":");
  const [outHour, outMin] = punchOutTime.split(":");

  // Wait for modal
  // Wait for a VISIBLE modal — there may be multiple dbx-ds-modal in DOM
  await page.locator("dbx-ds-modal").filter({ hasText: "Time Correction" }).waitFor({ state: "visible", timeout: 5000 });
  const modal = page.locator("dbx-ds-modal").filter({ hasText: "Time Correction" }).first();

  // Fill time spinners scoped to modal
  // Order: ClockIn-Hour[0], ClockIn-Min[1], ClockOut-Hour[2], ClockOut-Min[3], Break[4,5]
  const spinners     = modal.locator('input[type="number"]');
  const spinnerCount = await spinners.count();
  console.log(`   🔢 Found ${spinnerCount} spinner inputs`);

  if (spinnerCount >= 4) {
    await spinners.nth(0).click({ clickCount: 3 }); await spinners.nth(0).fill(inHour);  await sleep(300);
    await spinners.nth(1).click({ clickCount: 3 }); await spinners.nth(1).fill(inMin);   await sleep(300);
    await spinners.nth(2).click({ clickCount: 3 }); await spinners.nth(2).fill(outHour); await sleep(300);
    await spinners.nth(3).click({ clickCount: 3 }); await spinners.nth(3).fill(outMin);  await sleep(300);
    console.log(`   ✅ Times filled: in=${punchInTime} out=${punchOutTime}`);
  } else {
    throw new Error(`Expected ≥4 spinners, found ${spinnerCount}`);
  }

  // Select reason from dropdown
  await modal.locator('text="Select Reason"').click({ timeout: 3000 });
  await sleep(500);
  await page.click(`text="${REASON}"`, { timeout: 3000 });
  console.log(`   ✅ Reason: "${REASON}"`);
  await sleep(500);

  await page.screenshot({ path: `before_submit_${date}.png` });

  // Submit
  await modal.locator('button:has-text("Submit")').click({ timeout: 5000 });
  await sleep(3000);
  console.log(`   ✅ Submitted for ${date}`);
  await page.screenshot({ path: `submitted_${date}.png` });

  // Wait for modal to close
  await page.locator("dbx-ds-modal").filter({ hasText: "Time Correction" }).first().waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  await sleep(1000);
}

// ─── Main attendance regularization flow ─────────────────────────────────────

async function regularizeAttendance(page) {
  await openAttendanceListView(page);

  const absentDates = await findAbsentDates(page);

  if (absentDates.length === 0) {
    console.log("✅ No absent days needing regularization — nothing to do!");
    await page.screenshot({ path: "regularization_result.png" });
    return;
  }

  console.log("─".repeat(50));
  console.log(`📋 Found ${absentDates.length} absent day(s) to regularize:`);
  absentDates.forEach((d, i) => console.log(`   ${i + 1}. ${d}`));
  console.log("─".repeat(50));

  for (const date of absentDates) {
    const punchInTime  = randomTime(PUNCH_IN_BASE_HOUR,  PUNCH_RANDOM_MAX);
    const punchOutTime = randomTime(PUNCH_OUT_BASE_HOUR, PUNCH_RANDOM_MAX);
    console.log(`\n📝 Processing: ${date} | in: ${punchInTime} | out: ${punchOutTime}`);

    try {
      await openTimeCorrectionPanel(page, date);
      await fillAndSubmitForm(page, date, punchInTime, punchOutTime);
    } catch (err) {
      console.warn(`   ⚠️ Failed for ${date}: ${err.message}`);
      await page.screenshot({ path: `error_${date}.png` });
      // Force-close modal before next row
      try { await page.keyboard.press("Escape"); await sleep(500); } catch (_) {}
      try { await page.click('dbx-ds-modal button:has-text("Cancel")', { timeout: 2000 }); } catch (_) {}
      await sleep(1000);
    }
  }

  console.log(`\n✅ All done — processed ${absentDates.length} day(s)`);
  await page.screenshot({ path: "regularization_result.png" });
}

module.exports = { regularizeAttendance };
