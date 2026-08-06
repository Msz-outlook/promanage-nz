// Before this, a push failure retried on every fullSyncNow() call forever
// with no visible reason — schema.sql §2 records that shape having already
// caused real damage once (a signed-out device silently failing every push
// while the online listener kept calling fullSyncNow(), which is what wiped
// the local database on 4 Aug 2026). Backoff and a recorded reason are the
// fix; these cases pin both, plus an end-to-end run of syncPendingProperties
// against a stubbed network so the whole path is covered, not just the
// primitives.
//
// End-to-end cases stub authHeader() and fetch on the page and use `test_`
// prefixed ids in the real 'properties' store, cleaning up after themselves.

export const name = 'sync-retry';

export default ({ test, app, eq, ok }) => {
  test('pushFailure/isPushFailure classify every push return value correctly', async () => {
    eq(await app(() => isPushFailure(pushFailure('x'))), true);
    eq(await app(() => isPushFailure(true)), false, 'boolean success (tenant/maintenance/invoice/statement shape)');
    eq(await app(() => isPushFailure('deleted')), false, 'the delete sentinel is not a failure');
    eq(await app(() => isPushFailure('blocked')), false, 'the property 409 sentinel is not a failure');
    eq(await app(() => isPushFailure({ id: 'insp_1', synced: true })), false, 'a transformed record (inspection shape) is not a failure');
    eq(await app(() => isPushFailure(undefined)), true, 'a bare falsy return is still treated as failure');
  });

  test('a failed record backs off before retrying, then retries once the window elapses', async () => {
    const r = await app(() => {
      const rec = { id: 'x', synced: false };
      const beforeAny = dueForSyncRetry(rec);
      noteSyncFailure(rec, 'HTTP 500');
      const immediatelyAfter = dueForSyncRetry(rec);
      const attempts = rec.syncAttempts, reason = rec.syncLastError;
      rec.syncNextAttempt = new Date(Date.now() - 1000).toISOString();
      const afterWindow = dueForSyncRetry(rec);
      return { beforeAny, immediatelyAfter, attempts, reason, afterWindow };
    });
    ok(r.beforeAny, 'never-attempted record is due');
    ok(!r.immediatelyAfter, 'record backs off right after a failure');
    eq(r.attempts, 1);
    eq(r.reason, 'HTTP 500');
    ok(r.afterWindow, 'record is due again once its backoff window has passed');
  });

  test('backoff escalates and flattens at the last entry rather than growing forever', async () => {
    const r = await app(() => {
      const minutes = SYNC_RETRY_BACKOFF_MINUTES;
      const nondecreasing = minutes.every((m, i) => i === 0 || m >= minutes[i - 1]);
      return { minutes, nondecreasing, last: minutes[minutes.length - 1] };
    });
    ok(r.nondecreasing, JSON.stringify(r.minutes));
    ok(r.last > 0 && r.last < 24 * 60, 'the ceiling is a real number of minutes, not unbounded');
  });

  test('clearSyncAttemptState removes all three tracking fields', async () => {
    const after = await app(() => {
      const rec = { id: 'x', synced: false, syncAttempts: 3, syncNextAttempt: 'x', syncLastError: 'y' };
      clearSyncAttemptState(rec);
      return rec;
    });
    eq(after.syncAttempts, undefined);
    eq(after.syncNextAttempt, undefined);
    eq(after.syncLastError, undefined);
  });

  test('syncFailureSummary stays null below the visibility threshold', async () => {
    const r = await app(() => syncFailureSummary([
      { id: 'a', synced: false, syncAttempts: SYNC_RETRY_VISIBLE_AFTER - 1, syncLastError: 'too early' }
    ]));
    eq(r, null);
  });

  test('syncFailureSummary reports the count and the MOST RECENT reason once reached', async () => {
    // Two records both over the threshold, different ages — the summary must
    // surface the one still relevant to what's blocking sync right now, not
    // whichever happens to sort first.
    const r = await app(() => syncFailureSummary([
      { id: 'a', synced: false, syncAttempts: SYNC_RETRY_VISIBLE_AFTER, syncLastError: 'stale reason', syncNextAttempt: '2020-01-01T00:00:00.000Z' },
      { id: 'b', synced: false, syncAttempts: SYNC_RETRY_VISIBLE_AFTER, syncLastError: 'current reason', syncNextAttempt: '2030-01-01T00:00:00.000Z' }
    ]));
    eq(r.count, 2);
    eq(r.reason, 'current reason');
  });

  test('a synced record never counts toward the failure summary, however many attempts it recorded historically', async () => {
    const r = await app(() => syncFailureSummary([
      { id: 'a', synced: true, syncAttempts: 99, syncLastError: 'old news' }
    ]));
    eq(r, null);
  });

  // --- end-to-end: syncPendingProperties() against a stubbed network ---
  //
  // Each case is one self-contained function passed to app() — page.evaluate
  // serialises it and re-runs it in the browser, so it can only reference
  // globals that exist there (dbPut, syncPendingProperties, ...), never a
  // Node-side helper from this file. That's also why the stub/restore is
  // repeated inline in each case rather than factored into a shared helper.

  test('a rejected push records the HTTP status as the reason and leaves the record pending', async () => {
    const r = await app(async () => {
      const realAuthHeader = window.authHeader, realFetch = window.fetch;
      try {
        window.authHeader = async () => 'fake-token';
        window.fetch = async () => new Response('', { status: 500 });
        await dbClear('properties');
        await dbPut('properties', { id: 'test_p1', address: '1 Test St', synced: false });
        await syncPendingProperties();
        const rec = (await dbGetAll('properties')).find((p) => p.id === 'test_p1');
        return { synced: rec.synced, attempts: rec.syncAttempts, reason: rec.syncLastError, due: dueForSyncRetry(rec) };
      } finally {
        window.authHeader = realAuthHeader; window.fetch = realFetch;
        await dbClear('properties');
      }
    });
    eq(r.synced, false);
    eq(r.attempts, 1);
    eq(r.reason, 'HTTP 500');
    eq(r.due, false, 'backs off immediately after the first failure');
  });

  test('a record still in backoff is skipped — a second sync pass does not bump its attempt count', async () => {
    const r = await app(async () => {
      const realAuthHeader = window.authHeader, realFetch = window.fetch;
      let calls = 0;
      try {
        window.authHeader = async () => 'fake-token';
        window.fetch = async () => { calls++; return new Response('', { status: 500 }); };
        await dbClear('properties');
        await dbPut('properties', { id: 'test_p2', address: '2 Test St', synced: false });
        await syncPendingProperties();       // 1st attempt — fails, enters backoff
        await syncPendingProperties();       // 2nd pass — should be skipped entirely
        const rec = (await dbGetAll('properties')).find((p) => p.id === 'test_p2');
        return { calls, attempts: rec.syncAttempts };
      } finally {
        window.authHeader = realAuthHeader; window.fetch = realFetch;
        await dbClear('properties');
      }
    });
    eq(r.calls, 1, 'fetch was only reached once — the second pass respected the backoff window');
    eq(r.attempts, 1);
  });

  test('once the backoff window elapses, the next sync pass retries and a success clears the tracking fields', async () => {
    const r = await app(async () => {
      const realAuthHeader = window.authHeader, realFetch = window.fetch;
      let attempt = 0;
      try {
        window.authHeader = async () => 'fake-token';
        // Fail once, then succeed — a realistic "connection blipped" shape.
        window.fetch = async () => { attempt++; return new Response('', { status: attempt === 1 ? 500 : 200 }); };
        await dbClear('properties');
        await dbPut('properties', { id: 'test_p3', address: '3 Test St', synced: false });
        await syncPendingProperties(); // fails, enters backoff

        // Force the backoff window to have already elapsed, as if real time had passed.
        const failed = (await dbGetAll('properties')).find((p) => p.id === 'test_p3');
        failed.syncNextAttempt = new Date(Date.now() - 1000).toISOString();
        await dbPut('properties', failed);

        await syncPendingProperties(); // retries, succeeds this time
        const rec = (await dbGetAll('properties')).find((p) => p.id === 'test_p3');
        return {
          attemptsMade: attempt, synced: rec.synced,
          attempts: rec.syncAttempts, nextAttempt: rec.syncNextAttempt, lastError: rec.syncLastError
        };
      } finally {
        window.authHeader = realAuthHeader; window.fetch = realFetch;
        await dbClear('properties');
      }
    });
    eq(r.attemptsMade, 2);
    eq(r.synced, true);
    eq(r.attempts, undefined, 'tracking fields are cleared on success');
    eq(r.nextAttempt, undefined);
    eq(r.lastError, undefined);
  });

  test('a signed-out device fails closed with a real reason instead of retrying blind', async () => {
    // This is the exact shape schema.sql §2 records as having wiped the local
    // database once: a device with no session, still being asked to sync.
    // pushFailure('Not signed in') is what makes that visible instead of a
    // bare `false` no one could act on.
    const r = await app(async () => {
      const realAuthHeader = window.authHeader;
      try {
        window.authHeader = async () => null;
        return await pushPropertyToBackend({ id: 'test_p4', address: '4 Test St', synced: false });
      } finally {
        window.authHeader = realAuthHeader;
      }
    });
    eq(r.ok, false);
    eq(r.reason, 'Not signed in');
  });

  // --- sync freshness: fullSyncNow()'s silent mode and in-flight guard ---

  test('an automatic (silent) trigger does not alert while offline; an explicit one does', async () => {
    // Automatic triggers are visibilitychange and the periodic interval —
    // firing an offline alert on every tab focus would be unusable. The
    // explicit "Sync now" button and the online event are the one place a
    // user is asking specifically, so that path still answers.
    //
    // navigator.onLine is normally read-only; Object.defineProperty shadows
    // it for the duration of this test the same way Playwright's own
    // context.setOffline() does under the hood.
    const r = await app(async () => {
      const realAlert = window.alert;
      const alerted = { silent: false, explicit: false };
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      try {
        window.alert = () => { alerted.silent = true; };
        await fullSyncNow({ silent: true });
        window.alert = () => { alerted.explicit = true; };
        await fullSyncNow();
        return alerted;
      } finally {
        window.alert = realAlert;
        Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
      }
    });
    eq(r.silent, false);
    eq(r.explicit, true);
  });

  test('two concurrent fullSyncNow() calls run the inner sync only once', async () => {
    const calls = await app(async () => {
      const realInner = window.fullSyncNowInner, realAuth = window.authHeader;
      let innerCalls = 0;
      window.fullSyncNowInner = async () => { innerCalls++; await new Promise((r) => setTimeout(r, 150)); };
      window.authHeader = async () => 'fake-token';
      try {
        await Promise.all([fullSyncNow({ silent: true }), fullSyncNow({ silent: true })]);
        return innerCalls;
      } finally {
        window.fullSyncNowInner = realInner;
        window.authHeader = realAuth;
      }
    });
    eq(calls, 1, 'the second call should see syncInFlight and return immediately');
  });

  test('lastSyncAt advances after a sync completes', async () => {
    const r = await app(async () => {
      const realInner = window.fullSyncNowInner;
      window.fullSyncNowInner = async () => {};
      try {
        const before = lastSyncAt;
        await fullSyncNow({ silent: true });
        return lastSyncAt > before;
      } finally { window.fullSyncNowInner = realInner; }
    });
    ok(r);
  });

  test('visibilitychange triggers a sync once the gap since the last one is stale enough', async () => {
    const calls = await app(async () => {
      const real = window.fullSyncNow;
      const realLastSyncAt = lastSyncAt;
      let n = 0;
      window.fullSyncNow = () => { n++; return Promise.resolve(); };
      lastSyncAt = Date.now() - SYNC_FRESHNESS_MIN_GAP_MS - 1000;
      try {
        document.dispatchEvent(new Event('visibilitychange'));
        await new Promise((r) => setTimeout(r, 20));
        return n;
      } finally { window.fullSyncNow = real; lastSyncAt = realLastSyncAt; }
    });
    ok(calls >= 1);
  });

  test('visibilitychange does NOT trigger a sync when the last one was recent', async () => {
    const calls = await app(async () => {
      const real = window.fullSyncNow;
      const realLastSyncAt = lastSyncAt;
      let n = 0;
      window.fullSyncNow = () => { n++; return Promise.resolve(); };
      lastSyncAt = Date.now(); // just synced
      try {
        document.dispatchEvent(new Event('visibilitychange'));
        await new Promise((r) => setTimeout(r, 20));
        return n;
      } finally { window.fullSyncNow = real; lastSyncAt = realLastSyncAt; }
    });
    eq(calls, 0, 'a fresh sync should not be immediately repeated just because the tab regained focus');
  });
};
