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

async function chooseReasonOption(page, reasonChoices) {
  // Scoped to the panel — avoids matching "Time Correction" in status badges.
  const panel = page.locator("app-request-attendance");
  for (const reason of reasonChoices) {
    try {
      const option = panel.getByText(reason, { exact: true }).first();
      await option.waitFor({ state: "visible", timeout: REASON_OPTION_WAIT_MS });
      await option.click({ timeout: REASON_OPTION_CLICK_MS });
      return reason;
    } catch (_) {}
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

  // Single click to open the dropdown, then wait for an option to become visible
  // before attempting to select — replaces the fragile click→Escape→click dance.
  await page.mouse.click(cx, cy);
  await sleep(REASON_UI_SLEEP_MS);

  const reasonChoices = forcedReason ? [forcedReason] : getReasonPriority();

  // If the dropdown didn't open on the first click (e.g. component not ready),
  // one retry is enough — avoid overcomplicating the happy path.
  const panel = page.locator("app-request-attendance");
  const firstOption = panel.getByText(reasonChoices[0], { exact: true }).first();
  const opened = await firstOption.isVisible().catch(() => false);
  if (!opened) {
    await page.mouse.click(cx, cy);
    await sleep(REASON_UI_SLEEP_MS);
  }

  const chosenReason = await chooseReasonOption(page, reasonChoices);
  await sleep(REASON_UI_SLEEP_MS);
  await takeStepScreenshot(page, "step_5_option_clicked.png");
  console.log(`   ✅ Reason selected: ${chosenReason}`);
}

module.exports = { getReasonPriority, selectReason };
