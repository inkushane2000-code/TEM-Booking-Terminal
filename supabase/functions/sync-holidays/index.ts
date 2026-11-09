// Daily IISc holiday sync, called by pg_cron (see supabase/cron_holidays.sql).
// Deploy with --no-verify-jwt: the cron job authenticates with a random secret
// that only the database and this function can read (public.app_config).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { syncIiscHolidays } from "../_shared/iisc-holidays.ts";
import { extractPdfText } from "../_shared/pdf-text.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "POST required" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const given = request.headers.get("x-sync-secret") || "";
  const { data } = await db.from("app_config").select("value").eq("key", "holiday_sync_secret").maybeSingle();
  if (!data?.value || given !== data.value) return json({ error: "Unauthorized" }, 401);
  const reports = await syncIiscHolidays({ db, extractPdfText });
  return json({ reports });
});
