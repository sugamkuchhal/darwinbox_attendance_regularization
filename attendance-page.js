const { DARWINBOX_URL, EMPLOYEE_ID } = require("./config");
const { sleep } = require("./utils");

async function activateListView(page) {
  try {
    const listSvg = page.locator('svg[viewBox="0 0 12 10"]').first();
    if (await listSvg.count() > 0) {
      await listSvg.locator("..").click({ timeout: 3000 });
      await sleep(1500);
      console.log("✅ List view activated");
    }
  } catch (err) {
    console.warn(`⚠️ List view toggle failed: ${err.message}`);
  }
}

async function reloadAttendancePage(page) {
  await page.goto(`${DARWINBOX_URL}/ms/time/${EMPLOYEE_ID}/attendance`, { waitUntil: "networkidle" });
  await sleep(2000);
  await activateListView(page);
}

async function clickPreviousMonth(page) {
  const leftChevronPath = 'path[d="M15 18L9.70711 12.7071C9.31658 12.3166 9.31658 11.6834 9.70711 11.2929L15 6"]';
  const path = page.locator(leftChevronPath).first();
  if (await path.count() === 0) throw new Error("Previous month chevron path not found");

  const clickableParent = path.locator("xpath=ancestor::*[self::button or @role='button' or contains(@class,'btn')][1]").first();
  if (await clickableParent.count() > 0) await clickableParent.click({ timeout: 4000 });
  else await path.click({ timeout: 4000 });

  await sleep(1500);
  console.log("✅ Switched to previous month");
}

async function reloadInMonthContext(page, monthContext) {
  await reloadAttendancePage(page);
  if (monthContext === "previous") await clickPreviousMonth(page);
}

module.exports = { activateListView, reloadAttendancePage, clickPreviousMonth, reloadInMonthContext };
