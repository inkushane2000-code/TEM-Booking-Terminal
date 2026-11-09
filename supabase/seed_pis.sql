-- Known PIs, extra spellings, and linking of existing bookings.
-- Run after schema.sql. Safe to re-run.
-- Names are matched loosely already ("Vidya", "VIDYA M PRASAD", "Dr Juliet
-- Mohan Raj" all resolve), so aliases are only needed for nicknames/initials.

insert into public.pis (name)
select v.name from (values
  ('Dr. Juliet Roshini Mohan Raj'),
  ('Dr. Ritika Sharma'),
  ('Dr. Saravanan Palani'),
  ('Dr. Sivaprakasam Ramamoorthy'),
  ('Dr. Susweta Das'),
  ('Dr. Varun Bhaskar'),
  ('Dr. Vidya Mangala Prasad'),
  ('Prof. Dipankar Nandi'),
  ('Prof. Jayanta Chatterjee'),
  ('Prof. Jayaseelan'),
  ('Prof. Mrinmoy De'),
  ('Prof. Rachit Agarwal'),
  ('Prof. Somnath Dutta'),
  ('Prof. Subba Rao Gangi Setty'),
  ('Prof. Tanweer Hussain')
) as v(name)
where not exists (select 1 from public.pis p where public.pi_key(p.name) = public.pi_key(v.name));

insert into public.pi_aliases (alias, pi_id)
select public.pi_key(a.alias), p.id
from (values
  ('SD', 'Prof. Somnath Dutta')
) as a(alias, pi_name)
join public.pis p on public.pi_key(p.name) = public.pi_key(a.pi_name)
on conflict (alias) do update set pi_id = excluded.pi_id;

-- Link existing bookings to the directory and rewrite them to its spelling.
-- Names that match no PI (or several) become 'new' PIs for the operator.
do $$
declare
  r record;
  v_pi uuid;
  v_matches int;
begin
  -- Direct updates keep historic rows as they are (limits apply to new bookings).
  alter table public.bookings disable trigger bookings_assign_pi;
  for r in select distinct b.pi_name from public.bookings b where b.pi_id is null loop
    select count(*), min(x.id::text)::uuid into v_matches, v_pi from public.resolve_pi(r.pi_name) x;
    if v_matches <> 1 then
      insert into public.pis (name, status)
      values (regexp_replace(trim(r.pi_name), '\s+', ' ', 'g'), 'new')
      returning id into v_pi;
    end if;
    update public.bookings b
      set pi_id = v_pi, pi_name = (select p.name from public.pis p where p.id = v_pi)
      where b.pi_name = r.pi_name and b.pi_id is null;
  end loop;
  alter table public.bookings enable trigger bookings_assign_pi;
end
$$;
