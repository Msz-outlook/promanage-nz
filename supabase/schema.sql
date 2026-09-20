-- ProManage NZ — database schema
--
-- One idempotent file, safe to re-run. Sections are ordered by dependency:
-- ownership columns have to exist before the policies that read them, and the
-- old foreign keys have to be dropped before the unique key they depend on can
-- be replaced.
--
--   1. Server-side updated_at stamping
--   2. properties.compliance_items — column the client already writes
--   3. Team access — account_members, and who a login is acting as
--   4. Ownership — user_id on every table
--   5. Row Level Security — account-scoped, one policy per command per role
--   6. Foreign keys — and the decision on what a property delete does
--   7. Indexes — RLS predicates, incremental pulls, FK checks
--   8. Activity log retention
--   9. Uniqueness — invoice and statement numbers, per owner
--
-- Applying this file to a project that already holds data will FAIL LOUDLY
-- rather than half-apply if it cannot work out who owns the existing rows —
-- see section 4.


-- ============================================================
-- 1. SERVER-SIDE updated_at STAMPING
-- ============================================================
-- pullAndMerge() in index.html resolves a conflict between two copies of the
-- same row by comparing updated_at and taking the newer one. Until this
-- migration, updated_at was whatever the client put in the upsert body, i.e.
-- Date.now() on a phone. That means the winner of a genuine conflict was
-- decided by whichever device's clock was furthest ahead, not by who actually
-- edited last. A phone half an hour fast silently beats every other device.
--
-- This makes Postgres stamp the column itself, so every row that reaches the
-- server is timestamped by one clock.
--
-- The trigger fires on INSERT as well as UPDATE. On UPDATE that is the classic
-- case. On INSERT it matters too: the app upserts with
-- `Prefer: resolution=merge-duplicates`, so a brand-new row arrives as an
-- INSERT and would otherwise keep the client's timestamp forever, which is
-- exactly the row most likely to be created offline on a device whose clock
-- has drifted.
--
-- created_at is deliberately left alone — it keeps its `default now()` on
-- insert and is never rewritten.
--
-- Known residual: the push path does not ask for the row back
-- (no `Prefer: return=representation`), so immediately after a push the local
-- copy still holds the client-side updated_at while the server holds its own.
-- The next pullAndMerge() reconciles them and the contents are identical
-- either way, so this is cosmetic drift, not a lost edit.
--
-- One clock is also what makes the incremental pull in section 7 possible at
-- all: the client's `updated_at=gt.<cursor>` filter is only meaningful because
-- every value in that column was written by this server.

-- search_path is pinned empty: the function runs as a trigger on every write,
-- and an unqualified name inside it would resolve against whatever search_path
-- the caller happened to bring. now() lives in pg_catalog, which is always
-- searched, so nothing here needs a schema to be on the path.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'properties',
    'tenants',
    'maintenance',
    'inspections',
    'invoices',
    'statements',
    'activity_log'
  ]
  loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at
         before insert or update on public.%I
         for each row execute function public.set_updated_at()', t);
  end loop;
end;
$$;


-- ============================================================
-- 2. properties.compliance_items
-- ============================================================
-- pushPropertyToBackend() has been sending `compliance_items` since the
-- compliance tracker landed, but the column was never added. PostgREST rejects
-- an upsert naming a column it cannot find (PGRST204), so every property push
-- was failing: the record stayed `synced:false` locally, the banner sat on
-- "1 pending sync" forever, and nothing said why. Ownership and RLS on a table
-- the client cannot write to would be meaningless, so this is fixed first.
--
-- compliance_status stays as-is. It is the derived roll-up
-- (overallComplianceStatus()) that the same push already sends alongside the
-- per-item detail.

alter table public.properties
  add column if not exists compliance_items jsonb not null default '{}'::jsonb;


