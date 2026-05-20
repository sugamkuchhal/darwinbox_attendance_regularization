// Handles reason dropdown discovery and option selection in modal.
const { sleep } = require("./utils");
const { takeStepScreenshot } = require("./reporting");
const { DEFAULT_REASON_PRIORITY, REASON_OPTION_WAIT_MS, REASON_OPTION_CLICK_MS, REASON_UI_SLEEP_MS } = require("./attendance-constants");

function getReasonPriority() {
  const raw = process.env.DARWINBOX_REASON_PRIORITY || DEFAULT_REASON_PRIORITY;
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

async function getReasonDropdownBox(page) {
  return page.evaluate(() => {
    const modal = document.querySelector("dbx-ds-modal");
    if (!modal) return { ok: false, reason: "modal not found" };

    const dropdowns = [...modal.querySelectorAll("dbx-ds-dropdown")];

    // Primary strategy (existing): index-based or placeholder-text match.
    let reason = dropdowns[1] || dropdowns.find((d) => /select\s*reason/i.test((d.textContent || "").trim()));

    // Fallback strategy (additive): anchor to visible "Reason" text and pick nearest dropdown.
    if (!reason) {
      const anchors = [...modal.querySelectorAll("*")].filter((el) => /\breason\b/i.test((el.textContent || "").trim()));
      const anchor = anchors.find((el) => {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      });

      if (anchor && dropdowns.length) {
        const a = anchor.getBoundingClientRect();
        reason = dropdowns
          .map((d) => ({ d, r: d.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.height > 0)
          .sort((x, y) => {
            const dx = Math.abs((x.r.y + x.r.height / 2) - (a.y + a.height / 2));
            const dy = Math.abs((y.r.y + y.r.height / 2) - (a.y + a.height / 2));
            return dx - dy;
          })[0]?.d || null;
      }
    }

    if (!reason) return { ok: false, reason: "Reason dropdown not found" };
    reason.scrollIntoView({ block: "center" });
    const r = reason.getBoundingClientRect();
    return { ok: true, box: { x: r.x, y: r.y, width: r.width, height: r.height } };
  });
}

async function chooseReasonOption(page, reasonChoices) {
  for (const reason of reasonChoices) {
    try {
      const option = page.getByText(reason, { exact: true }).first();
      await option.waitFor({ state: "visible", timeout: REASON_OPTION_WAIT_MS });
      await option.click({ timeout: REASON_OPTION_CLICK_MS });
      return reason;
    } catch (_) {}
  }
  throw new Error(`No preferred reason option visible. Tried: ${reasonChoices.join(", ")}`);
}

async function selectReason(page, forcedReason = null) {
  await takeStepScreenshot(page, "step_1_modal_open.png", "modal opened");
  const result = await getReasonDropdownBox(page);
  if (!result.ok) {
    await takeStepScreenshot(page, "step_2_scrolled_bottom_failed.png", "reason lookup failed");
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
