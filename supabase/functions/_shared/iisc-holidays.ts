// Automatic IISc holiday sync.
//
// IISc has no calendar feed. The Public Relations Office publishes the list
// for each year as a PDF ("PRO_Holidays-<year>.pdf"), linked from the
// site-wide menu ("Holidays -2026") on every iisc.ac.in page. This module
// finds that link on the homepage, reads the
// declared holidays (page 1; restricted holidays are optional and ignored),
// and saves them only when every parsed date matches the weekday printed
// next to it in the PDF. Anything doubtful is logged for the operator and
// nothing is changed.

export const HOLIDAY_PAGE = "https://www.iisc.ac.in/";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export type ParsedHoliday = { holiday_date: string; name: string; weekday?: string };
export type ParseResult =
  | { ok: true; year: number; holidays: ParsedHoliday[] }
  | { ok: false; year: number; holidays: ParsedHoliday[]; reason: string };

export type PdfLink = { year: number; url: string };

/**
 * Holiday-list PDF links on an IISc page, by year; the newest upload wins.
 * Matches the file name (PRO_Holidays-2026.pdf) or the menu text ("Holidays -2026").
 */
export function findHolidayPdfLinks(html: string, base = HOLIDAY_PAGE): PdfLink[] {
  const byYear = new Map<number, string>();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+\.pdf)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const href = m[1].replace(/&amp;/g, "&");
    const label = m[2].replace(/<[^>]*>/g, " ");
    const file = href.split("/").pop() || "";
    const fromFile = file.match(/Holiday[s]?[^/]*?(20\d{2})/i);
    const fromLabel = /holiday/i.test(label) && !/restricted/i.test(label) ? label.match(/(20\d{2})/) : null;
    const yearText = fromFile?.[1] ?? fromLabel?.[1];
    if (!yearText || /restricted|RH[-_]/i.test(file)) continue;
    const url = new URL(href, base).toString();
    const year = Number(yearText);
    const prev = byYear.get(year);
    // Upload paths are /uploads/YYYY/MM/, so a later path is a later (revised) upload.
    if (!prev || uploadKey(url) > uploadKey(prev)) byYear.set(year, url);
  }
  return [...byYear.entries()].map(([year, url]) => ({ year, url })).sort((a, b) => a.year - b.year);
}

function uploadKey(url: string): string {
  const m = url.match(/uploads\/(\d{4})\/(\d{2})\//);
  return (m ? m[1] + m[2] : "000000") + url;
}

/** OCR in the scanned PDF turns digits into letters ("May0l", "Augustl5"). */
function ocrDigits(s: string): string {
  return s.replace(/[Oo]/g, "0").replace(/[lI|i!]/g, "1").replace(/S/g, "5");
}

function cleanName(s: string): string {
  return s
    .replace(/^\s*\d{1,2}\s*[.)]?\s+/, "") // leading serial number on the same line
    .replace(/\bld\b/g, "Id")
    .replace(/\bld-/g, "Id-")
    .replace(/\s+/g, " ")
    .trim();
}

function weekdayOf(iso: string): string {
  return WEEKDAYS[new Date(iso + "T00:00:00Z").getUTCDay()];
}

/**
 * Parse page-1 text of a PRO holiday list.
 * Handles both layouts seen from pdf text extraction: the weekday on the same
 * line ("Holi March 4 Wednesday") or weekdays as a separate column.
 */
