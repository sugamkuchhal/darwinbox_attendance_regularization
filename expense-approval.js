// Approves pending expense claims on expenses.onearvind.com.
//
// Unlike consultant payments (one detail page per item), this is a bulk form:
// every row carries a radio group submitdoc{n} = Y approve / N reject /
// P pending (default), and one Submit posts the whole visible page.
//
// To keep that safe we work one row at a time: set exactly one row to Y, force
// every other row back to P, submit, then re-read the list and only count it
// approved once that row has actually left the pending set.
const { newHardenedContext, enterCredentials, resolveAuth } = require("./browser");

const EXPENSE_BASE = "https://expenses.onearvind.com";
const EXPENSE_URL  = `${EXPENSE_BASE}/BusinessHead/Index/`;
const LIST_API     = "/BusinessHead/GetHODAppDetails";
const NAV_TIMEOUT  = 60000;

// Claims at or above this are never auto-approved — they are left pending and
// reported for manual review.
const AUTO_APPROVE_BELOW = 10000;

// The API reports Status as a numeric code ("1" = Pending); the grid renders
// the word. Accept either encoding, and nothing else — an unfamiliar status is
// still skipped rather than approved.
const ACTIONABLE_STATUSES = ["1", "pending"];

function parseAmount(v) {
  const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function fmtRow(r) {
  const amt = parseAmount(r.TotalValue);
  return `${r.EmpName} (${r.EmpNo}) | Req ${r.ExpenseID} | ${r.RequestDate} | ₹${
    amt === null ? String(r.TotalValue) : amt.toLocaleString("en-IN")
  }`;
}

async function fetchPending(page) {
  return page.evaluate(async (api) => {
    const resp = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    const data = await resp.json();
    return Array.isArray(data) ? data : data?.data ?? [];
  }, LIST_API);
}

// Show every row, so nothing eligible is hidden behind pagination.
async function showAllRows(page) {
  await page
    .evaluate(() => {
      const sel = document.querySelector('#gridhod_length select');
      if (!sel) return false;
      const all = [...sel.options].find((o) => /all/i.test(o.text) || o.value === "-1");
      if (!all) return false;
      sel.value = all.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })
    .catch(() => false);
  await page.waitForTimeout(1500);
}

// Set exactly one row to Approve and force every other row to Pending.
// Returns the number of rows found, so a miss is visible rather than silent.
async function armSingleRow(page, expenseId) {
  return page.evaluate((id) => {
    const rows = [...document.querySelectorAll("#gridhod tbody tr")];
    let target = -1;
    rows.forEach((row, i) => {
      const cells = [...row.querySelectorAll("td")].map((c) => (c.innerText || "").trim());
      if (cells.some((c) => c === String(id))) target = i;
    });
    if (target === -1) return { armed: false, rows: rows.length };

    rows.forEach((row, i) => {
      const radios = [...row.querySelectorAll('input[type=radio]')];
      const want = i === target ? "Y" : "P";
      const pick = radios.find((r) => r.value === want);
      if (pick) {
        pick.checked = true;
        pick.dispatchEvent(new Event("change", { bubbles: true }));
        pick.dispatchEvent(new Event("click", { bubbles: true }));
      }
    });

    const armedRow = rows[target];
    const chosen = [...armedRow.querySelectorAll('input[type=radio]')].find((r) => r.checked);
    return { armed: chosen?.value === "Y", rows: rows.length };
  }, expenseId);
}

async function submitAndConfirm(page) {
  await page.evaluate(() => {
    const b = document.querySelector("#btnAppHod");
    if (b) b.click();
  });
  await page.waitForTimeout(1200);
  // SweetAlert confirmation. Try the known containers, then fall back to a
  // button whose visible label is exactly OK.
  await page
    .evaluate(() => {
      const sels = [
        ".sweet-alert button.confirm",
        ".sweet-alert .sa-button-container button.confirm",
        "button.confirm",
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.offsetParent !== null) { el.click(); return s; }
      }
      const ok = [...document.querySelectorAll("button")].find(
        (b) => /^ok$/i.test((b.innerText || "").trim()) && b.offsetParent !== null
      );
      if (ok) { ok.click(); return "text:OK"; }
      return null;
    })
    .catch(() => null);
  await page.waitForTimeout(3000);
}

