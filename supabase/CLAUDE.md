# Supabase

Loaded when you read anything in `supabase/`.

Project `ilxjyhnbnsufeomnkmsg` (`promanage-nz`, ap-southeast-2), org on the
**Free** plan.

- `CONFIG.SUPABASE_KEY` in `index.html` is the **publishable** key and is meant
  to be in that served file. A service-role key must never land there —
  `check-app.mjs` fails the build if one does.
- RLS is account-scoped, one policy per command per role; every table carries
  `user_id`, which names the **account** rather than the login that wrote the
  row. See "Two logins, one account" below.
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
- **Account-scoped RLS is what `authHeader()` depends on.** A request sent with
  the publishable key instead of a session token authenticates as `anon`, so
  `auth.uid()` is NULL, every policy matches nothing, and PostgREST returns
  `200 []` rather than an error. That once looked like an empty table to the
  sync engine and cost a device its entire local database — see
  `.claude/rules/app-invariants.md`.

## Two logins, one account

`user_id` names an **account**, not a login. `account_members` maps a second
login into an existing account, and two `security definer` resolvers answer
the questions every policy asks — `current_account_id()` (whose data) and
`current_member_role()` (what they may do). A login with no membership row is
its own account and its own owner, so a single-login install behaves exactly
as it did before any of this existed.

Who exists today:

| Login | Role | Sees |
| --- | --- | --- |
| `msyahir.z@outlook.com` | owner (no membership row) | everything |
| `casualstaff@promanage.nz` | `staff` | properties, tenants, maintenance, inspections — read, insert, update |

The staff account is a **mock address**: nothing can be delivered to it, and
it was created directly in `auth.users` with `email_confirmed_at` already set,
so no confirmation mail is involved. Password resets by email will not work
for it; change its password from the SQL editor or from
Authentication → Users.

**Adding another staff login.** Create the user (Authentication → Users → Add
user, with "Auto Confirm" on), then grant membership — there is no in-app flow
and deliberately no write policy on this table, see `app-invariants.md`:

```sql
insert into public.account_members (account_id, member_id)
select owner.id, member.id
  from auth.users owner, auth.users member
 where owner.email  = 'msyahir.z@outlook.com'
   and member.email = '<the new login>'
on conflict do nothing;
```

**Revoking one** is `delete from public.account_members where member_id = ...`.
The next sign-in — or the next sync, if they are already signed in — picks it
up, and their rows stay in the account because they were never theirs. To
remove the login as well, delete the user; `activity_log.author_id` is
`on delete set null`, so what they did stays in the log.

**Adding a role** is three edits that have to agree: the `role` check on
`account_members`, a policy in §5, and `ACCESS_PROFILES` in `index.html`. The
client treats a role it does not recognise as the most restricted one, so a
missed client edit fails safe and a missed policy edit does not.

## Known open item

Auth **leaked-password protection (HaveIBeenPwned) is disabled**, and shows up
as a `WARN` in the security advisors. It requires the **Pro plan** — it is not
available to toggle on Free. Enable at
Authentication → Sign In / Providers → Email → "Prevent use of leaked passwords"
once the project is upgraded.
[Docs](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)
