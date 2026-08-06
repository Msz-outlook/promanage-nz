// The Financials page derives the agency's own books from Owner Statements:
// agency revenue is the management fee, not the owner's rent. Every statement
// expense line is sorted into fee / gst / recovery / disbursement by keyword
// match, and a line landing in the wrong bucket moves money between "our
// revenue" and "money we passed through to a tradesperson".
//
// These cases pin the classifier's real behaviour, including the two subtle
// rules that are easy to break by "tidying" the keyword lists: the third-party
// vendor marker overriding a fee match, and the ordering dependence in
// categorizeExpenseDescription.

export const name = 'financials';

export default ({ test, app, eq }) => {
  test('GST rate is 15%', async () => {
    eq(await app(() => GST_RATE), 0.15);
  });

  test('GST lines are recognised by their prefix', async () => {
    eq(await app(() => classifyStatementExpenseLine('GST for management fees')), 'gst');
    eq(await app(() => classifyStatementExpenseLine('GST for expense / other fees')), 'gst');
  });

  test('agency fee lines are classified as fees', async () => {
    for (const d of ['Management fee', 'Letting fee', 'Admin fee', 'Inspection report fee']) {
      eq(await app((x) => classifyStatementExpenseLine(x), d), 'fee', d);
    }
  });

  test('cost recoveries are their own bucket, not fees', async () => {
    // These are agency spend recharged to the owner — revenue-neutral, so
    // counting them as fee income would overstate what the agency earned.
    for (const d of ['Advertising', 'TradeMe listing fee', 'Credit check']) {
      eq(await app((x) => classifyStatementExpenseLine(x), d), 'recovery', d);
    }
  });

  test('a third-party vendor marker overrides a fee keyword', async () => {
    // "Management fee" alone is agency revenue. The same words with an em dash
    // or an invoice number are a vendor line passed through to the owner, and
    // must not be counted as the agency's income.
    eq(await app(() => classifyStatementExpenseLine('Management fee')), 'fee');
    eq(await app(() => classifyStatementExpenseLine('Management fee — ABC Property Ltd')), 'disbursement');
    eq(await app(() => classifyStatementExpenseLine('Repairs (inv 4471)')), 'disbursement');
    eq(await app(() => classifyStatementExpenseLine('Plumbing (12345)')), 'disbursement');
  });

  test('CURRENT BEHAVIOUR: an unrecognised line falls through to disbursement', async () => {
    // Documented in docs/REVIEW-2026-08.md as finding 13. There is no
    // "unclassified" state — a line the keyword lists do not know becomes a
    // pass-through, silently understating agency revenue. Pinned here so the
    // planned "Unreviewed lines" panel is a visible change in behaviour.
    eq(await app(() => classifyStatementExpenseLine('Sundry charge from the owner')), 'disbursement');
    eq(await app(() => classifyStatementExpenseLine('')), 'disbursement');
  });

  test('expense categories match on keyword', async () => {
    const cases = [
      ['Lawn mowing', 'Garden & grounds maintenance'],
      ['End of tenancy clean', 'Cleaning'],
      ['Smoke alarm check', 'Compliance & inspections'],
      ['Landlord insurance premium', 'Insurance'],
      ['Council rates', 'Rates & council'],
      ['Solicitor letter', 'Legal & professional fees'],
      ['Rodent treatment', 'Pest control']
    ];
    for (const [input, expected] of cases) {
      eq(await app((x) => categorizeExpenseDescription(x), input), expected, input);
    }
  });

  test('category matching is first-rule-wins, not best-match', async () => {
    // "Ceiling insulation replacement" contains both 'replace' (Repairs) and
    // 'insulation' (Compliance). Repairs is earlier in the list, so it wins.
    // Reordering EXPENSE_CATEGORY_RULES silently re-buckets historical lines,
    // which is why this is pinned rather than left to inference.
    eq(await app(() => categorizeExpenseDescription('Ceiling insulation replacement')),
       'Repairs & maintenance');
    eq(await app(() => categorizeExpenseDescription('Ceiling insulation upgrade')),
       'Compliance & inspections');
  });

  test('an unmatched description is categorised as Other', async () => {
    eq(await app(() => categorizeExpenseDescription('Miscellaneous')), 'Other');
  });

  test('management fees keep a category of their own in the pass-through table', async () => {
    // Deliberate, per the comment above EXPENSE_CATEGORY_RULES: a genuine fee
    // line that escapes the classifier surfaces under an obviously-wrong
    // heading instead of hiding inside "Other".
    eq(await app(() => categorizeExpenseDescription('Management fee — ABC Property Ltd')),
       'Property management fees');
  });

  // --- the "Unreviewed lines" panel: renderFinancials() end to end ---
  //
  // Fixes the CURRENT BEHAVIOUR case above from a silent miscount into a
  // visible one. A line only belongs here if it matched NOTHING anywhere in
  // the classifier — an ordinary, correctly-identified pass-through expense
  // (a plumber's invoice matching 'repair') must not show up just because it
  // landed in 'disbursement'; that classification is correct, not unreviewed.

  test('a line matching no rule anywhere appears in the panel; a correctly-categorised disbursement does not', async () => {
    const r = await app(async () => {
      await dbClear('statements');
      await dbPut('statements', {
        id: 'test_fin1', statementNumber: 'STMT-TEST-0001', ownerName: 'Test Owner',
        periodStart: '2026-01-01', periodEnd: '2026-01-31',
        properties: [{
          propertyId: '', propertyAddress: '12 Test St',
          income: [{ description: 'Rent', amount: 500 }],
          expenses: [
            { description: 'Management fee', amount: 50 },                    // fee — excluded
            { description: 'Lawn mowing', amount: 40 },                       // disbursement, categorised — excluded
            { description: 'Some odd charge nobody wrote a rule for', amount: 15 } // disbursement, Other — included
          ],
          openingBalance: 0, totalIncome: 500, totalExpenses: 105, netAmount: 395, closingBalance: 395
        }],
        totalIncome: 500, totalExpenses: 105, netAmount: 395, closingBalance: 395,
        synced: true, pendingDelete: false
      });
      try {
        await renderFinancials();
        return {
          visible: document.getElementById('fin-unreviewed-card').style.display,
          count: document.getElementById('fin-unreviewed-count').textContent,
          rows: Array.from(document.querySelectorAll('#fin-unreviewed-body tr'))
            .map((tr) => Array.from(tr.children).map((td) => td.textContent.trim()))
        };
      } finally {
        await dbClear('statements');
      }
    });
    eq(r.visible, 'block');
    eq(r.count, '(1)');
    eq(r.rows.length, 1);
    eq(r.rows[0][0], 'STMT-TEST-0001');
    eq(r.rows[0][1], '12 Test St');
    eq(r.rows[0][2], 'Some odd charge nobody wrote a rule for');
    eq(r.rows[0][3], '$15.00');
  });

  test('the panel stays hidden when every line matched a known category', async () => {
    const r = await app(async () => {
      await dbClear('statements');
      await dbPut('statements', {
        id: 'test_fin2', statementNumber: 'STMT-TEST-0002', ownerName: 'Test Owner',
        periodStart: '2026-02-01', periodEnd: '2026-02-28',
        properties: [{
          propertyId: '', propertyAddress: '14 Test St',
          income: [{ description: 'Rent', amount: 500 }],
          expenses: [
            { description: 'Management fee', amount: 50 },
            { description: 'Lawn mowing', amount: 40 }
          ],
          openingBalance: 0, totalIncome: 500, totalExpenses: 90, netAmount: 410, closingBalance: 410
        }],
        totalIncome: 500, totalExpenses: 90, netAmount: 410, closingBalance: 410,
        synced: true, pendingDelete: false
      });
      try {
        await renderFinancials();
        return document.getElementById('fin-unreviewed-card').style.display;
      } finally {
        await dbClear('statements');
      }
    });
    eq(r, 'none');
  });
};
