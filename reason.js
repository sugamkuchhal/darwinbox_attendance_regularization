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

    // Primary: stable data-scroll-id attribute set by the app.
    let reasonDropdown = modal.querySelector('dbx-ds-dropdown[data-scroll-id="reason"]');

    // Fallback: second dropdown (location is first, reason is second).
    if (!reasonDropdown) {
      const dropdowns = [...modal.querySelectorAll("dbx-ds-dropdown")];
      reasonDropdown = dropdowns[1] || null;
    }

    if (!reasonDropdown) return { ok: false, reason: "Reason dropdown not found" };

    // scrollIntoView is async — wait one frame for layout to settle before
    // reading getBoundingClientRect, otherwise coordinates may be stale.
    reasonDropdown.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise(r => requestAnimationFrame(r));

    const r = reasonDropdown.getBoundingClientRect();
    return { ok: true, box: { x: r.x, y: r.y, width: r.width, height: r.height } };
  });
}

// Wait for the reason dropdown panel to open and have items, then click the
// first matching option.
// DOM path (confirmed via live inspection):
//   dbx-ds-modal.shadowRoot → dbx-dropdown-panel.shadowRoot → dbx-dropdown-simple-item
//   item.shadowRoot.textContent gives the visible label.
async function chooseReasonOption(page, reasonChoices) {
  await page.waitForFunction(() => {
    const modal = document.querySelector("dbx-ds-modal");
    const panel = modal?.shadowRoot?.querySelector("dbx-dropdown-panel");
    const items = panel?.shadowRoot?.querySelectorAll("dbx-dropdown-simple-item");
    return items && items.length > 0;
  }, { timeout: REASON_OPTION_WAIT_MS });

  for (const reason of reasonChoices) {
    const clicked = await page.evaluate((targetReason) => {
      const modal = document.querySelector("dbx-ds-modal");
      const panel = modal?.shadowRoot?.querySelector("dbx-dropdown-panel");
      const items = panel?.shadowRoot?.querySelectorAll("dbx-dropdown-simple-item") || [];
      for (const item of items) {
        const text = (item.shadowRoot?.textContent || item.textContent || "").trim();
        if (text === targetReason) {
          item.click();
          return true;
        }
      }
      return false;
    }, reason);

    if (clicked) return reason;
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
  await page.mouse.click(x + width / 2, y + height / 2);
  await sleep(REASON_UI_SLEEP_MS);

  const reasonChoices = forcedReason ? [forcedReason] : getReasonPriority();
  const chosenReason = await chooseReasonOption(page, reasonChoices);
  await sleep(REASON_UI_SLEEP_MS);
  await takeStepScreenshot(page, "step_5_option_clicked.png");
  console.log(`   ✅ Reason selected: ${chosenReason}`);
}

module.exports = { getReasonPriority, selectReason };
