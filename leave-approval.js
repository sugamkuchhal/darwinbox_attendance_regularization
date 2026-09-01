// Approves all pending Leave Requests in the Darwinbox Task Box.
// Assumes the browser is already logged in (login() has been called).

const { DARWINBOX_URL } = require("./config");
const { sleep } = require("./utils");
const { takeStepScreenshot } = require("./reporting");

const LEAVE_REQUESTS_TABLE = "table#core_taskbox_tasks";
const APPROVE_BUTTON_SELECTOR = 'DBX-DS-BUTTON[data-action="leave_app_rej_approve"]';
const TABLE_LOAD_TIMEOUT_MS = 15000;

// ─── Navigation ───────────────────────────────────────────────────────────────

async function loadLeaveRequestsPage(page) {
  await page.goto(`${DARWINBOX_URL}/tasksApi/GetTasks`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(LEAVE_REQUESTS_TABLE, { timeout: TABLE_LOAD_TIMEOUT_MS });

  const isLeaveTab = await page.evaluate(() =>
    document.querySelector("#task_category_id")?.value === "leave_task"
  );

  if (!isLeaveTab) {
    console.log("   ↩️  Not on Leave Requests tab — clicking it...");
    const clicked = await page.evaluate(() => {
      // The tab group uses nested shadow DOMs — traverse to find "Leave Requests" text.
      function searchShadow(root) {
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot && searchShadow(el.shadowRoot)) return true;
          if (el.children.length === 0 && el.textContent.trim() === "Leave Requests") {
            // Walk up to find a clickable tab element
            let cur = el;
            while (cur) {
              if (cur.tagName === "DBX-DS-TAB" || cur.tagName === "A" || cur.getAttribute?.("role") === "tab") {
                cur.click();
                return true;
              }
              cur = cur.parentElement || cur.getRootNode()?.host;
            }
          }
        }
        return false;
      }
      const tabGroup = document.querySelector("#dbx_vertical_tabs");
      return tabGroup?.shadowRoot ? searchShadow(tabGroup.shadowRoot) : false;
    });

    if (!clicked) throw new Error("Could not find or click the Leave Requests tab");

    // Wait until the category switches to leave_task
    await page.waitForFunction(
      () => document.querySelector("#task_category_id")?.value === "leave_task",
      { timeout: TABLE_LOAD_TIMEOUT_MS }
    );
    console.log("   ✅ Leave Requests tab active");
  }
}

// ─── Approval loop ────────────────────────────────────────────────────────────

async function countApproveButtons(page) {
  return page.evaluate(
    (sel) => document.querySelectorAll(sel).length,
    APPROVE_BUTTON_SELECTOR
  );
}

async function clickFirstApproveButton(page) {
  // Use Playwright locator — auto-pierces shadow DOM where possible.
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

    console.log(`\n   🖊️ Approving request (${countBefore} remaining)...`);

    try {
      await clickFirstApproveButton(page);
    } catch (err) {
      console.warn(`   ⚠️ Click failed: ${err.message}`);
      await takeStepScreenshot(page, `leave_approve_click_failed.png`, "click failed", { log: true });
      results.failed++;
      break;
    }

    // Wait for the action to process, then reload to get fresh state.
    await sleep(2000);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(LEAVE_REQUESTS_TABLE, { timeout: TABLE_LOAD_TIMEOUT_MS });

    const countAfter = await countApproveButtons(page);

    if (countAfter < countBefore) {
      console.log(`   ✅ Approved (${countBefore - countAfter} row(s) removed)`);
      results.approved += countBefore - countAfter;
    } else {
      // Count didn't decrease — request was already processed or rejected by server.
      console.warn(`   ⚠️ Row count unchanged after approval attempt — skipping`);
      await takeStepScreenshot(page, `leave_approve_unchanged.png`, "count unchanged", { log: true });
      results.failed++;
      // Safety: if count stays same across attempts, stop to avoid infinite loop.
      break;
    }
  }

  return results;
}

module.exports = { approveAllLeaveRequests };
