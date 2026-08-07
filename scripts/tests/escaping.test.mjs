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

  /* --- escapeJsAttr: values inside inline event handlers ------------------
     Every list renderer writes onclick="fn('${id}')". That attribute is
     decoded twice — the HTML parser unescapes it, and only then is the result
     compiled as JavaScript — so escaping for HTML alone buys nothing: &#39;
     becomes an apostrophe again before the compiler ever sees it. Three of
     these renderers used escapeAttr and executed an id of "x'); ...; ('"
     anyway. Verified against the real page, not reasoned about. */

  test('escapeJsAttr neutralises the quote that closes the JS string', async () => {
    // escapeAttr's output decodes back to a bare apostrophe; this one decodes
    // to a backslash-escaped apostrophe, which stays inside the string.
    eq(await app(() => escapeJsAttr("x'); alert(1); ('")),
       "x\\'); alert(1); (\\'");
  });

  test('backslashes are escaped first, so they cannot escape the escape', async () => {
    // Without this, an input of  \'  would emit  \\'  — the backslash pairs
    // off and the apostrophe closes the string after all.
    eq(await app(() => escapeJsAttr("a\\'b")), "a\\\\\\'b");
  });

  test('a pre-encoded entity stays literal instead of decoding into a quote', async () => {
    // The reason HTML-escaping has to come last. If & were left alone, the
    // parser would turn &#39; into an apostrophe that the JS layer never saw.
    eq(await app(() => escapeJsAttr('a&#39;b')), 'a&amp;#39;b');
  });

  test('escapeJsAttr escapes double quotes for the surrounding attribute too', async () => {
    // The handler is written onclick="...", so an unescaped double quote would
    // close the attribute regardless of the JS string inside it.
    eq(await app(() => escapeJsAttr('a"b')), 'a\\&quot;b');
  });

  test('newlines cannot terminate the statement', async () => {
    eq(await app(() => escapeJsAttr('a\nb')), 'a\\nb');
    eq(await app(() => escapeJsAttr('a\rb')), 'a\\rb');
  });

  test('the JS line terminators U+2028 and U+2029 are escaped', async () => {
    // Legal whitespace in a string literal for JSON, but line terminators to
    // the JS parser — a classic way to break out of one.
    eq(await app(() => escapeJsAttr('a b')), 'a\\u2028b');
    eq(await app(() => escapeJsAttr('a b')), 'a\\u2029b');
  });

  test('angle brackets are escaped so the attribute cannot end the tag', async () => {
    eq(await app(() => escapeJsAttr('a<b>c')), 'a&lt;b&gt;c');
  });

  test('escapeJsAttr handles null and undefined', async () => {
    eq(await app(() => escapeJsAttr(null)), '');
    eq(await app(() => escapeJsAttr(undefined)), '');
  });

  test('an ordinary uuid passes through untouched', async () => {
    // The overwhelmingly common case must not be mangled.
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    eq(await app((s) => escapeJsAttr(s), id), id);
  });
};
