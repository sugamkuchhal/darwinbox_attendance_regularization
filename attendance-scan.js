// Scans table rows and verifies post-submit status badges.

// Compute today's date string in IST (Asia/Kolkata) within Node.js —
// avoids relying on the browser's locale/timezone which may differ on servers.
function getTodayStrIST() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const dd   = String(ist.getDate()).padStart(2, "0");
  const mm   = String(ist.getMonth() + 1).padStart(2, "0");
  const yyyy = ist.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

async function findAbsentDates(page) {
  const todayStr = getTodayStrIST();
  console.log(`📅 Today (IST): ${todayStr}`);

  const { results, skippedExisting, seenRows, totalRows } = await page.evaluate((today) => {
    const results         = [];
    const skippedExisting = []; // request already raised — actionable info
    const seenRows        = []; // every dated row we saw, with why we did/didn't act
    const seen            = new Set();

    function toNum(s) {
      const [dd, mm, yyyy] = s.split("-");
      return parseInt(yyyy + mm + dd, 10);
    }
    const todayNum = toNum(today);
    let totalRows  = 0;

    for (const row of document.querySelectorAll("table tr")) {
      if ([...row.querySelectorAll("td")].length < 2) continue;
      totalRows++;

      const dateSpan = row.querySelector('td.primary-cell span[dir="auto"]');
      if (!dateSpan) continue;
      const dateStr = (dateSpan.innerText || "").trim();
      if (!/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) continue;
      if (seen.has(dateStr)) continue;
      seen.add(dateStr);

      const attendanceSpan   = row.querySelector('td.primary-cell.sorting_1 span#dbx-overflow-span');
      const attendanceStatus = (attendanceSpan?.innerText || "").trim();
      const hasRequestBadge  = !!row.querySelector('dbx-ds-status-tag');

      let decision;
      if (toNum(dateStr) >= todayNum)          decision = "skip: today or future";
      else if (attendanceStatus !== "Absent")  decision = `skip: status is "${attendanceStatus || "(blank)"}"`;
      else if (hasRequestBadge)                decision = "skip: request already raised";
      else                                     decision = "REGULARIZE";

      seenRows.push({ date: dateStr, status: attendanceStatus || "(blank)", badge: hasRequestBadge, decision });

      if (decision === "REGULARIZE")                     results.push(dateStr);
      else if (decision === "skip: request already raised") skippedExisting.push(dateStr);
    }

    return { results, skippedExisting, seenRows, totalRows };
  }, todayStr);

  console.log(`🔍 Scanned ${totalRows} rows — ${seenRows.length} dated rows found`);
  console.log(`📋 Every date seen (status → decision):`);
  for (const r of seenRows) {
    const mark = r.decision === "REGULARIZE" ? "✅" : "  ";
    console.log(`   ${mark} ${r.date} | status="${r.status}" | badge=${r.badge ? "yes" : "no"} → ${r.decision}`);
  }
  console.log(`🔍 ${results.length} to regularize, ${skippedExisting.length} already pending`);

  findAbsentDates.lastScan = seenRows;
  return results;
}

async function verifySubmission(page, date) {
  const verified = await page.evaluate((targetDate) => {
    const row = [...document.querySelectorAll("table tr")].find(r => {
      const span = r.querySelector('td.primary-cell span[dir="auto"]');
      return span && (span.innerText || "").trim() === targetDate;
    });
    if (!row) return { ok: false, reason: "row not found after reload" };
    const hasBadge = !!row.querySelector('dbx-ds-status-tag');
    return { ok: hasBadge, reason: hasBadge ? "badge present" : "no badge — request may not have gone through" };
  }, date);

  if (verified.ok) {
    console.log(`   ✅ Verified: ${date} — badge confirmed`);
  } else {
    console.warn(`   ⚠️ Verification failed: ${date} — ${verified.reason}`);
  }
  return verified.ok;
}

async function findContextMenuIndex(page, date, monthContext = "") {
  const idx = await page.evaluate((targetDate) => {
    const targetRow = [...document.querySelectorAll("table tr")].find(r => {
      const span = r.querySelector('td.primary-cell span[dir="auto"]');
      return span && (span.innerText || "").trim() === targetDate;
    });
    if (!targetRow) return -1;
    return [...document.querySelectorAll("DBX-DS-BUTTON.row_context_menu")]
      .findIndex(btn => targetRow.contains(btn));
  }, date);

  if (idx === -1) throw new Error(`Row not found for date ${date}${monthContext ? ` (${monthContext})` : ""}`);
  return idx;
}

module.exports = { getTodayStrIST, findAbsentDates, verifySubmission, findContextMenuIndex };
