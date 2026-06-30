const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseOutdoorDutyDatesCsv,
  buildReasonPriorityForDate,
  OUTDOOR_DUTY_REASON,
} = require("../outdoor-duty-dates");

test("parseOutdoorDutyDatesCsv parses valid rows into a Set", () => {
  const csv = "date\n11-05-2026\n12-05-2026\n";
  const dates = parseOutdoorDutyDatesCsv(csv);
  assert.equal(dates.size, 2);
  assert.ok(dates.has("11-05-2026"));
  assert.ok(dates.has("12-05-2026"));
});

test("parseOutdoorDutyDatesCsv dedupes repeated dates", () => {
  const csv = "date\n11-05-2026\n11-05-2026\n";
  const dates = parseOutdoorDutyDatesCsv(csv);
  assert.equal(dates.size, 1);
});

test("parseOutdoorDutyDatesCsv rejects missing header", () => {
  assert.throws(() => parseOutdoorDutyDatesCsv(""), /CSV is empty/);
});

test("parseOutdoorDutyDatesCsv rejects wrong header", () => {
  assert.throws(() => parseOutdoorDutyDatesCsv("dates\n11-05-2026"), /single 'date' header/);
});

test("parseOutdoorDutyDatesCsv rejects malformed rows", () => {
  assert.throws(() => parseOutdoorDutyDatesCsv("date\n11-05-2026,extra"), /Invalid outdoor duty CSV row/);
});

test("parseOutdoorDutyDatesCsv rejects badly formatted dates", () => {
  assert.throws(() => parseOutdoorDutyDatesCsv("date\n2026-05-11"), /Expected DD-MM-YYYY/);
});

test("parseOutdoorDutyDatesCsv rejects dates that don't exist on the calendar", () => {
  assert.throws(() => parseOutdoorDutyDatesCsv("date\n31-02-2026"), /Date does not exist/);
});

test("buildReasonPriorityForDate leaves priority unchanged when date is not in the CSV set", () => {
  const base = ["Forgot To Punch", "Outdoor Duty", "Work From Home"];
  const result = buildReasonPriorityForDate("01-01-2026", new Set(), base);
  assert.deepEqual(result, base);
});

test("buildReasonPriorityForDate moves Outdoor Duty to the front when date matches", () => {
  const base = ["Forgot To Punch", "Outdoor Duty", "Work From Home"];
  const outdoorDutyDates = new Set(["01-01-2026"]);
  const result = buildReasonPriorityForDate("01-01-2026", outdoorDutyDates, base);
  assert.deepEqual(result, [OUTDOOR_DUTY_REASON, "Forgot To Punch", "Work From Home"]);
});

test("buildReasonPriorityForDate does not duplicate Outdoor Duty if already first", () => {
  const base = ["Outdoor Duty", "Forgot To Punch"];
  const outdoorDutyDates = new Set(["01-01-2026"]);
  const result = buildReasonPriorityForDate("01-01-2026", outdoorDutyDates, base);
  assert.deepEqual(result, ["Outdoor Duty", "Forgot To Punch"]);
});
