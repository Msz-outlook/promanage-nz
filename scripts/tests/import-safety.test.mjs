// importAllData is the one path where an arbitrary shape reaches IndexedDB.
// Everything else that writes a record built it from a form or from
// mapRemoteX(), so the renderers were written assuming the fields they read
// exist — and a record that broke that assumption blanked a whole page rather
// than dropping one row.
//
// The escaping fixes mean a hostile value can no longer execute. These pin the
// other half: a malformed one can no longer take a page down.

export const name = 'import-safety';

export default ({ test, app, eq, deepEq, ok, notOk }) => {
  test('a record needs a usable id to be imported at all', async () => {
    const kept = await app(() =>
      [
        { id: 'ok' },
        { id: 0 },              // falsy but real — must be kept
        { id: '' },             // unusable as a key
        { id: null },
        { id: undefined },
        {},
        null,
        'a string',
        ['an array'],
        42
      ].filter(isImportableRecord).map((r) => String(r.id))
    );
    deepEq(kept, ['ok', '0']);
  });

  test('an id is coerced to a string, matching every keyPath in the schema', async () => {
    eq(await app(() => typeof normaliseImportedRecord('properties', { id: 7 }).id), 'string');
    eq(await app(() => normaliseImportedRecord('properties', { id: 7 }).id), '7');
  });

  /* The specific crash. Five renderers sorted with
     b.createdAt.localeCompare(a.createdAt), which throws on a record without
     createdAt — but only once the list has three or more items, because below
     that V8 never puts the bad record in the b position. Two rows happened to
     survive, which is why this went unnoticed. */
  test('a missing createdAt becomes a sortable empty string', async () => {
    eq(await app(() => normaliseImportedRecord('properties', { id: 'a' }).createdAt), '');
    eq(await app(() => normaliseImportedRecord('properties', { id: 'a', createdAt: 42 }).createdAt), '');
  });

  test('a real createdAt is left exactly as it was', async () => {
    const iso = '2026-08-01T00:00:00Z';
    eq(await app((s) => normaliseImportedRecord('properties', { id: 'a', createdAt: s }).createdAt, iso), iso);
  });

  test('the activity log and triage get their own timestamp fields filled in', async () => {
    // Both sort on a different field from every other store.
    eq(await app(() => normaliseImportedRecord('activityLog', { id: 'a' }).timestamp), '');
    eq(await app(() => normaliseImportedRecord('emailTriage', { id: 'a' }).receivedAt), '');
    // …and inherit createdAt when it is the only timestamp present.
    eq(await app(() => normaliseImportedRecord('activityLog', { id: 'a', createdAt: 'X' }).timestamp), 'X');
  });

  test('collections the renderers index into are defaulted to arrays', async () => {
    // renderInspectionList did insp.areas.reduce(...) — a missing areas threw.
    deepEq(await app(() => normaliseImportedRecord('inspections', { id: 'a' }).areas), []);
    deepEq(await app(() => normaliseImportedRecord('invoices', { id: 'a' }).items), []);
    deepEq(await app(() => normaliseImportedRecord('statements', { id: 'a' }).properties), []);
    // A non-array in the field is just as broken as an absent one.
    deepEq(await app(() => normaliseImportedRecord('inspections', { id: 'a', areas: 'nope' }).areas), []);
  });

  test('a populated collection is preserved', async () => {
    const areas = await app(() =>
      normaliseImportedRecord('inspections', { id: 'a', areas: [{ name: 'Kitchen' }] }).areas
    );
    eq(areas.length, 1);
    eq(areas[0].name, 'Kitchen');
  });

  test('normalising fills gaps without inventing business data', async () => {
    // It must not manufacture an address, a rent or a status — a backup that
    // is missing those should look wrong, not plausible.
    const out = await app(() => normaliseImportedRecord('properties', { id: 'a' }));
    eq(out.address, undefined);
    eq(out.rentPerWeek, undefined);
    eq(out.status, undefined);
  });

  test('unrelated fields survive untouched', async () => {
    const out = await app(() =>
      normaliseImportedRecord('properties', { id: 'a', address: '1 High St', synced: true, bedrooms: 3 })
    );
    eq(out.address, '1 High St');
    eq(out.bedrooms, 3);
    ok(out.synced);
  });

  test('the three list renderers survive a record with no createdAt at 3+ rows', async () => {
    // The end-to-end version of the crash: below 3 items it never reproduced.
    const results = await app(async () => {
      const out = {};
      for (const [store, fn] of [
        ['properties', renderPropertiesList],
        ['tenants', renderTenantsList],
        ['invoices', renderInvoicesList]
      ]) {
        await dbClear(store);
        for (let i = 0; i < 5; i++) {
          const r = normaliseImportedRecord(store, {
            id: 'x' + i, address: 'A' + i, tenantName: 'T' + i, invoiceNumber: 'N' + i,
            billToName: 'B', status: 'Occupied', tenancy: 'Long-term',
            bedrooms: 1, bathrooms: 1, floorArea: 1, parking: 0, rentPerWeek: 1,
            complianceItems: {}, total: 0,
            ...(i === 2 ? {} : { createdAt: '2026-0' + (i + 1) + '-01T00:00:00Z' })
          });
          await dbPut(store, r);
        }
        try { await fn(); out[store] = 'ok'; }
        catch (e) { out[store] = 'THREW: ' + e.message; }
        await dbClear(store);
      }
      return out;
    });
    eq(results.properties, 'ok');
    eq(results.tenants, 'ok');
    eq(results.invoices, 'ok');
  });
};
