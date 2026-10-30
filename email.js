// Builds and sends run summary emails.
//
// Two independent senders, because the two workflows run on different
// schedules and have different notification rules:
//   sendAttendanceEmail — Darwinbox: attendance + leave/TC/optional holiday
//   sendPaymentsEmail   — OneArvind: consultant + intern payments
const nodemailer = require("nodemailer");
const { AUTO_APPROVE_BELOW } = require("./expense-approval");

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

function today() {
  return new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
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

const payFmt = (r) =>
  `${r.name} (${r.empNo}) | ${monthName(r.month)} ${r.year} | ${fmtAmount(r.netAmount)}`;

async function deliver(subject, text) {
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

  const transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
  try {
    await transporter.sendMail({ from, to: recipient, subject, text });
    console.log(`📧 Sent: ${subject}`);
  } catch (err) {
    console.log(`⚠️ Email send failed (non-fatal): ${err.message}`);
  }
}

// ─── Darwinbox: attendance + approvals ────────────────────────────────────────
// Silent when nothing at all was actioned; otherwise ALL GOOD or PENDING.

async function sendAttendanceEmail({ loginError, summary, taskApprovals }) {
  const date = today();

  const regularized = summary?.succeeded ?? [];
  const pending     = summary?.failed ?? [];
  const buckets     = [taskApprovals?.leave, taskApprovals?.timeCorrection, taskApprovals?.optionalHoliday];
  const approvedN   = buckets.reduce((n, b) => n + (b?.approved ?? 0), 0);
  const failedN     = buckets.reduce((n, b) => n + (b?.failed ?? 0), 0);

  const anyFailure =
    !!loginError || !!summary?.error || pending.length > 0 || !!taskApprovals?.error || failedN > 0;
  const anyAction = regularized.length > 0 || approvedN > 0;

  // Clean run that did nothing at all — stay quiet.
  if (!anyFailure && !anyAction) {
    console.log("📭 Nothing actioned and nothing failed — no email sent");
    return;
  }

  const subject = `${anyFailure ? "[PENDING]" : "[ALL GOOD]"} Darwinbox · Attendance & Approvals · ${date}`;

  const loginLine = loginError
    ? `  ❌ Sign-in failed: ${cleanErr(loginError)}`
    : `  ✅ Signed in (Microsoft SSO)`;

  let attendanceBlock;
  if (loginError)            attendanceBlock = `ATTENDANCE\n  - did not run (sign-in failed)`;
  else if (!summary)         attendanceBlock = `ATTENDANCE\n  - did not run`;
  else if (summary.error)    attendanceBlock = `ATTENDANCE\n  ❌ Error: ${cleanErr(summary.error)}`;
  else {
    const months = summary.monthContexts || [];
    const l = [`ATTENDANCE`];
    if (months.length) l.push(`  Checked     : ${months.join(" + ")} month`);
    l.push(`  Regularized : ${regularized.length}`);
    regularized.forEach((d) => l.push(`      - ${d}`));
    l.push(`  Pending     : ${pending.length}`);
    pending.forEach((d) => l.push(`      - ${d}`));
    attendanceBlock = l.join("\n");
  }

  const gone = loginError ? "- did not run (sign-in failed)"
             : !taskApprovals ? "- did not run"
             : taskApprovals.error ? `❌ Error: ${cleanErr(taskApprovals.error)}` : null;

  const text = [
    `DARWINBOX · ATTENDANCE & APPROVALS · ${date}`,
    line(), ``,
    loginLine, ``,
    attendanceBlock, ``,
    approvalBlock("LEAVE APPROVALS", taskApprovals?.leave, gone), ``,
    approvalBlock("TIME CORRECTIONS", taskApprovals?.timeCorrection, gone), ``,
    approvalBlock("OPTIONAL HOLIDAY REQUESTS", taskApprovals?.optionalHoliday, gone), ``,
    line(),
    `Darwinbox Automation`,
  ].join("\n");

  await deliver(subject, text);
}

// ─── OneArvind: consultant + intern payments ──────────────────────────────────
// Runs several times a day until one run reaches OneArvind.
//   reached + approved something        -> ALL GOOD
//   reached + pending but not approved  -> PENDING
//   reached + nothing pending           -> silent
//   never reached, and this is the last slot of the day -> FAILED

async function sendPaymentsEmail({ result, expenses, isLastRun }) {
  const date = today();
  const reached = !!result?.loginOk;

  if (!reached) {
    if (!isLastRun) {
      console.log("📭 OneArvind not reached — will retry at the next slot, no email");
      return;
    }
    const why = cleanErr(result?.loginError || result?.error);
    await deliver(
      `[FAILED] OneArvind · Payments & Expenses · ${date}`,
      [
        `ONEARVIND · PAYMENTS & EXPENSES · ${date}`,
        line(), ``,
        `  ❌ Could not reach OneArvind on any attempt today`,
        `     Last error: ${why}`, ``,
        `  Nothing was approved. Anything pending remains pending.`, ``,
        line(),
        `Darwinbox Automation`,
      ].join("\n")
    );
    return;
  }

  const c = result.consultants ?? {};
  const i = result.interns ?? {};
  const x = expenses ?? {};

  const approvedN = (c.approved ?? 0) + (i.approved ?? 0) + (x.approved ?? 0);
  const failedN   = (c.failed ?? 0) + (i.failed ?? 0) + (x.failed ?? 0);
  const heldN     = (x.heldRecords ?? []).length;
  const errored   = !!x.error;
  // Rows came back but none were actionable: either they are genuinely
  // already dealt with, or our filter is wrong. Silence hid exactly that bug
  // once, so report it rather than assume the former.
  const allSkipped =
    (x.skippedRecords ?? []).length > 0 && approvedN === 0 && heldN === 0 && failedN === 0;

  // Nothing waiting anywhere, nothing went wrong — stay quiet.
  if (approvedN === 0 && failedN === 0 && heldN === 0 && !errored && !allSkipped) {
    console.log("📭 Reached OneArvind, nothing pending — no email sent");
    return;
  }

  // Held claims are not failures, but they need action — so not ALL GOOD.
  const needsYou = failedN > 0 || heldN > 0 || errored || allSkipped;
  const subject = `${needsYou ? "[PENDING]" : "[ALL GOOD]"} OneArvind · Payments & Expenses · ${date}`;

  // ── Expenses block ──
  let expenseBlock;
  if (!expenses) {
    expenseBlock = `EXPENSES\n  - did not run`;
  } else if (x.error) {
    expenseBlock = `EXPENSES\n  ❌ Error: ${cleanErr(x.error)}`;
  } else {
    const l = [`EXPENSES`, `  Approved : ${x.approved ?? 0}`];
    (x.records ?? []).forEach((r) => l.push(`  - ${r}`));
    if (!(x.records ?? []).length) l.push("  - none");

    if (heldN) {
      l.push(``, `  Held for you : ${heldN}   (≥ ₹${AUTO_APPROVE_BELOW.toLocaleString("en-IN")} — not auto-approved)`);
      x.heldRecords.forEach((r) => l.push(`  * ${r}`));
    }
    if (x.failed > 0) {
      l.push(``, `  Failed   : ${x.failed}`);
      (x.failedRecords ?? []).forEach((r) => l.push(`  ! ${cleanErr(r)}`));
    }
    if ((x.skippedRecords ?? []).length) {
      l.push(``, `  Skipped  : ${x.skippedRecords.length}`);
      x.skippedRecords.forEach((r) => l.push(`  - ${r}`));
    }
    expenseBlock = l.join("\n");
  }

  const text = [
    `ONEARVIND · PAYMENTS & EXPENSES · ${date}`,
    line(), ``,
    `  ✅ Signed in`, ``,
    approvalBlock("CONSULTANT PAYMENTS", c, null, payFmt), ``,
    approvalBlock("INTERN PAYMENTS", i, null, payFmt), ``,
    expenseBlock, ``,
    line(),
    `Darwinbox Automation`,
  ].join("\n");

  await deliver(subject, text);
}

module.exports = { sendAttendanceEmail, sendPaymentsEmail };
