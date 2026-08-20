async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function redactUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch (_) {
    return "[unparseable url]";
  }
}

module.exports = { sleep, redactUrl };
