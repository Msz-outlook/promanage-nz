// escapeHtml / escapeAttr guard every interpolated value in the list
// renderers. Addresses, tenant names and statement descriptions are all user
// input rendered straight into innerHTML, so these two functions are the only
// thing between a tenant named `<img onerror=...>` and script execution.
//
// CLAUDE.md lists "escapeHtml on every interpolated value" as not to be
// simplified. These cases pin what it actually does — including what it
// deliberately does NOT escape, since the two functions are not
// interchangeable.

export const name = 'escaping';

export default ({ test, app, eq }) => {
  test('escapes the three HTML-significant characters', async () => {
    eq(await app(() => escapeHtml('<script>alert(1)</script>')),
       '&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('escapes & before < and >, so entities are not double-escaped', async () => {
    // If & were replaced after <, "&lt;" would come back out as "&amp;lt;".
    eq(await app(() => escapeHtml('&<>')), '&amp;&lt;&gt;');
  });

  test('a tenant name with an injection attempt is inert', async () => {
    eq(await app(() => escapeHtml('<img src=x onerror=alert(1)>')),
       '&lt;img src=x onerror=alert(1)&gt;');
  });

  test('null, undefined and empty string all become empty string', async () => {
    eq(await app(() => escapeHtml(null)), '');
    eq(await app(() => escapeHtml(undefined)), '');
    eq(await app(() => escapeHtml('')), '');
  });

  test('zero survives rather than being treated as empty', async () => {
    // A falsy-but-meaningful value: an amount of 0 must render as "0".
    eq(await app(() => escapeHtml(0)), '0');
  });

  test('escapeHtml does NOT escape quotes — it is for text, not attributes', async () => {
    // This is why escapeAttr exists separately. Using escapeHtml inside an
    // attribute would leave a quote free to close it.
    eq(await app(() => escapeHtml('say "hi"')), 'say "hi"');
  });

  test('escapeAttr escapes both quote styles and the ampersand', async () => {
    eq(await app(() => escapeAttr(`" onmouseover="alert(1)`)),
       '&quot; onmouseover=&quot;alert(1)');
    eq(await app(() => escapeAttr("it's")), 'it&#39;s');
    eq(await app(() => escapeAttr('a&b')), 'a&amp;b');
  });

  test('escapeAttr handles null and undefined', async () => {
    eq(await app(() => escapeAttr(null)), '');
    eq(await app(() => escapeAttr(undefined)), '');
  });

  test('an address with an apostrophe round-trips safely into an attribute', async () => {
    // O'Connell Street is a real Christchurch street; this is the ordinary
    // case, not an attack.
    eq(await app(() => escapeAttr("12 O'Connell St")), '12 O&#39;Connell St');
  });
};
