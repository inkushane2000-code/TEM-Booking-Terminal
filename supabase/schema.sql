-- EM Facility booking backend for Supabase
-- Run this file in Supabase Dashboard > SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.instruments (
  id text primary key,
  name text not null,
  subtitle text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.instruments (id, name, subtitle)
values
  ('TEM', 'Talos L120C', 'Transmission Electron Microscope'),
  ('ULTRA', 'Leica UC7 Ultra Microtome', 'Precision specimen preparation'),
  ('QUANTA', 'Quanta 200 SEM', 'Scanning electron microscopy'),
  ('TEDPELLA', 'Tedpella Glow Discharging Unit', 'Specimen preparation'),
  ('QUORUM', 'Quorum Glow Discharging Unit', 'Specimen preparation'),
  ('GLASS', 'Leica Glass Maker', 'Precision specimen preparation'),
  ('DRYER', 'Leica Dryer', 'Precision specimen preparation')
on conflict (id) do update
set name = excluded.name, subtitle = excluded.subtitle;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  pi_name text,
  phone text,
  institution text,
  role text not null default 'researcher'
    check (role in ('researcher', 'operator', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  booking_code text not null unique default upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 12)),
  user_id uuid not null references auth.users(id) on delete restrict,
  user_name text not null,
  pi_name text not null,
  phone text not null,
  email text not null,
  institution text,
  specimen text not null,
  instrument_id text not null references public.instruments(id),
  session_date date not null,
  slot smallint not null check (slot between 0 and 5),
  form_path text not null,
  status text not null default 'confirmed'
    check (status in ('confirmed', 'cancelled')),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz
);

-- One operator runs both instruments, so one booking is allowed per date/slot.
create unique index if not exists one_active_booking_per_slot
  on public.bookings (session_date, slot)
  where status = 'confirmed';

create table if not exists public.maintenance_slots (
  id uuid primary key default gen_random_uuid(),
  instrument_id text not null references public.instruments(id) on delete cascade,
  session_date date not null,
  slot smallint not null check (slot between 0 and 5),
  reason text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (instrument_id, session_date, slot)
);

create or replace function public.prevent_booking_during_maintenance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'confirmed' then
    perform pg_advisory_xact_lock(hashtextextended(new.session_date::text || ':' || new.slot::text, 0));
    if exists (
      select 1 from public.maintenance_slots
      where session_date = new.session_date and slot = new.slot
    ) then
      raise exception 'This slot is blocked for maintenance.'
        using errcode = '23505';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.prevent_maintenance_during_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    perform pg_advisory_xact_lock(hashtextextended(old.session_date::text || ':' || old.slot::text, 0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.session_date::text || ':' || new.slot::text, 0));
  if exists (
    select 1 from public.bookings
    where status = 'confirmed'
      and session_date = new.session_date
      and slot = new.slot
  ) then
    raise exception 'A confirmed booking already exists for this slot.'
      using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_respect_maintenance on public.bookings;
create trigger bookings_respect_maintenance
  before insert or update of session_date, slot, status on public.bookings
  for each row execute function public.prevent_booking_during_maintenance();

drop trigger if exists maintenance_respects_bookings on public.maintenance_slots;
create trigger maintenance_respects_bookings
  before insert or update of instrument_id, session_date, slot on public.maintenance_slots
  for each row execute function public.prevent_maintenance_during_booking();

create table if not exists public.booking_audit_logs (
  id bigint generated always as identity primary key,
  booking_id uuid references public.bookings(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('created', 'cancelled', 'maintenance_added', 'maintenance_removed')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.is_operator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('operator', 'admin')
  );
$$;

-- After creating these two users in Supabase Auth, grant administrator access:
-- update public.profiles set role = 'admin'
-- where id in (select id from auth.users
--   where email in ('ignatiouss@iisc.ac.in', 'keerthana@iisc.ac.in'));

alter table public.instruments enable row level security;
alter table public.profiles enable row level security;
alter table public.bookings enable row level security;
alter table public.maintenance_slots enable row level security;
alter table public.booking_audit_logs enable row level security;

drop policy if exists "Anyone can view active instruments" on public.instruments;
create policy "Anyone can view active instruments"
  on public.instruments for select
  to authenticated
  using (active = true);

drop policy if exists "Users can view their own profile" on public.profiles;
create policy "Users can view their own profile"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.is_operator());

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Full booking rows (phone, email, PI, specimen, form path) are private:
-- a session can read only its own bookings. Operators read everything
-- through the admin-booking Edge Function.
drop policy if exists "Users can view confirmed bookings" on public.bookings;
drop policy if exists "Users can view their own bookings" on public.bookings;
create policy "Users can view their own bookings"
  on public.bookings for select
  to authenticated
  using (user_id = auth.uid() or public.is_operator());

