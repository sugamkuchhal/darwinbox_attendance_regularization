const { GITHUB_TOKEN, GITHUB_REPO, TIMEOUT_MS, POLL_INTERVAL_MS, WAIT_MINUTES } = require("./config");
const { sleep } = require("./utils");

// ─── GitHub Issue helpers ─────────────────────────────────────────────────────

async function createGitHubIssue(title, body) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ title, body, labels: ["otp-request"] }),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`GitHub issue create failed (${res.status}): ${errorBody.slice(0, 300)}`);
  }
  const data = await res.json();
  console.log(`📋 Issue created: #${data.number} — ${data.html_url}`);
  return data.number;
}

async function getIssueComments(issueNumber) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/issues/${issueNumber}/comments`,
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" } }
  );
  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`GitHub comments fetch failed (${res.status}): ${errorBody.slice(0, 300)}`);
  }
  return await res.json();
}

async function closeGitHubIssue(issueNumber, comment) {
  const commentRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ body: comment }),
  });
  if (!commentRes.ok) {
    const errorBody = await commentRes.text();
    throw new Error(`GitHub issue comment failed (${commentRes.status}): ${errorBody.slice(0, 300)}`);
  }

  const closeRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues/${issueNumber}`, {
    method: "PATCH",
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ state: "closed" }),
  });
  if (!closeRes.ok) {
    const errorBody = await closeRes.text();
    throw new Error(`GitHub issue close failed (${closeRes.status}): ${errorBody.slice(0, 300)}`);
  }
  console.log(`✅ Issue #${issueNumber} closed`);
}

// Poll issue comments for a numeric code. Returns code string or null on timeout.
async function pollIssueForCode(issueNumber, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  console.log(`⏳ [${label}] Waiting up to ${WAIT_MINUTES * 60}s for code reply...`);
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const comments = await getIssueComments(issueNumber);
    if (Array.isArray(comments) && comments.length > 0) {
      const code = comments[comments.length - 1].body.trim().replace(/\D/g, "");
      if (code.length >= 4 && code.length <= 8) {
        console.log(`✅ [${label}] Code received`);
        return code;
      }
    }
    const secsLeft = Math.round((deadline - Date.now()) / 1000);
    console.log(`⏳ [${label}] No code yet — ${secsLeft}s remaining`);
  }
  console.warn(`⚠️ [${label}] Timed out after ${WAIT_MINUTES * 60}s`);
  return null;
}

module.exports = { createGitHubIssue, closeGitHubIssue, pollIssueForCode };
