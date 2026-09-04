// Approves all pending tasks (Leave Requests + Time Corrections) in the Darwinbox Task Box.
// Assumes the browser is already logged in (login() has been called).

const { DARWINBOX_URL } = require("./config");
const { sleep } = require("./utils");
const { takeStepScreenshot } = require("./reporting");

const LEAVE_REQUESTS_TABLE      = "table#core_taskbox_tasks";
const TABLE_LOAD_TIMEOUT_MS     = 15000;
const TAB_SWITCH_TIMEOUT_MS     = 10000;
const APPROVE_RENDER_TIMEOUT_MS = 10000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitForTable(page) {
  await page.waitForSelector(LEAVE_REQUESTS_TABLE, { timeout: TABLE_LOAD_TIMEOUT_MS });
}

async function getCurrentCategory(page) {
  return page.evaluate(() => document.querySelector("#task_category_id")?.value);
}

async function countButtons(page, selector) {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
}

// Extract employee name and request type from the first row containing an approve button.
async function extractFirstRowInfo(page, approveSelector) {
  return page.evaluate((sel) => {
    const btn = document.querySelector(sel);
    if (!btn) return null;
    const row = btn.closest("tr");
    if (!row) return null;
    const cells = [...row.querySelectorAll("td")].map((td) => {
      const clone = td.cloneNode(true);
      clone.querySelectorAll("DBX-DS-BUTTON, button, a").forEach((el) => el.remove());
      return clone.textContent.trim().replace(/\s+/g, " ");
    }).filter((t) => t.length > 0);
    return cells;
  }, approveSelector);
}

// ─── Tab navigation ───────────────────────────────────────────────────────────

// Click a named tab. The clickable element is div.tab-container inside each
// DBX-DS-TAB's shadow root — the outer custom element does not respond to .click().
async function tryClickTab(page, tabName) {
  return page.evaluate((name) => {
    const tabGroup = document.querySelector("#dbx_vertical_tabs");
    if (!tabGroup?.shadowRoot) return false;
    for (const tab of tabGroup.shadowRoot.querySelectorAll("DBX-DS-TAB")) {
      const container = tab.shadowRoot?.querySelector("div.tab-container");
      if (container?.textContent?.trim() === name) {
        container.click();
        return true;
      }
    }
    return false;
  }, tabName);
}

// Ensure we are on the given tab and its data has loaded.
// Returns false if the tab is not present in the sidebar (0 pending = tab hidden).
async function ensureTab(page, tabName, categoryValue, approveSelector) {
  const current = await getCurrentCategory(page);
  if (current !== categoryValue) {
    const clicked = await tryClickTab(page, tabName);
    if (!clicked) return false; // Tab absent — nothing pending

    // Category indicator updates immediately (before data XHR).
    await page.waitForFunction(
      (val) => document.querySelector("#task_category_id")?.value === val,
      categoryValue,
      { timeout: TAB_SWITCH_TIMEOUT_MS }
    );
  }

  // Wait for approve buttons to render (data XHR completes ~1s after category switch).
  // Graceful timeout: 0 buttons = nothing pending.
  await page.waitForFunction(
    (sel) => document.querySelectorAll(sel).length > 0,
    approveSelector,
    { timeout: APPROVE_RENDER_TIMEOUT_MS }
  ).catch(() => {});

  return true;
}

// ─── Generic approval loop ────────────────────────────────────────────────────

