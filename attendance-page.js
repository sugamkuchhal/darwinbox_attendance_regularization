// Handles attendance page loading and month navigation helpers.
const { DARWINBOX_URL, EMPLOYEE_ID } = require("./config");
const { sleep } = require("./utils");

const LEFT_CHEVRON_PATH = 'path[d="M15 18L9.70711 12.7071C9.31658 12.3166 9.31658 11.6834 9.70711 11.2929L15 6"]';
const CLICKABLE_ANCESTOR_SELECTOR = "xpath=ancestor::*[self::button or self::a or local-name()='dbx-ds-button' or local-name()='dbx-ds-icon-button' or @role='button' or @onclick or @tabindex='0' or contains(@class,'btn') or contains(@class,'cursor') or contains(@class,'pointer')][1]";

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

async function getAttendanceDates(page) {
  return page.evaluate(() => {
    const dates = [];
    const seen = new Set();

    for (const row of document.querySelectorAll("table tr")) {
      const dateSpan = row.querySelector('td.primary-cell span[dir="auto"]');
      const dateStr = (dateSpan?.innerText || "").trim();
      if (!/^\d{2}-\d{2}-\d{4}$/.test(dateStr) || seen.has(dateStr)) continue;
      seen.add(dateStr);
      dates.push(dateStr);
    }

    return dates;
  });
}

function getDateSignature(dates) {
  return dates.join("|");
}

async function getExpectedPreviousMonth(page) {
  return page.evaluate(() => {
    const previous = new Date();
    previous.setDate(1);
    previous.setMonth(previous.getMonth() - 1);

    return {
      month: String(previous.getMonth() + 1).padStart(2, "0"),
      year: String(previous.getFullYear()),
    };
  });
}

function datesContainMonth(dates, { month, year }) {
  return dates.some(date => date.slice(3, 5) === month && date.slice(6) === year);
}

async function waitForPreviousMonth(page, beforeSignature, expectedPreviousMonth) {
  try {
    await page.waitForFunction(
      ({ beforeSignature: previousSignature, expectedPreviousMonth: expected }) => {
        const dates = [];
        const seen = new Set();

        for (const row of document.querySelectorAll("table tr")) {
          const dateSpan = row.querySelector('td.primary-cell span[dir="auto"]');
          const dateStr = (dateSpan?.innerText || "").trim();
          if (!/^\d{2}-\d{2}-\d{4}$/.test(dateStr) || seen.has(dateStr)) continue;
          seen.add(dateStr);
          dates.push(dateStr);
        }

        if (dates.some(date => date.slice(3, 5) === expected.month && date.slice(6) === expected.year)) return true;
        return dates.length > 0 && dates.join("|") !== previousSignature;
      },
      { beforeSignature, expectedPreviousMonth },
      { timeout: 5000 }
    );
    return true;
  } catch (_) {
    return false;
  }
}

async function activateListView(page) {
  try {
    const listSvg = page.locator('svg[viewBox="0 0 12 10"]').first();
    if (await listSvg.count() > 0) {
      const clickableParent = listSvg.locator(CLICKABLE_ANCESTOR_SELECTOR).first();
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

async function clickPreviousMonthCandidate(page, index) {
  const path = page.locator(LEFT_CHEVRON_PATH).nth(index);
  if (await path.count() === 0) return false;

  const clickableParent = path.locator(CLICKABLE_ANCESTOR_SELECTOR).first();
  const svg = path.locator("xpath=ancestor::*[local-name()='svg'][1]").first();
  await clickFirstAvailable([clickableParent, svg, path], `Previous month chevron candidate ${index + 1}`, 4000);
  return true;
}

async function clickPreviousMonth(page) {
  const chevronCount = await page.locator(LEFT_CHEVRON_PATH).count();
  if (chevronCount === 0) throw new Error("Previous month chevron path not found");

  const beforeDates = await getAttendanceDates(page);
  const beforeSignature = getDateSignature(beforeDates);
  const expectedPreviousMonth = await getExpectedPreviousMonth(page);

  for (let index = 0; index < chevronCount; index++) {
    try {
      await clickPreviousMonthCandidate(page, index);
    } catch (err) {
      console.warn(`⚠️ Previous month chevron candidate ${index + 1} click failed: ${err.message}`);
      continue;
    }

    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

    if (await waitForPreviousMonth(page, beforeSignature, expectedPreviousMonth)) {
      await sleep(1000);
      const afterDates = await getAttendanceDates(page);
      if (datesContainMonth(afterDates, expectedPreviousMonth) || getDateSignature(afterDates) !== beforeSignature) {
        console.log(`✅ Switched to previous month (${expectedPreviousMonth.month}-${expectedPreviousMonth.year})`);
        return;
      }
    }

    console.warn(`⚠️ Previous month chevron candidate ${index + 1} clicked but attendance dates did not change`);
  }

  throw new Error(`Previous month navigation did not change attendance dates after ${chevronCount} chevron candidate(s)`);
}

async function reloadInMonthContext(page, monthContext) {
  await reloadAttendancePage(page);
  if (monthContext === "previous") await clickPreviousMonth(page);
}

module.exports = { activateListView, reloadAttendancePage, clickPreviousMonth, reloadInMonthContext };