-- The public schedule only needs to know which slots are taken, so it
-- reads this narrow projection instead of the bookings table.
create or replace function public.booked_slots()
returns table (id uuid, instrument_id text, session_date date, slot smallint, user_name text)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, b.instrument_id, b.session_date, b.slot, b.user_name
  from public.bookings b
  where b.status = 'confirmed'
    and b.session_date >= current_date - 14;
$$;
revoke all on function public.booked_slots() from public, anon;
grant execute on function public.booked_slots() to authenticated;

drop policy if exists "Users can create their own bookings" on public.bookings;
create policy "Users can create their own bookings"
  on public.bookings for insert
  to authenticated
  with check (user_id = auth.uid() and status = 'confirmed' and slot <> 0);

drop policy if exists "Users can cancel their own bookings" on public.bookings;
create policy "Users can cancel their own bookings"
  on public.bookings for update
  to authenticated
  using (user_id = auth.uid() or public.is_operator())
  with check (
    (user_id = auth.uid() and status = 'cancelled')
    or public.is_operator()
  );

-- Enable browser clients to receive booking changes immediately.
do $$
begin
  begin
    alter publication supabase_realtime add table public.bookings;
  exception
    when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.maintenance_slots;
  exception
    when duplicate_object then null;
  end;
end
$$;

drop policy if exists "Authenticated users can view maintenance slots" on public.maintenance_slots;
create policy "Authenticated users can view maintenance slots"
  on public.maintenance_slots for select
  to authenticated
  using (true);

drop policy if exists "Operators manage maintenance slots" on public.maintenance_slots;
create policy "Operators manage maintenance slots"
  on public.maintenance_slots for all
  to authenticated
  using (public.is_operator())
  with check (public.is_operator() and created_by = auth.uid());

drop policy if exists "Operators view audit logs" on public.booking_audit_logs;
create policy "Operators view audit logs"
  on public.booking_audit_logs for select
  to authenticated
  using (public.is_operator());

insert into storage.buckets (id, name, public)
values ('signed-forms', 'signed-forms', false)
on conflict (id) do update set public = false;

drop policy if exists "Users upload their own signed forms" on storage.objects;
create policy "Users upload their own signed forms"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'signed-forms'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users read their own signed forms" on storage.objects;
create policy "Users read their own signed forms"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'signed-forms'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_operator())
  );

-- ---------------------------------------------------------------------------
-- PI directory and per-PI booking limits
-- A PI may hold at most 3 confirmed slots per day and 5 per Monday–Sunday
-- week, across all students and instruments. PI names are matched loosely
-- ("somnath", "Dr. Somnath", "Prof S. Dutta" -> Prof. Somnath Dutta); an
-- unmatched name is added as a 'new' PI for the operator to review.
-- Operator (service-role / operator profile) bookings are exempt from limits.
-- ---------------------------------------------------------------------------

create table if not exists public.pis (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active' check (status in ('active', 'new')),
  created_at timestamptz not null default now()
);

-- Extra recognised spellings (stored normalised, see pi_key), e.g. 'sd'.
create table if not exists public.pi_aliases (
  alias text primary key,
  pi_id uuid not null references public.pis(id) on delete cascade
);

alter table public.bookings add column if not exists pi_id uuid references public.pis(id);
create index if not exists bookings_pi_day
  on public.bookings (pi_id, session_date)
  where status = 'confirmed';

