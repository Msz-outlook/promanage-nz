// jsPDF, jspdf-autotable and the three report generators are 438 KB that used
// to block the first paint to produce documents which do not exist until
// someone clicks a PDF button. loadPdfEngine() fetches them on demand instead.
//
// The cases here are about the parts that only run when something goes wrong,
// because the happy path is already covered by smoke-test.mjs (which asserts
// all four are absent at boot and present after a load). What smoke-test cannot
// reach is the failure behaviour: whether a PDF button reports a load failure
// in words, and — the one that matters — whether the archive path fails CLOSED
// when the engine will not load. The archive is the only code in the app that
// deletes photos from Storage on purpose, so an inspection must never be marked
// archived on the strength of a report that was never generated.
//
// pdfEnginePromise is module-level state shared with every other suite, so
// every case that touches it restores it, in the same pattern pagination.test.mjs
// uses for pageState.

export const name = 'pdf-engine';

const FAKE_DIR_SRC = `
function makeFakeDir(name){
  const dirs=new Map(), files=new Map();
  return {
    name, kind:'directory', _dirs:dirs, _files:files,
    async getDirectoryHandle(n,opts){
      if(!dirs.has(n)){
        if(!(opts&&opts.create)){ const e=new Error('not found: '+n); e.name='NotFoundError'; throw e; }
        dirs.set(n,makeFakeDir(n));
      }
      return dirs.get(n);
    },
    async getFileHandle(n,opts){
      if(!files.has(n)){
        if(!(opts&&opts.create)){ const e=new Error('not found: '+n); e.name='NotFoundError'; throw e; }
        files.set(n,{name:n,_blob:new Blob([])});
      }
      const entry=files.get(n);
      return {
        name:n,
        async createWritable(){ return { async write(b){ entry._blob=b; }, async close(){} }; },
        async getFile(){ return entry._blob; }
      };
    },
    async queryPermission(){ return 'granted'; },
    async requestPermission(){ return 'granted'; }
  };
}
`;

export default ({ test, app, eq, deepEq, ok, notOk }) => {
  test('jsPDF is listed before jspdf-autotable, which patches it', async () => {
    // jspdf-autotable adds doc.autoTable to jsPDF's prototype, so evaluating it
    // first registers nothing and every table in every report silently vanishes.
    // The order of this array is the only thing enforcing that.
    const files = await app(() => PDF_ENGINE_FILES.slice());
    const jspdf = files.findIndex((f) => /jspdf-2/.test(f));
    const autotable = files.findIndex((f) => /autotable/.test(f));
    const reports = files.findIndex((f) => /pdf-reports/.test(f));
    ok(jspdf !== -1 && autotable !== -1 && reports !== -1, 'all three files are listed: ' + files.join(', '));
    ok(jspdf < autotable, 'jsPDF must load before jspdf-autotable');
    ok(autotable < reports, 'the generators load last');
  });

  test('the load is attempted once and the result reused', async () => {
    // Without the cached promise, six PDF buttons means six concurrent sets of
    // script tags for the same three files.
    ok(await app(async () => {
      await loadPdfEngine();
      return loadPdfEngine() === loadPdfEngine();
    }), 'loadPdfEngine() returns the same promise every time');
  });

  test('loading twice does not inject a second script tag', async () => {
    eq(await app(async () => {
      await loadPdfEngine();
      await loadScriptOnce(PDF_ENGINE_FILES[0]);
      return document.querySelectorAll(
        `script[data-pdf-engine="${PDF_ENGINE_FILES[0]}"]`
      ).length;
    }), 1);
  });

  test('a failed load is reported to the user rather than thrown at them', async () => {
    // ensurePdfEngine() is what the six PDF buttons call. On failure it must
    // return false — so the caller stops before dereferencing a global that
    // does not exist — and say something a property manager can act on.
    const r = await app(async () => {
      const realPromise = pdfEnginePromise;
      const realAlert = window.alert;
      let alerted = null;
      window.alert = (m) => { alerted = m; };
      pdfEnginePromise = Promise.reject(new Error('simulated network failure'));
      pdfEnginePromise.catch(() => {});   // this rejection is expected; don't trip onunhandledrejection
      try {
        const result = await ensurePdfEngine();
        return { result, alerted };
      } finally {
        window.alert = realAlert;
        pdfEnginePromise = realPromise;
      }
    });
    eq(r.result, false, 'callers must be told not to proceed');
    ok(r.alerted, 'the user is told the PDF generator could not be loaded');
    ok(/try again/i.test(r.alerted), 'and told what to do about it: ' + r.alerted);
  });

  test('the archive fails CLOSED when the engine will not load', async () => {
    // The safety-critical one. archiveOneInspection() reports failures as a
    // reason string rather than an alert, and must return before creating any
    // folder — an inspection marked archived is one whose photos become
    // eligible for permanent deletion 180 days later.
    const r = await app(new Function(FAKE_DIR_SRC + `
      return (async () => {
        const realPromise = pdfEnginePromise;
        pdfEnginePromise = Promise.reject(new Error('simulated network failure'));
        pdfEnginePromise.catch(() => {});
        const dir = makeFakeDir('archive');
        try {
          const res = await archiveOneInspection(dir, {
            id: 'test_pdf_1', property: '12 Bealey Ave', date: '05/08/2026',
            areas: [{ name: 'Kitchen', status: 'OK', notes: '', photos: [] }],
            synced: true
          }, '12 Bealey Ave');
          return { res, folders: [...dir._dirs.keys()], files: [...dir._files.keys()] };
        } finally {
          pdfEnginePromise = realPromise;
        }
      })();
    `));
    eq(r.res.ok, false, 'the inspection must not be reported as archived');
    ok(/PDF generator could not be loaded/i.test(r.res.reason), r.res.reason);
    deepEq(r.folders, [], 'no folder may be created for an inspection that was never written');
    deepEq(r.files, [], 'and no files');
  });

  test('a working engine still archives normally', async () => {
    // The counterpart to the case above: proves the guard refuses a broken load
    // rather than refusing everything.
    const r = await app(new Function(FAKE_DIR_SRC + `
      return (async () => {
        await loadPdfEngine();
        const realGenerate = window.FindingsReport.generate;
        window.FindingsReport = { ...window.FindingsReport, generate: async () => new Blob(['%PDF-1.4']) };
        const dir = makeFakeDir('archive');
        try {
          const res = await archiveOneInspection(dir, {
            id: 'test_pdf_2', property: '12 Bealey Ave', date: '05/08/2026',
            areas: [{ name: 'Kitchen', status: 'OK', notes: '', photos: [] }],
            synced: true
          }, '12 Bealey Ave');
          return { ok: res.ok, reason: res.reason, folders: [...dir._dirs.keys()] };
        } finally {
          window.FindingsReport.generate = realGenerate;
        }
      })();
    `));
    eq(r.ok, true, 'should have archived: ' + r.reason);
    deepEq(r.folders, ['2026-08-05_12_Bealey_Ave']);
  });
};
