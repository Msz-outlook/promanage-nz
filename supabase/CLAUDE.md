# Supabase

Loaded when you read anything in `supabase/`.

Project `ilxjyhnbnsufeomnkmsg` (`promanage-nz`, ap-southeast-2), org on the
**Free** plan.

- `CONFIG.SUPABASE_KEY` in `index.html` is the **publishable** key and is meant
  to be in that served file. A service-role key must never land there —
  `check-app.mjs` fails the build if one does.
- RLS is owner-scoped, one policy per command; every table carries `user_id`.
- Re-running `supabase/schema.sql` is safe. It is idempotent and fails loudly
  rather than half-applying if it cannot determine ownership of existing rows.
- Check `get_advisors` after any DDL change.

## Not to "simplify"

- **Server-side `updated_at`** (schema.sql §1). Conflict resolution compares
  `updated_at`; letting clients write it means the device with the fastest
  clock wins. It also makes the incremental pull cursor meaningful.
- **Activity-log retention windows.** The pull filter in `index.html` and
  `pruneLocalActivityLog()` must use the same cutoff as the server-side
  retention, or each undoes the other on every sync forever.
- **Owner-scoped RLS is what `authHeader()` depends on.** A request sent with
  the publishable key instead of a session token authenticates as `anon`, so
  `auth.uid()` is NULL, every policy matches nothing, and PostgREST returns
  `200 []` rather than an error. That once looked like an empty table to the
  sync engine and cost a device its entire local database — see
  `.claude/rules/app-invariants.md`.

## Known open item

Auth **leaked-password protection (HaveIBeenPwned) is disabled**, and shows up
as a `WARN` in the security advisors. It requires the **Pro plan** — it is not
available to toggle on Free. Enable at
Authentication → Sign In / Providers → Email → "Prevent use of leaked passwords"
once the project is upgraded.
[Docs](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)
