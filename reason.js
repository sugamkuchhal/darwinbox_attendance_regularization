// Handles reason dropdown discovery and option selection in the Time Correction panel.
const { sleep } = require("./utils");
const { takeStepScreenshot } = require("./reporting");
const {
  DEFAULT_REASON_PRIORITY,
  REASON_OPTION_WAIT_MS,
  REASON_OPTION_CLICK_MS,
  REASON_UI_SLEEP_MS,
} = require("./attendance-constants");

function getReasonPriority() {
  const raw = process.env.DARWINBOX_REASON_PRIORITY || DEFAULT_REASON_PRIORITY;
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

async function getReasonDropdownBox(page) {
  return page.evaluate(() => {
    const modal = document.querySelector("dbx-ds-modal");
    if (!modal) return { ok: false, reason: "modal not found" };

    // Primary: use the stable data-scroll-id="reason" attribute set by the app.
    let reasonDropdown = modal.querySelector('dbx-ds-dropdown[data-scroll-id="reason"]');

    // Fallback: second dropdown by index (location is first, reason is second).
    if (!reasonDropdown) {
      const dropdowns = [...modal.querySelectorAll("dbx-ds-dropdown")];
      reasonDropdown = dropdowns[1] || null;
    }

    if (!reasonDropdown) return { ok: false, reason: "Reason dropdown not found" };

    reasonDropdown.scrollIntoView({ block: "center" });
    const r = reasonDropdown.getBoundingClientRect();
    return { ok: true, box: { x: r.x, y: r.y, width: r.width, height: r.height } };
  });
}

async function chooseReasonOption(page, reasonChoices) {
  // Scope search to the Time Correction panel to avoid matching status badges
  // or other text on the page that coincidentally contains the reason string.
  const panel = page.locator("app-request-attendance");

  for (const reason of reasonChoices) {
    try {
      const option = panel.getByText(reason, { exact: true }).first();
      await option.waitFor({ state: "visible", timeout: REASON_OPTION_WAIT_MS });
      await option.click({ timeout: REASON_OPTION_CLICK_MS });
      return reason;
    } catch (_) {}
  }
  throw new Error(`No preferred reason option visible. Tried: ${reasonChoices.join(", ")}`);
}

async function selectReason(page, forcedReason = null) {
  await takeStepScreenshot(page, "step_1_panel_open.png", "panel opened");
  const result = await getReasonDropdownBox(page);
  if (!result.ok) {
    await takeStepScreenshot(page, "step_2_reason_dropdown_failed.png", "reason lookup failed");
    throw new Error(result.reason);
  }

  const box = result.box;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(REASON_UI_SLEEP_MS);
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(REASON_UI_SLEEP_MS);

  const reasonChoices = forcedReason ? [forcedReason] : getReasonPriority();
  const chosenReason = await chooseReasonOption(page, reasonChoices);
  await sleep(REASON_UI_SLEEP_MS);
  await takeStepScreenshot(page, "step_5_option_clicked.png", `${chosenReason} clicked`);
}

module.exports = { getReasonPriority, selectReason };
