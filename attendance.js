const { DARWINBOX_URL, EMPLOYEE_ID, PUNCH_IN_BASE_HOUR, PUNCH_OUT_BASE_HOUR, PUNCH_RANDOM_MAX, REASON } = require("./config");
const { sleep, randomTime } = require("./utils");

// ─── Navigate to attendance page and switch to list view ─────────────────────

async function openAttendanceListView(page) {
  const ATTENDANCE_URL = `${DARWINBOX_URL}/ms/time/${EMPLOYEE_ID}/attendance`;
  console.log(`📅 Navigating to: ${ATTENDANCE_URL}`);
  await page.goto(ATTENDANCE_URL, { waitUntil: "networkidle" });
  await sleep(3000);

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

async function findAbsentDates(page) {
  console.log("🔍 Scanning attendance rows...");

  const todayStr = await page.evaluate(() => {
    const d  = new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}-${mm}-${d.getFullYear()}`;
  });
  console.log(`📅 Today: ${todayStr} — skipping today and future dates`);

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

      const dateSpan = row.querySelector('td.primary-cell span[dir="auto"]');
      if (!dateSpan) continue;
      const dateStr = (dateSpan.innerText || "").trim();
      if (!/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) continue;

      if (seen.has(dateStr))         { skipped.push({ date: dateStr, reason: "duplicate" }); continue; }
      if (toNum(dateStr) >= todayNum){ skipped.push({ date: dateStr, reason: "today or future — skip" }); continue; }
      seen.add(dateStr);

      const attendanceTd   = row.querySelector('td.primary-cell.sorting_1');
      const attendanceSpan = attendanceTd ? attendanceTd.querySelector('span#dbx-overflow-span') : null;
      const attendanceStatus = attendanceSpan ? (attendanceSpan.innerText || "").trim() : "";

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
  // Close any leftover modal from previous iteration
  try {
    await page.keyboard.press("Escape");
    await sleep(500);
    const cancelBtn = page.locator('dbx-ds-modal button:has-text("Cancel")');
    if (await cancelBtn.count() > 0) {
      await cancelBtn.first().click({ timeout: 2000 });
      await sleep(500);
    }
  } catch (_) {}

  // Find the DBX-DS-BUTTON.row_context_menu index for the target row
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

  // Click the ⋮ button — confirmed working from previous runs
  const contextBtn = page.locator("DBX-DS-BUTTON.row_context_menu").nth(btnIndex);
  await contextBtn.scrollIntoViewIfNeeded();
  await sleep(500);
  await contextBtn.click({ timeout: 5000 });
  console.log(`   ✅ ⋮ clicked (btn index ${btnIndex})`);
  await sleep(800);

  // Click "Time Correction" by coordinate — confirmed working from screenshot
  // "Time Correction" is the first item, ~20px below the bottom of the button
  const btnBox = await contextBtn.boundingBox();
  const tcX = btnBox.x + btnBox.width / 2;
  const tcY = btnBox.y + btnBox.height + 20;
  await page.mouse.click(tcX, tcY);
  console.log(`   ✅ Clicked Time Correction at (${Math.round(tcX)}, ${Math.round(tcY)})`);
  // Modal opens — wait for it to render (inputs are in Shadow DOM, not directly queryable)
  await sleep(2000);
  console.log(`   ✅ Time Correction panel open`);
}

// ─── Fill and submit the Time Correction form ─────────────────────────────────

async function fillAndSubmitForm(page, date, punchInTime, punchOutTime) {
  const [inHour, inMin]   = punchInTime.split(":");
  const [outHour, outMin] = punchOutTime.split(":");

  // Times are already pre-filled by Darwinbox (confirmed from screenshots)
  // We skip filling times and use the pre-filled values
  // The form shows correct 09:30 in and 18:00 out already
  console.log(`   ℹ️  Times pre-filled by form — skipping spinner fill`);
  console.log(`   ℹ️  Requested: in=${punchInTime} out=${punchOutTime} (using pre-filled values)`);

  // Select reason using coordinates
  // First scroll the reason dropdown into view so options open downward
  await page.evaluate(() => {
    const dropdown = document.querySelector("dbx-ds-modal").querySelectorAll("dbx-ds-dropdown")[1];
    dropdown.scrollIntoView({ block: "center" });
  });
  await sleep(500);

  // Get fresh bounding box after scroll
  const reasonBox = await page.evaluate(() => {
    const dropdowns = document.querySelector("dbx-ds-modal").querySelectorAll("dbx-ds-dropdown");
    const r = dropdowns[1].getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  console.log(`   🔍 Reason dropdown box after scroll: ${JSON.stringify(reasonBox)}`);

  // Click center of dropdown to open it
  const reasonX = reasonBox.x + reasonBox.width / 2;
  const reasonY = reasonBox.y + reasonBox.height / 2;
  await page.mouse.click(reasonX, reasonY);
  console.log(`   🔍 Clicked reason dropdown at (${Math.round(reasonX)}, ${Math.round(reasonY)})`);
  await sleep(1000);

  // Get the dropdown position again — options list renders below it
  // Take a screenshot to see where options are
  await page.screenshot({ path: `reason_open_${date}.png` });

  // "Forgot To Punch" is first option — it renders immediately below the dropdown
  // From screenshot: option height is ~50px, first option center is ~25px below dropdown bottom
  const forgotY = reasonBox.y + reasonBox.height + 25;
  console.log(`   🔍 Clicking "Forgot To Punch" at (${Math.round(reasonX)}, ${Math.round(forgotY)})`);
  await page.mouse.click(reasonX, forgotY);
  await sleep(500);

  // Verify by reading the dropdown head value from shadow DOM
  const reasonSelected = await page.evaluate(() => {
    try {
      const dropdown = document.querySelector("dbx-ds-modal").querySelectorAll("dbx-ds-dropdown")[1];
      const span = dropdown.shadowRoot
        .querySelector("dbx-internal-dropdown").shadowRoot
        .querySelector("dbx-dropdown-head").shadowRoot
        .querySelector("#dbx-overflow-span span");
      return span ? span.innerText.trim() : "unknown";
    } catch(e) { return "error: " + e.message; }
  });
  console.log(`   🔍 Reason selected value: "${reasonSelected}"`);
  if (reasonSelected === "Select Reason" || reasonSelected === "unknown") {
    throw new Error(`Reason not selected — still shows "${reasonSelected}". Check reason_open_${date}.png`);
  }
  console.log(`   ✅ Reason selected: "${reasonSelected}"`);

  await page.screenshot({ path: `before_submit_${date}.png` });

  // Submit — click the Submit button using coordinates from the modal footer
  // The Submit button is the second dbx-ds-button in the modal footer shadow root
  const submitBox = await page.evaluate(() => {
    const modalSR = document.querySelector("dbx-ds-modal").shadowRoot;
    const footerBtns = modalSR.querySelectorAll(".footer dbx-ds-button");
    // Submit is the last button in footer
    const submitBtn = footerBtns[footerBtns.length - 1];
    const r = submitBtn.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  console.log(`   🔍 Submit button box: ${JSON.stringify(submitBox)}`);
  await page.mouse.click(submitBox.x + submitBox.width / 2, submitBox.y + submitBox.height / 2);
  console.log(`   🔍 Clicked Submit`);
  await sleep(3000);
  console.log(`   ✅ Submitted for ${date}`);
  await page.screenshot({ path: `submitted_${date}.png` });

  // Close modal by pressing Escape, then reload the page
  // This ensures clean state for the next row — no lingering modal, fresh DOM
  await page.keyboard.press("Escape");
  await sleep(1000);
  await page.goto(`${DARWINBOX_URL}/ms/time/${EMPLOYEE_ID}/attendance`, { waitUntil: "networkidle" });
  await sleep(2000);
  // Re-activate list view after reload
  try {
    const listSvg = page.locator('svg[viewBox="0 0 12 10"]').first();
    if (await listSvg.count() > 0) {
      await listSvg.locator("..").click({ timeout: 3000 });
      await sleep(1500);
    }
  } catch (_) {}
  console.log(`   🔄 Page reloaded for next row`);
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
      try { await page.keyboard.press("Escape"); await sleep(500); } catch (_) {}
      try { await page.click('dbx-ds-modal button:has-text("Cancel")', { timeout: 2000 }); } catch (_) {}
      await sleep(1000);
    }
  }

  console.log(`\n✅ All done — processed ${absentDates.length} day(s)`);
  await page.screenshot({ path: "regularization_result.png" });
}

module.exports = { regularizeAttendance };
