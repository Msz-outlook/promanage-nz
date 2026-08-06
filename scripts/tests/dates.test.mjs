// Date parsing feeds invoice issue/due dates and the statement date filters.
// parseFlexibleDate accepts several shapes because people type dates into
// these boxes by hand, so the accepted set is a behavioural contract worth
// pinning rather than an implementation detail.

export const name = 'dates';

// parseFlexibleDate returns a Date, which does not survive serialisation out
// of the page. Formatting it on the way out keeps assertions readable and
// exercises formatDateNZ at the same time.
const parseAndFormat = (raw) => {
  const d = parseFlexibleDate(raw);
  return d === null ? null : formatDateNZ(d);
};

export default ({ test, app, eq, deepEq, ok }) => {
  test('formats a date in the NZ convention with a padded day', async () => {
    eq(await app(() => formatDateNZ(new Date(2026, 7, 5))), '05 Aug 2026');
    eq(await app(() => formatDateNZ(new Date(2026, 11, 31))), '31 Dec 2026');
  });

  test('parses ISO yyyy-mm-dd', async () => {
    eq(await app(parseAndFormat, '2026-08-05'), '05 Aug 2026');
  });

  test('parses dd/mm/yyyy, not mm/dd/yyyy', async () => {
    // 5 August, not 8 May — NZ order. Getting this backwards would silently
    // shift every hand-typed date.
    eq(await app(parseAndFormat, '5/8/2026'), '05 Aug 2026');
    eq(await app(parseAndFormat, '05/08/2026'), '05 Aug 2026');
  });

  test('reads a 2-digit year as 20xx', async () => {
    eq(await app(parseAndFormat, '05/08/26'), '05 Aug 2026');
  });

  test('parses "5 Aug 2026" and longer month names', async () => {
    eq(await app(parseAndFormat, '5 Aug 2026'), '05 Aug 2026');
    eq(await app(parseAndFormat, '5 August 2026'), '05 Aug 2026');
  });

  test('month name matching is case-insensitive', async () => {
    eq(await app(parseAndFormat, '5 AUGUST 2026'), '05 Aug 2026');
    eq(await app(parseAndFormat, '5 aug 2026'), '05 Aug 2026');
  });

  test('returns null for input it cannot read', async () => {
    eq(await app(parseAndFormat, 'not a date'), null);
    eq(await app(parseAndFormat, ''), null);
    eq(await app(parseAndFormat, '5 Smarch 2026'), null);
  });

  test('adds days across a month boundary', async () => {
    eq(await app((d) => addDaysToDateStr(d, 20), '2026-08-25'), '14 Sep 2026');
  });

  test('adds days across a year boundary', async () => {
    eq(await app((d) => addDaysToDateStr(d, 7), '2026-12-28'), '04 Jan 2027');
  });

  test('handles February in a leap year', async () => {
    // 2028 is a leap year; 28 Feb + 1 day must be the 29th, not 1 March.
    eq(await app((d) => addDaysToDateStr(d, 1), '2028-02-28'), '29 Feb 2028');
  });

  test('a zero-day term returns the issue date unchanged', async () => {
    eq(await app((d) => addDaysToDateStr(d, 0), '2026-08-05'), '05 Aug 2026');
  });

  // Formerly pinned here as "CURRENT BEHAVIOUR: an unreadable date silently
  // becomes today" — docs/REVIEW-2026-08.md finding 14: a typo in an invoice
  // issue date reached this fallback and quietly re-dated the invoice to
  // today, with nothing telling the user it had happened.
  //
  // The fix is at the save boundary, not here: invoice-issue-date and
  // statement-period-start/end are free-typed text (not a native
  // <input type="date">), so validateDateField() now refuses to save when one
  // of them is non-empty and unparseable — see saveInvoice()/saveStatement().
  // addDaysToDateStr's own fallback is unchanged and stays correct for what
  // it actually is: a low-level utility whose other callers already guarantee
  // it a valid string (a fresh formatDateNZ(new Date()), or a value read back
  // out of a record this app itself wrote). This case now pins that intent
  // rather than flagging it as an open bug.
  test('addDaysToDateStr falls back to today for a caller that hands it garbage directly', async () => {
    const expected = await app(() => {
      const d = new Date();
      d.setDate(d.getDate() + 7);
      return formatDateNZ(d);
    });
    eq(await app((d) => addDaysToDateStr(d, 7), 'not a date'), expected);
  });

  test('validateDateField accepts empty and any parseable format', async () => {
    const r = await app(() => {
      document.body.insertAdjacentHTML('beforeend', '<input id="test_date_field">');
      const el = document.getElementById('test_date_field');
      const results = ['', '2026-08-05', '5/8/2026', '5 Aug 2026'].map((v) => {
        el.value = v;
        return validateDateField('test_date_field', 'test field');
      });
      el.remove();
      return results;
    });
    deepEq(r, [true, true, true, true]);
  });

  test('validateDateField refuses a non-empty unparseable date and alerts why', async () => {
    const r = await app(() => {
      document.body.insertAdjacentHTML('beforeend', '<input id="test_date_field" value="25 Jly 2026">'); // typo
      const realAlert = window.alert;
      let message = null;
      window.alert = (m) => { message = m; };
      try {
        const ok = validateDateField('test_date_field', 'the issue date');
        return { ok, message };
      } finally {
        window.alert = realAlert;
        document.getElementById('test_date_field').remove();
      }
    });
    eq(r.ok, false);
    ok(/25 Jly 2026/.test(r.message) && /issue date/.test(r.message), r.message);
  });
};
