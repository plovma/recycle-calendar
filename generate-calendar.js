#!/usr/bin/env node

/*
 * Requires Node.js 20 or newer.
 */

const fs = require("node:fs/promises");
const path = require("node:path");

const API_URL = "https://api.fostplus.be/recyclecms/public/v1/collections";
const ZIPCODE_ID = "8310-31005";
const STREET_ID = "https://data.vlaanderen.be/id/straatnaam-46265";
const HOUSE_NUMBER = "9";
const SIZE = 100;
const EXCLUDED_FRACTION_IDS = new Set([
  "5ece2bd17125b481f93d935a", // Laatste dag aanvraag Grof
  "5ece2733516d157fbe89e8ca", // Grofvuil op aanvraag
]);
const ICS_OUTPUT = path.join(__dirname, "public", "calendar.ics");
const HTML_OUTPUT = path.join(__dirname, "public", "calendar.html");

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcMonths(date, months) {
  const targetMonth = date.getUTCMonth() + months;
  const targetYear = date.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      normalizedMonth,
      Math.min(date.getUTCDate(), lastDay),
    ),
  );
}

function createDateRange(now = new Date()) {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return {
    fromDate: formatDate(start),
    untilDate: formatDate(addUtcMonths(start, 2)),
  };
}

function createRequestUrl(dateRange) {
  const url = new URL(API_URL);
  for (const [key, value] of Object.entries({
    zipcodeId: ZIPCODE_ID,
    streetId: STREET_ID,
    houseNumber: HOUSE_NUMBER,
    fromDate: dateRange.fromDate,
    untilDate: dateRange.untilDate,
    size: String(SIZE),
  })) {
    url.searchParams.set(key, value);
  }
  return url;
}

function errorDetail(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? String(value)).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
}

async function fetchCollections(dateRange) {
  const url = createRequestUrl(dateRange);
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Consumer": "recycleapp.be",
      },
    });
  } catch (error) {
    throw new Error(`FostPlus request failed for ${url.origin}${url.pathname}: ${error.message}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = errorDetail(await response.text());
    } catch (error) {
      detail = `Unable to read error response: ${error.message}`;
    }
    throw new Error(
      `FostPlus request failed with HTTP ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`FostPlus returned invalid JSON: ${error.message}`, { cause: error });
  }
  if (!payload || !Array.isArray(payload.items)) {
    throw new Error("Unexpected FostPlus response: expected an items array");
  }
  return payload.items;
}

function mapCollection(item, index, dtstamp) {
  const label = `Collection item ${index + 1}`;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`${label} must be an object`);
  }
  if (typeof item.id !== "string" || item.id.trim() === "") {
    throw new Error(`${label} is missing a non-empty id`);
  }
  if (typeof item.timestamp !== "string" || Number.isNaN(Date.parse(item.timestamp))) {
    throw new Error(`${label} (${item.id}) has an invalid timestamp`);
  }
  const typeId = item.fraction?.id;
  if (typeof typeId !== "string" || typeId.trim() === "") {
    throw new Error(`${label} (${item.id}) is missing fraction.id`);
  }
  const wasteType = item.fraction?.name?.nl;
  if (typeof wasteType !== "string" || wasteType.trim() === "") {
    throw new Error(`${label} (${item.id}) is missing fraction.name.nl`);
  }

  return {
    uid: item.id,
    typeId,
    date: formatDate(new Date(item.timestamp)),
    dtstamp,
    summary: wasteType.trim(),
  };
}

function mapCollections(items, now = new Date()) {
  const dtstamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return items
    .map((item, index) => mapCollection(item, index, dtstamp))
    .sort((first, second) => first.date.localeCompare(second.date) || first.uid.localeCompare(second.uid));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function escapeIcsText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function foldIcsLine(line) {
  const folded = [];
  let current = "";
  let byteLength = 0;
  for (const character of line) {
    const characterLength = Buffer.byteLength(character, "utf8");
    if (byteLength + characterLength > 75) {
      folded.push(current);
      current = ` ${character}`;
      byteLength = 1 + characterLength;
    } else {
      current += character;
      byteLength += characterLength;
    }
  }
  folded.push(current);
  return folded.join("\r\n");
}

function formatIcsDate(date) {
  return date.replace(/-/g, "");
}

function nextDate(date) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return formatDate(value);
}

function createIcsEvent(event) {
  return [
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(event.uid)}`,
    `DTSTAMP:${event.dtstamp}`,
    `DTSTART;VALUE=DATE:${formatIcsDate(event.date)}`,
    `DTEND;VALUE=DATE:${formatIcsDate(nextDate(event.date))}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
    "END:VEVENT",
  ].map(foldIcsLine).join("\r\n");
}

function createCalendar(events) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Recycle Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Recycle",
    "",
    ...events.map(createIcsEvent).flatMap((event) => [event, ""]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

function createHtmlCalendar(events, dateRange) {
  const rows = events.length
    ? events.map((event) => `      <tr>
        <td>${escapeHtml(event.date)}</td>
        <td>${escapeHtml(event.summary)}</td>
      <td>${escapeHtml(event.typeId)}</td>
      <td>${escapeHtml(event.uid)}</td>
    </tr>`).join("\n")
    : '      <tr><td colspan="4">No collections scheduled for this period.</td></tr>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Recycle Calendar</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 0.5rem; text-align: left; }
    th { background: #f2f2f2; }
  </style>
</head>
<body>
  <h1>Recycle Calendar</h1>
  <table>
    <caption>Collections from ${escapeHtml(dateRange.fromDate)} through ${escapeHtml(dateRange.untilDate)}</caption>
    <thead>
      <tr>
        <th scope="col">Date</th>
        <th scope="col">Type</th>
        <th scope="col">Type ID</th>
        <th scope="col">Collection ID</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>
`;
}

async function writeOutput(filePath, content, format) {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  } catch (error) {
    throw new Error(`Could not write ${format} calendar to "${filePath}": ${error.message}`, {
      cause: error,
    });
  }
}

async function generateCalendar(dateRange) {
  const items = (await fetchCollections(dateRange)).filter(
    (item) => !EXCLUDED_FRACTION_IDS.has(item.fraction?.id),
  );
  const events = mapCollections(items);

  await writeOutput(
    HTML_OUTPUT,
    createHtmlCalendar(events, dateRange),
    "HTML",
  );
  console.log(`[output] Wrote HTML calendar to ${HTML_OUTPUT}`);

  await writeOutput(
    ICS_OUTPUT,
    createCalendar(events),
    "ICS",
  );
  console.log(`[output] Wrote ICS calendar to ${ICS_OUTPUT}`);
  console.log(`[done] Generated calendars for ${events.length} collection(s).`);
}

function formatError(error) {
  const lines = [error.stack ?? `${error.name}: ${error.message}`];
  let cause = error.cause;
  while (cause) {
    lines.push(`Caused by: ${cause.stack ?? `${cause.name}: ${cause.message}`}`);
    cause = cause.cause;
  }
  return lines.join("\n");
}

async function main() {
  const dateRange = createDateRange();
  console.log(
    `[start] FostPlus collections: ${dateRange.fromDate} to ${dateRange.untilDate}; page size: ${SIZE}`,
  );
  await generateCalendar(dateRange);
}

main().catch((error) => {
  console.error(`Unable to generate calendar:\n${formatError(error)}`);
  process.exitCode = 1;
});