-- ============================================================
-- 3. TEAM ACCESS — a second login inside one account
-- ============================================================
-- Until now "account" and "login" were the same thing. Every row carried the
-- user_id of the one person who signs in, and the policies in section 5 read
-- that column straight against auth.uid(). Handing a casual staff member their
-- own login under that model gives them an empty app — RLS matches none of the
-- manager's rows — and every record they create is stamped as theirs and is
-- invisible to the manager forever. Sharing the manager's password instead is
-- worse: one credential on every device it ever touched, and an audit trail
-- that cannot tell two people apart.
--
-- So the two ideas come apart. user_id stops meaning "who signed in" and starts
-- meaning "which ACCOUNT this row belongs to". account_members maps a login to
-- the account it works inside, and two resolvers answer the only questions the
-- rest of this file asks:
--
--   current_account_id()   whose data am I working on?  (the account's owner)
--   current_member_role()  what may I do with it?       ('owner' | 'staff')
--
-- They live in `private`, not `public`, and that is not tidiness. Anything in
-- `public` is also a PostgREST endpoint, so a security definer function there
-- is /rest/v1/rpc/current_account_id, callable by anon — which the Supabase
-- security advisor flags, correctly. These leak nothing (anon gets NULL, a
-- member gets the account id they can already read out of account_members),
-- but an unauthenticated entry point that nothing calls is one to close rather
-- than to explain. `private` is not in PostgREST's exposed schemas, and the
-- policies reach it the same way either way.
--
-- A login with no membership row is its own account and its own owner, which
-- is exactly what every policy did before this section existed. That is the
-- property to preserve when editing anything below: with account_members
-- empty, the whole section is a no-op and section 5 reduces to the
-- owner-scoped rules it replaced.

create table if not exists public.account_members (
  account_id uuid not null references auth.users(id) on delete cascade,
  member_id  uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'staff',
  created_at timestamptz not null default now(),
  primary key (account_id, member_id)
);

-- A member belongs to exactly ONE account. Without this, current_account_id()
-- would be picking one row out of a set, so "whose data is this" would depend
-- on physical row order — the kind of ambiguity that answers differently after
-- a vacuum, on the one query where being wrong hands someone another account's
-- portfolio.
create unique index if not exists account_members_member_id_key
  on public.account_members (member_id);

-- Constraints are added in exception-guarded blocks rather than with a bare
-- ALTER: there is no `add constraint if not exists`, and this file is promised
-- to be re-runnable.
do $$
begin
  -- Nobody is their own staff. Permitted, it would leave current_account_id()
  -- correct and current_member_role() saying 'staff' for the person who owns
  -- the data — locking the manager out of their own invoices.
  alter table public.account_members
    add constraint account_members_not_self check (account_id <> member_id);
exception when duplicate_object then null;
end;
$$;

do $$
begin
  -- Every role named here needs a matching profile in ACCESS_PROFILES
  -- (index.html), which decides the pages and buttons that role is shown.
  -- Adding one is two edits, and this constraint is the half that fails loudly.
  alter table public.account_members
    add constraint account_members_role_known check (role in ('staff'));
exception when duplicate_object then null;
end;
$$;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- security definer, and it has to be. These are read from inside the policies
-- ON the tables they protect and from a column default, so a security invoker
-- function would have account_members' own RLS applied while evaluating them —
-- a recursive policy check, which Postgres reports as a bare "infinite
-- recursion detected in policy for relation" naming the wrong relation.
--
-- search_path is pinned empty for the reason every definer function pins it:
-- each name inside is schema-qualified, so nothing can be shadowed by whatever
-- search_path the caller brought with them.
--
-- stable, not volatile: one evaluation per statement is the whole point when
-- this sits in a row filter.
create or replace function private.current_account_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select m.account_id from public.account_members m where m.member_id = (select auth.uid())),
    (select auth.uid())
  );
$$;

create or replace function private.current_member_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select m.role from public.account_members m where m.member_id = (select auth.uid())),
    'owner'
  );
$$;

revoke all on function private.current_account_id() from public;
revoke all on function private.current_member_role() from public;
grant execute on function private.current_account_id() to authenticated, service_role;
grant execute on function private.current_member_role() to authenticated, service_role;

-- The app reads one row of this table at sign-in to find out which profile to
-- draw — see establishAccessRole() in index.html.
grant select on public.account_members to authenticated;

alter table public.account_members enable row level security;

drop policy if exists "a login reads its own membership" on public.account_members;
create policy "a login reads its own membership" on public.account_members
  for select to authenticated
  using (member_id = (select auth.uid()) or account_id = (select auth.uid()));

