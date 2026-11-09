-- IISc declared holidays, from the Public Relations Office list
-- R.PRO/(Holidays)/2026 dated 10-09-2025:
-- https://www.iisc.ac.in/wp-content/uploads/2025/09/PRO_Holidays-2026.pdf
-- Restricted holidays are optional per employee and are not blocked.
-- Re-run safely. Later years are loaded automatically by the sync-holidays
-- function (see cron_holidays.sql); this file is only the initial load.

insert into public.holidays (holiday_date, name, source) values
  ('2026-01-26', 'Republic Day', 'IISc PRO 2026'),
  ('2026-03-19', 'Ugadi', 'IISc PRO 2026'),
  ('2026-03-21', 'Id-ul-Fitr', 'IISc PRO 2026'),
  ('2026-03-31', 'Mahavir Jayanti', 'IISc PRO 2026'),
  ('2026-04-03', 'Good Friday', 'IISc PRO 2026'),
  ('2026-05-01', 'Budha Purnima', 'IISc PRO 2026'),
  ('2026-05-27', 'Id-ul-Zuha (Bakrid)', 'IISc PRO 2026'),
  ('2026-06-26', 'Muharram', 'IISc PRO 2026'),
  ('2026-08-15', 'Independence Day', 'IISc PRO 2026'),
  ('2026-08-26', 'Milad-un-Nabi (Id-e-Milad)', 'IISc PRO 2026'),
  ('2026-08-28', 'Varamahalakshmi Festival', 'IISc PRO 2026'),
  ('2026-09-14', 'Ganesha Chaturthi', 'IISc PRO 2026'),
  ('2026-10-02', 'Mahatma Gandhi''s Birthday', 'IISc PRO 2026'),
  ('2026-10-20', 'Dussehra', 'IISc PRO 2026'),
  ('2026-11-09', 'Diwali (Deepavali)', 'IISc PRO 2026'),
  ('2026-11-24', 'Guru Nanak''s Birthday', 'IISc PRO 2026'),
  ('2026-12-25', 'Christmas Day', 'IISc PRO 2026')
on conflict (holiday_date) do update set name = excluded.name, source = excluded.source;
