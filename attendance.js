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

  // Find the ⋮ td using Playwright locator for a real pointer event
  // ⋮ td confirmed class: "row-level-context-menu" (from logs)
  // We use page.locator scoped to the row identified by its date span
  const rowLocator = page.locator('table tr').filter({
    has: page.locator(`td.primary-cell span[dir="auto"]:text-is("${date}")`)
  });

  const rowCount = await rowLocator.count();
  console.log(`   🔍 Row locator matched ${rowCount} row(s) for ${date}`);
  if (rowCount === 0) throw new Error(`Row not found for date ${date}`);

  // Click the ⋮ td with a real Playwright pointer event (not dispatchEvent)
  const menuTd = rowLocator.locator('td.row-level-context-menu');
  const menuCount = await menuTd.count();
  console.log(`   🔍 ⋮ td matched ${menuCount} element(s)`);
  if (menuCount === 0) throw new Error("row-level-context-menu td not found in row");

  // Scroll the target row into view so the correct ⋮ is clicked, not the first visible one
  await menuTd.scrollIntoViewIfNeeded();
  await sleep(500);
  await menuTd.click({ timeout: 5000 });
  console.log(`   ✅ ⋮ clicked`);
  await sleep(1000);

  // The dropdown has exactly 2 items: "Time Correction" and "Attendance Register"
  // Key insight: the dropdown container will contain BOTH items as siblings
  // Find the element whose parent also contains "Attendance Register"
  await sleep(500);

  const clicked = await page.evaluate(() => {
    const all = [...document.querySelectorAll("*")];
    for (const el of all) {
      if (!el.offsetParent) continue;
      const text = (el.innerText || "").trim();
      if (text !== "Time Correction") continue;
      // Check if a sibling or nearby element contains "Attendance Register"
      // which confirms this is the dropdown, not a badge
      const parent = el.parentElement;
      if (!parent) continue;
      const parentText = (parent.innerText || "").trim();
      if (parentText.includes("Attendance Register")) {
        el.click();
        return { found: true, parentTag: parent.tagName, parentClass: parent.className.slice(0, 80) };
      }
      // Also check grandparent
      const grandparent = parent.parentElement;
      if (grandparent) {
        const gpText = (grandparent.innerText || "").trim();
        if (gpText.includes("Attendance Register")) {
          el.click();
          return { found: true, parentTag: grandparent.tagName, parentClass: grandparent.className.slice(0, 80) };
        }
      }
    }
    return { found: false };
  });

  console.log(`   🔍 Dropdown click result: ${JSON.stringify(clicked)}`);
  if (!clicked.found) throw new Error("Could not find Time Correction in dropdown (sibling check failed)");
  await sleep(2000);
  console.log(`   ✅ Time Correction panel opened`);
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