-- And no write policy at all, deliberately — not even for the account owner.
--
-- A membership row decides WHOSE data a login sees, so the obvious insert
-- policy ("an owner may add members to their own account") also lets any
-- account name somebody ELSE as its member. That victim's current_account_id()
-- flips to the attacker's account on their very next request: their own rows
-- disappear behind RLS and everything they save afterwards lands in the
-- attacker's account, stamped as the attacker's data. The victim never
-- consented to anything and sees only an app that has gone empty.
--
-- Nothing in the app needs to write this table, so nothing may. Grant access
-- from the SQL editor, where service_role bypasses RLS:
--
--   insert into public.account_members (account_id, member_id)
--   values ('<manager uuid>', '<staff uuid>')
--   on conflict do nothing;
--
-- and revoke it by deleting that row. The member's next sign-in — or their
-- next sync, if they are already signed in — picks the change up.

-- WHO did it, next to WHICH ACCOUNT it belongs to. With one login those were
-- the same value and activity_log needed only user_id. With two they are not:
-- "Maintenance · Created" in the manager's log is ambiguous without it.
--
-- It also makes the client's own push safe. Entries are pushed as an upsert
-- (Prefer: resolution=merge-duplicates), so a retry of a push whose response
-- was lost arrives as ON CONFLICT DO UPDATE — which needs policies that let
-- the author see and update that row. A member holding INSERT alone would fail
-- that retry on every sync forever, on a table they cannot even open.
--
-- on delete set null: removing a staff account must not take the record of
-- what they did with it.
alter table public.activity_log
  add column if not exists author_id uuid default auth.uid() references auth.users(id) on delete set null;


-- ============================================================
-- 4. OWNERSHIP — user_id on every table
-- ============================================================
-- Until now every row was owned by "whoever is logged in", which is another
-- way of saying nobody. That is the constraint that blocks a second login of
-- any kind: a co-manager, an accountant with read-only access to invoices and
-- statements, an owner who should see their own statements and nothing else.
-- None of those can be expressed without a column naming who a row belongs to.
--
-- This adds that column and nothing more. Sharing was always going to be built
-- by widening the predicate that reads it rather than by changing the column,
-- and section 3 is that having happened: user_id now names the ACCOUNT, and
-- one account can have more than one login. Nothing here had to move.
--
-- The default is current_account_id(), not auth.uid(), and that one word is
-- what makes a staff member's work land in the manager's portfolio instead of
-- in a private copy of it. For a login with no membership row the two
-- expressions return the same value, so nothing about a single-login install
-- changes. The client never sends user_id either way: on an upsert
-- (`Prefer: resolution=merge-duplicates`) the column is absent from the body,
-- so a new row takes the default and an existing row keeps the value it
-- already had — a device cannot silently re-home someone else's row by
-- re-pushing it.
--
-- on delete cascade against auth.users: deleting the account deletes its data.

do $$
declare
  t text;
begin
  foreach t in array array[
    'properties',
    'tenants',
    'maintenance',
    'inspections',
    'invoices',
    'statements',
    'activity_log'
  ]
  loop
    execute format('alter table public.%I add column if not exists user_id uuid', t);
  end loop;
end;
$$;

-- Backfill. Rows that predate the column have no owner recorded anywhere, so
-- the only safe inference is "there is exactly one account, it must be theirs".
-- With zero accounts or more than one, guessing would hand one user's data to
-- another, so the migration stops instead and says what to run by hand.
do $$
declare
  t text;
  owner uuid;
  account_count integer;
  unowned bigint;
begin
  select count(*) into account_count from auth.users;
  if account_count = 1 then
    select id into owner from auth.users;
  end if;

  foreach t in array array[
    'properties',
    'tenants',
    'maintenance',
    'inspections',
    'invoices',
    'statements',
    'activity_log'
  ]
  loop
    if owner is not null then
      execute format('update public.%I set user_id = $1 where user_id is null', t) using owner;
    end if;

    execute format('select count(*) from public.%I where user_id is null', t) into unowned;
    if unowned > 0 then
      raise exception using
        message = format(
          'public.%I has %s row(s) with no user_id and auth.users holds %s account(s) — the owner cannot be inferred.',
          t, unowned, account_count),
        hint = format(
          'Assign them explicitly, then re-run this file: update public.%I set user_id = ''<uuid>'' where user_id is null;',
          t),
        errcode = '23502';
    end if;
  end loop;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'properties',
    'tenants',
    'maintenance',
    'inspections',
    'invoices',
    'statements',
    'activity_log'
  ]
  loop
    execute format('alter table public.%I alter column user_id set default private.current_account_id()', t);
    execute format('alter table public.%I alter column user_id set not null', t);
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_user_id_fkey');
    execute format(
      'alter table public.%I
         add constraint %I foreign key (user_id) references auth.users(id) on delete cascade',
      t, t || '_user_id_fkey');
  end loop;
