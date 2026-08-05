// Inspection photos live in a PRIVATE Storage bucket and are held in records
// as "storage:<path>" references, signed at display time. CLAUDE.md is explicit
// that this must not be relaxed: the paths are guessable from the address and
// inspection id, and "storage:" is deliberately not loadable by <img src> so a
// missed resolver step fails loudly instead of leaking a link.
//
// extractStoragePath is the compatibility seam. It has to keep reading the two
// legacy URL shapes from when the bucket was public, while refusing anything
// that is not yet uploaded.

export const name = 'storage-refs';

export default ({ test, app, eq, ok }) => {
  test('addresses become filesystem-safe path segments', async () => {
    eq(await app(() => sanitizeForPath('12 Bealey Ave, Christchurch')), '12_Bealey_Ave_Christchurch');
  });

  test('runs of punctuation collapse to a single underscore', async () => {
    eq(await app(() => sanitizeForPath('Flat 2 / 14  Papanui Rd')), 'Flat_2_14_Papanui_Rd');
  });

  test('a macron in a street name is not silently dropped from the middle', async () => {
    // Ōtākaro, Pōhutukawa etc. are ordinary Christchurch street names. Non-ASCII
    // becomes an underscore rather than vanishing, so two different streets
    // cannot collapse onto the same storage path.
    eq(await app(() => sanitizeForPath('Ōtākaro Ave')), '_t_karo_Ave');
  });

  test('a storage ref round-trips through photoRefFor and extractStoragePath', async () => {
    eq(await app(() => extractStoragePath(photoRefFor('12_Bealey_Ave/insp_1/area0-photo0.jpg'))),
       '12_Bealey_Ave/insp_1/area0-photo0.jpg');
  });

  test('the prefix is "storage:"', async () => {
    eq(await app(() => PHOTO_REF_PREFIX), 'storage:');
    eq(await app(() => photoRefFor('a/b.jpg')), 'storage:a/b.jpg');
  });

  test('a data URL has no storage path — it is not uploaded yet', async () => {
    // Returning a path here would make the sync think an unsent photo was
    // already in the bucket.
    eq(await app(() => extractStoragePath('data:image/jpeg;base64,/9j/4AAQSkZJRg==')), null);
  });

  test('null, undefined and non-strings are refused', async () => {
    eq(await app(() => extractStoragePath(null)), null);
    eq(await app(() => extractStoragePath(undefined)), null);
    eq(await app(() => extractStoragePath('')), null);
    eq(await app(() => extractStoragePath(42)), null);
  });

  test('legacy public URLs from when the bucket was public still resolve', async () => {
    eq(await app(() => extractStoragePath(
      CONFIG.SUPABASE_URL + '/storage/v1/object/public/' + CONFIG.STORAGE_BUCKET + '/addr/insp/a0-p0.jpg'
    )), 'addr/insp/a0-p0.jpg');
  });

  test('legacy signed URLs resolve, with the query string stripped', async () => {
    // A signed URL carries ?token=...; keeping it would produce a path that
    // matches nothing in the bucket.
    eq(await app(() => extractStoragePath(
      CONFIG.SUPABASE_URL + '/storage/v1/object/sign/' + CONFIG.STORAGE_BUCKET + '/addr/insp/a0-p0.jpg?token=abc.def'
    )), 'addr/insp/a0-p0.jpg');
  });

  test('an unrelated URL yields no path', async () => {
    eq(await app(() => extractStoragePath('https://example.com/some/other/image.jpg')), null);
  });

  test('the configured bucket is the private one', async () => {
    eq(await app(() => CONFIG.STORAGE_BUCKET), 'inspection-photos');
    ok(await app(() => CONFIG.SUPABASE_URL.startsWith('https://')));
  });
};
