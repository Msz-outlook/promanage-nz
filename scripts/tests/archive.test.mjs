// The archive writes each inspection to an external drive as its PDF report
// plus the source photos, and then — 180 days later — deletes those photos
// from Supabase Storage. After that the drive is the ONLY copy.
//
// That makes verifyArchivedInspection() the load-bearing function in the
// feature: it is the gate in front of every delete, and it runs at purge time
// rather than trusting the flag written six months earlier. The cases below
// weight accordingly — most of them are about refusing to delete.
//
// showDirectoryPicker() needs a real user gesture and a native dialog, so it
// cannot be driven headlessly. The archive functions take a directory handle
// as a parameter, which is the seam these tests use: an in-memory fake
// implementing the File System Access API surface the code actually touches
// (getDirectoryHandle / getFileHandle / createWritable / getFile).

export const name = 'archive';

// Installed into the page by each case that needs it. Mirrors enough of the
// real API to exercise the write and verify paths, including NotFoundError,
// which is what a missing file genuinely throws.
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
        async createWritable(){
          return { async write(b){ entry._blob=b; }, async close(){} };
        },
        async getFile(){ return entry._blob; }
      };
    },
    async queryPermission(){ return 'granted'; },
    async requestPermission(){ return 'granted'; }
  };
}
`;

export default ({ test, app, eq, deepEq, ok }) => {
  test('folder names are date-first so the drive sorts chronologically', async () => {
    eq(await app(() => archiveFolderName({ date: '05/08/2026', property: 'x' }, '12 Bealey Ave')),
       '2026-08-05_12_Bealey_Ave');
  });

  test('two properties inspected the same day get distinct folders', async () => {
    // The reason the address is in the name at all — at six properties, two
    // inspections on one day is routine, and a date-only folder would have
    // the second overwrite the first.
    const r = await app(() => [
      archiveFolderName({ date: '05/08/2026' }, '12 Bealey Ave'),
      archiveFolderName({ date: '05/08/2026' }, '14 Papanui Rd')
    ]);
    ok(r[0] !== r[1], r.join(' vs '));
  });

  test('an unparseable inspection date still produces a usable folder', async () => {
    eq(await app(() => archiveFolderName({ date: 'garbage' }, '12 Bealey Ave')),
       'undated_12_Bealey_Ave');
  });

  test('the purge window is 180 days', async () => {
    eq(await app(() => ARCHIVE_PURGE_AFTER_DAYS), 180);
  });

  /* ---- verifyArchivedInspection: the gate in front of every delete ---- */

  test('verification passes when every recorded file is present at the right size', async () => {
    const r = await app(new Function(FAKE_DIR_SRC + `
      return (async () => {
        const root = makeFakeDir('root');
        const folder = await root.getDirectoryHandle('2026-08-05_test', {create:true});
        const w = await (await folder.getFileHandle('report.pdf', {create:true})).createWritable();
        await w.write(new Blob(['1234567890'])); await w.close();
        return await verifyArchivedInspection(root, {
          archivePath: '2026-08-05_test',
          archivedFiles: [{file:'report.pdf', size:10}]
        });
      })();
    `));
    eq(r.ok, true, r.reason);
  });

  test('verification fails when a file is missing from the archive folder', async () => {
    const r = await app(new Function(FAKE_DIR_SRC + `
      return (async () => {
        const root = makeFakeDir('root');
        await root.getDirectoryHandle('2026-08-05_test', {create:true});
        return await verifyArchivedInspection(root, {
          archivePath: '2026-08-05_test',
          archivedFiles: [{file:'report.pdf', size:10}]
        });
      })();
    `));
    eq(r.ok, false);
    ok(/missing/i.test(r.reason), r.reason);
  });

  test('verification fails on a size mismatch — a truncated or replaced file', async () => {
    const r = await app(new Function(FAKE_DIR_SRC + `
      return (async () => {
        const root = makeFakeDir('root');
        const folder = await root.getDirectoryHandle('2026-08-05_test', {create:true});
        const w = await (await folder.getFileHandle('report.pdf', {create:true})).createWritable();
        await w.write(new Blob(['short'])); await w.close();
        return await verifyArchivedInspection(root, {
          archivePath: '2026-08-05_test',
          archivedFiles: [{file:'report.pdf', size:9999}]
        });
      })();
    `));
    eq(r.ok, false);
    ok(/expected/i.test(r.reason), r.reason);
  });

  test('verification fails when the whole archive folder is gone', async () => {
    const r = await app(new Function(FAKE_DIR_SRC + `
      return (async () => {
        return await verifyArchivedInspection(makeFakeDir('root'), {
          archivePath: 'folder-that-was-deleted',
          archivedFiles: [{file:'report.pdf', size:10}]
        });
      })();
    `));
    eq(r.ok, false);
  });

  test('verification fails closed with no drive, no folder, or no file list', async () => {
    // Each of these is a "we cannot prove the archive exists" state, and every
    // one of them must block a delete rather than being treated as trivially OK.
    const r = await app(new Function(FAKE_DIR_SRC + `
      return (async () => {
        const root = makeFakeDir('root');
        return [
          await verifyArchivedInspection(null, {archivePath:'x', archivedFiles:[{file:'a',size:1}]}),
          await verifyArchivedInspection(root, {archivedFiles:[{file:'a',size:1}]}),
          await verifyArchivedInspection(root, {archivePath:'x'}),
          await verifyArchivedInspection(root, {archivePath:'x', archivedFiles:[]})
        ];
      })();
    `));
    deepEq(r.map((x) => x.ok), [false, false, false, false]);
    ok(/not connected/i.test(r[0].reason), r[0].reason);
  });

  test('verification walks into the photos/ subfolder, not just the top level', async () => {
    const r = await app(new Function(FAKE_DIR_SRC + `
      return (async () => {
        const root = makeFakeDir('root');
        const folder = await root.getDirectoryHandle('2026-08-05_test', {create:true});
        const photos = await folder.getDirectoryHandle('photos', {create:true});
        const w = await (await photos.getFileHandle('area0-photo0.jpg', {create:true})).createWritable();
        await w.write(new Blob(['abcde'])); await w.close();
        return {
          good: await verifyArchivedInspection(root, {archivePath:'2026-08-05_test', archivedFiles:[{file:'photos/area0-photo0.jpg', size:5}]}),
          bad:  await verifyArchivedInspection(root, {archivePath:'2026-08-05_test', archivedFiles:[{file:'photos/area0-photo1.jpg', size:5}]})
        };
      })();
    `));
    eq(r.good.ok, true, r.good.reason);
    eq(r.bad.ok, false);
  });

  /* ---- purge: must never delete on an unverifiable archive ---- */

  test('purge deletes only after verification passes, and records when', async () => {
    const r = await app(new Function(FAKE_DIR_SRC + `
      return (async () => {
        const realDelete = window.deletePhotosFromStorage;
        let deleted = [];
        window.deletePhotosFromStorage = async (rec) => { deleted.push(rec.id); };
        try {
          await dbClear('inspections');
          const root = makeFakeDir('root');
          const folder = await root.getDirectoryHandle('2026-01-01_old', {create:true});
          const w = await (await folder.getFileHandle('report.pdf', {create:true})).createWritable();
          await w.write(new Blob(['1234567890'])); await w.close();

          const old = new Date(Date.now() - 200*86400000).toISOString();
          await dbPut('inspections', {
            id:'test_arch_1', property:'12 Bealey Ave', areas:[], synced:true,
            archivedAt: old, archivePath:'2026-01-01_old',
            archivedFiles:[{file:'report.pdf', size:10}]
          });
          const result = await purgeArchivedPhotos(root);
          const rec = (await dbGetAll('inspections')).find(i => i.id === 'test_arch_1');
          return { result, deleted, purgedAt: !!rec.photosPurgedAt };
        } finally {
          window.deletePhotosFromStorage = realDelete;
          await dbClear('inspections');
        }
      })();
    `));
    eq(r.result.purged, 1);
    deepEq(r.deleted, ['test_arch_1']);
    eq(r.purgedAt, true);
  });

  test('purge REFUSES to delete when the archived file is missing from the drive', async () => {
    // The single most important case in the feature. A photo deleted from the
    // drive by hand, a drive that silently corrupted, a folder moved — all look
    // like this, and all must leave Supabase untouched.
    const r = await app(new Function(FAKE_DIR_SRC + `
      return (async () => {
        const realDelete = window.deletePhotosFromStorage;
        let deleted = [];
        window.deletePhotosFromStorage = async (rec) => { deleted.push(rec.id); };
        try {
          await dbClear('inspections');
          const root = makeFakeDir('root');
          await root.getDirectoryHandle('2026-01-01_old', {create:true}); // folder exists, file does not
          await dbPut('inspections', {
            id:'test_arch_2', property:'12 Bealey Ave', areas:[], synced:true,
            archivedAt: new Date(Date.now() - 200*86400000).toISOString(),
            archivePath:'2026-01-01_old',
            archivedFiles:[{file:'report.pdf', size:10}]
          });
          const result = await purgeArchivedPhotos(root);
          const rec = (await dbGetAll('inspections')).find(i => i.id === 'test_arch_2');
          return { result, deleted, purgedAt: rec.photosPurgedAt };
        } finally {
          window.deletePhotosFromStorage = realDelete;
          await dbClear('inspections');
        }
      })();
    `));
    eq(r.result.purged, 0);
    deepEq(r.deleted, [], 'nothing may be deleted from Storage');
    eq(r.purgedAt, undefined, 'the record must not be marked purged');
    eq(r.result.blocked.length, 1);
  });

  test('purge does nothing at all when the drive is not connected', async () => {
    const r = await app(async () => {
      const realDelete = window.deletePhotosFromStorage;
      let deleted = [];
      window.deletePhotosFromStorage = async (rec) => { deleted.push(rec.id); };
      try {
        await dbClear('inspections');
        await dbPut('inspections', {
          id:'test_arch_3', property:'x', areas:[], synced:true,
          archivedAt: new Date(Date.now() - 200*86400000).toISOString(),
          archivePath:'old', archivedFiles:[{file:'report.pdf', size:10}]
        });
        const result = await purgeArchivedPhotos(null);
        return { result, deleted };
      } finally {
        window.deletePhotosFromStorage = realDelete;
        await dbClear('inspections');
      }
    });
    eq(r.result.purged, 0);
    deepEq(r.deleted, []);
  });

  test('an inspection archived more recently than the window is left alone', async () => {
    const r = await app(new Function(FAKE_DIR_SRC + `
      return (async () => {
        const realDelete = window.deletePhotosFromStorage;
        let deleted = [];
        window.deletePhotosFromStorage = async (rec) => { deleted.push(rec.id); };
        try {
          await dbClear('inspections');
          const root = makeFakeDir('root');
          const folder = await root.getDirectoryHandle('recent', {create:true});
          const w = await (await folder.getFileHandle('report.pdf', {create:true})).createWritable();
          await w.write(new Blob(['1234567890'])); await w.close();
          await dbPut('inspections', {
            id:'test_arch_4', property:'x', areas:[], synced:true,
            archivedAt: new Date(Date.now() - 10*86400000).toISOString(), // 10 days
            archivePath:'recent', archivedFiles:[{file:'report.pdf', size:10}]
          });
          const result = await purgeArchivedPhotos(root);
          return { result, deleted };
        } finally {
          window.deletePhotosFromStorage = realDelete;
          await dbClear('inspections');
        }
      })();
    `));
    eq(r.result.purged, 0);
    deepEq(r.deleted, []);
  });

  test('an already-purged inspection is never purged twice', async () => {
    const r = await app(new Function(FAKE_DIR_SRC + `
      return (async () => {
        const realDelete = window.deletePhotosFromStorage;
        let deleted = [];
        window.deletePhotosFromStorage = async (rec) => { deleted.push(rec.id); };
        try {
          await dbClear('inspections');
          const root = makeFakeDir('root');
          await dbPut('inspections', {
            id:'test_arch_5', property:'x', areas:[], synced:true,
            archivedAt: new Date(Date.now() - 200*86400000).toISOString(),
            photosPurgedAt: new Date(Date.now() - 100*86400000).toISOString(),
            archivePath:'old', archivedFiles:[{file:'report.pdf', size:10}]
          });
          const result = await purgeArchivedPhotos(root);
          return { result, deleted };
        } finally {
          window.deletePhotosFromStorage = realDelete;
          await dbClear('inspections');
        }
      })();
    `));
    eq(r.result.purged, 0);
    deepEq(r.deleted, []);
  });

  /* ---- the purged-state guard ---- */

  test('a purged inspection refuses to regenerate its PDF instead of emitting a photo-less one', async () => {
    const r = await app(async () => {
      const realAlert = window.alert;
      let message = null, generated = false;
      const realGenerate = window.FindingsReport.generate;
      window.alert = (m) => { message = m; };
      window.FindingsReport = { ...window.FindingsReport, generate: async () => { generated = true; return new Blob([]); } };
      try {
        await dbClear('inspections');
        await dbPut('inspections', {
          id:'test_arch_6', property:'12 Bealey Ave', date:'05/08/2026',
          areas:[{name:'Kitchen', status:'OK', notes:'', photos:['storage:a/b.jpg']}],
          synced:true, archivePath:'2026-08-05_12_Bealey_Ave',
          photosPurgedAt: new Date().toISOString()
        });
        await generateInspectionPDF('test_arch_6', null);
        return { message, generated };
      } finally {
        window.alert = realAlert;
        window.FindingsReport.generate = realGenerate;
        await dbClear('inspections');
      }
    });
    eq(r.generated, false, 'no PDF may be produced for a purged inspection');
    ok(/archived/i.test(r.message || ''), r.message);
    ok(/2026-08-05_12_Bealey_Ave/.test(r.message || ''), 'the message names the folder to look in');
  });

  test('a non-purged inspection still generates normally', async () => {
    const r = await app(async () => {
      const realAlert = window.alert;
      const realGenerate = window.FindingsReport.generate;
      let generated = false;
      window.alert = () => {};
      window.FindingsReport = { ...window.FindingsReport, generate: async () => { generated = true; return new Blob([]); } };
      try {
        await dbClear('inspections');
        await dbPut('inspections', {
          id:'test_arch_7', property:'12 Bealey Ave', date:'05/08/2026',
          areas:[{name:'Kitchen', status:'OK', notes:'', photos:[]}],
          synced:true
        });
        await generateInspectionPDF('test_arch_7', null);
        return generated;
      } finally {
        window.alert = realAlert;
        window.FindingsReport.generate = realGenerate;
        await dbClear('inspections');
      }
    });
    eq(r, true);
  });

  /* ---- storage headroom ---- */

  test('the storage estimate counts unpurged photos and flags unsized ones', async () => {
    const r = await app(async () => {
      try {
        await dbClear('inspections');
        await dbPut('inspections', {
          id:'test_arch_8', synced:true,
          areas:[{photos:['storage:a.jpg','storage:b.jpg']}],
          photoSizes:{'storage:a.jpg':1000} // b.jpg predates size tracking
        });
        await dbPut('inspections', {
          id:'test_arch_9', synced:true, photosPurgedAt:new Date().toISOString(),
          areas:[{photos:['storage:c.jpg']}], photoSizes:{'storage:c.jpg':9999}
        });
        return await storageUsageEstimate();
      } finally { await dbClear('inspections'); }
    });
    eq(r.bytes, 1000, 'purged photos must not count toward usage');
    eq(r.sized, 1);
    eq(r.unsized, 1);
  });
};
