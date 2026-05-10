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

      if (seen.has(dateStr))        { skipped.push({ date: dateStr, reason: "duplicate" }); continue; }
      if (toNum(dateStr) > todayNum){ skipped.push({ date: dateStr, reason: "future date" }); continue; }
      seen.add(dateStr);

      // Attendance status: read span text directly, excluding hover panel content
      // Hover panel has slot="hover" — exclude all descendants of that slot
      const statusSpans = [...row.querySelectorAll("span")].filter(
        s => !s.closest('[slot="hover"]')
      );
      let attendanceStatus = "";
      for (const span of statusSpans) {
        const t = (span.innerText || "").trim();
        if (["Absent", "Present", "Weekly Off", "Holiday"].includes(t)) {
          attendanceStatus = t;
          break;
        }
      }

      // Request status badge
      let requestStatus = "";
      for (const td of tds) {
        const t = (td.innerText || "").trim();
        if (t.includes("Request Pending") || t.includes("Time Correction")) {
          requestStatus = t.slice(0, 60);
          break;
        }
      }

      if (attendanceStatus !== "Absent") {
        skipped.push({ date: dateStr, reason: `not absent: ${attendanceStatus || "no status found"}` });
        continue;
      }
      if (requestStatus) {
        skipped.push({ date: dateStr, reason: `request exists: ${requestStatus}` });
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

  // Find the <tr> by exact date match in td.primary-cell > span[dir="auto"]
  // Then click the ⋮ td — identified by SVG paths with fill="var(--icon-color)"
  const clickResult = await page.evaluate((targetDate) => {
    const rows = [...document.querySelectorAll("table tr")];
    const row  = rows.find(r => {
      const span = r.querySelector('td.primary-cell span[dir="auto"]');
      return span && (span.innerText || "").trim() === targetDate;
    });
    if (!row) return { clicked: false, reason: "row not found — date span not matched" };

    const tds = [...row.querySelectorAll("td")];
    for (const td of tds) {
      const hasIconColor = [...td.querySelectorAll("path")]
        .some(p => (p.getAttribute("fill") || "").includes("icon-color"));
      if (hasIconColor) {
        td.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return { clicked: true, reason: "icon-color td clicked" };
      }
    }

    const tdClasses = tds.map(td => td.className.slice(0, 40));
    return { clicked: false, reason: "no icon-color td found", tdClasses };
  }, date);

  console.log(`   🔍 ⋮ click: ${JSON.stringify(clickResult)}`);
  if (!clickResult.clicked) {
    throw new Error(`Could not click ⋮ for ${date}: ${clickResult.reason}`);
  }

  await sleep(1000);

  // Click "Time Correction" from the dropdown — use the last match to avoid badge elements
  const tcItems = await page.$$('text="Time Correction"');
  if (tcItems.length === 0) throw new Error("Time Correction option not found in dropdown");
  await tcItems[tcItems.length - 1].click();
  await sleep(2000);
  console.log(`   ✅ Time Correction panel opened`);
}

// ─── Fill and submit the Time Correction form ─────────────────────────────────

async function fillAndSubmitForm(page, date, punchInTime, punchOutTime) {
  const [inHour, inMin]   = punchInTime.split(":");
  const [outHour, outMin] = punchOutTime.split(":");

  // Wait for modal
  await page.waitForSelector("dbx-ds-modal", { timeout: 5000 });
  const modal = page.locator("dbx-ds-modal");

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
  await page.waitForSelector("dbx-ds-modal", { state: "hidden", timeout: 5000 }).catch(() => {});
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
