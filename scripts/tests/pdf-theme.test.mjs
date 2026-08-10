// The three PDF generators are styled from one token block, MODERNIST, ported
// from the Claude Design "Modernist" system. These cases are the PDF-side
// counterpart to theme.test.mjs: that suite fails when a CSS rule names a
// colour outside the token blocks, and this one fails when a generator does.
//
// The failure mode is the same one dark mode surfaced in the stylesheet. A hex
// written directly into a draw call looks perfect to whoever added it — they
// only ever saw it next to the palette it happened to match — and the drift is
// invisible until someone puts an invoice and a statement side by side. Three
// generators sharing one palette by convention is exactly how the old
// blue/slate/teal split happened in the first place.
//
// Every case reads the real, loaded generator file rather than a copy: the
// suites run against the page, so a fetch here is the same file the browser
// executed.

export const name = 'pdf-theme';

// Hexes that are legitimately not palette colours: pure white and pure black
// are structural (paper, and the [255,255,255] autoTable expects for fills),
// not brand values.
const STRUCTURAL = /^#?(fff(fff)?|000(000)?)$/i;

export default ({ test, app, eq, deepEq, ok, notOk }) => {
  const source = () => app(async () => {
    const res = await fetch('reports/pdf-reports.js');
    return await res.text();
  });

  /* Comments are prose about the code, not code. They name colours, say what
     char spacing is for, and quote the template's "Statement №" to explain
     why it can't be used — all of which the scans below would otherwise read
     as violations. Strip them first so each case tests what actually runs. */
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const channel = (hex, i = 1) => parseInt(hex.slice(i, i + 2), 16);

  test('the token block resolves the design system\'s own values', async () => {
    const c = await app(async () => { await loadPdfEngine(); return MODERNIST.color; });
    eq(c.text, '#201e1d', 'Modernist --color-text');
    eq(c.accent, '#ec3013', 'Modernist --color-accent');
    eq(c.accent700, '#ae1800', 'Modernist --color-accent-700');
  });

  test('color-mix() tokens are pre-blended against white paper, not left translucent', async () => {
    // A PDF has no alpha compositing for text, so --color-divider and the
    // muted greys have to be resolved to flat hex at token time. Paper is
    // white on purpose: a full-bleed --color-bg tint either drops out when
    // printed or burns toner on every page of a document built to be filed.
    const r = await app(async () => {
      await loadPdfEngine();
      return { divider: MODERNIST.color.divider, muted55: MODERNIST.color.muted55, mixed: MODERNIST.mix('#201e1d', 0.4) };
    });
    eq(r.divider, r.mixed, 'divider is text at 40%');
    ok(/^#[0-9a-f]{6}$/.test(r.divider), 'resolved to flat hex: ' + r.divider);
    // More of the (dark) ink mixed in means a darker result, so the 55% grey
    // must sit below the 40% divider on every channel.
    ok(channel(r.muted55) < channel(r.divider),
       `muted55 (${r.muted55}) should be darker than divider (${r.divider})`);
  });

  test('px sizes convert at the 96dpi ratio the template was drawn at', async () => {
    // The template is a 0.6in-margin A4 doc-page, so its CSS pixel grid maps
    // to PDF points at exactly 1px = 0.75pt. Break this and every size in all
    // three generators is silently wrong together.
    const r = await app(async () => { await loadPdfEngine(); return { px: MODERNIST.PX, of44: MODERNIST.px(44), major: MODERNIST.rule.major }; });
    eq(r.px, 0.75);
    eq(r.of44, 33, '44px title');
    eq(r.major, 1.5, 'a 2px rule is 1.5pt');
  });

  test('no generator hard-codes a palette colour outside the token block', async () => {
    const src = stripComments(await source());
    // Everything above the first IIFE is the MODERNIST block itself, which is
    // where the literals are supposed to live.
    const body = src.slice(src.indexOf('(function (global)'));
    const offenders = [];
    body.split('\n').forEach((line, i) => {
      (line.match(/#[0-9a-fA-F]{3,6}\b/g) || []).forEach((hex) => {
        if (!STRUCTURAL.test(hex)) offenders.push(`line ${i + 1}: ${hex} — ${line.trim().slice(0, 72)}`);
      });
    });
    deepEq(offenders, [], 'colours belong in MODERNIST, not in a draw call');
  });

  test('all three generators draw from the shared block', async () => {
    // A generator that stops reading MODERNIST would pass the case above by
    // simply having no colours left to find.
    const src = await source();
    const iifes = src.split('(function (global)').slice(1);
    eq(iifes.length, 3, 'three generators');
    iifes.forEach((body, i) => {
      ok(/MODERNIST\./.test(body), `generator ${i + 1} reads the shared tokens`);
    });
  });

  test('char spacing never leaks onto tabular currency', async () => {
    /* setCharSpace is document state, not a per-call argument: a tracked
       uppercase label that fails to reset it widens everything drawn after,
       including autoTable's cells — which is how a column of right-aligned
       money stops lining up.

       Counting setCharSpace(0) against its non-zero calls proved far too
       loose to catch that (deleting a real reset still passed, because the
       post-table safety resets padded the count). So this instruments jsPDF
       instead and asserts on what actually reached the page.

       "Untracked" applies to TABULAR currency — the table columns and the
       balance strips, where figures have to align down a column. One
       exception is deliberate: the hero total in the accent block carries the
       template's own letter-spacing:-.03em, because at 52px it reads as a
       display number rather than a column entry. It is pinned below rather
       than merely excluded, so losing it fails too. */
    const r = await app(async () => {
      await loadPdfEngine();
      // Defined in here, not in the test file's scope: app() is page.evaluate,
      // so the callback closes over nothing from this module.
      const DISPLAY_PT = 30;  // between the balance figures (12pt) and the hero (39pt)
      /* jsPDF assigns text/setCharSpace as OWN properties on each instance,
         not onto the prototype — patching the prototype silently intercepts
         nothing and the case passes without testing anything. Wrap the
         constructor and patch the instance it hands back instead. */
      const RealPDF = jspdf.jsPDF;
      const bad = [];
      let drawn = 0, displayTracked = 0;
      function Wrapped() {
        const doc = new RealPDF(...arguments);
        const realText = doc.text;
        doc.text = function (str) {
          const s = Array.isArray(str) ? str.join(' ') : String(str);
          if (/^\$[\d,]/.test(s)) {
            const cs = doc.getCharSpace();
            if (doc.getFontSize() >= DISPLAY_PT) {
              if (cs < 0) displayTracked++;
            } else {
              drawn++;
              if (cs !== 0) bad.push({ text: s, pt: doc.getFontSize(), charSpace: cs });
            }
          }
          return realText.apply(doc, arguments);
        };
        return doc;
      }
      Wrapped.prototype = RealPDF.prototype;
      jspdf.jsPDF = Wrapped;
      try {
        await StatementReport.generate({
          statementNumber: '27', periodStart: '01 Jul 2026', periodEnd: '31 Jul 2026', status: 'Paid',
          from: { name: 'Test Ltd' }, owner: { name: 'Test Owner' },
          properties: [{
            propertyAddress: '1 Test St', openingBalance: 0,
            income: [{ date: '01 Jul 2026', description: 'Rent', amount: 650 }],
            expenses: [{ date: '31 Jul 2026', description: 'Management Fees', amount: 50 }],
            totalIncome: 650, totalExpenses: 50, netAmount: 600, closingBalance: 600
          }],
          openingBalance: 0, totalIncome: 650, totalExpenses: 50, netAmount: 600, closingBalance: 600
        }, { download: false });
      } finally {
        jspdf.jsPDF = RealPDF;
      }
      return { bad, drawn, displayTracked };
    });
    // Guard the guard: if the instrumentation stops intercepting, this case
    // would otherwise report a clean pass having measured nothing at all.
    ok(r.drawn > 0, 'the instrumentation actually saw tabular currency being drawn');
    deepEq(r.bad, [], 'tabular currency must be drawn with char spacing at 0');
    eq(r.displayTracked, 1, 'the hero total keeps the template\'s negative tracking');
  });

  test('U+2116 never reaches a generator — WinAnsi has no numero sign', async () => {
    // jsPDF's built-in Helvetica is WinAnsi-encoded. "№" is not in it and
    // renders as "!" rather than failing, so the template's "Statement №"
    // has to be written "Statement No.". En/em dashes and · ARE in WinAnsi.
    notOk(/№/.test(stripComments(await source())), 'use "No." instead');
  });

  test('every generator still produces a PDF after the restyle', async () => {
    const r = await app(async () => {
      await loadPdfEngine();
      const head = async (blob) => new Uint8Array(await blob.slice(0, 5).arrayBuffer())
        .reduce((s, b) => s + String.fromCharCode(b), '');
      const statement = await StatementReport.generate({
        statementNumber: '27', periodStart: '01 Jul 2026', periodEnd: '31 Jul 2026', status: 'Paid',
        from: { name: 'Test Ltd' }, owner: { name: 'Test Owner' },
        properties: [{
          propertyAddress: '1 Test St', openingBalance: 0,
          income: [{ date: '01 Jul 2026', description: 'Rent', amount: 650 }],
          expenses: [{ date: '31 Jul 2026', description: 'Management Fees', amount: 50 }],
          totalIncome: 650, totalExpenses: 50, netAmount: 600, closingBalance: 600
        }],
        openingBalance: 0, totalIncome: 650, totalExpenses: 50, netAmount: 600, closingBalance: 600
      }, { download: false });
      const invoice = await InvoiceReport.generate({
        invoiceNumber: 'INV-1', issueDate: '31 Jul 2026', from: { name: 'Test Ltd' },
        billTo: { name: 'Test Owner' }, items: [{ description: 'Fee', quantity: 1, unitPrice: 50, amount: 50 }],
        subtotal: 50, gst: 7.5, total: 57.5
      }, { download: false });
      const findings = await FindingsReport.generate({
        title: 'Test Inspection', meta: { Site: '1 Test St' },
        findings: [{ item: 'Door', description: 'Sticking', photos: [] }]
      }, { download: false });
      return { s: await head(statement), i: await head(invoice), f: await head(findings) };
    });
    eq(r.s, '%PDF-', 'statement');
    eq(r.i, '%PDF-', 'invoice');
    eq(r.f, '%PDF-', 'findings report');
  });
};
