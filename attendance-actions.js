// Encapsulates direct modal/table UI interactions on attendance page.
const { sleep } = require("./utils");
const { findContextMenuIndex } = require("./attendance-scan");
const { MODAL_OPEN_TIMEOUT_MS, UI_SLEEP_SHORT_MS, UI_SLEEP_MENU_MS, UI_SLEEP_SUBMIT_MS } = require("./attendance-constants");
const { takeStepScreenshot } = require("./reporting");

async function openContextMenu(page, date) {
  const idx = await findContextMenuIndex(page, date);
  console.log(`   🔍 Context menu btn index: ${idx}`);
  const btn = page.locator("DBX-DS-BUTTON.row_context_menu").nth(idx);
  await btn.scrollIntoViewIfNeeded();
  await sleep(UI_SLEEP_SHORT_MS);
  await btn.click({ timeout: MODAL_OPEN_TIMEOUT_MS });
  console.log(`   ✅ ⋮ clicked`);
  await sleep(UI_SLEEP_MENU_MS);
  return btn;
}

async function waitForModal(page, timeout) {
  await page.waitForFunction(() => {
    const modal = document.querySelector("dbx-ds-modal");
    return modal && modal.querySelectorAll("dbx-ds-dropdown").length >= 2;
  }, { timeout });
}

async function selectTimeCorrectionItem(page, btn) {
  // Primary: coordinate-based click 20px below the ⋮ button
  const box = await btn.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 20);
  console.log(`   ✅ Clicked Time Correction (coordinate)`);

  try {
    await waitForModal(page, 5000);
    console.log(`   ✅ Modal ready`);
    return;
  } catch (_) {
    console.log(`   ⚠️ Coordinate click didn't open modal — trying text locator fallback`);
  }

  // Fallback: text-based locator (handles menus that open upward on last rows).
  // Dismiss any stale menu first, then re-open and click by text.
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(UI_SLEEP_SHORT_MS);
  await btn.click({ timeout: MODAL_OPEN_TIMEOUT_MS });
  await sleep(UI_SLEEP_MENU_MS);
  const menuItem = page.locator("text=Time Correction").last();
  await menuItem.waitFor({ state: "visible", timeout: 5000 });
  await menuItem.click();
  console.log(`   ✅ Clicked Time Correction (text locator fallback)`);

  await waitForModal(page, MODAL_OPEN_TIMEOUT_MS);
  console.log(`   ✅ Modal ready`);
}

async function clickSubmit(page) {
  try {
    const box = await page.evaluate(() => {
      const btns = document.querySelector("dbx-ds-modal").shadowRoot.querySelectorAll(".footer dbx-ds-button");
      const r = btns[btns.length - 1].getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(UI_SLEEP_SUBMIT_MS);
    await takeStepScreenshot(page, "step_7_submitted.png", "submitted");
    console.log(`   ✅ Submitted`);
  } catch (err) {
    await takeStepScreenshot(page, "step_7_submitted_failed.png", "submit failed");
    throw err;
  }
}

module.exports = { openContextMenu, selectTimeCorrectionItem, clickSubmit };
