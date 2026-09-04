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

drop policy if exists "Users can view their own bookings" on public.bookings;
drop policy if exists "Users can view confirmed bookings" on public.bookings;
create policy "Users can view confirmed bookings"
  on public.bookings for select
  to authenticated
  using (status = 'confirmed' or user_id = auth.uid() or public.is_operator());

drop policy if exists "Users can create their own bookings" on public.bookings;
create policy "Users can create their own bookings"
  on public.bookings for insert
  to authenticated
  with check (user_id = auth.uid() and status = 'confirmed');

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
  alter publication supabase_realtime add table public.bookings;
exception
  when duplicate_object then null;
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
