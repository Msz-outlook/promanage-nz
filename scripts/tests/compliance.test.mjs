// Healthy Homes and RTA compliance state per property. getPropertyCompliance
// fills defaults for records created before the feature existed, so a property
// saved last year must still produce a complete, well-formed item list rather
// than undefined fields that render as "undefined" in the modal.

export const name = 'compliance';

export default ({ test, app, eq, ok, notOk }) => {
  test('a property with no compliance data gets the full default item set', async () => {
    const items = await app(() => getPropertyCompliance({ address: '1 Test St' }));
    eq(items.length, 9, '5 Healthy Homes + 4 regulatory');
    ok(items.every((it) => it.status === 'Not assessed'));
    ok(items.every((it) => it.lastChecked === '' && it.nextDue === '' && it.notes === ''));
  });

  test('every item carries the label and description the modal renders', async () => {
    const items = await app(() => getPropertyCompliance({}));
    ok(items.every((it) => typeof it.key === 'string' && it.key.length > 0));
    ok(items.every((it) => typeof it.label === 'string' && it.label.length > 0));
    ok(items.every((it) => typeof it.desc === 'string' && it.desc.length > 0));
  });

  test('a short-term tenancy adds the two extra regulatory items', async () => {
    const items = await app(() => getPropertyCompliance({ tenancy: 'Short-term' }));
    eq(items.length, 11);
    const keys = items.map((it) => it.key);
    ok(keys.includes('st_consent'), 'short-term rental consent');
    ok(keys.includes('gst_threshold'), 'GST threshold monitoring');
  });

  test('a long-term tenancy does not get the short-term items', async () => {
    const keys = await app(() => getPropertyCompliance({ tenancy: 'Long-term' }).map((it) => it.key));
    notOk(keys.includes('st_consent'));
    notOk(keys.includes('gst_threshold'));
  });

  test('stored values are preserved rather than overwritten by defaults', async () => {
    const item = await app(() => getPropertyCompliance({
      complianceItems: { heating: { status: 'Compliant', lastChecked: '2026-01-15', notes: 'Heat pump installed' } }
    }).find((it) => it.key === 'heating'));
    eq(item.status, 'Compliant');
    eq(item.lastChecked, '2026-01-15');
    eq(item.notes, 'Heat pump installed');
    eq(item.nextDue, '', 'unset fields still fall back to empty');
  });

  test('an unknown stored key does not add a phantom item', async () => {
    const items = await app(() => getPropertyCompliance({
      complianceItems: { some_removed_item: { status: 'Compliant' } }
    }));
    eq(items.length, 9);
  });

  test('overall status is Current when nothing is overdue', async () => {
    eq(await app(() => overallComplianceStatus({})), 'Current');
  });

  test('an explicitly Overdue item makes the property Overdue', async () => {
    eq(await app(() => overallComplianceStatus({
      complianceItems: { smoke_alarms: { status: 'Overdue' } }
    })), 'Overdue');
  });

  test('a past nextDue date makes the property Overdue even if the status says otherwise', async () => {
    // The date is what matters — a stale "Compliant" with a due date in the
    // past must not read as current.
    eq(await app(() => overallComplianceStatus({
      complianceItems: { insulation: { status: 'Compliant', nextDue: '2020-01-01' } }
    })), 'Overdue');
  });

  test('a future nextDue date is not overdue', async () => {
    const status = await app(() => {
      const future = new Date();
      future.setFullYear(future.getFullYear() + 1);
      return overallComplianceStatus({
        complianceItems: { insulation: { status: 'Compliant', nextDue: future.toISOString().slice(0, 10) } }
      });
    });
    eq(status, 'Current');
  });
};
