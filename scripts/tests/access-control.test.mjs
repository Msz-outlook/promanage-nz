// Two logins, one account. The manager owns it; a casual staff login is a
// member of it with four pages and no deletes.
//
// Most of this file is registry checks rather than logic checks, in the spirit
// of page-render.test.mjs, because that is the shape the feature breaks in. A
// profile naming a page that no longer exists, or a store the sync engine does
// not have, does not throw — it silently removes a page from someone's app or
// stops a table syncing for one login and not the other, and neither gets
// reported as a bug by the person who can see everything.
//
// What is NOT tested here is whether any of it is enforced, because none of it
// is: hiding a page hides a page. Enforcement is RLS, in supabase/schema.sql
// §3 and §5, and a browser test of the real page cannot reach it. The one case
// below that pins real behaviour rather than presentation is the delete guard,
// for the reason recorded next to it.

export const name = 'access-control';

export default ({ test, app, eq, deepEq, ok, notOk }) => {
  /* ---- the profiles line up with the rest of the app ---------------- */

  test('every page a profile names is a real page', async () => {
    const unknown = await app(() => {
      const out = [];
      for (const [role, profile] of Object.entries(ACCESS_PROFILES)) {
        for (const page of profile.pages || []) if (!pages[page]) out.push(role + ':' + page);
      }
      return out;
    });
    deepEq(unknown, []);
  });

  test('every store a profile syncs is a real local store', async () => {
    // A typo here is a table that silently stops syncing for one login.
    const unknown = await app(() => {
      const known = new Set(LOCAL_STORES);
      const out = [];
      for (const [role, profile] of Object.entries(ACCESS_PROFILES)) {
        for (const store of profile.pulls) if (!known.has(store)) out.push(role + ':pull:' + store);
        for (const store of profile.pushes) if (!known.has(store)) out.push(role + ':push:' + store);
      }
      return out;
    });
    deepEq(unknown, []);
  });

  test('a store a profile pulls is also one it pushes', async () => {
    // The reverse is allowed and used — activityLog is push-only for staff.
    // Pulling a table you cannot push is not: local edits would be merged away
    // by the next full pull with nothing having gone to the server.
    const orphans = await app(() => {
      const out = [];
      for (const [role, profile] of Object.entries(ACCESS_PROFILES)) {
        for (const store of profile.pulls) {
          if (profile.pushes.indexOf(store) === -1) out.push(role + ':' + store);
        }
      }
      return out;
    });
    deepEq(orphans, []);
  });

  test('every module a profile can reach has a renderer', async () => {
    const missing = await app(() => {
      const before = accessRole;
      try {
        const known = new Set(Object.keys(MODULE_RENDERERS));
        const out = [];
        for (const role of Object.keys(ACCESS_PROFILES)) {
          accessRole = role;
          for (const name of accessibleModules()) if (!known.has(name)) out.push(role + ':' + name);
        }
        return out;
      } finally {
        accessRole = before;
      }
    });
    deepEq(missing, []);
  });

  /* ---- what casual staff actually get ------------------------------- */

  test('casual staff get properties, tenants, maintenance and inspections — and nothing else', async () => {
    const seen = await app(() => {
      const before = accessRole;
      try {
        accessRole = ROLE_STAFF;
        return accessiblePages();
      } finally {
        accessRole = before;
      }
    });
    deepEq(seen, ['properties', 'tenants', 'maintenance', 'inspections']);
  });

  test('the finance, compliance and automation modules are out of reach for staff', async () => {
    const reachable = await app(() => {
      const before = accessRole;
      try {
        accessRole = ROLE_STAFF;
        const mods = accessibleModules();
        return ['dashboard', 'financials', 'invoices', 'statements', 'compliance', 'activity',
          'email-triage', 'backup', 'archive'].filter((m) => mods.has(m));
      } finally {
        accessRole = before;
      }
    });
    deepEq(reachable, []);
  });

  test('the manager keeps every page, without the profile listing them', async () => {
    // pages:null rather than a copy of Object.keys(pages) — a page added to
    // the app belongs to the owner without anyone remembering to say so.
    const r = await app(() => ({
      declared: ACCESS_PROFILES[ROLE_OWNER].pages,
      resolved: (() => {
        const before = accessRole;
        try { accessRole = ROLE_OWNER; return accessiblePages().length; } finally { accessRole = before; }
      })(),
      total: Object.keys(pages).length
    }));
    eq(r.declared, null);
    eq(r.resolved, r.total);
  });

  test('staff land on Properties, the manager on the Dashboard', async () => {
    const r = await app(() => {
      const before = accessRole;
      try {
        accessRole = ROLE_STAFF;
        const staff = { page: defaultPage(), dashboard: canAccessPage('dashboard') };
        accessRole = ROLE_OWNER;
        return { staff, owner: { page: defaultPage(), dashboard: canAccessPage('dashboard') } };
      } finally {
        accessRole = before;
      }
    });
    eq(r.staff.page, 'properties');
    notOk(r.staff.dashboard);
    eq(r.owner.page, 'dashboard');
    ok(r.owner.dashboard);
  });

  test('staff sync the four shared tables and append to the audit trail, nothing more', async () => {
    const r = await app(() => {
      const before = accessRole;
      try {
        accessRole = ROLE_STAFF;
        return {
          pulls: ['properties', 'tenants', 'maintenance', 'inspections', 'invoices', 'statements', 'activityLog']
            .filter((s) => canSyncStore(s, 'pull')),
          pushes: ['properties', 'tenants', 'maintenance', 'inspections', 'invoices', 'statements', 'activityLog']
            .filter((s) => canSyncStore(s, 'push'))
        };
      } finally {
        accessRole = before;
      }
    });
    deepEq(r.pulls, ['properties', 'tenants', 'maintenance', 'inspections']);
    deepEq(r.pushes, ['properties', 'tenants', 'maintenance', 'inspections', 'activityLog']);
  });

  /* ---- nav ----------------------------------------------------------- */

  test('nav() sends a login to a page it can open rather than an empty one', async () => {
    const landed = await app(() => {
      const beforeRole = accessRole;
      const beforePage = currentPageId;
      try {
        accessRole = ROLE_STAFF;
        nav('invoices', null, true);
        return currentPageId;
      } finally {
        accessRole = beforeRole;
        nav(beforePage, null, true);
      }
    });
    eq(landed, 'properties');
  });

  /* ---- deletes ------------------------------------------------------- */

  test('the delete guard is the one client-side rule that is not cosmetic', async () => {
    // PostgREST answers a DELETE that matched no rows with 204, so a delete
    // RLS refused reads here as a successful one — and deleteInspection()
    // strips the photos out of Storage before it sends the row delete. The
    // button being hidden is not enough; the function has to refuse.
    const r = await app(() => {
      const before = accessRole;
      const realAlert = window.alert;
      let alerted = '';
      try {
        window.alert = (m) => { alerted = String(m); };
        accessRole = ROLE_STAFF;
        const blocked = deleteBlockedByRole('inspections');
        accessRole = ROLE_OWNER;
        return { blocked, allowed: deleteBlockedByRole('inspections'), alerted };
      } finally {
        window.alert = realAlert;
        accessRole = before;
      }
    });
    ok(r.blocked, 'staff must be refused');
    notOk(r.allowed, 'the manager must not be');
    ok(/manager/i.test(r.alerted), `the refusal must say who can: ${JSON.stringify(r.alerted)}`);
  });

  test('a hidden delete button stays hidden even after a form sets its display', async () => {
    // toggleXForm() writes style.display on these buttons itself, so the rule
    // hiding them has to be !important. Drop that and the button comes back
    // the moment a record is opened for editing — which is the only time it
    // has ever been visible.
    const r = await app(() => {
      const before = accessRole;
      const btn = document.getElementById('prop-delete-btn');
      const beforeDisplay = btn.style.display;
      try {
        accessRole = ROLE_STAFF;
        applyAccessRole();
        btn.style.display = 'inline-flex'; // what editing a property does
        const staff = getComputedStyle(btn).display;
        accessRole = ROLE_OWNER;
        applyAccessRole();
        return { staff, owner: getComputedStyle(btn).display };
      } finally {
        btn.style.display = beforeDisplay;
        accessRole = before;
        applyAccessRole();
      }
    });
    eq(r.staff, 'none');
    // Not inline-flex: the button is a flex item, so the used value is
    // blockified. All that matters is that it came back.
    ok(r.owner !== 'none', `the manager's button must still show, got ${r.owner}`);
  });

  /* ---- the sidebar --------------------------------------------------- */

  test('applyAccessRole hides the pages a login cannot open, and the headings left empty', async () => {
    const r = await app(() => {
      const before = accessRole;
      const visible = () => Array.from(document.querySelectorAll('.nav-item[data-page]'))
        .filter((i) => i.style.display !== 'none')
        .map((i) => i.getAttribute('data-page'));
      const headings = () => Array.from(document.querySelectorAll('.nav-section'))
        .filter((s) => s.style.display !== 'none' && s.querySelector('.nav-item[data-page]'))
        .length;
      try {
        accessRole = ROLE_STAFF;
        applyAccessRole();
        const staff = { pages: visible(), sections: headings() };
        accessRole = ROLE_OWNER;
        applyAccessRole();
        return { staff, owner: { pages: visible(), sections: headings() } };
      } finally {
        accessRole = before;
        applyAccessRole();
      }
    });
    deepEq(r.staff.pages, ['properties', 'tenants', 'maintenance', 'inspections']);
    eq(r.staff.sections, 1, 'only the Portfolio heading still has anything under it');
    eq(r.owner.pages.length, await app(() => Object.keys(pages).length), 'the manager gets every page back');
    ok(r.owner.sections > 1, 'and every heading with it');
  });

  /* ---- the cached role ----------------------------------------------- */

  test('a cached role this build does not recognise is not honoured', async () => {
    // Junk gets into this key the same way it gets anywhere else: an older
    // build, a half-written value, someone poking at devtools. A role that
    // resolves to no profile must read as "unknown", not as a profile.
    const read = await app(() => {
      const key = ROLE_CACHE_PREFIX + 'test-user';
      const before = localStorage.getItem(key);
      const out = [];
      try {
        for (const v of ['', 'nonsense', 'OWNER', 'admin', '{}']) {
          localStorage.setItem(key, v);
          out.push(readCachedRole('test-user'));
        }
        localStorage.removeItem(key);
        out.push(readCachedRole('test-user')); // absent entirely
        localStorage.setItem(key, ROLE_STAFF);
        out.push(readCachedRole('test-user')); // a real one still reads back
      } finally {
        if (before === null) localStorage.removeItem(key);
        else localStorage.setItem(key, before);
      }
      return out;
    });
    deepEq(read, [null, null, null, null, null, null, 'staff']);
  });

  test('the role cache is per user id, so two logins on one device do not inherit each other', async () => {
    const r = await app(() => {
      const keys = [ROLE_CACHE_PREFIX + 'user-a', ROLE_CACHE_PREFIX + 'user-b'];
      const before = keys.map((k) => localStorage.getItem(k));
      try {
        localStorage.setItem(keys[0], ROLE_STAFF);
        return { a: readCachedRole('user-a'), b: readCachedRole('user-b') };
      } finally {
        keys.forEach((k, i) => {
          if (before[i] === null) localStorage.removeItem(k);
          else localStorage.setItem(k, before[i]);
        });
      }
    });
    eq(r.a, 'staff');
    eq(r.b, null, 'the other login must resolve on its own, not inherit this one');
  });
};
