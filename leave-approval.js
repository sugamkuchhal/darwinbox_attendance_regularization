// Approves all pending Leave Requests in the Darwinbox Task Box.
// Assumes the browser is already logged in (login() has been called).

const { DARWINBOX_URL } = require("./config");
const { sleep } = require("./utils");
const { takeStepScreenshot } = require("./reporting");

const LEAVE_REQUESTS_TABLE    = "table#core_taskbox_tasks";
const APPROVE_BUTTON_SELECTOR = 'DBX-DS-BUTTON[data-action="leave_app_rej_approve"]';
const TABLE_LOAD_TIMEOUT_MS   = 15000;
const TAB_SWITCH_TIMEOUT_MS   = 10000;
const ROW_LOAD_TIMEOUT_MS     = 10000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitForTable(page) {
  await page.waitForSelector(LEAVE_REQUESTS_TABLE, { timeout: TABLE_LOAD_TIMEOUT_MS });
}

// After the table element appears, the SPA still populates rows asynchronously.
async function waitForTableRows(page) {
  await page.waitForFunction(
    (sel) => !!document.querySelector(sel + " tbody"),
    LEAVE_REQUESTS_TABLE,
    { timeout: ROW_LOAD_TIMEOUT_MS }
  ).catch(() => {}); // graceful — 0-row tbody is fine
}

async function isOnLeaveTab(page) {
  return page.evaluate(
    () => document.querySelector("#task_category_id")?.value === "leave_task"
  );
}

async function countApproveButtons(page) {
  return page.evaluate(
    (sel) => document.querySelectorAll(sel).length,
    APPROVE_BUTTON_SELECTOR
  );
}

// ─── Tab navigation ───────────────────────────────────────────────────────────

// Click the Leave Requests tab by finding the div.tab-container whose text
// includes "Leave Requests" inside each DBX-DS-TAB's shadow root.
// Clicking div.tab-container (not the outer custom element) triggers the SPA switch.
async function tryClickLeaveTab(page) {
  return page.evaluate(() => {
    const tabGroup = document.querySelector("#dbx_vertical_tabs");
    if (!tabGroup?.shadowRoot) return false;
    const tabs = [...tabGroup.shadowRoot.querySelectorAll("DBX-DS-TAB")];
    for (const tab of tabs) {
      const container = tab.shadowRoot?.querySelector("div.tab-container");
      if (container?.textContent?.trim().includes("Leave Requests")) {
        container.click();
        return true;
      }
    }
    return false;
  });
}

async function loadLeaveRequestsPage(page) {
  await page.goto(`${DARWINBOX_URL}/tasksApi/GetTasks`, { waitUntil: "domcontentloaded" });
  await waitForTable(page);
  await waitForTableRows(page);

  if (await isOnLeaveTab(page)) return;

  console.log("   ↩️  Not on Leave Requests tab — clicking it...");
  const clicked = await tryClickLeaveTab(page);
  if (!clicked) throw new Error("Could not find the Leave Requests tab in shadow DOM");

  // SPA switches in-place — wait for category indicator to update (no reload needed).
  await page.waitForFunction(
    () => document.querySelector("#task_category_id")?.value === "leave_task",
    null,
    { timeout: TAB_SWITCH_TIMEOUT_MS }
  );
  await waitForTableRows(page);
  console.log("   ✅ Leave Requests tab active");
}

// ─── Approval loop ────────────────────────────────────────────────────────────

async function clickFirstApproveButton(page) {
  const btn = page.locator(APPROVE_BUTTON_SELECTOR).first();
  await btn.waitFor({ state: "visible", timeout: 5000 });
  await btn.click();
}

async function approveAllLeaveRequests(page) {
  await loadLeaveRequestsPage(page);

  const initialCount = await countApproveButtons(page);
  if (initialCount === 0) {
    console.log("✅ No pending leave requests to approve");
    return { approved: 0, failed: 0 };
  }

  console.log(`📋 ${initialCount} pending leave request(s) to approve`);
  const results = { approved: 0, failed: 0 };

  while (true) {
    const countBefore = await countApproveButtons(page);
    if (countBefore === 0) break;

    console.log(`\n   🖊️  Approving request (${countBefore} remaining)...`);

    try {
      await clickFirstApproveButton(page);
    } catch (err) {
      console.warn(`   ⚠️ Click failed: ${err.message}`);
      await takeStepScreenshot(page, "leave_approve_click_failed.png", "click failed", { log: true });
      results.failed++;
      break;
    }

    // Allow the request to process, then reload for clean DOM state.
    await sleep(2000);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForTable(page);
    await waitForTableRows(page);

    const countAfter = await countApproveButtons(page);

    if (countAfter < countBefore) {
      const delta = countBefore - countAfter;
      console.log(`   ✅ Approved (${delta} row(s) removed, ${countAfter} remaining)`);
      results.approved += delta;
    } else {
      console.warn("   ⚠️ Row count unchanged after approval attempt — stopping");
      await takeStepScreenshot(page, "leave_approve_unchanged.png", "count unchanged", { log: true });
      results.failed++;
      break;
    }
  }

  return results;
}

module.exports = { approveAllLeaveRequests };
