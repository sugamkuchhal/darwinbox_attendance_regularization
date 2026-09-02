# 🤖 Darwinbox Automation

Automates daily Darwinbox tasks via GitHub Actions — attendance regularization, leave & time correction approvals, consultant & intern payment approvals, and a summary email.

## What it does

| Step | Module |
|---|---|
| 1. Login | `browser.js` |
| 2. Attendance Regularization | `attendance-orchestrator.js` |
| 3. Leave & Time Correction Approvals | `leave-approval.js` |
| 4. Consultant & Intern Approvals | `consultant-approval.js` |
| 5. Summary Email | `email.js` |

## Project Structure

```text
├── index.js                    # Entry point: orchestration and step sequencing
├── browser.js                  # Browser launch, login, MFA handling
├── attendance-orchestrator.js  # Month/date orchestration and retry policy
├── attendance-page.js          # Attendance page navigation helpers
├── attendance-scan.js          # Scan rows + verification helpers
├── attendance-actions.js       # UI actions (menu open, modal open, submit)
├── attendance-constants.js     # Retry/time constants
├── leave-approval.js           # Leave request + time correction approvals
├── consultant-approval.js      # Consultant & intern payment approvals
├── reason.js                   # Reason dropdown selection logic
├── email.js                    # SMTP summary email
├── config.js                   # Runtime env configuration
├── utils.js                    # Shared utility helpers
└── .github/workflows/darwinbox.yml
```

## Setup

### 1) Add repository secrets

Go to **Settings → Secrets and variables → Actions** and add:

- `DARWINBOX_URL`
- `DARWINBOX_USERNAME`
- `DARWINBOX_PASSWORD`
- `DARWINBOX_EMPLOYEE_ID`
- `DARWINBOX_TOTP_SECRET` (if your tenant requires TOTP)

### 2) Optional: email summary secrets

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE` (`true` for 465, `false` for 587)
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `REPORT_EMAIL_TO` (fallback if `DARWINBOX_USERNAME` is not an email address)

## Schedule

Workflow runs daily at `30 4 * * *` (4:30 UTC / 10:00 IST).

## Attendance Regularization

1. Opens attendance page for the current month (and previous month on days 1–4).
2. Finds eligible absent dates.
3. Loads Outdoor Duty dates from `outdoor-duty-dates.csv`.
4. For each date, tries reasons in configured priority order — Outdoor Duty CSV matches try `Outdoor Duty` first.
5. Retries each reason up to the configured limit.
6. Verifies badge after submission; moves to next reason on failure.

### Reason priority

Default: Forgot To Punch → Outdoor Duty → Work From Home → In / Out Swiping Mistake

Override with env var `DARWINBOX_REASON_PRIORITY` (comma-separated).

### Outdoor Duty dates

Add dates to `outdoor-duty-dates.csv` (single `date` column, `DD-MM-YYYY`):

```csv
date
11-05-2026
12-05-2026
```

If the CSV is missing, unreadable, or contains an invalid date, the run fails before regularization starts.

## Security

- **Keep this repository private.** Actions logs and artifacts may contain login UI screenshots, employee ID, and partially-masked MFA details — all visible to anyone if the repo is public.
- Use GitHub Secrets for all credentials. Never hardcode or commit a `.env` file.

## Troubleshooting

- **Gmail SMTP error 534** — Use an App Password (requires 2FA), not your account password.
- **Email skipped** — Ensure all `SMTP_*` secrets are present and mapped in the workflow env.
- **Verification fails after submit** — Script moves to the next configured reason automatically.
