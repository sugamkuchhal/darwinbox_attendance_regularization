// Handles attendance page loading and month navigation helpers.
const { DARWINBOX_URL, EMPLOYEE_ID } = require("./config");
const { sleep } = require("./utils");

async function clickLocator(locator, description, timeout = 4000) {
  await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});

  try {
    await locator.click({ timeout });
    return;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn(`⚠️ ${description} normal click failed, retrying with force: ${message}`);
  }

  try {
    await locator.click({ timeout, force: true });
    return;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn(`⚠️ ${description} forced click failed, retrying with DOM click: ${message}`);
  }

  await locator.evaluate((element) => {
    if (typeof element.click === "function") {
      element.click();
      return;
    }

    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
}

async function clickFirstAvailable(candidates, description, timeout = 4000) {
  for (const candidate of candidates) {
    if (await candidate.count() === 0) continue;
    await clickLocator(candidate.first(), description, timeout);
    return;
  }

  throw new Error(`${description} not found`);
}

async function activateListView(page) {
  try {
    const listSvg = page.locator('svg[viewBox="0 0 12 10"]').first();
    if (await listSvg.count() > 0) {
      const clickableParent = listSvg.locator("xpath=ancestor::*[self::button or @role='button' or contains(@class,'btn')][1]").first();
      await clickFirstAvailable([clickableParent, listSvg], "List view toggle", 3000);
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

  const clickableParent = path.locator("xpath=ancestor::*[self::button or @role='button' or contains(@class,'btn')][1]").first();
  const svg = path.locator("xpath=ancestor::*[local-name()='svg'][1]").first();
  await clickFirstAvailable([clickableParent, svg, path], "Previous month chevron", 4000);

  await sleep(1500);
  console.log("✅ Switched to previous month");
}

async function reloadInMonthContext(page, monthContext) {
  await reloadAttendancePage(page);
  if (monthContext === "previous") await clickPreviousMonth(page);
}

module.exports = { activateListView, reloadAttendancePage, clickPreviousMonth, reloadInMonthContext };
