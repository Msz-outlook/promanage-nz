-- ProManage NZ — server-side updated_at stamping
--
-- Why this exists
-- ---------------
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
-- Idempotent: safe to re-run.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
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
