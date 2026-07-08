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

async function openContextMenu(page, date, monthContext = "") {
  const idx = await findContextMenuIndex(page, date, monthContext);
  console.log(`   🔍 Context menu btn index: ${idx}`);
  const btn = page.locator("DBX-DS-BUTTON.row_context_menu").nth(idx);
  await btn.scrollIntoViewIfNeeded();
  await sleep(UI_SLEEP_SHORT_MS);
  await btn.click({ timeout: CONTEXT_MENU_CLICK_TIMEOUT_MS });
  console.log(`   ✅ ⋮ clicked`);
  await sleep(UI_SLEEP_MENU_MS);
  // No return value — caller no longer needs the btn reference.
}

async function selectTimeCorrectionItem(page) {
  // Click via shadow DOM traversal — direction-independent (menu opens up or down).
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
  // Close via the X button in the modal's shadow root header.
  // Avoids hardcoded screen coordinates — works at any viewport width.
  try {
    await page.evaluate(() => {
      const modal = document.querySelector("dbx-ds-modal");
      if (!modal || !modal.shadowRoot) return;
      const footerBtns = new Set(
        [...modal.shadowRoot.querySelectorAll(".footer dbx-ds-button, .footer button")]
      );
      const closeBtn = [...modal.shadowRoot.querySelectorAll("dbx-ds-button, button")]
        .find(b => !footerBtns.has(b));
      if (closeBtn) closeBtn.click();
    });
  } catch (_) {}
  // Fallback: Escape key.
  try { await page.keyboard.press("Escape"); } catch (_) {}
}

async function clickSubmit(page) {
  try {
    // Find the Submit button by text in the modal shadow root —
    // more robust than selecting by last index.
    const box = await page.evaluate(() => {
      const modal = document.querySelector("dbx-ds-modal");
      if (!modal || !modal.shadowRoot) throw new Error("modal shadow root not found");
      const btns = [...modal.shadowRoot.querySelectorAll(".footer dbx-ds-button")];
      const submitBtn = btns.find(b => {
        const inner = b.shadowRoot?.querySelector("button");
        return (inner?.textContent?.trim() || b.textContent?.trim()) === "Submit";
      });
      if (!submitBtn) throw new Error("Submit button not found in modal footer");
      const r = submitBtn.getBoundingClientRect();
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
