# 🤖 Darwinbox Attendance Auto-Regularizer

Runs daily in the cloud (GitHub Actions) — no machine needed.

---

## 📁 Files

```
├── darwinbox_regularize.js          ← Main automation script
├── package.json                     ← Node.js dependencies
└── .github/
    └── workflows/
        └── darwinbox.yml            ← GitHub Actions schedule
```

---

## 🚀 Setup (One-Time)

### Step 1: Create a GitHub Repository
1. Go to [github.com](https://github.com) → **New repository**
2. Name it e.g. `darwinbox-automation`
3. Set it to **Private** (important — keeps your credentials safe)
4. Upload all three files maintaining the folder structure above

### Step 2: Add Your Secrets
Go to your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add these secrets one by one:

| Secret Name           | Value                                      |
|-----------------------|--------------------------------------------|
| `DARWINBOX_URL`       | `https://yourcompany.darwinbox.in`         |
| `DARWINBOX_USERNAME`  | Your login email or employee ID            |
| `DARWINBOX_PASSWORD`  | Your Darwinbox password                    |
| `PUNCH_IN_TIME`       | `09:00`                                    |
| `PUNCH_OUT_TIME`      | `18:30`                                    |
| `REGULARIZE_REASON`   | `Worked from office - system missed punch` |

### Step 3: Enable GitHub Actions
1. Go to your repo → **Actions** tab
2. Click **"I understand my workflows, go ahead and enable them"**

### Step 4: Test It Manually
1. Go to **Actions** → **Darwinbox Attendance Regularization**
2. Click **"Run workflow"** → **Run workflow**
3. Watch the logs — check if it succeeds

---

## ⏰ Schedule
The workflow runs **Monday–Friday at 9:30 PM IST** by default.

To change the time, edit `.github/workflows/darwinbox.yml`:
```yaml
- cron: "0 16 * * 1-5"   # This is 4:00 PM UTC = 9:30 PM IST
```
Use [crontab.guru](https://crontab.guru) to calculate your preferred time in UTC.

---

## 🐛 Debugging
After each run, GitHub Actions saves a **screenshot** as an artifact:
- Go to **Actions** → click the latest run → scroll to **Artifacts**
- Download `regularization-screenshot` to see exactly what the browser saw

---

## ⚠️ Important Notes

1. **Selectors may need tuning** — Darwinbox UI varies by company. If the script fails, check the error screenshot and update the CSS selectors in `darwinbox_regularize.js` to match your company's Darwinbox layout.

2. **2FA / OTP** — If your Darwinbox login requires OTP, the script will fail at login. Let me know and I can add OTP handling.

3. **Already regularized days** — The script tries to regularize yesterday's attendance. If already regularized, Darwinbox may show an error — that's fine, the script will still exit cleanly.

4. **Security** — Always keep your repo **Private**. GitHub Secrets are encrypted and never exposed in logs.

---

## 🔧 Customizing

- **Regularize today instead of yesterday**: In `darwinbox_regularize.js`, change `getYesterdayDate()` to `getTodayDate()` on the date fill line.
- **Skip weekends**: Already handled — the cron runs `1-5` (Mon–Fri only).
- **Different punch times per day**: Let me know and I can add day-of-week logic.
