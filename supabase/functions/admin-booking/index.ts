import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { syncIiscHolidays } from "../_shared/iisc-holidays.ts";
import { extractPdfText } from "../_shared/pdf-text.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function parseISODate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.toISOString().slice(0, 10) === value ? date : null;
}

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "POST required" }, 405);
  const { action, password, booking } = await request.json().catch(() => ({}));
  const adminPassword = Deno.env.get("ADMIN_PASSWORD");
  // Fail closed: if the secret is missing, a request without a password must not match `undefined`.
  if (!adminPassword) return json({ error: "ADMIN_PASSWORD secret is not configured" }, 500);
  if (typeof password !== "string" || password !== adminPassword) return json({ error: "Unauthorized" }, 401);
  if (action === "verify") return json({ ok: true });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  if (action === "list") {
    const { data, error } = await admin
      .from("bookings")
      .select("*")
      .eq("status", "confirmed")
      .order("session_date")
      .order("slot");
    if (error) return json({ error: error.message }, 400);
    return json({ bookings: data || [] });
  }
  if (action === "pi-list") {
    const [pis, aliases, bookings] = await Promise.all([
      admin.from("pis").select("id,name,status,created_at").order("name"),
      admin.from("pi_aliases").select("alias,pi_id"),
      admin.from("bookings").select("pi_id").eq("status", "confirmed"),
    ]);
    const error = pis.error || aliases.error || bookings.error;
    if (error) return json({ error: error.message }, 400);
    const counts = new Map<string, number>();
    for (const row of bookings.data || []) if (row.pi_id) counts.set(row.pi_id, (counts.get(row.pi_id) || 0) + 1);
    return json({
      pis: (pis.data || []).map((pi) => ({
        ...pi,
        aliases: (aliases.data || []).filter((a) => a.pi_id === pi.id).map((a) => a.alias),
        bookings: counts.get(pi.id) || 0,
      })),
    });
  }
  if (action === "pi-save") {
    const id = typeof booking?.id === "string" ? booking.id : null;
    const name = typeof booking?.name === "string" ? booking.name.trim().replace(/\s+/g, " ") : "";
    const aliases: string[] = Array.isArray(booking?.aliases) ? booking.aliases.filter((a: unknown) => typeof a === "string" && a.trim()) : [];
    if (!name) return json({ error: "PI name is required" }, 400);
    const saved = id
      ? await admin.from("pis").update({ name, status: "active" }).eq("id", id).select("id,name").single()
      : await admin.from("pis").insert({ name, status: "active" }).select("id,name").single();
    if (saved.error) return json({ error: saved.error.message }, 400);
    const piId = saved.data.id;
    // Replace this PI's spellings with the submitted list (stored normalised).
    const keys = await Promise.all(aliases.map(async (a) => (await admin.rpc("pi_key", { p_name: a })).data as string));
    const unique = [...new Set(keys.filter(Boolean))];
    const { error: delError } = await admin.from("pi_aliases").delete().eq("pi_id", piId);
    if (delError) return json({ error: delError.message }, 400);
    if (unique.length) {
      const { error: aliasError } = await admin.from("pi_aliases").upsert(unique.map((alias) => ({ alias, pi_id: piId })), { onConflict: "alias" });
      if (aliasError) return json({ error: aliasError.message }, 400);
    }
    // Keep every booking for this PI on the directory spelling.
    const { error: renameError } = await admin.from("bookings").update({ pi_name: name }).eq("pi_id", piId);
    if (renameError) return json({ error: renameError.message }, 400);
    return json({ ok: true, id: piId });
  }
  if (action === "pi-merge") {
    const from = booking?.from, to = booking?.to;
    if (typeof from !== "string" || typeof to !== "string" || from === to) return json({ error: "Choose two different PIs" }, 400);
    const { data: target, error: targetError } = await admin.from("pis").select("id,name").eq("id", to).single();
    if (targetError || !target) return json({ error: "Target PI not found" }, 404);
    const { data: source } = await admin.from("pis").select("name").eq("id", from).single();
    const moved = await admin.from("bookings").update({ pi_id: to, pi_name: target.name }).eq("pi_id", from);
    if (moved.error) return json({ error: moved.error.message }, 400);
    const aliasMove = await admin.from("pi_aliases").update({ pi_id: to }).eq("pi_id", from);
    if (aliasMove.error) return json({ error: aliasMove.error.message }, 400);
    // The merged PI's own spelling keeps resolving to the target.
    if (source?.name) {
      const { data: key } = await admin.rpc("pi_key", { p_name: source.name });
      if (key) await admin.from("pi_aliases").upsert({ alias: key, pi_id: to }, { onConflict: "alias" });
    }
    const removed = await admin.from("pis").delete().eq("id", from);
    if (removed.error) return json({ error: removed.error.message }, 400);
    return json({ ok: true });
  }
  if (action === "holiday-set") {
    const date = parseISODate(booking?.holiday_date);
    if (!date || typeof booking?.enabled !== "boolean") return json({ error: "A valid date is required" }, 400);
    if (!booking.enabled) {
      const { error } = await admin.from("holidays").delete().eq("holiday_date", booking.holiday_date);
      if (error) return json({ error: error.message }, 400);
      // Remember the removal so the daily IISc sync does not add the date back.
      await admin.from("holiday_dismissals").upsert({ holiday_date: booking.holiday_date }, { onConflict: "holiday_date" });
      return json({ ok: true });
    }
    const name = typeof booking?.name === "string" ? booking.name.trim() : "";
    if (!name) return json({ error: "Holiday name is required" }, 400);
    const { error } = await admin.from("holidays").upsert({ holiday_date: booking.holiday_date, name, source: "operator" }, { onConflict: "holiday_date" });
    if (error) return json({ error: error.message }, 400);
    await admin.from("holiday_dismissals").delete().eq("holiday_date", booking.holiday_date);
    // Existing bookings are kept; report them so the operator can follow up.
    const { count } = await admin.from("bookings").select("id", { count: "exact", head: true })
      .eq("status", "confirmed").eq("session_date", booking.holiday_date);
    return json({ ok: true, existingBookings: count || 0 });
  }
  if (action === "holiday-sync") {
    // "Check IISc now" in the Operator Console: re-read the PDFs even if unchanged.
    const reports = await syncIiscHolidays({ db: admin, extractPdfText, force: true });
    return json({ reports });
  }
  if (action === "holiday-sync-status") {
    const { data, error } = await admin.from("holiday_sync_log").select("*").order("year");
    if (error) return json({ error: error.message }, 400);
    return json({ log: data || [] });
  }
  if (action === "maintenance-set") {
    const sessionDate = parseISODate(booking?.session_date);
    const slot = booking?.slot;
    const instrumentId = booking?.instrument_id;
    if (!sessionDate || !Number.isInteger(slot) || slot < 0 || slot > 5
      || typeof instrumentId !== "string" || !instrumentId
      || typeof booking?.enabled !== "boolean"
      || (booking.enabled && typeof booking?.created_by !== "string")) {
      return json({ error: "A valid instrument, date, slot, and enabled state are required" }, 400);
    }

    if (!booking.enabled) {
      const { error } = await admin
        .from("maintenance_slots")
        .delete()
        .eq("session_date", booking.session_date)
        .eq("slot", slot);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    const { data: existingBooking, error: bookingError } = await admin
      .from("bookings")
      .select("id")
      .eq("status", "confirmed")
      .eq("session_date", booking.session_date)
      .eq("slot", slot)
      .maybeSingle();
    if (bookingError) return json({ error: bookingError.message }, 400);
    if (existingBooking) return json({ error: "A confirmed booking already exists for this slot. Cancel it before adding maintenance." }, 409);

    const { error } = await admin.from("maintenance_slots").upsert({
      instrument_id: instrumentId,
      session_date: booking.session_date,
      slot,
      created_by: booking.created_by,
    }, { onConflict: "instrument_id,session_date,slot" });
    if (error) return json({ error: error.message }, error.code === "23505" ? 409 : 400);
    return json({ ok: true });
  }
  if (action === "bulk-download-forms") {
    const startDate = parseISODate(booking?.start_date);
    const endDate = parseISODate(booking?.end_date);
    if (!startDate || !endDate) return json({ error: "A valid booking week is required" }, 400);
    const expectedEnd = new Date(startDate);
    expectedEnd.setUTCDate(expectedEnd.getUTCDate() + 4);
    if (dateString(expectedEnd) !== dateString(endDate)) return json({ error: "Booking week must cover Monday through Friday" }, 400);

    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const local = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const today = new Date(`${local.year}-${local.month}-${local.day}T00:00:00.000Z`);
    const weekday = today.getUTCDay();
    const hour = Number(local.hour);
    const minute = Number(local.minute);
    const second = Number(local.second);
    const windowIsOpen = (weekday === 5 && hour >= 12)
      || weekday === 6
      || (weekday === 0 && (hour < 11 || (hour === 11 && minute === 0 && second === 0)));
    if (windowIsOpen) return json({ error: "Bulk form downloads are available after the booking window closes Sunday at 11:00 AM India time" }, 409);

    const cycleMonday = new Date(today);
    cycleMonday.setUTCDate(cycleMonday.getUTCDate() + (weekday === 0 ? 1 : 1 - weekday));
    const cycleStart = dateString(cycleMonday);
    const cycleEnd = new Date(cycleMonday);
    cycleEnd.setUTCDate(cycleEnd.getUTCDate() + 4);
    if (dateString(startDate) !== cycleStart || dateString(endDate) !== dateString(cycleEnd)) {
      return json({ error: "Bulk download is limited to the most recently closed booking week's forms" }, 409);
    }

    const { data: records, error: recordsError } = await admin
      .from("bookings")
      .select("booking_code,user_name,session_date,form_path")
      .eq("status", "confirmed")
      .gte("session_date", cycleStart)
      .lte("session_date", dateString(cycleEnd))
      .neq("form_path", "operator-entry")
      .order("session_date");
    if (recordsError) return json({ error: recordsError.message }, 400);

    const uniqueForms = new Map((records || []).map((record) => [record.form_path, record]));
    const files = [];
    for (const record of uniqueForms.values()) {
      const { data, error } = await admin.storage
        .from("signed-forms")
        .createSignedUrl(record.form_path, 300, { download: true });
      if (error) return json({ error: error.message }, 400);
      files.push({
        signedUrl: data.signedUrl,
        userName: record.user_name,
        bookingCode: record.booking_code,
        sessionDate: record.session_date,
        originalName: record.form_path.split("/").pop() || "booking-form",
      });
    }
    return json({ files });
  }
  if (action === "download-form") {
    if (!booking?.id) return json({ error: "Booking ID is required" }, 400);
    const { data: record, error: bookingError } = await admin
      .from("bookings")
      .select("form_path")
      .eq("id", booking.id)
      .eq("status", "confirmed")
      .maybeSingle();
    if (bookingError) return json({ error: bookingError.message }, 400);
    if (!record || record.form_path === "operator-entry") return json({ error: "No uploaded form is available for this booking" }, 404);
    const { data, error } = await admin.storage
      .from("signed-forms")
      .createSignedUrl(record.form_path, 60, { download: true });
    if (error) return json({ error: error.message }, 400);
    return json({ signedUrl: data.signedUrl });
  }
  if (action === "delete") {
    const { error } = await admin.from("bookings").update({ status: "cancelled", cancelled_at: new Date().toISOString() }).eq("id", booking.id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }
  if (action !== "upsert" || !booking?.instrument_id || !booking?.session_date) return json({ error: "Invalid booking" }, 400);
  const payload = { ...booking, status: "confirmed", form_path: "operator-entry", user_id: booking.user_id ?? null };
  delete payload.id;
  const query = booking.id
    ? admin.from("bookings").update(payload).eq("id", booking.id).select("id,booking_code,created_at").single()
    : admin.from("bookings").insert(payload).select("id,booking_code,created_at").single();
  const { data, error } = await query;
  if (error) return json({ error: error.message }, 400);
  return json(data);
});
