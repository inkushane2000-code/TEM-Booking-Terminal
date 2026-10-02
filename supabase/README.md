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
- The private `signed-forms` bucket stores uploaded documents. Files must be uploaded under a user UUID folder, for example:

```text
signed-forms/<authenticated-user-uuid>/<booking-id>.pdf
```

- The frontend reuses an existing anonymous Supabase session when available, loads all confirmed bookings, uploads signed forms, and inserts bookings into Supabase. If startup or a network request fails, it retries with backoff and reconnects when the browser comes back online. Booking stays disabled until the remote database is reachable; a new booking is never presented as confirmed based only on local storage. Confirmed bookings are readable by authenticated anonymous sessions so every page can show occupied slots. Realtime updates plus a 15-second polling fallback keep open pages synchronized. Local storage remains as a browser cache.
- For production, replace anonymous sessions with email/password or institution SSO before launch.
# Supabase setup

Run [`schema.sql`](./schema.sql) in the Supabase SQL Editor. If the database was already initialized, run the file again so the global booking read policy, Realtime publication, and all seven instruments are applied.

Deploy the operator function with the Supabase CLI:

```sh
supabase functions deploy admin-booking
supabase secrets set ADMIN_PASSWORD='EM_GC-04'
```

The function uses `SUPABASE_SERVICE_ROLE_KEY` server-side for operator Add/Edit/Delete actions. Never place that key in the HTML or expose it to users.
