// Export/import exists because the Supabase project is on the Free plan, which
// keeps no automated backups — so this is the only thing that turns "the
// device and the server hold the same data one sync apart" into an actual
// second copy.
//
// The round-trip cases below write to the real IndexedDB in the page. They use
// ids prefixed `test_` and clean up after themselves, so they do not disturb
// the other suites or leave records behind.

export const name = 'backup';

// Builds a payload, wipes the store, imports, and reports what came back.
//
// importAllData asks two questions, and they do NOT mean the same thing: the
// first picks the mode (OK = replace, Cancel = merge), the second is the
// proceed/abort confirmation for whichever mode was chosen. Answering both
// with the same value makes the merge path abort on its own confirmation —
// so the stub answers the first with `replace` and then agrees.
const roundTrip = async ({ replace, seed, file }) => {
  const realConfirm = window.confirm, realAlert = window.alert;
  let asked = 0;
  window.confirm = () => (asked++ === 0 ? replace : true);
  window.alert = () => {};
  try {
    await dbClear('properties');
    for (const r of seed) await dbPut('properties', r);
    await importAllData(new File([JSON.stringify(file)], 'b.json', { type: 'application/json' }));
    const after = await dbGetAll('properties');
    return after.map((r) => ({ id: r.id, address: r.address })).sort((a, b) => a.id.localeCompare(b.id));
  } finally {
    window.confirm = realConfirm;
    window.alert = realAlert;
    await dbClear('properties');
  }
};

const backupFile = (properties) => ({
  format: 1,
  exportedAt: '2026-08-05T00:00:00.000Z',
  includesPhotos: false,
  data: { properties }
});

export default ({ test, app, eq, deepEq, ok }) => {
  test('formats byte sizes at each magnitude', async () => {
    eq(await app(() => formatBytes(0)), '0 B');
    eq(await app(() => formatBytes(512)), '512 B');
    eq(await app(() => formatBytes(2048)), '2 KB');
    eq(await app(() => formatBytes(5 * 1024 * 1024)), '5.0 MB');
    eq(await app(() => formatBytes(2 * 1024 * 1024 * 1024)), '2.00 GB');
  });

  test('an unknown size renders as a dash rather than NaN', async () => {
    eq(await app(() => formatBytes(undefined)), '—');
    eq(await app(() => formatBytes(null)), '—');
  });

  test('the backup filename is dated and marks whether photos are included', async () => {
    ok(await app(() => /^promanage-backup-\d{4}-\d{2}-\d{2}\.json$/.test(backupFileName(false))));
    ok(await app(() => /^promanage-backup-\d{4}-\d{2}-\d{2}-with-photos\.json$/.test(backupFileName(true))));
  });

  test('the export covers every local store', async () => {
    // A store missing from the export is data that silently does not come
    // back. Tie the two lists together so adding a store to LOCAL_STORES
    // without thinking about backup fails here.
    const stores = await app(() => LOCAL_STORES);
    deepEq(stores.slice().sort(), [
      'activityLog', 'emailTriage', 'inspections', 'invoices',
      'maintenance', 'properties', 'statements', 'tenants'
    ]);
  });

  test('replace makes the device match the file exactly', async () => {
    const after = await app(roundTrip, {
      replace: true,
      seed: [{ id: 'test_keep', address: 'On device only' }],
      file: backupFile([{ id: 'test_a', address: 'From file' }])
    });
    deepEq(after, [{ id: 'test_a', address: 'From file' }]);
  });

  test('merge keeps device records the file does not mention', async () => {
    const after = await app(roundTrip, {
      replace: false,
      seed: [{ id: 'test_keep', address: 'On device only' }],
      file: backupFile([{ id: 'test_a', address: 'From file' }])
    });
    deepEq(after, [
      { id: 'test_a', address: 'From file' },
      { id: 'test_keep', address: 'On device only' }
    ]);
  });

  test('merge overwrites a device record with the file copy of the same id', async () => {
    const after = await app(roundTrip, {
      replace: false,
      seed: [{ id: 'test_a', address: 'Stale local copy' }],
      file: backupFile([{ id: 'test_a', address: 'Restored copy' }])
    });
    deepEq(after, [{ id: 'test_a', address: 'Restored copy' }]);
  });

  test('records without an id are skipped rather than corrupting the store', async () => {
    // dbPut uses keyPath 'id'; putting an id-less object throws and would
    // abort the whole restore part-way.
    const after = await app(roundTrip, {
      replace: true,
      seed: [],
      file: backupFile([{ address: 'No id' }, { id: 'test_a', address: 'Has id' }])
    });
    deepEq(after, [{ id: 'test_a', address: 'Has id' }]);
  });

  test('a file with no data section is refused', async () => {
    const refused = await app(async () => {
      const realAlert = window.alert;
      let message = null;
      window.alert = (m) => { message = m; };
      try {
        await importAllData(new File([JSON.stringify({ format: 1 })], 'b.json'));
        return message;
      } finally { window.alert = realAlert; }
    });
    ok(/does not look like a ProManage backup/.test(refused), refused);
  });

  test('a file that is not JSON is refused', async () => {
    const refused = await app(async () => {
      const realAlert = window.alert;
      let message = null;
      window.alert = (m) => { message = m; };
      try {
        await importAllData(new File(['not json at all'], 'b.json'));
        return message;
      } finally { window.alert = realAlert; }
    });
    ok(/not valid JSON/.test(refused), refused);
  });

  test('quota errors are recognised under both browser spellings', async () => {
    ok(await app(() => isQuotaError({ name: 'QuotaExceededError' })));
    ok(await app(() => isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })), 'Firefox spelling');
    ok(await app(() => !isQuotaError({ name: 'AbortError' })));
    ok(await app(() => !isQuotaError(null)));
  });
};
