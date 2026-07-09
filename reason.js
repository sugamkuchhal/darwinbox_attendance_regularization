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

// Click the reason dropdown to open it.
// Playwright auto-scrolls the element into view and dispatches real pointer events,
// so no getBoundingClientRect or coordinate math is needed.
async function openReasonDropdown(page) {
  // dbx-ds-dropdown is in the light DOM of dbx-ds-modal — standard CSS selector works.
  let dropdown = page.locator('dbx-ds-modal dbx-ds-dropdown[data-scroll-id="reason"]');

  // Fallback: second dropdown (location is first, reason is second).
  if (await dropdown.count() === 0) {
    dropdown = page.locator('dbx-ds-modal dbx-ds-dropdown').nth(1);
  }

  await dropdown.scrollIntoViewIfNeeded();
  await dropdown.click({ timeout: REASON_OPTION_WAIT_MS });
}

// Wait for the dropdown panel and select the first matching reason option.
//
// Playwright auto-pierces open shadow DOM in CSS and text selectors, so:
//   page.locator('dbx-dropdown-panel')  →  finds panel inside dbx-ds-modal.shadowRoot
//   panel.getByText(reason)             →  finds text inside dbx-dropdown-simple-item.shadowRoot
//
// Clicking the matched text node dispatches a composed click event that bubbles
// through the shadow boundary to dbx-dropdown-simple-item, which registers the
// selection in the Angular form model (ng-valid confirmed via live testing).
async function chooseReasonOption(page, reasonChoices) {
  const panel = page.locator('dbx-dropdown-panel');
  await panel.waitFor({ state: 'visible', timeout: REASON_OPTION_WAIT_MS });

  for (const reason of reasonChoices) {
    const option = panel.getByText(reason, { exact: true });
    if (await option.isVisible().catch(() => false)) {
      await option.click();
      return reason;
    }
  }

  throw new Error(`No reason option visible. Tried: ${reasonChoices.join(", ")}`);
}

async function selectReason(page, forcedReason = null) {
  await takeStepScreenshot(page, "step_1_panel_open.png");

  await openReasonDropdown(page);
  await sleep(REASON_UI_SLEEP_MS);

  const reasonChoices = forcedReason ? [forcedReason] : getReasonPriority();
  const chosenReason = await chooseReasonOption(page, reasonChoices);
  await sleep(REASON_UI_SLEEP_MS);
  await takeStepScreenshot(page, "step_5_option_clicked.png");
  console.log(`   ✅ Reason selected: ${chosenReason}`);
}

module.exports = { getReasonPriority, selectReason };
