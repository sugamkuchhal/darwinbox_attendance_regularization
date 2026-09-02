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
  const date = new Date().toISOString().slice(0, 10);
  return `${prefix} Darwinbox regularization summary (${date})`;
}

function monthName(m) {
  return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1] ?? m;
}

function fmtAmount(n) {
  return "₹" + Number(n).toLocaleString("en-IN");
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

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  const subject = buildSubject(pendingCount);

  const leaveLines = taskApprovals?.leave
    ? taskApprovals.leave.approved === 0
      ? ["- none"]
      : taskApprovals.leave.records.map((r) => `- ${r}`)
    : ["- not run"];

  const tcLines = taskApprovals?.timeCorrection
    ? taskApprovals.timeCorrection.approved === 0
      ? ["- none"]
      : taskApprovals.timeCorrection.records.map((r) => `- ${r}`)
    : ["- not run"];

  const consultantLines = consultantApprovals?.consultants?.approved > 0
    ? consultantApprovals.consultants.records.map(
        (r) => `- ${r.name} (Emp ${r.empNo}) | Payment ID ${r.paymentID} | ${monthName(r.month)} ${r.year} | Net ${fmtAmount(r.netAmount)}`
      )
    : ["- none"];

  const internLines = consultantApprovals?.interns?.approved > 0
    ? consultantApprovals.interns.records.map(
        (r) => `- ${r.name} (Emp ${r.empNo}) | Payment ID ${r.paymentID} | ${monthName(r.month)} ${r.year} | Net ${fmtAmount(r.netAmount)}`
      )
    : ["- none"];

  const text = [
    `Hello,`,
    ``,
    `Attendance regularization run is complete.`,
    ``,
    `Regularized (${regularizedDates.length}):`,
    regularizedDates.length ? regularizedDates.map((d) => `- ${d}`).join("\n") : "- none",
    ``,
    `Pending (${pendingCount}):`,
    pendingDates.length ? pendingDates.map((d) => `- ${d}`).join("\n") : "- none",
    ``,
    `Leave requests approved (${taskApprovals?.leave?.approved ?? 0}):`,
    leaveLines.join("\n"),
    ``,
    `Time corrections approved (${taskApprovals?.timeCorrection?.approved ?? 0}):`,
    tcLines.join("\n"),
    ``,
    `Consultant payments approved (${consultantApprovals?.consultants?.approved ?? "not run"}):`,
    consultantLines.join("\n"),
    ``,
    `Intern payments approved (${consultantApprovals?.interns?.approved ?? "not run"}):`,
    internLines.join("\n"),
    ``,
    `Regards,`,
    `Darwinbox Automation`
  ].join("\n");

  try {
    await transporter.sendMail({ from, to: recipient, subject, text });
    console.log(`📧 Summary email sent to ${recipient}`);
  } catch (err) {
    console.log(`⚠️ Email send failed (non-fatal): ${err.message}`);
  }
}

module.exports = { sendRegularizationEmail };
