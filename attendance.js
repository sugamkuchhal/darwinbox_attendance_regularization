const { DARWINBOX_URL, EMPLOYEE_ID } = require("./config");
const { sleep } = require("./utils");

async function takeStepScreenshot(page, path, note = "") {
  await page.screenshot({ path });
  console.log(`   📸 Screenshot saved: ${path}${note ? ` — ${note}` : ""}`);
}

// ─── Page navigation ──────────────────────────────────────────────────────────

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
  if (await path.count() === 0) {
    throw new Error("Previous month chevron path not found");
  }

  const clickableParent = path.locator("xpath=ancestor::*[self::button or @role='button' or contains(@class,'btn')][1]").first();
  if (await clickableParent.count() > 0) {
    await clickableParent.click({ timeout: 4000 });
  } else {
    await path.click({ timeout: 4000 });
  }
  await sleep(1500);
  console.log("✅ Switched to previous month");
}

async function reloadInMonthContext(page, monthContext) {
  await reloadAttendancePage(page);
  if (monthContext === "previous") {
    await clickPreviousMonth(page);
  }
}

// ─── Row scanning ─────────────────────────────────────────────────────────────

async function getTodayStr(page) {
  return page.evaluate(() => {
    const d  = new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}-${mm}-${d.getFullYear()}`;
  });
}

async function findAbsentDates(page) {
  console.log("🔍 Scanning attendance rows...");
  const todayStr = await getTodayStr(page);
  console.log(`📅 Today: ${todayStr} — skipping today and future`);

  const { results, skipped, totalRows } = await page.evaluate((today) => {
    const results = [];
    const skipped = [];
    const seen    = new Set();

    function toNum(s) {
      const [dd, mm, yyyy] = s.split("-");
      return parseInt(yyyy + mm + dd, 10);
    }
    const todayNum = toNum(today);
    let totalRows  = 0;

    for (const row of document.querySelectorAll("table tr")) {
      if ([...row.querySelectorAll("td")].length < 2) continue;
      totalRows++;

      // Date — confirmed: td.primary-cell > span[dir="auto"]
      const dateSpan = row.querySelector('td.primary-cell span[dir="auto"]');
      if (!dateSpan) continue;
      const dateStr = (dateSpan.innerText || "").trim();
      if (!/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) continue;

      if (seen.has(dateStr))         { skipped.push({ date: dateStr, reason: "duplicate" }); continue; }
      if (toNum(dateStr) >= todayNum){ skipped.push({ date: dateStr, reason: "today or future" }); continue; }
      seen.add(dateStr);

      // Attendance status — confirmed: td.primary-cell.sorting_1 > span#dbx-overflow-span
      const attendanceSpan   = row.querySelector('td.primary-cell.sorting_1 span#dbx-overflow-span');
      const attendanceStatus = (attendanceSpan?.innerText || "").trim();

      // Request badge — confirmed: dbx-ds-status-tag presence means request exists (Shadow DOM)
      const hasRequestBadge = !!row.querySelector('dbx-ds-status-tag');

      if (attendanceStatus !== "Absent") {
        skipped.push({ date: dateStr, reason: `not absent: ${attendanceStatus || "unknown"}` });
        continue;
      }
      if (hasRequestBadge) {
        skipped.push({ date: dateStr, reason: "request already exists" });
        continue;
      }

      results.push(dateStr);
    }

    return { results, skipped, totalRows };
  }, todayStr);

  console.log(`🔍 Scanned ${totalRows} rows`);
  skipped.forEach(s => console.log(`   ⏭️  ${s.date} — ${s.reason}`));
  return results;
}

// ─── Success verification ─────────────────────────────────────────────────────

async function verifySubmission(page, date) {
  // After reload, check that the row now has a dbx-ds-status-tag (request badge)
  const verified = await page.evaluate((targetDate) => {
    const row = [...document.querySelectorAll("table tr")].find(r => {
      const span = r.querySelector('td.primary-cell span[dir="auto"]');
      return span && (span.innerText || "").trim() === targetDate;
    });
    if (!row) return { ok: false, reason: "row not found after reload" };
    const hasBadge = !!row.querySelector('dbx-ds-status-tag');
    return { ok: hasBadge, reason: hasBadge ? "badge present" : "no badge found — request may not have gone through" };
  }, date);

  if (verified.ok) {
    console.log(`   ✅ Verified: ${date} — request badge confirmed`);
  } else {
    console.warn(`   ⚠️ Verification failed: ${date} — ${verified.reason}`);
  }
  return verified.ok;
}

// ─── Context menu ─────────────────────────────────────────────────────────────

async function findContextMenuIndex(page, date) {
  const idx = await page.evaluate((targetDate) => {
    const targetRow = [...document.querySelectorAll("table tr")].find(r => {
      const span = r.querySelector('td.primary-cell span[dir="auto"]');
      return span && (span.innerText || "").trim() === targetDate;
    });
    if (!targetRow) return -1;
    return [...document.querySelectorAll("DBX-DS-BUTTON.row_context_menu")]
      .findIndex(btn => targetRow.contains(btn));
  }, date);

  if (idx === -1) throw new Error(`Row not found for date ${date}`);
  return idx;
}

async function openContextMenu(page, date) {
  const idx = await findContextMenuIndex(page, date);
  console.log(`   🔍 Context menu btn index: ${idx}`);
  const btn = page.locator("DBX-DS-BUTTON.row_context_menu").nth(idx);
  await btn.scrollIntoViewIfNeeded();
  await sleep(300);
  await btn.click({ timeout: 5000 });
  console.log(`   ✅ ⋮ clicked`);
  await sleep(800);
  return btn;
}

async function selectTimeCorrectionItem(page, btn) {
  // "Time Correction" is the first dropdown item — confirmed from screenshots
  // Rendered ~20px below the button bottom as a floating popover
  const box = await btn.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 20);
  console.log(`   ✅ Clicked Time Correction`);

  // Wait for modal — poll for reason dropdown to appear (up to 5s)
  await page.waitForFunction(() => {
    const modal = document.querySelector("dbx-ds-modal");
    return modal && modal.querySelectorAll("dbx-ds-dropdown").length >= 2;
  }, { timeout: 5000 });
  console.log(`   ✅ Modal ready`);
}

// ─── Form filling ─────────────────────────────────────────────────────────────

async function getReasonDropdownBox(page) {
  // Phase A: Scroll modal body to terminal bottom before locating Reason.
  const result = await page.evaluate(() => {
    const modal = document.querySelector("dbx-ds-modal");
    if (!modal) return { ok: false, reason: "modal not found" };

    const collectNodes = (root) => {
      const out = [];
      const stack = [root];
      while (stack.length) {
        const node = stack.pop();
        if (!node) continue;
        out.push(node);
        if (node.shadowRoot) stack.push(node.shadowRoot);
        if (node.children && node.children.length) {
          for (const child of node.children) stack.push(child);
        }
      }
      return out;
    };

    const isScrollable = (el) => {
      if (!el || typeof el.scrollHeight !== "number" || typeof el.clientHeight !== "number") return false;
      // Some component libraries render scrollbars while reporting overflow as `visible`/empty.
      return el.scrollHeight > el.clientHeight + 8;
    };

    const searchRoot = modal.shadowRoot || modal;
    const allCandidates = collectNodes(searchRoot).filter(isScrollable);

    // Prefer right-side pane-like container: right-most visible scrollable area.
    const ranked = allCandidates
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 120 && rect.height > 120)
      .sort((a, b) => {
        const aDepth = (a.el.scrollHeight || 0) - (a.el.clientHeight || 0);
        const bDepth = (b.el.scrollHeight || 0) - (b.el.clientHeight || 0);
        return bDepth - aDepth || b.rect.right - a.rect.right || b.rect.height - a.rect.height;
      });

    const scrollTrace = [];
    const scroller = (ranked[0] && ranked[0].el) || allCandidates[0] || null;
    if (scroller) {
      for (let step = 0; step < 30; step++) {
        const before = scroller.scrollTop || 0;
        scroller.scrollTop = before + 220;
        const after = scroller.scrollTop || 0;
        scrollTrace.push({ step, before, after });
        if (after === before && step > 0) break;
      }
      scroller.scrollTop = scroller.scrollHeight;
      scrollTrace.push({
        step: "force-bottom",
        before: scroller.scrollTop || 0,
        after: scroller.scrollTop || 0,
        max: Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0))
      });
    } else {
      scrollTrace.push({ step: "no-scroller", note: "Proceeding without modal scrolling" });
    }

    const allDropdowns = [...searchRoot.querySelectorAll("dbx-ds-dropdown"), ...modal.querySelectorAll("dbx-ds-dropdown")];
    const uniqueDropdowns = [...new Set(allDropdowns)];

    // First-choice: dropdown that already contains "Select Reason" placeholder/text.
    let reason = uniqueDropdowns.find((d) => /select\s*reason/i.test((d.textContent || "").replace(/\s+/g, " ").trim()));

    // Fallback: find any element containing "Reason" label and locate closest dropdown.
    let reasonRow = null;
    if (!reason) {
      const reasonAnchors = [...searchRoot.querySelectorAll("*"), ...modal.querySelectorAll("*")].filter((el) =>
        /\breason\b/i.test((el.textContent || "").replace(/\s+/g, " ").trim())
      );
      for (const anchor of reasonAnchors) {
        const host = anchor.closest("div, label, dbx-ds-form-item, dbx-ds-field, dbx-form-field") || anchor.parentElement;
        reason = host?.querySelector?.("dbx-ds-dropdown") || host?.parentElement?.querySelector?.("dbx-ds-dropdown");
        if (reason) {
          reasonRow = host;
          break;
        }
      }
    }

    // Final fallback: pick dropdown closest to the first visible "Reason" anchor.
    if (!reason) {
      const reasonAnchor = [...searchRoot.querySelectorAll("*"), ...modal.querySelectorAll("*")]
        .find((el) => /\breason\b/i.test((el.textContent || "").replace(/\s+/g, " ").trim()));
      if (reasonAnchor && allDropdowns.length) {
        const a = reasonAnchor.getBoundingClientRect();
        reason = uniqueDropdowns
          .map((d) => ({ d, r: d.getBoundingClientRect() }))
          .sort((x, y) => {
            const dx = Math.abs((x.r.y + x.r.height / 2) - (a.y + a.height / 2));
            const dy = Math.abs((y.r.y + y.r.height / 2) - (a.y + a.height / 2));
            return dx - dy;
          })[0]?.d || null;
        reasonRow = reasonAnchor;
      }
    }

    // Ultimate fallback: pick the lowest visible dropdown in modal (Reason is near bottom in this flow).
    if (!reason) {
      reason = uniqueDropdowns
        .map((d) => ({ d, r: d.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 100 && r.height > 20)
        .sort((a, b) => b.r.y - a.r.y)[0]?.d || null;
    }

    if (!reason) return { ok: false, reason: "Reason dropdown not found after bottom scroll", scrollTrace };
    reason.scrollIntoView({ block: "center" });
    const r = reason.getBoundingClientRect();
    const rr = reasonRow?.getBoundingClientRect?.() || r;
    return {
      ok: true,
      box: { x: r.x, y: r.y, width: r.width, height: r.height },
      reasonRowRect: { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height) },
      scrollTrace
    };
  });

  if (!result.ok) {
    console.log(`   🧭 Bottom-scroll trace: ${JSON.stringify(result.scrollTrace || [])}`);
    throw new Error(result.reason);
  }
  console.log(`   🧭 Reason row rect: ${JSON.stringify(result.reasonRowRect)}`);
  console.log(`   🧭 Bottom-scroll trace: ${JSON.stringify((result.scrollTrace || []).slice(0, 8))}`);
  await sleep(500);
  return result.box;
}

async function selectReason(page) {
  await takeStepScreenshot(page, "step_1_modal_open.png", "modal opened");
  let box;
  try {
    box = await getReasonDropdownBox(page);
  } catch (err) {
    await takeStepScreenshot(page, "step_2_scrolled_bottom_failed.png", "reason lookup failed");
    throw err;
  }
  console.log(`   🔍 Reason dropdown: ${JSON.stringify(box)}`);
  await takeStepScreenshot(page, "step_2_scrolled_bottom.png", "bottom scroll + reason located");

  // Step 1: open reason dropdown by clicking its center.
  try {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(400);
    await takeStepScreenshot(page, "step_3_reason_visible.png", "reason control clicked");
  } catch (err) {
    await takeStepScreenshot(page, "step_3_reason_visible_failed.png", "reason control click failed");
    throw err;
  }

  // Close date picker if accidentally opened by prior focus state.
  try {
    try { await page.keyboard.press("Escape"); } catch (_) {}
    await sleep(100);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(300);
    await takeStepScreenshot(page, "step_4_reason_opened.png", "reason dropdown reopened");
  } catch (err) {
    await takeStepScreenshot(page, "step_4_reason_opened_failed.png", "reason dropdown reopen failed");
    throw err;
  }

  // Phase B: open-state gate — verify popup/listbox-like content appears.
  const openState = await page.evaluate(() => {
    const hints = [...document.querySelectorAll("body *")].filter((el) => {
      const txt = (el.textContent || "").trim();
      return txt.includes("Forgot To Punch") || txt.includes("Machine Not Working") || txt.includes("Work From Home");
    }).map((el) => {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return {
        tag: el.tagName,
        visible: r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden",
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        text: (el.textContent || "").trim().slice(0, 80)
      };
    });
    return hints.slice(0, 30);
  });
  console.log(`   🧭 Open-state hints count: ${openState.length}`);
  openState.forEach((h, i) => console.log(`      [open ${i}] ${h.tag} vis=${h.visible} rect=${JSON.stringify(h.rect)} text="${h.text}"`));

  const optionDiagnostics = await page.evaluate(() => {
    const hits = [];
    const walk = (root, path) => {
      const els = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const el of els) {
        const text = (el.textContent || "").trim();
        if (text.includes("Forgot To Punch")) {
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          hits.push({
            path,
            tag: el.tagName,
            text,
            visible: r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none",
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
          });
        }
        if (el.shadowRoot) walk(el.shadowRoot, `${path}>${el.tagName}#shadow`);
      }
    };
    walk(document, "document");
    return hits.slice(0, 20);
  });
  console.log(`   🧭 'Forgot To Punch' diagnostic hits: ${optionDiagnostics.length}`);
  optionDiagnostics.forEach((h, i) => console.log(`      [${i}] ${h.tag} vis=${h.visible} rect=${JSON.stringify(h.rect)} path=${h.path}`));
  let optionHits = optionDiagnostics;
  for (let i = 0; i < 3 && optionHits.length === 0; i++) {
    await sleep(300);
    optionHits = await page.evaluate(() => {
      const hits = [];
      const walk = (root) => {
        const els = root.querySelectorAll ? root.querySelectorAll("*") : [];
        for (const el of els) {
          const text = (el.textContent || "").trim();
          if (text.includes("Forgot To Punch")) {
            const r = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            if (r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none") {
              hits.push(true);
            }
          }
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      return hits;
    });
  }
  if (optionHits.length === 0) {
    await takeStepScreenshot(page, "reason_open_state_no_options.png", "no options rendered");
    // Continue anyway: some builds render text lazily but click still works.
    console.log("   ⚠️ Open-state gate inconclusive; continuing with option click fallback");
  }

  // Step 2: strict option selection from visible list.
  try {
    const option = page.getByText("Forgot To Punch", { exact: true }).first();
    await option.waitFor({ state: "visible", timeout: 4000 });
    await option.click({ timeout: 4000 });
    await sleep(400);
    await takeStepScreenshot(page, "step_5_option_clicked.png", "forgot to punch clicked");
  } catch (err) {
    await takeStepScreenshot(page, "step_5_option_clicked_failed.png", "forgot to punch click failed");
    throw err;
  }

  // Step 4: verify via confirmed shadow DOM chain.
  await sleep(300);

  // Verify via confirmed shadow DOM chain
  const selected = await page.evaluate(() => {
    try {
      return document.querySelector("dbx-ds-modal")
        .querySelectorAll("dbx-ds-dropdown")[1]
        .shadowRoot.querySelector("dbx-internal-dropdown")
        .shadowRoot.querySelector("dbx-dropdown-head")
        .shadowRoot.querySelector("#dbx-overflow-span span")
        .innerText.trim();
    } catch (e) { return "error: " + e.message; }
  });

  console.log(`   🔍 Reason selected: "${selected}"`);
  await takeStepScreenshot(page, "step_6_reason_selected.png", `selection value=${selected}`);
  if (selected === "Select Reason" || selected.startsWith("error")) {
    await takeStepScreenshot(page, "reason_selection_verification_failed.png", "selection verification failed");
    await takeStepScreenshot(page, "step_6_reason_selected_failed.png", `bad selection value=${selected}`);
    throw new Error(`Reason not selected — shows "${selected}"`);
  }
}

async function clickSubmit(page) {
  // Submit is the last dbx-ds-button in the modal footer shadow root
  try {
    const box = await page.evaluate(() => {
      const btns = document.querySelector("dbx-ds-modal").shadowRoot.querySelectorAll(".footer dbx-ds-button");
      const r    = btns[btns.length - 1].getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(3000);
    await takeStepScreenshot(page, "step_7_submitted.png", "submitted");
    console.log(`   ✅ Submitted`);
  } catch (err) {
    await takeStepScreenshot(page, "step_7_submitted_failed.png", "submit failed");
    throw err;
  }
}

// ─── Per-date orchestration (with retry) ─────────────────────────────────────

async function attemptDate(page, date) {
  const btn = await openContextMenu(page, date);
  await selectTimeCorrectionItem(page, btn);
  await selectReason(page);
  await clickSubmit(page);
}

async function processDate(page, date, reloadView) {
  console.log(`\n📝 Processing: ${date}`);

  let succeeded = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`   🔄 Retry attempt ${attempt}...`);
        await reloadView();
      }
      await attemptDate(page, date);
      succeeded = true;
      break;
    } catch (err) {
      console.warn(`   ⚠️ Attempt ${attempt} failed: ${err.message}`);
      await page.screenshot({ path: `error_${date}_attempt${attempt}.png` });
      try { await page.keyboard.press("Escape"); } catch (_) {}
      await sleep(500);
    }
  }

  // Reload and verify regardless of outcome
  await reloadView();

  if (succeeded) {
    const verified = await verifySubmission(page, date);
    if (!verified) {
      await page.screenshot({ path: `unverified_${date}.png` });
    }
  } else {
    console.warn(`   ❌ All attempts failed for ${date}`);
  }

  return succeeded;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function regularizeAttendance(page) {
  const dayOfMonth = new Date().getDate();
  const monthContexts = (dayOfMonth >= 1 && dayOfMonth <= 4)
    ? ["previous", "current"]
    : ["current"];

  const overall = { succeeded: [], failed: [] };

  for (const monthContext of monthContexts) {
    const reloadForContext = () => reloadInMonthContext(page, monthContext);

    console.log("\n" + "=".repeat(60));
    console.log(`📆 Month context: ${monthContext.toUpperCase()}`);
    console.log("=".repeat(60));

    await reloadForContext();
  await page.screenshot({ path: "list_view.png" });

    const absentDates = await findAbsentDates(page);

    if (absentDates.length === 0) {
      console.log(`✅ No absent days to regularize in ${monthContext} month view`);
      continue;
    }

    console.log("─".repeat(50));
    console.log(`📋 ${absentDates.length} absent day(s) to regularize (${monthContext}):`);
    absentDates.forEach((d, i) => console.log(`   ${i + 1}. ${d}`));
    console.log("─".repeat(50));

    const results = { succeeded: [], failed: [] };
    for (const date of absentDates) {
      const ok = await processDate(page, date, reloadForContext);
      (ok ? results.succeeded : results.failed).push(date);
    }

    overall.succeeded.push(...results.succeeded.map(d => `${d} (${monthContext})`));
    overall.failed.push(...results.failed.map(d => `${d} (${monthContext})`));

    console.log(`✅ ${monthContext} month succeeded (${results.succeeded.length}): ${results.succeeded.join(", ") || "none"}`);
    if (results.failed.length > 0) {
      console.warn(`❌ ${monthContext} month failed    (${results.failed.length}): ${results.failed.join(", ")}`);
    }
  }

  console.log("\n" + "─".repeat(50));
  console.log(`✅ Total succeeded (${overall.succeeded.length}): ${overall.succeeded.join(", ") || "none"}`);
  if (overall.failed.length > 0) {
    console.warn(`❌ Total failed    (${overall.failed.length}): ${overall.failed.join(", ")}`);
  } else {
    console.log("✅ Total failed    (0): none");
  }
  await page.screenshot({ path: "regularization_result.png" });
  return overall;
}

module.exports = { regularizeAttendance };