end;
$$;


-- ============================================================
-- 5. ROW LEVEL SECURITY — account-scoped, per command, per role
-- ============================================================
-- Every table previously carried one `for all` policy whose entire test was
-- `auth.role() = 'authenticated'`. That is not a row filter — it is a login
-- check written in the row filter's place. Any authenticated account could
-- read, edit and delete every row in the database.
--
-- Replaced with four policies per table, one per command. Splitting them is
-- not ceremony: it is what makes a second role cheap, and section 3's casual
-- staff login is that claim being cashed in. Each restriction below is one
-- policy that differs, not a rewrite:
--
--   properties, tenants,      everyone in the account reads, inserts and
--   maintenance, inspections  updates; only the owner deletes.
--
--   invoices, statements      the owner alone, all four commands.
--
--   activity_log              the owner reads it; anyone in the account
--                             appends to it; an author can re-push their own
--                             entry (see author_id in section 3).
--
-- `user_id = current_account_id()` is the widened predicate the ownership
-- section always said would arrive. For a login with no membership row it
-- evaluates to `user_id = auth.uid()`, character for character the behaviour
-- these policies had before.
--
-- The owner-only tables keep `user_id = auth.uid()` rather than gaining a role
-- check, and that is exact rather than lazy: a member's rows are stamped with
-- the ACCOUNT's id and never with their own, so `user_id = auth.uid()` already
-- means "and you are the account owner". Writing it as a role test as well
-- would be a second thing to keep true.
--
-- `(select ...)` around every function call rather than a bare one — wrapping
-- it makes Postgres evaluate it once per statement as an InitPlan instead of
-- once per row, which is the difference the Supabase performance advisor flags
-- on exactly this pattern. It matters more now than it did: current_account_id()
-- reads a table.
--
-- `to authenticated` keeps the anon role out by construction. anon holds table
-- grants by default on Supabase, and with RLS enabled and no policy matching
-- its role it now reads zero rows.

do $$
declare
  t text;
  p record;
