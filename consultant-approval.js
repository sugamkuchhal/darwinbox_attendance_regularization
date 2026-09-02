// Approves all pending Consultant and Intern payments on consultantmgmt.onearvind.com.
// Uses the same MS SSO session already established by login() — no separate login needed.

const CONSULTANT_BASE = "https://consultantmgmt.onearvind.com";
const DASHBOARD_URL = `${CONSULTANT_BASE}/Approver/ManagerDashboard`;
const DASHBOARD_LOAD_TIMEOUT_MS = 20000;
const DETAIL_LOAD_TIMEOUT_MS = 15000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureDashboard(page) {
  await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });

  // ADFS SSO for a new SP redirects through a form-POST chain.
  // Poll until we land on the dashboard, handling any "Stay signed in?" prompt.
  const deadline = Date.now() + 60000; // 60s total budget

  while (Date.now() < deadline) {
    // Already on dashboard?
    const onDashboard = await page.$("#dvManagerPending").catch(() => null);
    if (onDashboard) break;

    // "Stay signed in?" — same prompt as Darwinbox login flow
    const stayBtn = await page
      .$('input[value="Yes"], button:has-text("Yes")')
      .catch(() => null);
    if (stayBtn) {
      console.log("   🔐 ADFS 'Stay signed in?' — clicking Yes");
      await stayBtn.click().catch(() => {});
      await page
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 })
        .catch(() => {});
      continue;
    }

    await page.waitForTimeout(1000);
  }

  // Final authoritative check with a short timeout
  await page.waitForSelector("#dvManagerPending", { timeout: 10000 });
  console.log("   ✅ Consultant dashboard loaded");
}

async function fetchPendingConsultants(page) {
  return page.evaluate(async () => {
    const resp = await fetch("/Approver/GetManagerPendingApproval/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "draw=1&start=0&length=1000",
    });
    return resp.json();
  });
}

async function fetchPendingInterns(page) {
  return page.evaluate(async () => {
    const resp = await fetch("/Approver/GetManagerPendingApprovalIntern/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "draw=1&start=0&length=1000",
    });
    return resp.json();
  });
}

// ─── Consultant approval ───────────────────────────────────────────────────────

async function approveConsultant(page, consultant) {
  const { PaymentID, EmpName, EmpNo, PaymentMonth, PaymentYear, TotalAmount } = consultant;

  console.log(`\n   🖊️  Approving consultant: ${EmpName} (PaymentID ${PaymentID})`);

  // Navigate to detail page — DivisionID lives there as a hidden input.
  await page.goto(
    `${CONSULTANT_BASE}/Consultant/ConsultantEntry?PaymentID=${PaymentID}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#hdnDivID", { timeout: DETAIL_LOAD_TIMEOUT_MS });

  const divID = await page.evaluate(
    () => document.querySelector("#hdnDivID")?.value ?? ""
  );

  if (!divID) {
    throw new Error(`hdnDivID is empty for PaymentID ${PaymentID}`);
  }

  const result = await page.evaluate(
    async ({ paymentID, divID }) => {
      const resp = await fetch("/Consultant/ApproveRejectRequest/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          PaymentID: String(paymentID),
          StatusID: 2,
          ConsultantDivisionID: divID,
          Remarks: "",
        }),
      });
      return { status: resp.status, body: await resp.text() };
    },
    { paymentID: PaymentID, divID }
  );

  if (result.status !== 200) {
    throw new Error(
      `Approval POST failed — HTTP ${result.status}: ${result.body.slice(0, 200)}`
    );
  }

  console.log(`   ✅ Approved: ${EmpName}`);
  return {
    type: "consultant",
    name: EmpName,
    empNo: EmpNo,
    paymentID: PaymentID,
    month: PaymentMonth,
    year: PaymentYear,
    netAmount: TotalAmount,
  };
}

// ─── Intern approval ───────────────────────────────────────────────────────────

async function approveIntern(page, intern) {
  const { InternPaymentID, EmpName, EmpNo, PaymentMonth, PaymentYear, TotalAmount } = intern;

  console.log(`\n   🖊️  Approving intern: ${EmpName} (InternPaymentID ${InternPaymentID})`);

  await page.goto(
    `${CONSULTANT_BASE}/Consultant/InternPaymentEntry?InternPaymentID=${InternPaymentID}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#hdnDivID", { timeout: DETAIL_LOAD_TIMEOUT_MS });

  // Read both DivisionID and the pre-populated Remarks from the form.
  const { divID, remarks } = await page.evaluate(() => ({
    divID: document.querySelector("#hdnDivID")?.value ?? "",
    remarks: document.querySelector("#txtRemarks")?.value ?? "",
  }));

  if (!divID) {
    throw new Error(`hdnDivID is empty for InternPaymentID ${InternPaymentID}`);
  }

  const result = await page.evaluate(
    async ({ internPaymentID, divID, remarks }) => {
      const resp = await fetch("/Consultant/ApproveRejectRequestIntern/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          InternPaymentID: String(internPaymentID),
          StatusID: 2,
          ConsultantDivisionID: divID,
          Remarks: remarks,
        }),
      });
      return { status: resp.status, body: await resp.text() };
    },
    { internPaymentID: InternPaymentID, divID, remarks }
  );

  if (result.status !== 200) {
    throw new Error(
      `Intern approval POST failed — HTTP ${result.status}: ${result.body.slice(0, 200)}`
    );
  }

  console.log(`   ✅ Approved: ${EmpName}`);
  return {
    type: "intern",
    name: EmpName,
    empNo: EmpNo,
    paymentID: InternPaymentID,
    month: PaymentMonth,
    year: PaymentYear,
    netAmount: TotalAmount,
  };
}

