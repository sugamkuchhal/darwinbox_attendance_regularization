# 🤖 Darwinbox Attendance Auto-Regularizer

Automates attendance regularization in Darwinbox using Playwright, with optional post-run email summary.

## Project Structure

```text
├── index.js                    # Entry point: env validation, run orchestration, email trigger
├── browser.js                  # Browser launch + login/MFA handling
├── attendance.js               # Compatibility export (re-exports attendance-orchestrator)
├── attendance-orchestrator.js  # Month/date orchestration and retry policy
├── attendance-page.js          # Attendance page navigation helpers
├── attendance-scan.js          # Scan rows + verification helpers
├── attendance-actions.js       # UI actions (menu open, modal open, submit)
├── attendance-constants.js     # Retry/time constants
├── reason.js                   # Reason dropdown selection logic
├── email.js                    # SMTP summary email sender
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
- `GITHUB_TOKEN`

### 2) Optional email summary secrets

Add these only if you want post-run email:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE` (`true` for 465, `false` for 587)
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `REPORT_EMAIL_TO` (fallback recipient if `DARWINBOX_USERNAME` is not an email)

## Schedule

Workflow currently runs daily at `30 4 * * *` (4:30 UTC).

## Runtime behavior (high level)

1. Login to Darwinbox.
2. Open attendance page (current month, and previous month for days 1–4).
3. Find eligible absent dates.
4. Load repo-configured Outdoor Duty dates from `outdoor-duty-dates.csv`.
5. For each date, try reasons in configured priority order. Outdoor Duty CSV matches try `Outdoor Duty` first, then the remaining reasons.
6. Retry each reason attempt up to configured limit.
7. Verify badge after submission; if verification fails, try next reason.
8. Send summary email (if SMTP is configured).

## Reason priority

Default order:

1. Forgot To Punch
2. Outdoor Duty
3. Work From Home
4. In / Out Swiping Mistake

Override using env var `DARWINBOX_REASON_PRIORITY` (comma-separated).

## Outdoor Duty dates

Add Outdoor Duty dates to `outdoor-duty-dates.csv` using a single `date` column in `DD-MM-YYYY` format:

```csv
date
11-05-2026
12-05-2026
```

When an absent date is present in this CSV, the script tries `Outdoor Duty` first for that date, followed by the rest of the configured reason priority. If the CSV is missing, unreadable, missing the `date` header, or contains an invalid date, the run fails before regularization starts.

## Troubleshooting

- **SMTP Gmail error 534 / app password required**
  - Use Gmail App Password with 2FA enabled, not your normal account password.
- **Email skipped due to missing SMTP vars**
  - Ensure all `SMTP_*` secrets are mapped in workflow env.
- **Verification fails after submit**
  - Script treats this as failed for that reason and moves to next configured reason.

## Security

- **Keep this repository private.** This is not optional. Every run uploads debug screenshots (login UI, attendance dates, employee ID, partially-masked MFA phone number) as a GitHub Actions artifact, and Actions logs may include other run details. On a public repo, both the artifacts and the logs are visible to anyone with the URL — there is no way to make those debugging aids work safely on a public repo.
- Use GitHub Secrets for all credentials — never hardcode usernames/passwords/tokens in code or commit a `.env` file.
- The bundled `.gitignore` blocks `*.png`/`.env*` from being committed, but that only prevents *new* accidental commits — it does not protect Actions artifact/log visibility once the repo is public.
