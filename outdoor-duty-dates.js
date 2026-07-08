// Loads and validates repo-configured Outdoor Duty dates.
const fs   = require("fs");
const path = require("path");

const OUTDOOR_DUTY_REASON    = "Outdoor Duty";
const OUTDOOR_DUTY_DATES_CSV = path.join(__dirname, "outdoor-duty-dates.csv");
const DATE_PATTERN           = /^\d{2}-\d{2}-\d{4}$/;

function assertValidDate(date) {
  if (!DATE_PATTERN.test(date)) {
    throw new Error(`Invalid outdoor duty date "${date}". Expected DD-MM-YYYY.`);
  }
  const [day, month, year] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const isValid = parsed.getUTCFullYear() === year
    && parsed.getUTCMonth()  === month - 1
    && parsed.getUTCDate()   === day;
  if (!isValid) throw new Error(`Invalid outdoor duty date "${date}". Date does not exist.`);
}

function parseOutdoorDutyDatesCsv(csv) {
  const lines = csv.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const [header, ...rows] = lines;
  if (!header) throw new Error("Outdoor duty dates CSV is empty. Expected a 'date' header.");
  if (header !== "date") throw new Error("Outdoor duty dates CSV must start with a single 'date' header.");
  const dates = new Set();
  rows.forEach((row, idx) => {
    const columns = row.split(",").map(col => col.trim());
    if (columns.length !== 1 || !columns[0]) {
      throw new Error(`Invalid outdoor duty CSV row ${idx + 2}. Expected a single DD-MM-YYYY date.`);
    }
    assertValidDate(columns[0]);
    dates.add(columns[0]);
  });
  return dates;
}

function loadOutdoorDutyDates(csvPath = OUTDOOR_DUTY_DATES_CSV) {
  let csv;
  try {
    csv = fs.readFileSync(csvPath, "utf8");
  } catch (err) {
    throw new Error(`Unable to read outdoor duty dates CSV at ${csvPath}: ${err.message}`);
  }
  const dates = parseOutdoorDutyDatesCsv(csv);
  if (dates.size > 0) {
    console.log(`📄 Outdoor Duty dates: ${[...dates].join(", ")}`);
  }
  return dates;
}

// baseReasons is optional — callers no longer need to import getReasonPriority separately.
function buildReasonPriorityForDate(date, outdoorDutyDates, baseReasons) {
  if (outdoorDutyDates.size === 0 || !outdoorDutyDates.has(date)) return baseReasons;
  const remaining = baseReasons.filter(r => r.trim().toLowerCase() !== OUTDOOR_DUTY_REASON.toLowerCase());
  return [OUTDOOR_DUTY_REASON, ...remaining];
}

module.exports = {
  OUTDOOR_DUTY_REASON,
  loadOutdoorDutyDates,
  parseOutdoorDutyDatesCsv,
  buildReasonPriorityForDate,
};
