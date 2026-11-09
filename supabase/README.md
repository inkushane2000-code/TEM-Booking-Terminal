# Supabase setup

This folder contains the initial backend setup for the EM Facility booking page.

## Setup

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** in the Supabase dashboard.
3. Run [`schema.sql`](./schema.sql).
4. Enable **Anonymous Sign-Ins** under **Authentication > Providers**. The current single-file frontend uses an anonymous Supabase session so researchers do not need a login screen yet.
5. Create the first user, then update their `profiles.role` to `operator` if they need operator access. Operator access should later be moved behind a proper email/password login.
6. Copy the project URL and publishable key for the frontend integration. The current values are configured at the top of `script.js`.

## Important

- Never put the Supabase service-role key in the browser.
- The booking unique index prevents two confirmed bookings from taking the same date and time slot.
- Maintenance blocks are stored in `maintenance_slots` and apply to the selected date/time slot across all instruments. Database triggers reject both user and operator bookings for blocked slots and prevent adding a block where a confirmed booking already exists. Re-run `schema.sql` after updating it, and redeploy `admin-booking` to enable the remote maintenance toggle.
- The 9:30–10:30 AM slot (slot `0`) is reserved every weekday for superuser bookings placed by an administrator. The public booking UI blocks it, and row-level security rejects direct user inserts for it. Admin bookings must use the protected `admin-booking` Edge Function. Re-run `schema.sql` after updating it to apply the reservation rule to an existing project.
- The private `signed-forms` bucket stores uploaded documents. Files must be uploaded under a user UUID folder, for example:

```text
signed-forms/<authenticated-user-uuid>/<booking-id>.pdf
```

- The frontend reuses an existing anonymous Supabase session when available, loads all confirmed bookings, uploads signed forms, and inserts bookings into Supabase. If startup or a network request fails, it retries with backoff and reconnects when the browser comes back online. Booking stays disabled until the remote database is reachable; a new booking is never presented as confirmed based only on local storage. Full booking rows (phone, email, PI, specimen, form path) are readable only by the session that created them; every page learns which slots are taken through the `booked_slots()` function, which returns only instrument, date, slot and user name. The unlocked Operator Console loads full rows through the `admin-booking` function's `list` action. Because Realtime respects row-level security, other users' new bookings reach an open page through the 15-second polling fallback rather than instantly. Local storage remains as a browser cache.
- For production, replace anonymous sessions with email/password or institution SSO before launch.
# Supabase setup

Run [`schema.sql`](./schema.sql) in the Supabase SQL Editor. If the database was already initialized, run the file again so the private booking read policy, the `booked_slots()` function, the Realtime publication, and all seven instruments are applied.

Deploy the operator function with the Supabase CLI:

```sh
supabase functions deploy admin-booking
supabase secrets set ADMIN_PASSWORD='<choose-a-new-strong-password>'
```

The function uses `SUPABASE_SERVICE_ROLE_KEY` server-side for operator Add/Edit/Delete actions and creates short-lived signed download links for users' private booking forms. The operator can download the current Monday–Friday booking week's forms as one ZIP after the booking window closes Sunday at 11:00 AM India time. Redeploy `admin-booking` after changing its code and publish the updated frontend; no database migration is needed for form downloads. Never place the service-role key in the HTML or expose it to users.

## Rolling out a change to the live site

The live database is in use, and the page and database rules must stay compatible. Deploy in this order:

1. `supabase functions deploy admin-booking --project-ref feyaopefxbyhglbkqsch` — the function supports both old and new pages.
2. Run only the `booked_slots()` block from `schema.sql` (additive; safe for the currently deployed page).
3. Push to `main` and wait for Render to finish deploying; confirm the live `script.js` calls `booked_slots`.
4. Run the full `schema.sql`. This makes booking rows private, so it must come after the new page is live — the old page reads the bookings table directly and would show every slot as free.
5. Run `seed_pis.sql` (known PIs, the "SD" spelling, and linking of existing bookings to the PI directory), then `seed_holidays.sql` (IISc 2026 holidays). Both are safe to re-run.
6. Turn on the automatic IISc holiday sync:
   `supabase functions deploy sync-holidays --no-verify-jwt --project-ref feyaopefxbyhglbkqsch`, then run `cron_holidays.sql`. It schedules a daily check (07:00 IST) and runs the first one immediately. Safe to re-run.

## PI limits, holidays and maintenance

- **PI limits:** a PI may hold at most 3 confirmed slots per day and 5 per Monday–Sunday week, across all students and instruments. The `bookings_assign_pi` trigger matches the typed PI name to `pis` (ignoring titles, punctuation and word order; partial names and initials match, e.g. "dr. somnath", "S. Dutta"), stores the directory spelling, and rejects bookings over the limit. Unmatched names are added as `new` PIs; ambiguous names are rejected so the student picks from the list. Operator bookings are exempt. Manage PIs, spellings and merges in the Operator Console.
- **Holidays:** `holidays` blocks student bookings on IISc declared holidays (`bookings_block_holidays`). Restricted (optional) holidays are not blocked. Operator bookings are exempt.
- **Automatic holiday sync:** IISc has no calendar feed; the Public Relations Office posts a PDF each year, linked from the site-wide menu ("Holidays -2026") on iisc.ac.in. The `sync-holidays` function, called daily by pg_cron, finds the links for this year and next, reads the declared holidays and saves them only if every date matches the weekday printed in the PDF and the count matches the numbered list. A revised PDF replaces that year's dates. If anything doesn't check out, nothing is changed and the Operator Console's IISc Holidays card shows "Needs your review" with a link to the PDF; it also warns from 15 December if next year's list is still missing. Dates the operator removes are recorded in `holiday_dismissals` and never re-added; dates the operator adds are never overwritten. "Check IISc now" in the console runs the same check on demand. Logic: `functions/_shared/iisc-holidays.ts`; status: `holiday_sync_log`.
- **Maintenance:** `maintenance_slots` blocks a date and slot on every instrument for everyone, including the operator.
- **Booking rules (`bookings_enforce_rules`):** for students the database itself enforces the booking window (Friday 12:00 noon – Sunday 11:00 AM IST, for the following Monday–Friday only), the 9:30–10:30 AM Super Users slot, the administrative break (Wednesday and Friday 4:00–5:00 PM), and Monday/Tuesday 4:00–5:00 PM for external users only. Institution is required; `user_category` (`iisc`/`external`) is derived from it by `is_iisc_institution()` (an iisc.ac.in email always counts as IISc), never taken from the page. Operator bookings are exempt. Existing bookings are not affected.


To change the operator password: `supabase secrets set ADMIN_PASSWORD='…' --project-ref feyaopefxbyhglbkqsch`. It takes effect immediately; never commit it.
