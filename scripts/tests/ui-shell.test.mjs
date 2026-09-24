// The app shell: the phone tab bar, the one primary action per page, list rows
// that open with one tap, the sheets every form lives in, and the quiet sync
// banner.
//
// Like page-render and access-control, most of this pins the ways the shell
// breaks without throwing: a tab that points at a page the login cannot open,
// two primary buttons on one page, a row that went back to needing a
// double-click (which a phone reads as "zoom"), a sheet that closes over
// unsaved work, a new inspection's photos lost to a stray tap.
//
// Every case puts back what it changes — the page is shared by every suite.

export const name = 'ui-shell';

export default ({ test, app, eq, deepEq, ok, notOk }) => {
  /* ---- navigation ---------------------------------------------------- */

  test('the phone tab bar shows the first four pages each login can open', async () => {
    const r = await app(() => {
      const before = accessRole;
      const visible = () => Array.from(document.querySelectorAll('.tab[data-page]'))
        .filter((t) => t.style.display !== 'none')
        .map((t) => t.getAttribute('data-page'));
      try {
        accessRole = ROLE_STAFF;
        applyAccessRole();
        const staff = visible();
        accessRole = ROLE_OWNER;
        applyAccessRole();
        return { staff, owner: visible() };
      } finally {
        accessRole = before;
        applyAccessRole();
      }
    });
    // Staff have no dashboard, so their four pages fill the bar.
    deepEq(r.staff, ['properties', 'tenants', 'maintenance', 'inspections']);
    deepEq(r.owner, ['dashboard', 'properties', 'maintenance', 'inspections']);
  });

  test('a page with no tab of its own lights up More instead', async () => {
    const r = await app(() => {
      const before = currentPageId;
      const more = () => document.getElementById('tab-more').classList.contains('active');
      try {
        nav('financials', null, true);
        const onFinancials = more();
        nav('properties', null, true);
        return { onFinancials, onProperties: more() };
      } finally {
        nav(before, null, true);
      }
    });
    ok(r.onFinancials, 'Financials lives under More');
    notOk(r.onProperties, 'Properties has its own tab');
  });

  test('each page shows at most one primary action, and it is that page\'s own', async () => {
    const r = await app(() => {
      const before = currentPageId;
      const out = {};
      try {
        for (const id of Object.keys(pages)) {
          nav(id, null, true);
          out[id] = Array.from(document.querySelectorAll('.page-cta'))
            .filter((b) => getComputedStyle(b).display !== 'none')
            .map((b) => b.getAttribute('data-for'));
        }
        return out;
      } finally {
        nav(before, null, true);
      }
    });
    for (const [page, shown] of Object.entries(r)) {
      ok(shown.length <= 1, `${page} shows ${shown.length} primary actions: ${shown.join(', ')}`);
      if (shown.length) eq(shown[0], page, `${page} shows another page's action`);
    }
    // The six pages that create something each have their button.
    for (const page of ['properties', 'tenants', 'maintenance', 'inspections', 'invoices', 'statements']) {
      deepEq(r[page], [page], `${page} has lost its primary action`);
    }
  });

  /* ---- one tap opens a record ------------------------------------------ */

  test('a list row opens its record on a single click', async () => {
    const r = await app(async () => {
      const id = 'test_ui_prop_1';
      await dbPut('properties', {
        id, address: '1 Tap Test St', bedrooms: 2, bathrooms: 1, floorArea: 80, parking: 0,
        tenancy: 'Long-term', rentPerWeek: 500, status: 'Vacant', complianceItems: {}, notes: '',
        synced: true, pendingDelete: false,
        // Sorts first (newest first), so it is on page one however many
        // properties another suite left behind.
        createdAt: '2099-01-01T00:00:00Z', updatedAt: '2099-01-01T00:00:00Z'
      });
      const sheet = document.getElementById('prop-form-card');
      try {
        pageState.properties = 1;
        await renderPropertiesList();
        const row = Array.from(document.querySelectorAll('#prop-list tr.row-link'))
          .find((tr) => tr.textContent.includes('1 Tap Test St'));
        if (!row) return { found: false };
        row.querySelector('.row-title').click();
        for (let i = 0; i < 100 && sheet.style.display !== 'block'; i++) await new Promise((res) => setTimeout(res, 10));
        return {
          found: true,
          open: sheet.style.display === 'block',
          address: document.getElementById('prop-address').value,
          title: document.getElementById('prop-form-title').textContent
        };
      } finally {
        togglePropForm(false);
        await dbDelete('properties', id);
        await renderPropertiesList();
      }
    });
    ok(r.found, 'the test property is not in the list');
    ok(r.open, 'one click did not open the property');
    eq(r.address, '1 Tap Test St');
    eq(r.title, 'Edit property');
  });

  test('nothing in the app asks for a double-click any more', async () => {
    const r = await app(async () => {
      const id = 'test_ui_prop_2';
      await dbPut('properties', {
        id, address: '2 Tap Test St', tenancy: 'Long-term', status: 'Occupied', complianceItems: {},
        synced: true, pendingDelete: false, createdAt: '2099-01-02T00:00:00Z'
      });
      try {
        await renderAllModules();
        return {
          handlers: document.querySelectorAll('[ondblclick]').length,
          hints: /double-click/i.test(document.getElementById('main-app').textContent)
        };
      } finally {
        await dbDelete('properties', id);
        await renderAllModules();
      }
    });
    eq(r.handlers, 0, 'elements with an ondblclick handler');
    notOk(r.hints, 'on-screen text still tells someone to double-click');
  });

  test('every row that opens something gives the keyboard a button to land on', async () => {
    const r = await app(async () => {
      const id = 'test_ui_prop_3';
      await dbPut('properties', {
        id, address: '3 Tap Test St', tenancy: 'Long-term', status: 'Occupied', complianceItems: {},
        synced: true, pendingDelete: false, createdAt: '2099-01-03T00:00:00Z'
      });
      try {
        await renderAllModules();
        const rows = Array.from(document.querySelectorAll('tr.row-link'));
        return {
          rows: rows.length,
          missing: rows.filter((tr) => {
            const b = tr.querySelector('.row-title');
            return !b || b.tagName !== 'BUTTON';
          }).length
        };
      } finally {
        await dbDelete('properties', id);
        await renderAllModules();
      }
    });
    ok(r.rows > 0, 'no clickable rows rendered at all — has the markup changed?');
    eq(r.missing, 0, 'clickable rows with no button in them');
  });

  /* ---- sheets ------------------------------------------------------------ */

  test('an open sheet makes the page behind it inert and stops it scrolling', async () => {
    const r = await app(() => {
      const appEl = document.getElementById('main-app');
      const root = document.documentElement;
      togglePropForm(true);
      const during = { inert: appEl.inert, locked: root.classList.contains('sheet-open') };
      togglePropForm(false);
      return { during, after: { inert: appEl.inert, locked: root.classList.contains('sheet-open') } };
    });
    ok(r.during.inert, 'the page behind an open sheet is still focusable');
    ok(r.during.locked, 'the page behind an open sheet can still scroll');
    notOk(r.after.inert);
    notOk(r.after.locked);
  });

  test('Escape closes an untouched sheet, and asks before throwing away typing', async () => {
    const r = await app(() => {
      const realConfirm = window.confirm;
      const sheet = document.getElementById('prop-form-card');
      const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      let asked = 0;
      try {
        togglePropForm(true);
        escape();
        const cleanClosed = sheet.style.display === 'none';

        togglePropForm(true);
        const input = document.getElementById('prop-address');
        input.value = 'Something typed';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        window.confirm = () => { asked++; return false; }; // keep editing
        escape();
        const keptOpen = sheet.style.display === 'block';
        window.confirm = () => { asked++; return true; }; // discard
        escape();
        return { cleanClosed, keptOpen, discarded: sheet.style.display === 'none', asked };
      } finally {
        window.confirm = realConfirm;
        togglePropForm(false);
      }
    });
    ok(r.cleanClosed, 'Escape did not close a sheet with nothing in it');
    ok(r.keptOpen, 'Escape closed a sheet over unsaved typing without asking');
    ok(r.discarded, 'confirming the discard did not close the sheet');
    eq(r.asked, 2, 'times the discard question was asked');
  });

  test('the system Back button closes an open sheet rather than changing page', async () => {
    const r = await app(async () => {
      // A sheet closed from the UI unwinds its history entry with
      // history.back(), whose popstate arrives a moment later; let any from the
      // cases above land first so this one sees only the event it sends.
      for (let i = 0; i < 100 && ignoreSheetPopStates > 0; i++) await new Promise((res) => setTimeout(res, 10));
      const before = currentPageId;
      const sheet = document.getElementById('prop-form-card');
      try {
        nav('properties', null, true);
        togglePropForm(true);
        // What the browser delivers when Back leaves the sheet's history entry.
        window.dispatchEvent(new PopStateEvent('popstate', { state: { page: 'properties' } }));
        return { closed: sheet.style.display === 'none', page: currentPageId };
      } finally {
        togglePropForm(false);
        history.replaceState({ page: currentPageId }, '', location.hash);
        nav(before, null, true);
      }
    });
    ok(r.closed, 'Back left the sheet open');
    eq(r.page, 'properties', 'Back changed page instead of closing the sheet');
  });

  test('a cancelled or refused delete leaves the form open', async () => {
    // It used to close the form whatever happened — so saying "no" to
    // "Delete this tenant?" also threw away the edits in front of you.
    const r = await app(async () => {
      const id = 'test_ui_tenant_1';
      const realConfirm = window.confirm;
      await dbPut('tenants', {
        id, tenantName: 'Keep Me', propertyId: '', propertyAddress: '', status: 'Current',
        synced: false, pendingDelete: false, createdAt: '2099-01-01T00:00:00Z'
      });
      try {
        await editTenant(id);
        window.confirm = () => false;
        await deleteTenantFromForm();
        const stillOpen = document.getElementById('tenant-form-card').style.display === 'block';
        const stillThere = !!(await dbGet('tenants', id));
        return { stillOpen, stillThere };
      } finally {
        window.confirm = realConfirm;
        await toggleTenantForm(false);
        await dbDelete('tenants', id);
      }
    });
    ok(r.stillThere, 'the tenant was deleted after the confirmation was cancelled');
    ok(r.stillOpen, 'the form closed although nothing was deleted');
  });

  /* ---- inspections: the draft outlives the sheet ------------------------- */

  test('closing a new inspection keeps its draft; closing an edit discards the edit', async () => {
    const r = await app(async () => {
      const id = 'test_ui_insp_1';
      const realConfirm = window.confirm;
      const notes = () => document.querySelector('#insp-areas .area-notes').value;
      try {
        resetInspectionForm();
        toggleInspectionForm(true);
        const field = document.querySelector('#insp-areas .area-notes');
        field.value = 'Mould behind the fridge';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        closeInspectionForm();
        const keptAfterClose = notes();
        toggleInspectionForm(true);
        const keptOnReopen = notes();
        closeInspectionForm();

        await dbPut('inspections', {
          id, propertyId: '', property: '9 Edit Test St', date: '01/01/2026',
          areas: [{ name: 'Kitchen', status: 'Good', notes: 'Saved note', photos: [] }],
          synced: true, pendingDelete: false, createdAt: '2000-01-01T00:00:00Z'
        });
        let asked = 0;
        window.confirm = () => { asked++; return true; }; // "discard the draft and open this one"
        await editInspection(id);
        const editing = editingInspectionId === id && notes() === 'Saved note';
        closeInspectionForm();
        return {
          keptAfterClose, keptOnReopen, asked, editing,
          afterEdit: { editing: editingInspectionId, notes: notes(), open: document.getElementById('insp-form-card').style.display }
        };
      } finally {
        window.confirm = realConfirm;
        await dbDelete('inspections', id);
        resetInspectionForm();
      }
    });
    eq(r.keptAfterClose, 'Mould behind the fridge', 'closing a new inspection lost its notes');
    eq(r.keptOnReopen, 'Mould behind the fridge');
    eq(r.asked, 1, 'opening a saved inspection over a started draft should ask once');
    ok(r.editing, 'the saved inspection did not load');
    eq(r.afterEdit.editing, null, 'closing an edit should drop it');
    eq(r.afterEdit.notes, '', 'the abandoned edit is still in the form');
    eq(r.afterEdit.open, 'none');
  });

  /* ---- pickers ------------------------------------------------------------ */

  test('a property picker starts on "Select a property…", not on some address', async () => {
    // A pre-selected first address is how a record gets filed against the
    // wrong property without anyone noticing. Every save refuses an empty one.
    const r = await app(async () => {
      const id = 'test_ui_prop_4';
      await dbPut('properties', {
        id, address: '4 Picker Test St', tenancy: 'Long-term', status: 'Occupied', complianceItems: {},
        synced: true, pendingDelete: false, createdAt: '2099-01-04T00:00:00Z'
      });
      try {
        await populateTenantPropertyDropdown();
        await populateMaintenancePropertyDropdown();
        const t = document.getElementById('tenant-property');
        const m = document.getElementById('maint-property');
        return { tenant: t.value, tenantFirst: t.options[0].value, maint: m.value, maintFirst: m.options[0].value };
      } finally {
        await dbDelete('properties', id);
      }
    });
    eq(r.tenant, '');
    eq(r.tenantFirst, '');
    eq(r.maint, '');
    eq(r.maintFirst, '');
  });

  test('properties in a picker sort by street, not by house number', async () => {
    const order = await app(() => sortedProperties([
      { address: '8 Riccarton Road, Riccarton' },
      { address: '77 Fendalton Road, Fendalton' },
      { address: "5 O'Connell Street, Sydenham" },
      { address: '2/14 Ilam Road, Ilam' },
      { address: '14 Ilam Road, Ilam' }
    ]).map((p) => p.address));
    deepEq(order, [
      '77 Fendalton Road, Fendalton',
      '2/14 Ilam Road, Ilam',
      '14 Ilam Road, Ilam',
      "5 O'Connell Street, Sydenham",
      '8 Riccarton Road, Riccarton'
    ]);
  });

  /* ---- feedback ------------------------------------------------------------ */

  test('the sync banner is silent when nothing is waiting, and speaks when something is', async () => {
    const r = await app(() => {
      const banner = document.createElement('div');
      const status = document.createElement('span');
      const pending = document.createElement('span');
      applySyncBannerState(banner, status, pending, [{ synced: true }]);
      const idleWhenClean = banner.classList.contains('sync-idle');
      applySyncBannerState(banner, status, pending, [{ synced: true }, { synced: false }]);
      return { idleWhenClean, idleWhenPending: banner.classList.contains('sync-idle'), text: pending.textContent };
    });
    ok(r.idleWhenClean);
    notOk(r.idleWhenPending, 'a page with a change waiting hid its banner');
    eq(r.text, '1 change waiting to sync');
  });

  test('a local change marks every other page stale and leaves the one on screen alone', async () => {
    // Before this, an edit made with no signal did not reach the dashboard
    // until the next sync marked it stale.
    const r = await app(() => {
      const before = currentPageId;
      try {
        currentPageId = 'properties';
        staleModules.clear();
        const version = dataVersion;
        noteLocalDataChange();
        return {
          bumped: dataVersion === version + 1,
          onScreen: staleModules.has('properties'),
          dashboard: staleModules.has('dashboard'),
          tenants: staleModules.has('tenants')
        };
      } finally {
        currentPageId = before;
        staleModules.clear();
      }
    });
    ok(r.bumped, 'dataVersion did not move');
    notOk(r.onScreen, 'the page on screen is redrawn by whatever changed it, not marked stale');
    ok(r.dashboard, 'the dashboard would show the old state');
    ok(r.tenants);
  });

  test('a toast shows its message as text, never as markup', async () => {
    const r = await app(() => {
      const region = document.getElementById('toast-region');
      showToast('<img src=x onerror="window.__toastHit=1">Saved');
      const out = { imgs: region.querySelectorAll('img').length, text: region.lastElementChild.textContent };
      region.innerHTML = '';
      return out;
    });
    eq(r.imgs, 0, 'markup in a toast message was parsed');
    ok(r.text.includes('<img'), 'the message text was lost');
  });
};