async function approveAllExpenses(page) {
  const result = {
    reached: false,
    approved: 0,
    failed: 0,
    records: [],
    failedRecords: [],
    heldRecords: [],
    skippedRecords: [],
  };

  const browser = page.context().browser();
  const context = await newHardenedContext(browser);
  page = await context.newPage();

  try {
    // The expenses host does not inherit a session from elsewhere, and the
    // consultant step closes its own context, so sign in here from scratch.
    console.log("   ↳ signing in via onearvind portal...");
    await page.goto("https://onearvind.com", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    if (/login\.microsoft(online)?\.com/i.test(page.url())) {
      await enterCredentials(page);
      await resolveAuth(page, { targetHost: "onearvind.com" });
    }
    console.log(`   ↳ portal: ${new URL(page.url()).hostname}`);

    // Reach expenses through the portal's own link, which points at the ROOT.
    // Going straight to /BusinessHead/Index/ returns Access Denied — the root
    // is what establishes the session.
    const link = await page.$('a[href^="https://expenses.onearvind.com"]').catch(() => null);
    if (link) {
      const [popup] = await Promise.all([
        context.waitForEvent("page", { timeout: 30000 }).catch(() => null),
        page.evaluate(() => {
          const a = document.querySelector('a[href^="https://expenses.onearvind.com"]');
          if (a) a.click();
        }).catch(() => {}),
      ]);
      if (popup) {
        await popup.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT }).catch(() => {});
        page = popup;
        console.log("   ↳ expenses opened via portal link");
      }
    }
    if (!/expenses\.onearvind\.com/i.test(page.url())) {
      console.log("   ↳ portal link unavailable — opening expenses root directly");
      await page.goto(EXPENSE_BASE + "/", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    }
    await page.waitForTimeout(2000);

    // Now the Approval dashboard.
    console.log("   ↳ opening approval dashboard...");
    await page.goto(EXPENSE_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    console.log(`   ↳ landed on: ${new URL(page.url()).pathname}`);

    if (/AccessDenied/i.test(page.url())) {
      throw new Error("expenses returned Access Denied — session not established");
    }
    await page.waitForSelector("#gridhod", { timeout: 30000 });
    result.reached = true;
    console.log("   ✅ Expenses dashboard loaded");

    await showAllRows(page);

    const pending = await fetchPending(page);
    console.log(`   📌 Expense rows returned: ${pending.length}`);

    // Decide up front what we will and will not touch.
    const eligible = [];
    for (const r of pending) {
      const status = String(r.Status ?? "").trim().toLowerCase();
      if (!ACTIONABLE_STATUSES.includes(status)) {
        result.skippedRecords.push(`${fmtRow(r)} | status "${r.Status}"`);
        continue;
      }
      const amt = parseAmount(r.TotalValue);
      // Unreadable amount is treated as above the cap — never auto-approved.
      if (amt === null || amt >= AUTO_APPROVE_BELOW) {
        result.heldRecords.push(fmtRow(r));
        continue;
      }
      eligible.push(r);
    }

    console.log(
      `   📊 ${eligible.length} to approve, ${result.heldRecords.length} held (≥ ₹${AUTO_APPROVE_BELOW.toLocaleString("en-IN")}), ${result.skippedRecords.length} skipped`
    );

    for (const r of eligible) {
      const label = fmtRow(r);
      console.log(`   🖊️  ${label}`);

      const armed = await armSingleRow(page, r.ExpenseID);
      if (!armed.armed) {
        console.warn(`   ⚠️ Could not find/arm row for Req ${r.ExpenseID} (${armed.rows} rows on page)`);
        result.failed++;
        result.failedRecords.push(`${label} — row not found on page`);
        continue;
      }

      await submitAndConfirm(page);

      // Only a row that has actually left the pending list counts as approved.
      await page.goto(EXPENSE_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await page.waitForSelector("#gridhod", { timeout: 30000 }).catch(() => {});
      await showAllRows(page);
      const after = await fetchPending(page);
      const still = after.some(
        (x) =>
          String(x.ExpenseID) === String(r.ExpenseID) &&
          ACTIONABLE_STATUSES.includes(String(x.Status ?? "").trim().toLowerCase())
      );

      if (still) {
        console.warn(`   ⚠️ Req ${r.ExpenseID} still pending after submit`);
        result.failed++;
        result.failedRecords.push(`${label} — still Pending after submit`);
      } else {
        console.log(`   ✅ ${label}`);
        result.approved++;
        result.records.push(label);
      }
    }
  } catch (err) {
    console.error(`   ❌ Expenses step failed: ${err.message}`);
    result.error = err.message;
  }

  await context.close().catch(() => {});
  console.log(
    `   ✅ Expenses: ${result.approved} approved, ${result.failed} failed, ${result.heldRecords.length} held`
  );
  return result;
}

module.exports = { approveAllExpenses, AUTO_APPROVE_BELOW };
