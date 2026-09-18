// Sends end-of-run summary email when SMTP config is available.
const nodemailer = require("nodemailer");

function isEmail(v) {
  return typeof v === "string" && /.+@.+\..+/.test(v.trim());
}

function getRecipient() {
  const primary = process.env.DARWINBOX_USERNAME;
  if (isEmail(primary)) return primary.trim();
  const fallback = process.env.REPORT_EMAIL_TO;
  if (isEmail(fallback)) return fallback.trim();
  return null;
}

function monthName(m) {
  return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1] ?? m;
}

function fmtAmount(n) {
  return "₹" + Number(n).toLocaleString("en-IN");
}

function line(char = "═", len = 40) {
  return char.repeat(len);
}

function isAllGood({ loginError, summary, taskApprovals, consultantApprovals }) {
  if (loginError) return false;
  if (!summary || summary.error || (summary.failed && summary.failed.length > 0)) return false;
  if (!taskApprovals || taskApprovals.error) return false;
  if (!consultantApprovals || consultantApprovals.error) return false;
  return true;
}

function buildSubject(allGood) {
  const date = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  return allGood
    ? `[ALL GOOD] Darwinbox · ${date}`
    : `[PENDING] Darwinbox · ${date}`;
}

async function sendSummaryEmail({ loginError, summary, taskApprovals, consultantApprovals }) {
  const recipient = getRecipient();
  if (!recipient) {
    console.log("⚠️ Email skipped: no valid recipient in DARWINBOX_USERNAME/REPORT_EMAIL_TO");
    return;
  }

  const host   = process.env.SMTP_HOST;
  const port   = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
  const user   = process.env.SMTP_USER;
  const pass   = process.env.SMTP_PASS;
  const from   = process.env.SMTP_FROM || user;

  if (!host || !port || !user || !pass || !from) {
    console.log("⚠️ Email skipped: missing SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM");
    return;
  }

  const date    = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const allGood = isAllGood({ loginError, summary, taskApprovals, consultantApprovals });
  const subject = buildSubject(allGood);

  // ── Login ──
  const loginBlock = loginError
    ? `LOGIN\n  ❌ Failed: ${loginError}`
    : `LOGIN\n  ✅ Success`;

  // ── Attendance ──
  let attendanceBlock;
  if (loginError) {
    attendanceBlock = `ATTENDANCE\n  - did not run (login failed)`;
  } else if (!summary) {
    attendanceBlock = `ATTENDANCE\n  - did not run`;
  } else if (summary.error) {
    attendanceBlock = `ATTENDANCE\n  ❌ Error: ${summary.error}`;
  } else {
    const regularizedDates = summary.succeeded || [];
    const pendingDates     = summary.failed || [];
    attendanceBlock = [
      `ATTENDANCE`,
      `  Regularized : ${regularizedDates.length} dates`,
      `  Pending     : ${pendingDates.length} dates` + (pendingDates.length ? ` (${pendingDates.join(", ")})` : ""),
    ].join("\n");
  }

  // ── Leave ──
  let leaveBlock;
  if (loginError || !taskApprovals) {
    leaveBlock = `LEAVE APPROVALS\n  - did not run`;
  } else if (taskApprovals.error) {
    leaveBlock = `LEAVE APPROVALS\n  ❌ Error: ${taskApprovals.error}`;
  } else {
    const leaveApproved = taskApprovals?.leave?.approved ?? null;
    const leaveRecords  = taskApprovals?.leave?.records ?? [];
    leaveBlock = [
      `LEAVE APPROVALS`,
      `  Approved : ${leaveApproved ?? "not run"}`,
      ...(leaveRecords.length ? leaveRecords.map((r) => `  - ${r}`) : ["  - none"]),
    ].join("\n");
  }

  // ── Time Correction ──
  let tcBlock;
  if (loginError || !taskApprovals) {
    tcBlock = `TIME CORRECTIONS\n  - did not run`;
  } else if (taskApprovals.error) {
    tcBlock = `TIME CORRECTIONS\n  ❌ Error: ${taskApprovals.error}`;
  } else {
    const tcApproved = taskApprovals?.timeCorrection?.approved ?? null;
    const tcRecords  = taskApprovals?.timeCorrection?.records ?? [];
    tcBlock = [
      `TIME CORRECTIONS`,
      `  Approved : ${tcApproved ?? "not run"}`,
      ...(tcRecords.length ? tcRecords.map((r) => `  - ${r}`) : ["  - none"]),
    ].join("\n");
  }

  // ── Optional Holiday ──
  let ohBlock;
  if (loginError || !taskApprovals) {
    ohBlock = `OPTIONAL HOLIDAY REQUESTS\n  - did not run`;
  } else if (taskApprovals.error) {
    ohBlock = `OPTIONAL HOLIDAY REQUESTS\n  ❌ Error: ${taskApprovals.error}`;
  } else {
    const ohApproved = taskApprovals?.optionalHoliday?.approved ?? null;
    const ohRecords  = taskApprovals?.optionalHoliday?.records ?? [];
    ohBlock = [
      `OPTIONAL HOLIDAY REQUESTS`,
      `  Approved : ${ohApproved ?? "not run"}`,
      ...(ohRecords.length ? ohRecords.map((r) => `  - ${r}`) : ["  - none"]),
    ].join("\n");
  }

  // ── Consultants ──
  let consultantBlock;
  if (loginError || !consultantApprovals) {
    consultantBlock = `CONSULTANT PAYMENTS\n  - did not run`;
  } else if (consultantApprovals.error) {
    consultantBlock = `CONSULTANT PAYMENTS\n  ❌ Error: ${consultantApprovals.error}`;
  } else {
    const cApproved = consultantApprovals?.consultants?.approved ?? null;
    const cRecords  = consultantApprovals?.consultants?.records ?? [];
    consultantBlock = [
      `CONSULTANT PAYMENTS`,
      `  Approved : ${cApproved ?? "not run"}`,
      ...(cRecords.length
        ? cRecords.map((r) => `  - ${r.name} (${r.empNo}) | ${monthName(r.month)} ${r.year} | ${fmtAmount(r.netAmount)}`)
        : ["  - none"]),
    ].join("\n");
  }

  // ── Interns ──
  let internBlock;
  if (loginError || !consultantApprovals) {
    internBlock = `INTERN PAYMENTS\n  - did not run`;
  } else if (consultantApprovals.error) {
    internBlock = `INTERN PAYMENTS\n  ❌ Error: ${consultantApprovals.error}`;
  } else {
    const iApproved = consultantApprovals?.interns?.approved ?? null;
    const iRecords  = consultantApprovals?.interns?.records ?? [];
    internBlock = [
      `INTERN PAYMENTS`,
      `  Approved : ${iApproved ?? "not run"}`,
      ...(iRecords.length
        ? iRecords.map((r) => `  - ${r.name} (${r.empNo}) | ${monthName(r.month)} ${r.year} | ${fmtAmount(r.netAmount)}`)
        : ["  - none"]),
    ].join("\n");
  }

  const text = [
    `DARWINBOX AUTOMATION · ${date}`,
    line(),
    ``,
    loginBlock,
    ``,
    attendanceBlock,
    ``,
    leaveBlock,
    ``,
    tcBlock,
    ``,
    ohBlock,
    ``,
    consultantBlock,
    ``,
    internBlock,
    ``,
    line(),
    `Darwinbox Automation`,
  ].join("\n");

  const transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });

  try {
    await transporter.sendMail({ from, to: recipient, subject, text });
    console.log(`📧 Summary email sent to ${recipient}`);
  } catch (err) {
    console.log(`⚠️ Email send failed (non-fatal): ${err.message}`);
  }
}

module.exports = { sendSummaryEmail };
