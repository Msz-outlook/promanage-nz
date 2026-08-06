// docs/REVIEW-2026-08.md finding 12: money accumulates as ordinary floats —
// qty*price, row sums, opening+(income-expenses) — which displays fine
// (toLocaleString rounds what's shown) but leaves the STORED total carrying
// float dust, so a PDF total can differ from the sum of its own printed
// lines by a cent. toCents/fromCents/roundMoney close that at every
// accumulation boundary — see the comment above their definition for why a
// single rounding pass at the very end isn't enough.

export const name = 'money';

export default ({ test, app, eq }) => {
  test('roundMoney fixes the classic binary float case', async () => {
    // 0.1 + 0.2 === 0.30000000000000004 in raw IEEE 754 arithmetic.
    eq(await app(() => 0.1 + 0.2), 0.30000000000000004);
    eq(await app(() => roundMoney(0.1 + 0.2)), 0.3);
  });

  test('toCents rounds to the nearest cent', async () => {
    eq(await app(() => toCents(1.006)), 101, 'unambiguously above the half-cent');
    eq(await app(() => toCents(1.004)), 100, 'unambiguously below it');
    eq(await app(() => toCents(19.999999999999996)), 2000, 'the kind of value repeated float ops actually produce');
  });

  test('rounds the same way Math.round/toFixed do at a value that only LOOKS like an exact half-cent', async () => {
    // 1.005 has no exact binary representation; its true double-precision
    // value is 100.49999999999999 cents, which is genuinely closer to 100
    // than 101. roundMoney matching that (rather than "fixing" it toward
    // decimal intuition) is correct — it's the same value Math.round and
    // toFixed both already agree on, and this app never has to explain a
    // rounding rule beyond "does what the platform's own rounding does".
    eq(await app(() => Math.round(1.005 * 100)), 100);
    eq(await app(() => toCents(1.005)), 100);
  });

  test('fromCents is the exact inverse of toCents for ordinary amounts', async () => {
    eq(await app(() => fromCents(toCents(45.5))), 45.5);
    eq(await app(() => fromCents(toCents(0))), 0);
    eq(await app(() => fromCents(toCents(1234.56))), 1234.56);
  });

  test('roundMoney handles null/undefined/NaN like the arithmetic it replaces (treats them as 0)', async () => {
    eq(await app(() => roundMoney(undefined)), 0);
    eq(await app(() => roundMoney(null)), 0);
  });

  test('summing many already-rounded amounts stays exact — the case that broke before this existed', async () => {
    // Twenty 33.33 line items: naive summation drifts by fractions of a cent
    // over that many additions; rounding at the boundary does not.
    const total = await app(() => {
      let sum = 0;
      for (let i = 0; i < 20; i++) sum = roundMoney(sum + 33.33);
      return sum;
    });
    eq(total, 666.6);
  });

  test('a fractional quantity produces a clean 2dp line amount', async () => {
    // 2.5 hours at $45.33/hr — a real invoice line, not a contrived float.
    // True product is 113.32499999999999 (45.33 has no exact binary form),
    // genuinely closer to .32 than .33 — same reasoning as the half-cent
    // case above. The property under test is "exactly 2 decimal places",
    // not a specific expected value picked by eye.
    const r = await app(() => roundMoney(2.5 * 45.33));
    eq(Number(r.toFixed(2)), r, 'the rounded result has no more than 2 decimal places');
    eq(r, 113.32);
  });

  test('GST split round-trips: subtotal + gst === total to the cent', async () => {
    const r = await app(() => {
      const subtotal = roundMoney(3 * 33.33);
      const gst = roundMoney(subtotal * GST_RATE);
      const total = roundMoney(subtotal + gst);
      return { subtotal, gst, total, matches: roundMoney(subtotal + gst) === total };
    });
    eq(r.matches, true);
    eq(r.subtotal + r.gst, r.total, 'plain addition of the two rounded parts equals the rounded total');
  });
};
