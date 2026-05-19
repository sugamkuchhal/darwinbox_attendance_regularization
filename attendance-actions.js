// Encapsulates direct modal/table UI interactions on attendance page.
const { sleep } = require("./utils");
const { findContextMenuIndex } = require("./attendance-scan");
const { MODAL_OPEN_TIMEOUT_MS, UI_SLEEP_SHORT_MS, UI_SLEEP_MENU_MS, UI_SLEEP_SUBMIT_MS } = require("./attendance-constants");

async function takeStepScreenshot(page, path, note = "") {
  await page.screenshot({ path });
  console.log(`   📸 Screenshot saved: ${path}${note ? ` — ${note}` : ""}`);
}

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

async function selectTimeCorrectionItem(page, btn) {
  const box = await btn.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 20);
  console.log(`   ✅ Clicked Time Correction`);

  await page.waitForFunction(() => {
    const modal = document.querySelector("dbx-ds-modal");
    return modal && modal.querySelectorAll("dbx-ds-dropdown").length >= 2;
  }, { timeout: MODAL_OPEN_TIMEOUT_MS });
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

module.exports = { takeStepScreenshot, openContextMenu, selectTimeCorrectionItem, clickSubmit };
