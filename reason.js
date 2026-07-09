// Handles reason dropdown discovery and option selection in the Time Correction panel.
const { sleep } = require("./utils");
const { takeStepScreenshot } = require("./reporting");
const {
  DEFAULT_REASON_PRIORITY,
  REASON_OPTION_WAIT_MS,
  REASON_UI_SLEEP_MS,
} = require("./attendance-constants");

function getReasonPriority() {
  const raw = process.env.DARWINBOX_REASON_PRIORITY || DEFAULT_REASON_PRIORITY;
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

async function getReasonDropdownBox(page) {
  return page.evaluate(async () => {
    const modal = document.querySelector("dbx-ds-modal");
    if (!modal) return { ok: false, reason: "modal not found" };

    let reasonDropdown = modal.querySelector('dbx-ds-dropdown[data-scroll-id="reason"]');
    if (!reasonDropdown) {
      const dropdowns = [...modal.querySelectorAll("dbx-ds-dropdown")];
      reasonDropdown = dropdowns[1] || null;
    }
    if (!reasonDropdown) return { ok: false, reason: "Reason dropdown not found" };

    reasonDropdown.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise(r => requestAnimationFrame(r));

    const r = reasonDropdown.getBoundingClientRect();
    return { ok: true, box: { x: r.x, y: r.y, width: r.width, height: r.height } };
  });
}

// The reason options list is rendered as a shadow DOM portal — same structure as
// the "Time Correction" context menu item. Find and click by .menu-text content.
async function clickOptionInShadowDOM(page, reason) {
  return page.evaluate((targetReason) => {
    function searchShadow(root) {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot && searchShadow(el.shadowRoot)) return true;
        if (
          el.classList?.contains("menu-item-wrapper") &&
          el.querySelector(".menu-text")?.textContent.trim() === targetReason
        ) {
          el.click();
          return true;
        }
      }
      return false;
    }
    return searchShadow(document);
  }, reason);
}

// Poll for any option to appear in the shadow DOM, then click it.
// The dropdown list renders asynchronously after the click that opens it.
async function chooseReasonOption(page, reasonChoices) {
  const deadline = Date.now() + REASON_OPTION_WAIT_MS;
  while (Date.now() < deadline) {
    for (const reason of reasonChoices) {
      if (await clickOptionInShadowDOM(page, reason)) return reason;
    }
    await sleep(200);
  }
  throw new Error(`No reason option visible. Tried: ${reasonChoices.join(", ")}`);
}

async function selectReason(page, forcedReason = null) {
  await takeStepScreenshot(page, "step_1_panel_open.png");
  const result = await getReasonDropdownBox(page);
  if (!result.ok) {
    await takeStepScreenshot(page, "step_2_reason_dropdown_failed.png", "reason lookup failed", { log: true });
    throw new Error(result.reason);
  }

  const { x, y, width, height } = result.box;
  const cx = x + width / 2;
  const cy = y + height / 2;

  // Click to open the dropdown. chooseReasonOption polls until options appear
  // (up to REASON_OPTION_WAIT_MS), so a single click is enough — no need for
  // Escape + second click or a probe check.
  await page.mouse.click(cx, cy);
  await sleep(REASON_UI_SLEEP_MS);

  const reasonChoices = forcedReason ? [forcedReason] : getReasonPriority();
  const chosenReason  = await chooseReasonOption(page, reasonChoices);

  await takeStepScreenshot(page, "step_5_option_clicked.png");
  console.log(`   ✅ Reason selected: ${chosenReason}`);
}

module.exports = { getReasonPriority, selectReason };
