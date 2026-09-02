// Approves all pending Consultant and Intern payments on consultantmgmt.onearvind.com.
// Auth: creates a separate browser context that handles the ADFS HTTP auth challenge
// using Arvind AD credentials (same DARWINBOX_USERNAME / DARWINBOX_PASSWORD).

const { USERNAME, PASSWORD } = require("./config");

const CONSULTANT_BASE = "https://consultantmgmt.onearvind.com";
const DASHBOARD_URL   = `${CONSULTANT_BASE}/Approver/ManagerDashboard`;
const DETAIL_TIMEOUT  = 20000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchPendingConsultants(page) {
  return page.evaluate(async () => {
    const resp = await fetch("/Approver/GetManagerPendingApproval/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "draw=1&start=0&length=1000",
    });
    const data = await resp.json();
    return data.data ?? data;
  });
}

async function fetchPendingInterns(page) {
  return page.evaluate(async () => {
    const resp = await fetch("/Approver/GetManagerPendingApprovalIntern/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "draw=1&start=0&length=1000",
    });
    const data = await resp.json();
    return data.data ?? data;
  });
}

// ─── Consultant approval ───────────────────────────────────────────────────────

async function approveConsultant(page, consultant) {
  const { PaymentID, EmpName, EmpNo, PaymentMonth, PaymentYear, TotalAmount } = consultant;

  console.log(`\n   🖊️  Approving consultant: ${EmpName} (PaymentID ${PaymentID})`);

  await page.goto(
    `${CONSULTANT_BASE}/Consultant/ConsultantEntry?PaymentID=${PaymentID}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#hdnDivID", { timeout: DETAIL_TIMEOUT });

  const divID = await page.evaluate(() => document.querySelector("#hdnDivID")?.value ?? "");
  if (!divID) throw new Error(`hdnDivID is empty for PaymentID ${PaymentID}`);

  const result = await page.evaluate(
    async ({ paymentID, divID }) => {
      const resp = await fetch("/Consultant/ApproveRejectRequest/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ PaymentID: String(paymentID), StatusID: 2, ConsultantDivisionID: divID, Remarks: "" }),
      });
      return { status: resp.status, body: await resp.text() };
    },
    { paymentID: PaymentID, divID }
  );

  if (result.status !== 200) {
    throw new Error(`Approval POST failed — HTTP ${result.status}: ${result.body.slice(0, 200)}`);
  }

  console.log(`   ✅ Approved: ${EmpName}`);
  return { type: "consultant", name: EmpName, empNo: EmpNo, paymentID: PaymentID, month: PaymentMonth, year: PaymentYear, netAmount: TotalAmount };
}

// ─── Intern approval ───────────────────────────────────────────────────────────

async function approveIntern(page, intern) {
  const { InternPaymentID, EmpName, EmpNo, PaymentMonth, PaymentYear, TotalAmount } = intern;

  console.log(`\n   🖊️  Approving intern: ${EmpName} (InternPaymentID ${InternPaymentID})`);

  await page.goto(
    `${CONSULTANT_BASE}/Consultant/InternPaymentEntry?InternPaymentID=${InternPaymentID}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#hdnDivID", { timeout: DETAIL_TIMEOUT });

  const { divID, remarks } = await page.evaluate(() => ({
    divID:   document.querySelector("#hdnDivID")?.value ?? "",
    remarks: document.querySelector("#txtRemarks")?.value ?? "",
  }));

  if (!divID) throw new Error(`hdnDivID is empty for InternPaymentID ${InternPaymentID}`);

  const result = await page.evaluate(
    async ({ internPaymentID, divID, remarks }) => {
      const resp = await fetch("/Consultant/ApproveRejectRequestIntern/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ InternPaymentID: String(internPaymentID), StatusID: 2, ConsultantDivisionID: divID, Remarks: remarks }),
      });
      return { status: resp.status, body: await resp.text() };
    },
    { internPaymentID: InternPaymentID, divID, remarks }
  );

  if (result.status !== 200) {
    throw new Error(`Intern approval POST failed — HTTP ${result.status}: ${result.body.slice(0, 200)}`);
  }

  console.log(`   ✅ Approved: ${EmpName}`);
  return { type: "intern", name: EmpName, empNo: EmpNo, paymentID: InternPaymentID, month: PaymentMonth, year: PaymentYear, netAmount: TotalAmount };
}

// ─── Main entry point ──────────────────────────────────────────────────────────

async function approveAllConsultants(page) {
  console.log("\n📋 Consultant & Intern Approvals");
  console.log("─".repeat(40));

  const result = {
    consultants: { approved: 0, failed: 0, records: [] },
    interns:     { approved: 0, failed: 0, records: [] },
  };

  if (!USERNAME || !PASSWORD) {
    console.error("❌ DARWINBOX_USERNAME / DARWINBOX_PASSWORD not set — skipping consultant approvals");
    return result;
  }

  // Create a dedicated browser context that auto-responds to the ADFS HTTP auth
  // challenge (adfs.arvind.in presents WWW-Authenticate: Negotiate/NTLM).
  const browser = page.context().browser();
  const context = await browser.newContext({
    httpCredentials: { username: USERNAME, password: PASSWORD },
  });
  const cPage = await context.newPage();

  try {
    console.log("   🔐 Navigating to consultant dashboard (ADFS auth)...");
    await cPage.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });

    // The ADFS WIA challenge is handled automatically by httpCredentials.
    // Wait for the dashboard indicator.
    await cPage.waitForSelector("#dvManagerPending", { timeout: 45000 });
    console.log("   ✅ Consultant dashboard loaded");

    // ── Consultants ──
    let pendingConsultants = [];
    try {
      pendingConsultants = await fetchPendingConsultants(cPage);
      console.log(`\n📌 Pending consultants: ${pendingConsultants.length}`);
    } catch (err) {
      console.error(`❌ Failed to fetch pending consultants: ${err.message}`);
    }

    for (const consultant of pendingConsultants) {
      try {
        const record = await approveConsultant(cPage, consultant);
        result.consultants.approved++;
        result.consultants.records.push(record);
      } catch (err) {
        console.error(`   ❌ Failed to approve ${consultant.EmpName}: ${err.message}`);
        result.consultants.failed++;
      }
    }

    // Reload dashboard for interns
    await cPage.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
    await cPage.waitForSelector("#dvManagerPending", { timeout: 45000 });

    // ── Interns ──
    let pendingInterns = [];
    try {
      pendingInterns = await fetchPendingInterns(cPage);
      console.log(`\n📌 Pending interns: ${pendingInterns.length}`);
    } catch (err) {
      console.error(`❌ Failed to fetch pending interns: ${err.message}`);
    }

    for (const intern of pendingInterns) {
      try {
        const record = await approveIntern(cPage, intern);
        result.interns.approved++;
        result.interns.records.push(record);
      } catch (err) {
        console.error(`   ❌ Failed to approve ${intern.EmpName}: ${err.message}`);
        result.interns.failed++;
      }
    }

  } catch (err) {
    console.error(`❌ Could not load consultant dashboard: ${err.message}`);
  } finally {
    await context.close();
  }

  console.log(`\n✅ Consultant approvals done — ${result.consultants.approved} approved, ${result.consultants.failed} failed`);
  console.log(`✅ Intern approvals done — ${result.interns.approved} approved, ${result.interns.failed} failed`);

  return result;
}

module.exports = { approveAllConsultants };
