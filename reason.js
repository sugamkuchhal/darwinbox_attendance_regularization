// Handles reason dropdown discovery and option selection in modal.
const { sleep } = require("./utils");

async function takeStepScreenshot(page, path, note = "") {
  await page.screenshot({ path });
  console.log(`   📸 Screenshot saved: ${path}${note ? ` — ${note}` : ""}`);
}

function getReasonPriority() {
  const raw = process.env.DARWINBOX_REASON_PRIORITY || "Forgot To Punch,Outdoor Duty,Work From Home,In / Out Swiping Mistake";
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

async function getReasonDropdownBox(page) {
  return page.evaluate(() => {
    const modal = document.querySelector("dbx-ds-modal");
    if (!modal) return { ok: false, reason: "modal not found" };
    const dropdowns = [...modal.querySelectorAll("dbx-ds-dropdown")];
    const reason = dropdowns[1] || dropdowns.find((d) => /select\s*reason/i.test((d.textContent || "").trim()));
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
      await option.waitFor({ state: "visible", timeout: 1500 });
      await option.click({ timeout: 2000 });
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
  await sleep(300);
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(300);

  const reasonChoices = forcedReason ? [forcedReason] : getReasonPriority();
  const chosenReason = await chooseReasonOption(page, reasonChoices);
  await sleep(300);
  await takeStepScreenshot(page, "step_5_option_clicked.png", `${chosenReason} clicked`);
}

module.exports = { getReasonPriority, selectReason };
