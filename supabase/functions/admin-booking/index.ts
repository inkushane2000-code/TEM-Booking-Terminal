import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  const { action, password, booking } = await request.json();
  if (password !== Deno.env.get("ADMIN_PASSWORD")) return json({ error: "Unauthorized" }, 401);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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