async function approveCategory(page, { tabName, categoryValue, approveSelector, label }) {
  console.log(`\n🔍 Checking ${label}...`);

  // Always start from a fresh Task Box load so prior navigation state doesn't matter.
  await page.goto(`${DARWINBOX_URL}/tasksApi/GetTasks`, { waitUntil: "domcontentloaded" });

  const tableExists = await page.waitForSelector(LEAVE_REQUESTS_TABLE, { timeout: TABLE_LOAD_TIMEOUT_MS })
    .then(() => true).catch(() => false);

  if (!tableExists) {
    console.log(`✅ Task Box empty — no ${label} to approve`);
    return { approved: 0, failed: 0 };
  }

  const onTab = await ensureTab(page, tabName, categoryValue, approveSelector);
  if (!onTab) {
    console.log(`✅ No ${tabName} tab — nothing pending`);
    return { approved: 0, failed: 0 };
  }

  const initialCount = await countButtons(page, approveSelector);
  if (initialCount === 0) {
    console.log(`✅ No pending ${label}`);
    return { approved: 0, failed: 0 };
  }

  console.log(`📋 ${initialCount} pending ${label}`);
  const results = { approved: 0, failed: 0, records: [] };

  while (true) {
    const countBefore = await countButtons(page, approveSelector);
    if (countBefore === 0) break;

    const rowInfo = await extractFirstRowInfo(page, approveSelector);
    const rowLabel = rowInfo ? rowInfo.slice(0, 2).join(" | ") : "unknown";
    console.log(`\n   🖊️  Approving: ${rowLabel} (${countBefore} remaining)...`);

    try {
      const btn = page.locator(approveSelector).first();
      await btn.waitFor({ state: "visible", timeout: 5000 });
      await btn.click();
    } catch (err) {
      console.warn(`   ⚠️ Click failed: ${err.message}`);
      await takeStepScreenshot(page, `${label.replace(/ /g,"_")}_click_failed.png`, "click failed", { log: true });
      results.failed++;
      break;
    }

    await sleep(2000);
    await page.reload({ waitUntil: "domcontentloaded" });

    const tableFound = await page.waitForSelector(LEAVE_REQUESTS_TABLE, { timeout: TABLE_LOAD_TIMEOUT_MS })
      .then(() => true).catch(() => false);

    if (!tableFound) {
      console.log(`   ✅ Approved (Task Box exited — all ${label} processed)`);
      results.approved++;
      if (rowInfo) results.records.push(rowInfo.slice(0, 2).join(" | "));
      break;
    }

    const onTabAfter = await ensureTab(page, tabName, categoryValue, approveSelector);
    if (!onTabAfter) {
      console.log(`   ✅ Approved (${tabName} tab removed — 0 remaining)`);
      results.approved++;
      if (rowInfo) results.records.push(rowInfo.slice(0, 2).join(" | "));
      break;
    }

    const countAfter = await countButtons(page, approveSelector);
    if (countAfter < countBefore) {
      const delta = countBefore - countAfter;
      console.log(`   ✅ Approved (${delta} removed, ${countAfter} remaining)`);
      results.approved += delta;
      if (rowInfo) results.records.push(rowInfo.slice(0, 2).join(" | "));
    } else {
      console.warn(`   ⚠️ Count unchanged after approval — stopping`);
      await takeStepScreenshot(page, `${label.replace(/ /g,"_")}_unchanged.png`, "count unchanged", { log: true });
      results.failed++;
      break;
    }
  }

  return results;
}

// ─── Public entry point ───────────────────────────────────────────────────────

async function approveAllLeaveRequests(page) {
  const leaveResult = await approveCategory(page, {
    tabName: "Leave Requests",
    categoryValue: "leave_task",
    approveSelector: 'DBX-DS-BUTTON[data-action="leave_app_rej_approve"]',
    label: "leave requests",
  });

  const tcResult = await approveCategory(page, {
    tabName: "Time Correction",
    categoryValue: "attendance_request",
    approveSelector: 'DBX-DS-BUTTON[data-action="attendance_app_rej_accept"]',
    label: "time corrections",
  });

  const ohResult = await approveCategory(page, {
    tabName: "Optional Holiday Requests",
    categoryValue: "leave_task_oh",
    approveSelector: 'DBX-DS-BUTTON[data-action="request_optional_holiday_approve"]',
    label: "optional holiday requests",
  });

  console.log(`\n✅ Task approvals done. Leave: ${leaveResult.approved} approved. Time Correction: ${tcResult.approved} approved. Optional Holiday: ${ohResult.approved} approved.`);
  return {
    leave: leaveResult,
    timeCorrection: tcResult,
    optionalHoliday: ohResult,
  };
}

module.exports = { approveAllLeaveRequests };