export function parseHolidayText(text: string, expectedYear: number): ParseResult {
  // Declared holidays only: stop where the restricted-holiday list begins.
  const declared = text.split(/List\s+of\s+Restricted|Restricted\s+Holidays/i)[0];
  const lines = declared.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const holidays: ParsedHoliday[] = [];
  const weekdayColumn: string[] = [];
  let serials = 0;
  let headerYear: number | null = null;

  // Explicit month names, so OCR like "Augustl5" reads as August 15, not "Augustl" 5.
  const month = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
  const entryRe = new RegExp(`^(.*?[A-Za-z)].*?)\\s+${month}\\.?\\s*([0-9OoIl|iS!]{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?(?:\\s+([A-Za-z]+day))?\\s*$`, "i");

  for (const line of lines) {
    const hy = line.match(/HOLIDAYS\s+FOR\s+THE\s+YEAR\s+(20\d{2})/i);
    if (hy) headerYear = Number(hy[1]);
    if (/^\d{1,2}\s*\.?$/.test(line)) { serials++; continue; }
    if (WEEKDAYS.includes(line.toLowerCase())) { weekdayColumn.push(line.toLowerCase()); continue; }
    if (/^Date\s*:/i.test(line)) continue;

    const m = line.match(entryRe);
    if (!m) continue;
    const monthIdx = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (monthIdx < 0) continue;
    const day = Number(ocrDigits(m[3]));
    const year = m[4] ? Number(m[4]) : expectedYear;
    if (!day || day > 31) continue;
    const iso = `${year}-${String(monthIdx + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (new Date(iso + "T00:00:00Z").toISOString().slice(0, 10) !== iso) continue;
    const name = cleanName(m[1]);
    if (!name || /^holiday$/i.test(name)) continue;
    const inlineDay = m[5] && WEEKDAYS.includes(m[5].toLowerCase()) ? m[5].toLowerCase() : undefined;
    holidays.push({ holiday_date: iso, name, weekday: inlineDay });
  }

  const fail = (reason: string): ParseResult => ({ ok: false, year: expectedYear, holidays, reason });

  if (headerYear !== null && headerYear !== expectedYear) return fail(`The PDF title says ${headerYear}, expected ${expectedYear}.`);
  if (holidays.length < 8 || holidays.length > 30) return fail(`Found ${holidays.length} holidays; a normal IISc list has about 15–20.`);
  if (holidays.some((h) => !h.holiday_date.startsWith(`${expectedYear}-`))) return fail(`Some dates are not in ${expectedYear}.`);
  if (new Set(holidays.map((h) => h.holiday_date)).size !== holidays.length) return fail("The same date appears twice.");
  if (serials && serials !== holidays.length) return fail(`The list is numbered 1–${serials} but ${holidays.length} dates were read.`);

  // Every date must be checked against the weekday printed in the PDF.
  if (holidays.every((h) => !h.weekday)) {
    if (weekdayColumn.length !== holidays.length) {
      return fail(`Read ${holidays.length} dates but ${weekdayColumn.length} weekdays, so the dates cannot be checked.`);
    }
    holidays.forEach((h, i) => (h.weekday = weekdayColumn[i]));
  } else if (holidays.some((h) => !h.weekday)) {
    return fail("Some dates have no weekday next to them, so they cannot be checked.");
  }
  const wrong = holidays.filter((h) => weekdayOf(h.holiday_date) !== h.weekday);
  if (wrong.length) {
    return fail("Date/weekday mismatch: " + wrong.map((h) => `${h.name} ${h.holiday_date} is not a ${h.weekday!.replace(/^./, (c) => c.toUpperCase())}`).join("; "));
  }
  return { ok: true, year: expectedYear, holidays: holidays.map(({ holiday_date, name }) => ({ holiday_date, name })) };
}

// ---------------------------------------------------------------------------
// Sync: fetch, parse, save. Works with the service-role Supabase client.
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
type Db = any;
export type YearReport = {
  year: number;
  status: "ok" | "unchanged" | "needs_review" | "not_published" | "failed";
  message: string;
  pdf_url?: string | null;
  added?: number;
  removed?: number;
  bookingsOnNewHolidays?: number;
};

export const sourceFor = (year: number) => `IISc PRO ${year}`;

const UA = { "User-Agent": "Mozilla/5.0 (compatible; EM-Facility-Booking/1.0; holiday sync)" };

/**
 * iisc.ac.in is slow and sometimes answers 502/503/504 or drops HTTP/2 streams.
 * Up to 3 attempts, 20 s each, retrying network errors and server errors.
 */
export const RETRY_WAIT_MS = { value: 4000 };
async function fetchRetry(fetchImpl: typeof fetch, url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(20_000) });
      if ((res.status >= 500 || res.status === 429) && attempt < 3) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, RETRY_WAIT_MS.value * attempt));
    }
  }
}

export async function syncIiscHolidays(opts: {
  db: Db;
  extractPdfText: (bytes: Uint8Array) => Promise<string>;
  fetchImpl?: typeof fetch;
  now?: Date;
  force?: boolean;
}): Promise<YearReport[]> {
  const { db, extractPdfText } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date();
  // IST calendar year, so the check on 1 Jan 00:30 IST looks for the new year.
  const thisYear = new Date(now.getTime() + 5.5 * 3600_000).getUTCFullYear();
  const years = [thisYear, thisYear + 1];
  const reports: YearReport[] = [];

  let links: PdfLink[] = [];
  try {
    const res = await fetchRetry(fetchImpl, HOLIDAY_PAGE);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    links = findHolidayPdfLinks(await res.text());
  } catch (error) {
    const message = `Could not read ${HOLIDAY_PAGE}: ${(error as Error).message}`;
    for (const year of years) reports.push({ year, status: "failed", message });
    await logReports(db, reports, now);
    return reports;
  }

  const { data: logs } = await db.from("holiday_sync_log").select("year,pdf_url,status").in("year", years);
  for (const year of years) {
    const link = links.find((l) => l.year === year);
    const previous = (logs || []).find((l: { year: number }) => l.year === year);
    if (!link && previous?.status === "ok") {
      // The menu shows one year at a time; once next year's list is up, this year's link disappears.
      reports.push({ year, status: "unchanged", message: `${year} list already loaded.`, pdf_url: previous.pdf_url });
      continue;
    }
    if (!link) {
      reports.push({
        year,
        status: "not_published",
        message: year === thisYear
          ? `No ${year} holiday list is linked on ${HOLIDAY_PAGE} (the site menu may have changed). Add the dates by hand if IISc has published them.`
          : `IISc has not published the ${year} list yet; checking daily.`,
        pdf_url: null,
      });
      continue;
    }
    if (!opts.force && previous?.pdf_url === link.url && previous?.status === "ok") {
      reports.push({ year, status: "unchanged", message: `${year} list already loaded.`, pdf_url: link.url });
      continue;
    }
    reports.push(await syncYear(db, fetchImpl, extractPdfText, link));
  }
  await logReports(db, reports, now);
  return reports;
}

async function syncYear(
  db: Db,
  fetchImpl: typeof fetch,
  extractPdfText: (bytes: Uint8Array) => Promise<string>,
  link: PdfLink,
): Promise<YearReport> {
  const { year, url } = link;
  let parsed: ParseResult;
  try {
    const res = await fetchRetry(fetchImpl, url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await extractPdfText(new Uint8Array(await res.arrayBuffer()));
    parsed = parseHolidayText(text, year);
  } catch (error) {
    return { year, status: "failed", message: `Could not read the ${year} PDF: ${(error as Error).message}`, pdf_url: url };
  }
  if (!parsed.ok) {
    return {
      year,
      status: "needs_review",
      message: `The ${year} list was published but could not be read reliably, so nothing was changed. ${parsed.reason.replace(/\.?$/, ".")} Please add the dates by hand from the PDF.`,
      pdf_url: url,
    };
  }

  const source = sourceFor(year);
  const [existing, dismissed] = await Promise.all([
    db.from("holidays").select("holiday_date,name,source").gte("holiday_date", `${year}-01-01`).lte("holiday_date", `${year}-12-31`),
    db.from("holiday_dismissals").select("holiday_date").gte("holiday_date", `${year}-01-01`).lte("holiday_date", `${year}-12-31`),
  ]);
  if (existing.error || dismissed.error) {
    return { year, status: "failed", message: (existing.error || dismissed.error).message, pdf_url: url };
  }
  const byDate = new Map<string, { name: string; source: string }>((existing.data || []).map((r: { holiday_date: string; name: string; source: string }) => [r.holiday_date, r]));
  const skip = new Set((dismissed.data || []).map((r: { holiday_date: string }) => r.holiday_date));
  const wanted = new Set(parsed.holidays.map((h) => h.holiday_date));

  // Never overwrite a date the operator added or removed by hand.
  const toUpsert = parsed.holidays.filter((h) => !skip.has(h.holiday_date) && byDate.get(h.holiday_date)?.source !== "operator");
  const newDates = toUpsert.filter((h) => !byDate.has(h.holiday_date)).map((h) => h.holiday_date);
  // A revised PDF can move a holiday: drop old dates from this year's IISc list.
  const stale = [...byDate.entries()].filter(([d, r]) => r.source === source && !wanted.has(d)).map(([d]) => d);

  if (toUpsert.length) {
    const { error } = await db.from("holidays").upsert(toUpsert.map((h) => ({ ...h, source })), { onConflict: "holiday_date" });
    if (error) return { year, status: "failed", message: error.message, pdf_url: url };
  }
  if (stale.length) {
    const { error } = await db.from("holidays").delete().in("holiday_date", stale).eq("source", source);
    if (error) return { year, status: "failed", message: error.message, pdf_url: url };
  }
  let bookingsOnNewHolidays = 0;
  if (newDates.length) {
    const { count } = await db.from("bookings").select("id", { count: "exact", head: true }).eq("status", "confirmed").in("session_date", newDates);
    bookingsOnNewHolidays = count || 0;
  }
  return {
    year,
    status: "ok",
    message: `Read ${parsed.holidays.length} IISc holidays for ${year}` +
      (newDates.length ? ` (${newDates.length} new)` : "") +
      (stale.length ? `; removed ${stale.length} date(s) no longer on the list` : "") +
      (bookingsOnNewHolidays ? `. ${bookingsOnNewHolidays} existing booking(s) fall on the new holidays and were kept — contact those users.` : "."),
    pdf_url: url,
    added: newDates.length,
    removed: stale.length,
    bookingsOnNewHolidays,
  };
}

async function logReports(db: Db, reports: YearReport[], now: Date) {
  const rows = reports.filter((r) => r.status !== "unchanged").map((r) => ({
    year: r.year,
    status: r.status,
    message: r.message,
    pdf_url: r.pdf_url ?? null,
    checked_at: now.toISOString(),
    ...(r.status === "ok" ? { applied_at: now.toISOString() } : {}),
  }));
  const unchanged = reports.filter((r) => r.status === "unchanged").map((r) => r.year);
  if (rows.length) await db.from("holiday_sync_log").upsert(rows, { onConflict: "year" });
  if (unchanged.length) await db.from("holiday_sync_log").update({ checked_at: now.toISOString() }).in("year", unchanged);
}
