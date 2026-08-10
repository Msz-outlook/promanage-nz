# `reports/pdf-reports.js` — the PDF design system

Loaded when you read anything in `reports/`.

The file holds three generators: `FindingsReport` (inspection report),
`InvoiceReport`, `StatementReport`. Each is an IIFE taking `global`, exposes a
single `generate(data, options)`, and ends by assigning to `global.<Name>` —
which is what the smoke test checks after calling `loadPdfEngine()`, proof the
file ran to completion rather than merely parsing.

It is fetched on demand by `loadPdfEngine()` in `index.html`, not by a
`<script src>`. The load order inside `PDF_ENGINE_FILES` is load-bearing; see
`.claude/rules/app-invariants.md`.

## One token block, `MODERNIST`

All three generators are styled from **one token block at the top of the
file**. It is a port of the Claude Design "Modernist" system the owner
statement was designed in; the statement follows that design closely, and the
invoice and inspection report keep their own layouts but draw from the same
palette, rule weights and label treatment so the three documents read as one
set.

**A hex written into a draw call is a bug.** `pdf-theme.test.mjs` fails on one.
Same failure mode as the app's CSS tokens, and it is how the generators ended
up blue, teal and slate the first time: nobody sees two of the three documents
side by side.

Getting CSS into a PDF needed two translations, and both are load-bearing:

- **px → pt at exactly 0.75.** The template is a 0.6in-margin A4 page, so its
  CSS pixel grid maps to PDF points at the 96dpi ratio. Every size is written
  as `PX(n)` with the template's own pixel value, so the mapping back to the
  CSS stays legible. Change the ratio and every size in all three generators
  is wrong together.
- **`color-mix()` → flat hex.** A PDF has no alpha compositing for text, so
  `MODERNIST.mix()` pre-blends the translucent tokens. **Paper is white**, not
  the system's `--color-bg` (`#f3f2f2`): these are documents that get printed
  and filed, and a full-bleed tint either drops out at print time or burns
  toner on every page. Every other value is the system's own.

## Two things the PDF stack cannot do, both failing *silently*

- **Only Helvetica, Times and Courier exist.** `setFont("arial")` does not
  error — it falls back to **Times**, quietly turning a statement serif. Arial
  is metrically identical to Helvetica and viewers substitute it, so
  `helvetica` is how you get Arial; embedding real Arial is a licensing
  problem in a public repo, and any custom face means vendoring ~290 KB of
  base64 TTF plus a `SHELL_FILES` entry.
- **The built-in fonts are WinAnsi-encoded.** `№` (U+2116) is not in WinAnsi
  and renders as `!` — hence "Statement No.". En dashes, em dashes and `·`
  *are* in WinAnsi and are fine.

## `doc.setCharSpace(0)` after every tracked string

Char spacing is *document* state in jsPDF, not an argument to `text()`. A
tracked uppercase label that does not reset it widens everything drawn
afterwards, autoTable cells included — which is how a column of right-aligned
money silently stops aligning.

`pdf-theme.test.mjs` pins this by instrumenting jsPDF and asserting on the char
spacing every `$…` string was actually drawn with. Note it wraps the
**constructor**, not the prototype: jsPDF assigns `text` and `setCharSpace` as
own properties on each instance, so patching `jsPDF.prototype` intercepts
nothing and passes having measured nothing.

## The `var MODERNIST` at the top

`pdf-reports.js` is a classic `<script>`, so this becomes a window property. It
is deliberately named to not collide with anything in `index.html` — a
top-level `const MODERNIST` there would make this throw and take all three
generators down with it. See `.claude/rules/app-conventions.md`.
