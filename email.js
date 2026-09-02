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

function buildSubject(pendingCount) {
  const prefix = pendingCount === 0 ? "[ALL GOOD]" : "[PENDING]";
  const date = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  return pendingCount === 0 ? `${prefix} Darwinbox · ${date}` : `${prefix} Darwinbox · ${date} (${pendingCount} unresolved)`;
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

async function sendRegularizationEmail(summary, taskApprovals = null, consultantApprovals = null) {
  const recipient = getRecipient();
  if (!recipient) {
    console.log("⚠️ Email skipped: no valid recipient in DARWINBOX_USERNAME/REPORT_EMAIL_TO");
    return;
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !port || !user || !pass || !from) {
    console.log("⚠️ Email skipped: missing SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM");
    return;
  }

  const pendingDates = summary.failed || [];
  const regularizedDates = summary.succeeded || [];
  const pendingCount = pendingDates.length;

  const date = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const subject = buildSubject(pendingCount);

  // ── Attendance ──
  const attendanceBlock = [
    `ATTENDANCE`,
    `  Regularized : ${regularizedDates.length} dates`,
    `  Pending     : ${pendingCount} dates` + (pendingDates.length ? ` (${pendingDates.join(", ")})` : ""),
  ].join("\n");

  // ── Leave ──
  const leaveApproved = taskApprovals?.leave?.approved ?? null;
  const leaveRecords = taskApprovals?.leave?.records ?? [];
  const leaveBlock = [
    `LEAVE APPROVALS`,
    `  Approved : ${leaveApproved ?? "not run"}`,
    ...(leaveRecords.length ? leaveRecords.map((r) => `  - ${r}`) : ["  - none"]),
  ].join("\n");

  // ── Time Correction ──
  const tcApproved = taskApprovals?.timeCorrection?.approved ?? null;
  const tcRecords = taskApprovals?.timeCorrection?.records ?? [];
  const tcBlock = [
    `TIME CORRECTIONS`,
    `  Approved : ${tcApproved ?? "not run"}`,
    ...(tcRecords.length ? tcRecords.map((r) => `  - ${r}`) : ["  - none"]),
  ].join("\n");

  // ── Consultants ──
  const cApproved = consultantApprovals?.consultants?.approved ?? null;
  const cRecords = consultantApprovals?.consultants?.records ?? [];
  const consultantBlock = [
    `CONSULTANT PAYMENTS`,
    `  Approved : ${cApproved ?? "not run"}`,
    ...(cRecords.length
      ? cRecords.map((r) => `  - ${r.name} (${r.empNo}) | ${monthName(r.month)} ${r.year} | ${fmtAmount(r.netAmount)}`)
      : ["  - none"]),
  ].join("\n");

  // ── Interns ──
  const iApproved = consultantApprovals?.interns?.approved ?? null;
  const iRecords = consultantApprovals?.interns?.records ?? [];
  const internBlock = [
    `INTERN PAYMENTS`,
    `  Approved : ${iApproved ?? "not run"}`,
    ...(iRecords.length
      ? iRecords.map((r) => `  - ${r.name} (${r.empNo}) | ${monthName(r.month)} ${r.year} | ${fmtAmount(r.netAmount)}`)
      : ["  - none"]),
  ].join("\n");

  const text = [
    `DARWINBOX AUTOMATION · ${date}`,
    line(),
    ``,
    attendanceBlock,
    ``,
    leaveBlock,
    ``,
    tcBlock,
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

module.exports = { sendRegularizationEmail };
