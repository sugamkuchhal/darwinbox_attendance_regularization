// Encapsulates direct modal/table UI interactions on attendance page.
const { sleep } = require("./utils");
const { findContextMenuIndex } = require("./attendance-scan");
const {
  MODAL_OPEN_TIMEOUT_MS,
  CONTEXT_MENU_CLICK_TIMEOUT_MS,
  UI_SLEEP_SHORT_MS,
  UI_SLEEP_MENU_MS,
  UI_SLEEP_SUBMIT_MS,
} = require("./attendance-constants");
const { takeStepScreenshot } = require("./reporting");

async function openContextMenu(page, date) {
  const idx = await findContextMenuIndex(page, date);
  console.log(`   🔍 Context menu btn index: ${idx}`);
  const btn = page.locator("DBX-DS-BUTTON.row_context_menu").nth(idx);
  await btn.scrollIntoViewIfNeeded();
  await sleep(UI_SLEEP_SHORT_MS);
  await btn.click({ timeout: CONTEXT_MENU_CLICK_TIMEOUT_MS });
  console.log(`   ✅ ⋮ clicked`);
  await sleep(UI_SLEEP_MENU_MS);
  return btn;
}

async function selectTimeCorrectionItem(page) {
  // Click "Time Correction" via shadow DOM traversal — coordinate-independent,
  // works whether the menu opens upward or downward.
  const clicked = await page.evaluate(() => {
    function searchShadow(root) {
      const els = root.querySelectorAll("*");
      for (const el of els) {
        if (el.shadowRoot && searchShadow(el.shadowRoot)) return true;
        if (
          el.classList?.contains("menu-item-wrapper") &&
          el.querySelector(".menu-text")?.textContent.trim() === "Time Correction"
        ) {
          el.click();
          return true;
        }
      }
      return false;
    }
    return searchShadow(document);
  });

  if (!clicked) throw new Error("Time Correction menu item not found in DOM");
  console.log(`   ✅ Clicked Time Correction`);

  await page.waitForFunction(() => {
    const modal = document.querySelector("dbx-ds-modal");
    return modal && modal.querySelectorAll("dbx-ds-dropdown").length >= 2;
  }, { timeout: MODAL_OPEN_TIMEOUT_MS });
  console.log(`   ✅ Panel ready`);
}

async function closePanelIfOpen(page) {
  // Close the side panel via its X button (Escape does not close it).
  try {
    await page.evaluate(() => {
      function searchShadow(root) {
        const els = root.querySelectorAll("*");
        for (const el of els) {
          if (el.shadowRoot && searchShadow(el.shadowRoot)) return true;
          // The close button is the first dbx-ds-button in the modal shadow footer area
          // Its visible bounding box is top-right of the panel (x > 1400, y < 100).
          if (el.tagName === "DBX-DS-BUTTON" || el.tagName === "BUTTON") {
            const rect = el.getBoundingClientRect();
            if (rect.x > 1400 && rect.y < 100 && rect.width > 0) {
              el.click();
              return true;
            }
          }
        }
        return false;
      }
      searchShadow(document);
    });
  } catch (_) {}
  // Fallback: Escape key
  try { await page.keyboard.press("Escape"); } catch (_) {}
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

module.exports = { openContextMenu, selectTimeCorrectionItem, closePanelIfOpen, clickSubmit };
