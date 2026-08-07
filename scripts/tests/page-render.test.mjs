// The module registry, and the staleness contract it exists to keep.
//
// A sync used to end by re-rendering every module regardless of which page was
// on screen. It now draws the current page and marks the rest stale, which is
// only correct as long as every module has a page that will draw it again.
//
// The specific way this breaks is worth stating, because it is silent: before
// this registry existed, nav() re-rendered dashboard, activity, compliance,
// invoices, statements, financials and email-triage — but NOT properties,
// tenants, maintenance or inspections. Those four refreshed only because the
// sync redrew everything. Deferring a render without a path back would have
// left them stale forever on a device receiving changes made elsewhere, and
// stale data that merely looks unchanged does not get reported as a bug.

export const name = 'page-render';

export default ({ test, app, eq, deepEq, ok, notOk }) => {
  test('every module renderer is reachable from at least one page', async () => {
    const orphans = await app(() =>
      Object.keys(MODULE_RENDERERS).filter(
        (m) => !Object.values(PAGE_MODULES).some((mods) => mods.includes(m))
      )
    );
    deepEq(orphans, []);
  });

  test('the four modules nav() never used to redraw are all mapped to a page', async () => {
    // The regression this whole file exists for. If one of these loses its
    // page entry, a sync stops being able to update it at all.
    const mapped = await app(() =>
      ['properties', 'tenants', 'maintenance', 'inspections'].filter(
        (m) => (PAGE_MODULES[m] || []).includes(m)
      )
    );
    deepEq(mapped, ['properties', 'tenants', 'maintenance', 'inspections']);
  });

  test('every page in the nav maps to at least one module', async () => {
    const empty = await app(() =>
      Object.keys(pages).filter((p) => !(PAGE_MODULES[p] || []).length)
    );
    deepEq(empty, []);
  });

  test('every module named in PAGE_MODULES actually has a renderer', async () => {
    const missing = await app(() => {
      const known = new Set(Object.keys(MODULE_RENDERERS));
      const out = [];
      for (const mods of Object.values(PAGE_MODULES)) {
        for (const m of mods) if (!known.has(m)) out.push(m);
      }
      return out;
    });
    deepEq(missing, []);
  });

  test('marking everything stale leaves only the current page drawn', async () => {
    const result = await app(async () => {
      const before = currentPageId;
      try {
        currentPageId = 'tenants';
        staleModules.clear();
        for (const m of Object.keys(MODULE_RENDERERS)) staleModules.add(m);
        await renderCurrentPage();
        return {
          currentDrawn: !staleModules.has('tenants'),
          othersDeferred: staleModules.has('properties') && staleModules.has('invoices')
        };
      } finally {
        currentPageId = before;
        staleModules.clear();
      }
    });
    ok(result.currentDrawn);
    ok(result.othersDeferred);
  });

  test('a deferred module is drawn when its page is entered, and not before', async () => {
    const result = await app(async () => {
      const before = currentPageId;
      try {
        currentPageId = 'dashboard';
        staleModules.clear();
        staleModules.add('invoices');
        await renderCurrentPage();
        const stillStale = staleModules.has('invoices');
        currentPageId = 'invoices';
        await renderCurrentPage();
        return { stillStale, drawnAfterEntering: !staleModules.has('invoices') };
      } finally {
        currentPageId = before;
        staleModules.clear();
      }
    });
    ok(result.stillStale, 'invoices must not be drawn while the dashboard is showing');
    ok(result.drawnAfterEntering);
  });

  test('a renderer that throws clears its stale flag rather than retrying forever', async () => {
    const stillStale = await app(async () => {
      const before = currentPageId;
      const original = MODULE_RENDERERS.activity;
      try {
        MODULE_RENDERERS.activity = async () => { throw new Error('boom'); };
        currentPageId = 'activity';
        staleModules.clear();
        staleModules.add('activity');
        await renderCurrentPage();
        return staleModules.has('activity');
      } finally {
        MODULE_RENDERERS.activity = original;
        currentPageId = before;
        staleModules.clear();
      }
    });
    notOk(stillStale);
  });

  test('a page with nothing stale does no work on entry', async () => {
    const rendered = await app(async () => {
      const before = currentPageId;
      const original = MODULE_RENDERERS.compliance;
      let calls = 0;
      try {
        MODULE_RENDERERS.compliance = async () => { calls++; };
        currentPageId = 'compliance';
        staleModules.clear();
        await renderCurrentPage();
        return calls;
      } finally {
        MODULE_RENDERERS.compliance = original;
        currentPageId = before;
        staleModules.clear();
      }
    });
    eq(rendered, 0);
  });
};
