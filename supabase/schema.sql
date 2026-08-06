-- ProManage NZ — database schema
--
-- One idempotent file, safe to re-run. Sections are ordered by dependency:
-- ownership columns have to exist before the policies that read them, and the
-- old foreign keys have to be dropped before the unique key they depend on can
-- be replaced.
--
--   1. Server-side updated_at stamping
--   2. properties.compliance_items — column the client already writes
--   3. Ownership — user_id on every table
--   4. Row Level Security — owner-scoped, one policy per command
--   5. Foreign keys — and the decision on what a property delete does
--   6. Indexes — RLS predicates, incremental pulls, FK checks
--   7. Activity log retention
--   8. Uniqueness — invoice and statement numbers, per owner
--
-- Applying this file to a project that already holds data will FAIL LOUDLY
-- rather than half-apply if it cannot work out who owns the existing rows —
-- see section 3.


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
-- One clock is also what makes the incremental pull in section 6 possible at
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
-- 3. OWNERSHIP — user_id on every table
-- ============================================================
-- Until now every row was owned by "whoever is logged in", which is another
-- way of saying nobody. That is the constraint that blocks a second login of
-- any kind: a co-manager, an accountant with read-only access to invoices and
-- statements, an owner who should see their own statements and nothing else.
-- None of those can be expressed without a column naming who a row belongs to.
--
-- This adds that column and nothing more. The policies in section 4 are
-- deliberately the simplest possible reading of it — owner sees own rows —
-- because that is the behaviour the app has today. Sharing gets built by
-- widening the predicate later (a memberships table joined in the USING
-- clause); it does not need this column to change again.
--
-- default auth.uid() means the client never has to send user_id. On an upsert
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
    execute format('alter table public.%I alter column user_id set default auth.uid()', t);
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
-- 4. ROW LEVEL SECURITY — owner-scoped
-- ============================================================
-- Every table previously carried one `for all` policy whose entire test was
-- `auth.role() = 'authenticated'`. That is not a row filter — it is a login
-- check written in the row filter's place. Any authenticated account could
-- read, edit and delete every row in the database.
--
-- Replaced with four policies per table, one per command. Splitting them is
-- not ceremony: it is what makes the next role cheap. A read-only accountant
-- is a second SELECT policy on invoices and statements and no other change; a
-- `for all` policy would have to be torn down and rebuilt to say the same
-- thing.
--
-- `(select auth.uid())` rather than a bare `auth.uid()` — wrapping it makes
-- Postgres evaluate it once per statement as an InitPlan instead of once per
-- row, which is the difference the Supabase performance advisor flags on
-- exactly this pattern.
--
-- `to authenticated` keeps the anon role out by construction. anon holds table
-- grants by default on Supabase, and with RLS enabled and no policy matching
-- its role it now reads zero rows.

do $$
declare
  t text;
  p record;
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
    execute format('alter table public.%I enable row level security', t);

    -- Drop whatever is there by name, including the old
    -- "authenticated full access" blanket policy, so re-running this file
    -- cannot leave a stale permissive policy sitting alongside the new ones.
    for p in
      select policyname from pg_policies
       where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;

    execute format(
      'create policy "owner reads own rows" on public.%I
         for select to authenticated
         using (user_id = (select auth.uid()))', t);

    execute format(
      'create policy "owner inserts own rows" on public.%I
         for insert to authenticated
         with check (user_id = (select auth.uid()))', t);

    -- USING decides which rows can be targeted, WITH CHECK decides what they
    -- may look like afterwards. Both are needed: without WITH CHECK an owner
    -- could hand a row to another account by updating user_id.
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


-- ============================================================
-- 5. FOREIGN KEYS — and what a property delete does
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
-- 6. INDEXES
-- ============================================================
-- Three jobs, and one index per table covers the first two.
--
-- (user_id, updated_at) serves the RLS predicate — every policy in section 4
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
-- activity_log is also read by created_at (retention, section 7, and the
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
-- 7. ACTIVITY LOG RETENTION
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
-- 8. UNIQUENESS — invoice and statement numbers, per owner
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
-- already uses for "add this if it is not already there" — see section 6.
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
