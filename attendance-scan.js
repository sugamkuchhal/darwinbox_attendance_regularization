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

  const { results, skippedExisting, totalRows } = await page.evaluate((today) => {
    const results         = [];
    const skippedExisting = []; // only "request already exists" — actionable info
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
      if (seen.has(dateStr) || toNum(dateStr) >= todayNum) continue;
      seen.add(dateStr);

      const attendanceSpan   = row.querySelector('td.primary-cell.sorting_1 span#dbx-overflow-span');
      const attendanceStatus = (attendanceSpan?.innerText || "").trim();
      const hasRequestBadge  = !!row.querySelector('dbx-ds-status-tag');

      if (attendanceStatus !== "Absent") continue;

      if (hasRequestBadge) {
        skippedExisting.push(dateStr);
        continue;
      }

      results.push(dateStr);
    }

    return { results, skippedExisting, totalRows };
  }, todayStr);

  console.log(`🔍 Scanned ${totalRows} rows — ${results.length} to regularize, ${skippedExisting.length} already pending`);
  if (skippedExisting.length) {
    console.log(`   ⏭️  Already pending: ${skippedExisting.join(", ")}`);
  }
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