// ─── Main entry point ──────────────────────────────────────────────────────────

async function approveAllConsultants(page) {
  console.log("\n📋 Consultant & Intern Approvals");
  console.log("─".repeat(40));

  const result = {
    consultants: { approved: 0, failed: 0, records: [] },
    interns: { approved: 0, failed: 0, records: [] },
  };

  try {
    await ensureDashboard(page);
  } catch (err) {
    console.error(`❌ Could not load consultant dashboard: ${err.message}`);
    return result;
  }

  // ── Consultants ──
  let pendingConsultants = [];
  try {
    pendingConsultants = await fetchPendingConsultants(page);
    console.log(`\n📌 Pending consultants: ${pendingConsultants.length}`);
  } catch (err) {
    console.error(`❌ Failed to fetch pending consultants: ${err.message}`);
  }

  for (const consultant of pendingConsultants) {
    try {
      const record = await approveConsultant(page, consultant);
      result.consultants.approved++;
      result.consultants.records.push(record);
    } catch (err) {
      console.error(`   ❌ Failed to approve ${consultant.EmpName}: ${err.message}`);
      result.consultants.failed++;
    }
  }

  // Navigate back to dashboard before fetching interns
  // (detail page navigation leaves us off the consultant domain context)
  try {
    await ensureDashboard(page);
  } catch (err) {
    console.error(`❌ Could not reload dashboard for interns: ${err.message}`);
    return result;
  }

  // ── Interns ──
  let pendingInterns = [];
  try {
    pendingInterns = await fetchPendingInterns(page);
    console.log(`\n📌 Pending interns: ${pendingInterns.length}`);
  } catch (err) {
    console.error(`❌ Failed to fetch pending interns: ${err.message}`);
  }

  for (const intern of pendingInterns) {
    try {
      const record = await approveIntern(page, intern);
      result.interns.approved++;
      result.interns.records.push(record);
    } catch (err) {
      console.error(`   ❌ Failed to approve ${intern.EmpName}: ${err.message}`);
      result.interns.failed++;
    }
  }

  console.log(
    `\n✅ Consultant approvals done — ${result.consultants.approved} approved, ${result.consultants.failed} failed`
  );
  console.log(
    `✅ Intern approvals done — ${result.interns.approved} approved, ${result.interns.failed} failed`
  );

  return result;
}

module.exports = { approveAllConsultants };
