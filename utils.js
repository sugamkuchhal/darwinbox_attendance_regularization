// ─── Shared utility functions ─────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Returns a time string like "09:17" by adding a random minute (0–max) to baseHour
function randomTime(baseHour, maxMinutes) {
  const minutes = Math.floor(Math.random() * (maxMinutes + 1));
  const hh = String(baseHour).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  return `${hh}:${mm}`;
}

module.exports = { sleep, randomTime };