-- Lower-case word tokens with titles and filler words removed.
create or replace function public.pi_tokens(p_name text)
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg(tok order by ord), '{}')
  from unnest(regexp_split_to_array(trim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z]+', ' ', 'g')), ' '))
       with ordinality as t(tok, ord)
  where tok <> ''
    and tok not in ('prof', 'professor', 'dr', 'doctor', 'mr', 'mrs', 'ms', 'miss', 'sir', 'madam', 'mam', 'maam', 'lab', 'group', 'iisc');
$$;

create or replace function public.pi_key(p_name text)
returns text
language sql
immutable
as $$ select array_to_string(public.pi_tokens(p_name), ' '); $$;

-- True when every query token matches a different word of the PI's name
-- (any order); a one-letter token matches an initial. At least one full
-- word must match, so bare initials ("SD") only resolve through an alias.
create or replace function public.pi_name_matches(q text[], c text[])
returns boolean
language plpgsql
immutable
as $$
declare
  nq int := coalesce(array_length(q, 1), 0);
  nc int := coalesce(array_length(c, 1), 0);
  used boolean[] := array_fill(false, array[greatest(nc, 1)]);
  full_word boolean := false;
  hit boolean;
begin
  if nq = 0 or nc = 0 then return false; end if;
  -- Full words first, so an initial cannot take a word a full token needs.
  for pass in 1..2 loop
    for i in 1..nq loop
      continue when (pass = 1) <> (length(q[i]) > 1);
      hit := false;
      for j in 1..nc loop
        if not used[j] and (q[i] = c[j] or (length(q[i]) = 1 and left(c[j], 1) = q[i])) then
          used[j] := true;
          hit := true;
          exit;
        end if;
      end loop;
      if not hit then return false; end if;
      if length(q[i]) > 1 then full_word := true; end if;
    end loop;
  end loop;
  return full_word;
end;
$$;

-- Exact matches (alias or full name) win; otherwise loose matches.
create or replace function public.resolve_pi(p_name text)
returns table (id uuid, name text, status text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  k text := public.pi_key(p_name);
begin
  if k = '' then return; end if;
  return query
    select distinct p.id, p.name, p.status from public.pis p
    left join public.pi_aliases a on a.pi_id = p.id
    where a.alias = k or public.pi_key(p.name) = k;
  if found then return; end if;
  return query
    select p.id, p.name, p.status from public.pis p
    where public.pi_name_matches(public.pi_tokens(p_name), public.pi_tokens(p.name))
    order by p.name;
end;
$$;

-- Slots a PI already holds per day in a date range (no personal details).
create or replace function public.pi_usage(p_pi uuid, p_from date, p_to date)
returns table (session_date date, used int)
language sql
stable
security definer
set search_path = public
as $$
  select b.session_date, count(*)::int
  from public.bookings b
  where b.pi_id = p_pi and b.status = 'confirmed' and b.session_date between p_from and p_to
  group by b.session_date;
$$;

create or replace function public.assign_pi_and_enforce_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pi uuid;
  v_matches int;
  v_week date;
  v_day_used int;
  v_week_used int;
  v_exempt boolean := coalesce(auth.role(), '') = 'service_role' or public.is_operator();
begin
  -- Resolve the PI when none is given, or when the typed name changed.
  if new.pi_id is null
     or (tg_op = 'UPDATE' and new.pi_name is distinct from old.pi_name and new.pi_id is not distinct from old.pi_id) then
    select count(*), min(r.id::text)::uuid into v_matches, v_pi from public.resolve_pi(new.pi_name) r;
    if v_matches > 1 then
      raise exception 'PI_AMBIGUOUS: "%" matches more than one PI. Please choose your PI from the list.', new.pi_name
        using errcode = '23514';
    elsif v_matches = 0 then
      if public.pi_key(new.pi_name) = '' then
        raise exception 'PI_REQUIRED: Please enter your PI''s name.' using errcode = '23514';
      end if;
      insert into public.pis (name, status)
      values (regexp_replace(trim(new.pi_name), '\s+', ' ', 'g'), 'new')
      returning id into v_pi;
    end if;
    new.pi_id := v_pi;
  end if;

  -- Store the directory spelling so every booking for a PI reads the same.
  select p.name into new.pi_name from public.pis p where p.id = new.pi_id;
  if new.pi_name is null then
    raise exception 'PI_UNKNOWN: The selected PI no longer exists.' using errcode = '23514';
  end if;

  if new.status = 'confirmed' and not v_exempt
     and (tg_op = 'INSERT'
          or old.status is distinct from new.status
          or old.session_date is distinct from new.session_date
          or old.pi_id is distinct from new.pi_id) then
    v_week := date_trunc('week', new.session_date)::date;
    -- Serialise concurrent bookings for the same PI and week.
    perform pg_advisory_xact_lock(hashtextextended('pi:' || new.pi_id::text || ':' || v_week::text, 0));
    select count(*) filter (where b.session_date = new.session_date), count(*)
      into v_day_used, v_week_used
      from public.bookings b
      where b.pi_id = new.pi_id and b.status = 'confirmed'
        and b.session_date between v_week and v_week + 6
        and b.id <> new.id;
    if v_day_used >= 3 then
      raise exception 'PI_DAY_LIMIT: % already has 3 slots on %, the daily maximum per PI.',
        new.pi_name, to_char(new.session_date, 'FMDay DD Mon') using errcode = '23514';
    end if;
    if v_week_used >= 5 then
      raise exception 'PI_WEEK_LIMIT: % already has 5 slots this week, the weekly maximum per PI.',
        new.pi_name using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_assign_pi on public.bookings;
create trigger bookings_assign_pi
  before insert or update of pi_name, pi_id, session_date, slot, status on public.bookings
  for each row execute function public.assign_pi_and_enforce_limits();

alter table public.pis enable row level security;
alter table public.pi_aliases enable row level security;

drop policy if exists "Authenticated users can view PIs" on public.pis;
create policy "Authenticated users can view PIs"
  on public.pis for select
  to authenticated
  using (true);

revoke all on function public.resolve_pi(text) from public, anon;
grant execute on function public.resolve_pi(text) to authenticated;
revoke all on function public.pi_usage(uuid, date, date) from public, anon;
grant execute on function public.pi_usage(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- IISc holidays: no student bookings on these dates. IISc publishes the list
-- once a year as a PDF (Public Relations Office). The sync-holidays function
-- loads it automatically every day (supabase/cron_holidays.sql); the operator
-- can also add or remove dates in the Operator Console.
-- Operator (service-role / operator profile) bookings are exempt.
-- ---------------------------------------------------------------------------

create table if not exists public.holidays (
  holiday_date date primary key,
  name text not null,
  source text not null default 'operator',
  created_at timestamptz not null default now()
);

alter table public.holidays enable row level security;
drop policy if exists "Authenticated users can view holidays" on public.holidays;
create policy "Authenticated users can view holidays"
  on public.holidays for select
  to authenticated
  using (true);

create or replace function public.prevent_booking_on_holiday()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if new.status = 'confirmed'
     and not (coalesce(auth.role(), '') = 'service_role' or public.is_operator()) then
    select h.name into v_name from public.holidays h where h.holiday_date = new.session_date;
    if v_name is not null then
      raise exception 'HOLIDAY: % is an IISc holiday (%). The facility is closed that day.',
        to_char(new.session_date, 'FMDay DD Mon'), v_name using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_block_holidays on public.bookings;
create trigger bookings_block_holidays
  before insert or update of session_date, status on public.bookings
  for each row execute function public.prevent_booking_on_holiday();

-- Dates the operator removed by hand; the automatic sync never re-adds them.
create table if not exists public.holiday_dismissals (
  holiday_date date primary key,
  dismissed_at timestamptz not null default now()
);
alter table public.holiday_dismissals enable row level security;

-- One row per year: what the last automatic check found (shown to the operator).
create table if not exists public.holiday_sync_log (
  year int primary key,
  status text not null check (status in ('ok', 'needs_review', 'not_published', 'failed')),
  message text not null,
  pdf_url text,
  checked_at timestamptz not null default now(),
  applied_at timestamptz
);
alter table public.holiday_sync_log enable row level security;

-- Server-only settings (e.g. the cron job's secret). RLS on with no policies:
-- only the service role and the database itself can read it.
create table if not exists public.app_config (
  key text primary key,
  value text not null
);
alter table public.app_config enable row level security;
revoke all on public.app_config, public.holiday_dismissals, public.holiday_sync_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Booking rules, enforced here so they hold even if the page is bypassed.
-- Students (anonymous sessions) only; operator and service-role bookings are
-- exempt. The page shows the same rules before submitting.
--   * Booking window: Friday 12:00 noon to Sunday 11:00 AM IST, for the
--     following Monday to Friday only.
--   * Administrative break: Wednesday and Friday 4:00-5:00 PM.
--   * Monday and Tuesday 4:00-5:00 PM: external (non-IISc) users only.
--   * Institution is required. Internal (IISc) vs external is derived here
--     from the institution (and an iisc.ac.in email always counts as IISc),
--     so the page cannot claim a category; it is stored in user_category.
-- (9:30-10:30 AM is reserved for Super Users by the insert policy above.)
-- ---------------------------------------------------------------------------

alter table public.bookings add column if not exists user_category text
  check (user_category in ('iisc', 'external'));
alter table public.bookings add column if not exists department text;

-- "IISc", "I.I.Sc.", "IISc Bangalore", "Indian Institute of Science" -> true.
-- IISER ("Indian Institute of Science Education and Research") -> false.
create or replace function public.is_iisc_institution(p_text text)
returns boolean
language sql
immutable
as $$
  with t as (
    select trim(regexp_replace(replace(lower(coalesce(p_text, '')), '.', ''), '[^a-z]+', ' ', 'g')) as v
  )
  select v ~ '(^| )(iisc|iiscb|iiscbangalore|iiscbengaluru|iiscblr)( |$)'
      or (v ~ '(^| )indian institute of science( |$)' and v !~ 'indian institute of science education')
  from t;
$$;

-- The clock the rules use (a function so tests can simulate a booking window).
create or replace function public.booking_clock()
returns timestamptz
language sql
stable
as $$ select now() $$;

create or replace function public.enforce_booking_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamp := public.booking_clock() at time zone 'Asia/Kolkata';
  v_open timestamp;
  v_monday date;
  v_dow int := extract(isodow from new.session_date);
begin
  if nullif(trim(coalesce(new.institution, '')), '') is not null or new.email ~* '(@|\.)iisc\.ac\.in\s*$' then
    new.user_category := case
      when new.email ~* '(@|\.)iisc\.ac\.in\s*$' or public.is_iisc_institution(new.institution) then 'iisc'
      else 'external' end;
  end if;
  if new.status <> 'confirmed'
     or coalesce(auth.role(), '') = 'service_role' or public.is_operator() then
    return new;
  end if;
  -- An existing booking that is not being moved is left alone.
  if tg_op = 'UPDATE' and old.status = 'confirmed'
     and new.session_date = old.session_date and new.slot = old.slot
     and new.user_category is not distinct from old.user_category then
    return new;
  end if;

  -- Most recent Friday 12:00 IST at or before now; the window closes Sunday 11:00.
  v_open := date_trunc('day', v_now)
            - make_interval(days => (extract(isodow from v_now)::int + 2) % 7)
            + interval '12 hours';
  if v_open > v_now then v_open := v_open - interval '7 days'; end if;
  v_monday := (v_open + interval '3 days')::date;
  if v_now > v_open + interval '1 day 23 hours' then
    raise exception 'BOOKING_WINDOW: Booking is closed. The window opens on Friday at 12:00 noon and closes on Sunday at 11:00 AM.'
      using errcode = '23514';
  end if;
  if new.session_date < v_monday or new.session_date > v_monday + 4 then
    raise exception 'BOOKING_WINDOW: Only % – % can be booked in this window.',
      to_char(v_monday, 'FMDD Mon'), to_char(v_monday + 4, 'FMDD Mon') using errcode = '23514';
  end if;

  if new.slot = 0 then
    raise exception 'SUPER_USER_SLOT: 9:30–10:30 AM is reserved for Super Users.' using errcode = '23514';
  end if;
  if new.slot = 5 and v_dow in (3, 5) then
    raise exception 'ADMIN_BREAK: 4:00–5:00 PM on % is the administrative break.',
      to_char(new.session_date, 'FMDay') using errcode = '23514';
  end if;
  if nullif(trim(coalesce(new.institution, '')), '') is null then
    raise exception 'INSTITUTION_REQUIRED: Enter your institution.' using errcode = '23514';
  end if;
  if new.slot = 5 and v_dow in (1, 2) and new.user_category <> 'external' then
    raise exception 'EXTERNAL_ONLY: 4:00–5:00 PM on Monday and Tuesday is reserved for external (non-IISc) users.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_enforce_rules on public.bookings;
create trigger bookings_enforce_rules
  before insert or update of session_date, slot, status, institution, email on public.bookings
  for each row execute function public.enforce_booking_rules();
