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

// Playwright errors carry a multi-line "logs" block and full URLs. URLs get
// rewritten by Outlook SafeLinks (which also leaks the recipient address into
// the body), so keep the first line only and strip links.
function cleanErr(msg) {
  if (!msg) return "unknown error";
  return String(msg)
    .split("\n")[0]
    .replace(/https?:\/\/\S+/g, "<link>")
    .trim()
    .slice(0, 180);
}

function isAllGood({ loginError, summary, taskApprovals, consultantApprovals }) {
  if (loginError) return false;
  if (!summary || summary.error || (summary.failed && summary.failed.length > 0)) return false;
  if (!taskApprovals || taskApprovals.error) return false;
  if (!consultantApprovals || consultantApprovals.error) return false;
  if (consultantApprovals.loginOk === false) return false;
  const buckets = [
    taskApprovals.leave, taskApprovals.timeCorrection, taskApprovals.optionalHoliday,
    consultantApprovals.consultants, consultantApprovals.interns,
  ];
  if (buckets.some((b) => b && b.failed > 0)) return false;
  return true;
}

// Renders one approval section: count, records, and any failures.
function approvalBlock(title, bucket, unavailable, fmt) {
  if (unavailable) return `${title}\n  ${unavailable}`;
  const approved = bucket?.approved ?? null;
  const records  = bucket?.records ?? [];
  const failures = bucket?.failedRecords ?? [];
  const failed   = bucket?.failed ?? 0;
  const lines = [title, `  Approved : ${approved ?? "not run"}`];
  if (records.length) records.forEach((r) => lines.push(`  - ${fmt ? fmt(r) : r}`));
  else lines.push("  - none");
  if (failed > 0) {
    lines.push(`  Failed   : ${failed}`);
    (failures.length ? failures : ["(see run log)"]).forEach((r) => lines.push(`  ! ${cleanErr(r)}`));
  }
  return lines.join("\n");
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

  // ── Per-system sign-in status (each system logs in separately) ──
  const dbxLogin = loginError
    ? `  \u274c Sign-in failed: ${cleanErr(loginError)}`
    : `  \u2705 Signed in (Microsoft SSO)`;

  let oaLogin;
  if (loginError || !consultantApprovals) {
    oaLogin = `  -  did not run`;
  } else if (consultantApprovals.loginOk) {
    oaLogin = `  \u2705 Signed in`;
  } else {
    oaLogin = `  \u274c Sign-in failed: ${cleanErr(
      consultantApprovals.loginError || consultantApprovals.error
    )}`;
  }

  // ── Attendance ──
  let attendanceBlock;
  if (loginError) {
    attendanceBlock = `ATTENDANCE\n  - did not run (login failed)`;
  } else if (!summary) {
    attendanceBlock = `ATTENDANCE\n  - did not run`;
  } else if (summary.error) {
    attendanceBlock = `ATTENDANCE\n  ❌ Error: ${cleanErr(summary.error)}`;
  } else {
    const regularizedDates = summary.succeeded || [];
    const pendingDates     = summary.failed || [];
    const months           = summary.monthContexts || [];

    const lines = [`ATTENDANCE`];
    if (months.length) lines.push(`  Checked     : ${months.join(" + ")} month`);
    lines.push(`  Regularized : ${regularizedDates.length}`);
    regularizedDates.forEach((d) => lines.push(`      - ${d}`));
    lines.push(`  Pending     : ${pendingDates.length}`);
    pendingDates.forEach((d) => lines.push(`      - ${d}`));
    attendanceBlock = lines.join("\n");
  }

  // ── Approval sections ──
  const taskGone = loginError ? "- did not run (login failed)"
                 : !taskApprovals ? "- did not run"
                 : taskApprovals.error ? `❌ Error: ${cleanErr(taskApprovals.error)}` : null;

  const payGone = loginError ? "- did not run (login failed)"
                : !consultantApprovals ? "- did not run"
                : consultantApprovals.error ? `❌ Error: ${cleanErr(consultantApprovals.error)}` : null;

  const payFmt = (r) =>
    `${r.name} (${r.empNo}) | ${monthName(r.month)} ${r.year} | ${fmtAmount(r.netAmount)}`;

  const leaveBlock      = approvalBlock("LEAVE APPROVALS", taskApprovals?.leave, taskGone);
  const tcBlock         = approvalBlock("TIME CORRECTIONS", taskApprovals?.timeCorrection, taskGone);
  const ohBlock         = approvalBlock("OPTIONAL HOLIDAY REQUESTS", taskApprovals?.optionalHoliday, taskGone);
  const consultantBlock = approvalBlock("CONSULTANT PAYMENTS", consultantApprovals?.consultants, payGone, payFmt);
  const internBlock     = approvalBlock("INTERN PAYMENTS", consultantApprovals?.interns, payGone, payFmt);

  const text = [
    `DARWINBOX AUTOMATION \u00b7 ${date}`,
    line(),
    ``,
    `\u2501\u2501 DARWINBOX \u2501\u2501`,
    dbxLogin,
    ``,
    attendanceBlock,
    ``,
    leaveBlock,
    ``,
    tcBlock,
    ``,
    ohBlock,
    ``,
    `\u2501\u2501 ONEARVIND \u2501\u2501`,
    oaLogin,
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
