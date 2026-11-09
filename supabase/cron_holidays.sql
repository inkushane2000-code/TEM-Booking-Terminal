-- Daily automatic IISc holiday sync. Run once, after schema.sql and after
-- deploying the function:
--   supabase functions deploy sync-holidays --no-verify-jwt --project-ref feyaopefxbyhglbkqsch
-- Safe to re-run: it keeps the existing secret and replaces the schedule.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Random secret shared by the cron job and the function (never leaves the database).
insert into public.app_config (key, value)
values ('holiday_sync_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- Twice a day, 01:30 and 13:30 UTC (07:00 and 19:00 IST). It checks the IISc holidays page for this
-- year's and next year's PDF and loads a new or revised list when it appears.
select cron.schedule(
  'iisc-holiday-sync',
  '30 1,13 * * *',
  $job$
  select net.http_post(
    url := 'https://feyaopefxbyhglbkqsch.supabase.co/functions/v1/sync-holidays',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select value from public.app_config where key = 'holiday_sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);

-- Run the first check now instead of waiting for tomorrow morning.
select net.http_post(
  url := 'https://feyaopefxbyhglbkqsch.supabase.co/functions/v1/sync-holidays',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-sync-secret', (select value from public.app_config where key = 'holiday_sync_secret')
  ),
  body := '{}'::jsonb,
  timeout_milliseconds := 150000
);
