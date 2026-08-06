// CLAUDE.md flags pagination and the delete guard as looking redundant and
// not being. getListPage also clamps the stored page, which is what stops a
// list going blank after deletions shrink it below the page you were on.
//
// getListPage mutates the shared pageState, so every case resets the key it
// uses rather than relying on the order suites happen to run in.

export const name = 'pagination';

// Runs getListPage against a synthetic list of the requested size, starting
// from an explicit page, and reports what came back plus where the clamp
// landed. Returns ids rather than objects to keep failures readable.
const page = ({ key, total, startPage }) => {
  pageState[key] = startPage;
  const all = Array.from({ length: total }, (_, i) => ({ id: i }));
  const got = getListPage(key, all);
  return { ids: got.map((x) => x.id), landedOn: pageState[key], pageSize: PAGINATION_CONFIG[key].pageSize };
};

export default ({ test, app, eq, deepEq }) => {
  test('lists paginate at 10 and the activity log at 20', async () => {
    eq(await app(() => PAGINATION_CONFIG.properties.pageSize), 10);
    eq(await app(() => PAGINATION_CONFIG.statements.pageSize), 10);
    eq(await app(() => PAGINATION_CONFIG.activity.pageSize), 20);
  });

  test('page 1 returns the first pageSize items', async () => {
    const r = await app(page, { key: 'properties', total: 25, startPage: 1 });
    deepEq(r.ids, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('page 2 returns the next slice', async () => {
    const r = await app(page, { key: 'properties', total: 25, startPage: 2 });
    deepEq(r.ids, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  test('the final page returns only the remainder', async () => {
    const r = await app(page, { key: 'properties', total: 25, startPage: 3 });
    deepEq(r.ids, [20, 21, 22, 23, 24]);
  });

  test('a page past the end clamps to the last page rather than returning nothing', async () => {
    // This is the case that matters: you are on page 3, you delete enough
    // records that only one page remains, and the list must not go blank.
    const r = await app(page, { key: 'properties', total: 12, startPage: 9 });
    eq(r.landedOn, 2);
    deepEq(r.ids, [10, 11]);
  });

  test('a page below 1 clamps to 1', async () => {
    const r = await app(page, { key: 'properties', total: 25, startPage: 0 });
    eq(r.landedOn, 1);
    deepEq(r.ids, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('an empty list yields an empty page, not an error', async () => {
    const r = await app(page, { key: 'properties', total: 0, startPage: 3 });
    eq(r.landedOn, 1);
    deepEq(r.ids, []);
  });

  test('a list that exactly fills one page does not create a second', async () => {
    const r = await app(page, { key: 'properties', total: 10, startPage: 2 });
    eq(r.landedOn, 1);
    deepEq(r.ids, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('the clamped page is written back, so the next render agrees', async () => {
    // getListPage is the only thing that corrects pageState. If it returned a
    // clamped slice without storing the clamp, the pagination controls would
    // keep highlighting a page that no longer exists.
    const landed = await app(({ key, total, startPage }) => {
      pageState[key] = startPage;
      getListPage(key, Array.from({ length: total }, (_, i) => ({ id: i })));
      return pageState[key];
    }, { key: 'invoices', total: 5, startPage: 7 });
    eq(landed, 1);
  });
};
