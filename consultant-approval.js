// Approves all pending Consultant and Intern payments on consultantmgmt.onearvind.com.
//
// Auth flow: onearvind.com → ADFS forms login → consultantmgmt root → dashboard
// Detail pages must be reached by clicking from dashboard (direct goto → /Home/UnAuthorized)

const { USERNAME, PASSWORD } = require("./config");

const CONSULTANT_BASE = "https://consultantmgmt.onearvind.com";
const DASHBOARD_URL   = `${CONSULTANT_BASE}/Approver/ManagerDashboard`;
const NAV_TIMEOUT     = 60000;
const DETAIL_TIMEOUT  = 20000;

async function loadDashboard(page) {
  await page.goto(DASHBOARD_URL, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
  await page.waitForSelector("#dvManagerPending", { timeout: 30000 });
}

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

async function approveConsultant(page, consultant) {
  const { PaymentID, EmpName, EmpNo, PaymentMonth, PaymentYear, TotalAmount } = consultant;
  console.log(`   🖊️  ${EmpName} (PaymentID ${PaymentID})`);

  await loadDashboard(page);
  await page.click(`a[href*="PaymentID=${PaymentID}"]`);

  await page.waitForSelector("#hdnDivID", { state: "attached", timeout: DETAIL_TIMEOUT });
  await page.waitForFunction(
    () => (document.querySelector("#hdnDivID")?.value ?? "") !== "",
    { timeout: DETAIL_TIMEOUT }
  );

  const divID = await page.$eval("#hdnDivID", el => el.value);
  if (!divID) throw new Error(`hdnDivID empty for PaymentID ${PaymentID}`);

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

  if (result.status !== 200)
    throw new Error(`Approval POST failed — HTTP ${result.status}: ${result.body.slice(0, 200)}`);

  console.log(`   ✅ ${EmpName}`);
  return { type: "consultant", name: EmpName, empNo: EmpNo, paymentID: PaymentID, month: PaymentMonth, year: PaymentYear, netAmount: TotalAmount };
}

async function approveIntern(page, intern) {
  const { InternPaymentID, EmpName, EmpNo, PaymentMonth, PaymentYear, TotalAmount } = intern;
  console.log(`   🖊️  ${EmpName} (InternPaymentID ${InternPaymentID})`);

  await loadDashboard(page);
  await page.click(`a[href*="InternPaymentID=${InternPaymentID}"]`);

  await page.waitForSelector("#hdnDivID", { state: "attached", timeout: DETAIL_TIMEOUT });
  await page.waitForFunction(
    () => (document.querySelector("#hdnDivID")?.value ?? "") !== "",
    { timeout: DETAIL_TIMEOUT }
  );

  const { divID, remarks } = await page.evaluate(() => ({
    divID:   document.querySelector("#hdnDivID")?.value ?? "",
    remarks: document.querySelector("#txtRemarks")?.value ?? "",
  }));
  if (!divID) throw new Error(`hdnDivID empty for InternPaymentID ${InternPaymentID}`);

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

  if (result.status !== 200)
    throw new Error(`Intern approval POST failed — HTTP ${result.status}: ${result.body.slice(0, 200)}`);

  console.log(`   ✅ ${EmpName}`);
  return { type: "intern", name: EmpName, empNo: EmpNo, paymentID: InternPaymentID, month: PaymentMonth, year: PaymentYear, netAmount: TotalAmount };
}

async function approveAllConsultants(page) {
  const result = {
    consultants: { approved: 0, failed: 0, records: [] },
    interns:     { approved: 0, failed: 0, records: [] },
  };

  if (!USERNAME || !PASSWORD) {
    console.error("❌ DARWINBOX_USERNAME / DARWINBOX_PASSWORD not set — skipping");
    return result;
  }

  const browser = page.context().browser();
  const context = await browser.newContext();
  const cPage = await context.newPage();

  try {
    console.log("   🔐 Logging in via ADFS...");
    await cPage.goto("https://onearvind.com", { waitUntil: "domcontentloaded" });

    if (cPage.url().includes("adfs.arvind.in")) {
      await cPage.waitForSelector("#userNameInput", { timeout: 10000 });
      await cPage.fill("#userNameInput", USERNAME);
      await cPage.fill("#passwordInput", PASSWORD);
      await cPage.click("#submitButton");
      await cPage.waitForURL("**/onearvind.com/**", { timeout: 30000 });
    }

    await cPage.goto(CONSULTANT_BASE + "/", { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
    await loadDashboard(cPage);

    let pendingConsultants = [];
    let pendingInterns = [];

    try {
      pendingConsultants = await fetchPendingConsultants(cPage);
      console.log(`   📌 Pending consultants: ${pendingConsultants.length}`);
    } catch (err) {
      console.error(`   ❌ Failed to fetch pending consultants: ${err.message}`);
    }

    try {
      pendingInterns = await fetchPendingInterns(cPage);
      console.log(`   📌 Pending interns: ${pendingInterns.length}`);
    } catch (err) {
      console.error(`   ❌ Failed to fetch pending interns: ${err.message}`);
    }

    for (const consultant of pendingConsultants) {
      try {
        const record = await approveConsultant(cPage, consultant);
        result.consultants.approved++;
        result.consultants.records.push(record);
      } catch (err) {
        console.error(`   ❌ ${consultant.EmpName}: ${err.message}`);
        result.consultants.failed++;
      }
    }

    for (const intern of pendingInterns) {
      try {
        const record = await approveIntern(cPage, intern);
        result.interns.approved++;
        result.interns.records.push(record);
      } catch (err) {
        console.error(`   ❌ ${intern.EmpName}: ${err.message}`);
        result.interns.failed++;
      }
    }

  } catch (err) {
    console.error(`   ❌ Could not complete approvals: ${err.message}`);
  } finally {
    await context.close();
  }

  console.log(`   ✅ Consultants: ${result.consultants.approved} approved, ${result.consultants.failed} failed`);
  console.log(`   ✅ Interns: ${result.interns.approved} approved, ${result.interns.failed} failed`);

  return result;
}

module.exports = { approveAllConsultants };
