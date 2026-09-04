import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "POST required" }, 405);
  const { action, password, booking } = await request.json();
  if (password !== Deno.env.get("ADMIN_PASSWORD")) return json({ error: "Unauthorized" }, 401);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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