begin
  -- Drop whatever is there by name first, across every table — including the
  -- old "authenticated full access" blanket policy and the owner-scoped set
  -- this section used to create — so re-running this file cannot leave a
  -- stale permissive policy sitting alongside the new ones. A leftover
  -- `owner reads own rows` on properties would be harmless; a leftover one on
  -- a table that later becomes shared would not be.
  foreach t in array array[
    'properties',
    'tenants',
    'maintenance',
    'inspections',
    'invoices',
    'statements',
    'activity_log'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);

    for p in
      select policyname from pg_policies
       where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
  end loop;

  -- ---- shared with everyone in the account ----------------------------
  foreach t in array array['properties','tenants','maintenance','inspections']
  loop
    execute format(
      'create policy "account reads its rows" on public.%I
         for select to authenticated
         using (user_id = (select private.current_account_id()))', t);

    execute format(
      'create policy "account inserts its rows" on public.%I
         for insert to authenticated
         with check (user_id = (select private.current_account_id()))', t);

    -- USING decides which rows can be targeted, WITH CHECK decides what they
    -- may look like afterwards. Both are needed: without WITH CHECK a login
    -- could hand a row to another account by updating user_id.
    execute format(
      'create policy "account updates its rows" on public.%I
         for update to authenticated
         using (user_id = (select private.current_account_id()))
         with check (user_id = (select private.current_account_id()))', t);

    -- The one command a member does not get. A delete here is unrecoverable
    -- from the app — there is no trash and no undo — and on inspections it
    -- takes the photos out of Storage with it, which is why the client
    -- refuses it too rather than firing a request it knows will match no
    -- rows: PostgREST answers a DELETE that deleted nothing with 204, and the
    -- client would read that as success and drop its local copy.
    execute format(
      'create policy "the account owner deletes its rows" on public.%I
         for delete to authenticated
         using (user_id = (select private.current_account_id())
                and (select private.current_member_role()) = ''owner'')', t);
  end loop;

  -- ---- the account owner alone ----------------------------------------
  foreach t in array array['invoices','statements']
  loop
    execute format(
      'create policy "owner reads own rows" on public.%I
         for select to authenticated
         using (user_id = (select auth.uid()))', t);

    execute format(
      'create policy "owner inserts own rows" on public.%I
         for insert to authenticated
         with check (user_id = (select auth.uid()))', t);

    execute format(
      'create policy "owner updates own rows" on public.%I
         for update to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))', t);

    execute format(
      'create policy "owner deletes own rows" on public.%I
         for delete to authenticated
         using (user_id = (select auth.uid()))', t);
  end loop;
end;
$$;

-- ---- activity_log: append-only for a member ---------------------------
-- Written out rather than looped because no other table has this shape.
--
-- A member appends to the manager's audit trail and cannot read it back —
-- their actions are recorded where the manager will see them, and the log
-- itself carries invoice and statement activity that a member has no access
-- to. The two author-scoped policies exist only so the client's upsert retry
-- has a row it can see and update; they hand a member nothing but their own
-- entries.

create policy "owner reads the account log" on public.activity_log
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "an author reads their own entries" on public.activity_log
  for select to authenticated
  using (author_id = (select auth.uid()));

create policy "account appends to the log" on public.activity_log
  for insert to authenticated
  with check (user_id = (select private.current_account_id()));

create policy "owner updates the account log" on public.activity_log
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "an author re-pushes their own entries" on public.activity_log
  for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));

create policy "owner deletes from the account log" on public.activity_log
  for delete to authenticated
  using (user_id = (select auth.uid()));


-- ---- Storage: the inspection-photos bucket ----------------------------
-- The bucket's policies are the other half of "a member does not delete".
-- pushInspectionToBackend() removes an inspection's photos from Storage
-- BEFORE it deletes the row, so a member whose row delete is refused (above)
-- but whose object deletes succeed would strip the photos off an inspection
-- that then stays in the database — the row survives and its evidence does
-- not. Read and upload stay open to the whole account; delete does not.
--
-- storage.objects is owned by the storage extension, so altering its policies
-- needs a privileged role. Re-running this file as anything less should say so
-- and carry on rather than failing the whole script at the last section.
do $$
begin
  drop policy if exists "Allow authenticated delete" on storage.objects;
  drop policy if exists "the account owner deletes photos" on storage.objects;
  create policy "the account owner deletes photos" on storage.objects
    for delete to authenticated
    using (
      bucket_id = 'inspection-photos'
      and (select private.current_member_role()) = 'owner'
    );
exception when insufficient_privilege then
  raise warning
    'Could not set the storage.objects delete policy — run this section as the postgres role, or apply it from Storage → Policies in the dashboard.';
end;
$$;


-- ============================================================
-- 6. FOREIGN KEYS — and what a property delete does
-- ============================================================
-- Decision: a property delete is BLOCKED while anything still points at it.
--
-- Cascade was rejected. The delete arrives as one REST call from a phone with
-- no undo, and it would take tenancies, inspections and invoices with it.
-- Inspection photos are worse than lost: they live in a private Storage bucket
-- and are removed by a separate client-side call (deletePhotosFromStorage),
-- which reads the paths off the inspection row. Cascade deletes that row
-- first, so the objects are stranded in the bucket with nothing left that
-- knows their names.
--
-- ON DELETE SET NULL — what tenants, maintenance and inspections were actually
-- carrying — was rejected for the reason this work exists. The row survives
-- with its address snapshot, so nothing visibly breaks, but its property_id is
-- gone: resolvePropertyAddress() falls back to the frozen snapshot forever and
-- renderFinancials(), which groups by propertyId, is left aggregating a
-- property that no longer exists. That is the ghost, and it never leaves.
--
-- Blocking keeps the link honest. Every dependent record is one the user can
-- delete or re-point first, and deleteProperty() in index.html now counts them
-- up front and says exactly what is in the way instead of firing a delete that
-- will bounce.
--
-- Consequence worth knowing: a property that has ever appeared on an owner
-- statement stops being deletable, because a statement is a financial record
-- and re-pointing it is not something the app should do quietly. Retiring such
-- a property wants an archived status rather than a delete — that is a
-- properties-module change, not a schema one, and it is not built here.
--
-- The keys are composite — (user_id, property_id) → properties (user_id, id) —
-- rather than the plain property_id → properties(id) they replace. RLS stops
-- an account reading another account's rows, but on its own it does not stop
-- one inserting a tenant whose property_id names a property it cannot see. The
-- composite key makes a cross-account link structurally impossible.
--
-- MATCH SIMPLE (the default) is doing real work here: user_id is NOT NULL but
-- property_id is not, and a composite key with any column NULL is not checked
-- at all. So an unlinked tenant/job/inspection/invoice stays legal, which is
-- what the app expects — property_id is optional on all four.
--
-- NO ACTION DEFERRABLE, not RESTRICT, and the difference matters exactly once.
-- Both refuse the delete with the same 23503, so for anything the app does
-- they are the same constraint. But RESTRICT cannot be deferred even inside a
-- DEFERRABLE constraint, and deleting an account cascades from auth.users into
-- all seven tables in an order Postgres does not promise: if properties go
-- first, a RESTRICT would fire against tenants that are about to be deleted
-- anyway and take the whole account deletion down with it. Deferrable NO
-- ACTION leaves the way out:
--
--   begin;
--     set constraints all deferred;
--     delete from auth.users where id = '<uuid>';
--   commit;

do $$
declare
  t text;
begin
  foreach t in array array['tenants','maintenance','inspections','invoices']
  loop
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_property_id_fkey');
  end loop;
end;
$$;

-- The composite key needs a matching unique constraint to point at. id is
-- already the primary key, so this adds no real restriction — it just gives
-- the referencing tables something to name.
alter table public.properties drop constraint if exists properties_user_id_id_key;
alter table public.properties add constraint properties_user_id_id_key unique (user_id, id);

do $$
declare
  t text;
begin
  foreach t in array array['tenants','maintenance','inspections','invoices']
  loop
    execute format(
      'alter table public.%I
         add constraint %I foreign key (user_id, property_id)
         references public.properties (user_id, id)
         on delete no action deferrable initially immediate',
      t, t || '_property_id_fkey');
  end loop;
end;
$$;

-- Statements cannot carry a foreign key: their property blocks live inside a
-- jsonb array (statements.properties), one object per property, each with its
-- own propertyId. So the same rule is enforced with a trigger.
--
-- It raises 23503 — the same SQLSTATE a real foreign key violation raises —
-- so PostgREST returns 409 for this exactly as it does for the four keys
-- above, and the client needs one branch, not two.
--
-- It only enforces against a logged-in session. A trigger cannot be deferred
-- the way the four keys above can, so with no auth.uid() — an account
-- cascade-deleting through auth.users, a maintenance script, the SQL editor —
-- it stands aside rather than blocking an operation that is deliberately
-- reaching past the app. Those paths are trusted; the app is the thing being
-- kept honest.
create or replace function public.block_property_delete_when_referenced()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  referencing_statements integer;
begin
  if (select auth.uid()) is null then
    return old;
  end if;

  select count(*) into referencing_statements
    from public.statements s
   where s.user_id = old.user_id
     and jsonb_typeof(s.properties) = 'array'
     and exists (
       select 1 from jsonb_array_elements(s.properties) block
        where block ->> 'propertyId' = old.id
     );

  if referencing_statements > 0 then
    raise exception using
      errcode = '23503',
      message = format(
        'property %s is still referenced by %s owner statement(s)',
        old.id, referencing_statements),
      hint = 'Remove the property from those statements first, or keep the property.';
  end if;

  return old;
end;
$$;

drop trigger if exists block_property_delete_when_referenced on public.properties;
create trigger block_property_delete_when_referenced
  before delete on public.properties
  for each row execute function public.block_property_delete_when_referenced();


-- ============================================================
-- 7. INDEXES
-- ============================================================
-- Three jobs, and one index per table covers the first two.
--
-- (user_id, updated_at) serves the RLS predicate — every policy in section 5
-- filters on user_id, so it is the leading column of every query the app can
-- now make — and the incremental pull, which asks for
-- `user_id = me AND updated_at > <cursor>`. That was the whole reason to index
-- updated_at: fetchRemoteTablePaged() used to walk `select=*` over every row
-- of every table on every sync, so a device that had changed nothing still
-- downloaded everything. Now it downloads what moved.
--
-- (user_id, property_id) on the four child tables backs the composite foreign
-- key. Without it every property delete seq-scans four tables to find out
-- whether it is allowed; more to the point, an unindexed foreign key is a
-- table scan taken while holding a lock.
--
-- activity_log is also read by created_at (retention, section 8, and the
-- retention-window filter the client puts on its pull), hence the extra one.

do $$
declare
  t text;
begin
  foreach t in array array[
    'properties',
    'tenants',
    'maintenance',
    'inspections',
    'invoices',
    'statements',
    'activity_log'
  ]
  loop
    execute format(
      'create index if not exists %I on public.%I (user_id, updated_at)',
      t || '_user_id_updated_at_idx', t);
  end loop;

  foreach t in array array['tenants','maintenance','inspections','invoices']
  loop
    execute format(
      'create index if not exists %I on public.%I (user_id, property_id)',
      t || '_user_id_property_id_idx', t);
  end loop;
end;
$$;

create index if not exists activity_log_user_id_created_at_idx
  on public.activity_log (user_id, created_at);


-- ============================================================
-- 8. ACTIVITY LOG RETENTION
-- ============================================================
-- activity_log gains a row on every create, update and delete across every
-- module, is synced in both directions, and is re-read and re-rendered on
-- every write. Nothing else in the schema grows without an upper bound. At six
-- properties it is invisible; the point is that it is the one table that will
-- eventually reach the row ceiling the paginated pull was built to survive.
--
-- The window has to be the same number on both sides or the two prunes fight:
-- if the client dropped rows the server still held, the next full pull would
-- pull them straight back and the local prune would run again forever. So the
-- client passes retain_days from its own constant
-- (ACTIVITY_LOG_RETENTION_DAYS in index.html) rather than relying on the
-- default below, and filters its pull to the same window. Change one, change
-- the other.
--
-- security invoker, not definer: called over PostgREST as `authenticated`, RLS
-- applies, and the delete can only reach the caller's own rows. A definer
-- function here would prune the whole table for whoever called it.
--
-- Cutoff is computed from now() — the server's clock — for the same reason
-- updated_at is stamped server-side. A device a day fast must not be able to
-- delete a day of everyone's history.

create or replace function public.prune_activity_log(retain_days integer default 365)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  pruned integer;
begin
  if retain_days is null or retain_days < 1 then
    raise exception 'retain_days must be a positive number of days, got %', retain_days;
  end if;

  delete from public.activity_log
   where created_at < now() - make_interval(days => retain_days);

  get diagnostics pruned = row_count;
  return pruned;
end;
$$;

grant execute on function public.prune_activity_log(integer) to authenticated;

-- The client calls this on sync, throttled to once a day per device, which is
-- enough for an app whose rows only exist because that same client wrote them:
-- nobody using it means nothing growing. If you would rather it ran whether or
-- not anyone opens the app, enable pg_cron and schedule it. It is left
-- commented out so this file stays runnable on a project without the
-- extension.
--
--   create extension if not exists pg_cron;
--   select cron.schedule(
--     'prune-activity-log', '17 3 * * *',
--     $cron$ delete from public.activity_log
--             where created_at < now() - interval '365 days' $cron$);
--
-- Note the scheduled form deletes across all accounts — cron has no session,
-- so it runs as the job owner with no auth.uid() and RLS does not scope it.
-- That is the intent for a maintenance job; it is also why the function above
-- is not the thing being scheduled.


-- ============================================================
-- 9. UNIQUENESS — invoice and statement numbers, per owner
-- ============================================================
-- nextInvoiceNumber() / nextStatementNumber() in index.html mint the next
-- number by reading the highest one already in local IndexedDB. That is
-- read-then-write with nothing enforcing it server-side, so two devices
-- offline at the same time can both mint INV-0005, and — separately — once a
-- pendingDelete invoice is actually purged, its number is free for the next
-- save to reuse. Either way, two different invoices end up sharing a number
-- in what are GST records.
--
-- A unique index is the same guarantee a unique constraint would give
-- (Postgres implements one as the other) and is what the rest of this file
-- already uses for "add this if it is not already there" — see section 7.
-- Scoped to (user_id, *_number), not the number alone: two different owners
-- are free to both use INV-0001, and there is no reason to stop them.
--
-- If this ever fails on a project that already has data, the failure IS the
-- point: Postgres reports the exact duplicate pair, and that pair needs a
-- human decision (which one keeps the number), not a script guessing.

create unique index if not exists invoices_user_id_invoice_number_key
  on public.invoices (user_id, invoice_number);

create unique index if not exists statements_user_id_statement_number_key
  on public.statements (user_id, statement_number);


-- PostgREST caches the schema. Everything above changes it.
notify pgrst, 'reload schema';
