/*
 * pdf-reports.js — the three PDF generators, loaded on demand.
 *
 * This file used to be an inline <script> block in index.html, and jsPDF and
 * jspdf-autotable used to be plain <script src> tags beside it. Together that
 * was 438 KB — 73% of the JavaScript blocking the first paint — to render
 * documents that only exist after someone clicks a PDF button. Now the app
 * loads all three through loadPdfEngine() in index.html at the moment a report
 * is actually requested.
 *
 * All three stay in SHELL_FILES in sw.js, so they are still pre-cached and
 * offline PDF generation is unchanged. Pre-caching a file and blocking the
 * first paint on it are different things, and only the second one cost
 * anything.
 *
 * Load order matters and loadPdfEngine() owns it: jsPDF first, then
 * jspdf-autotable (which patches jsPDF's prototype to add doc.autoTable),
 * then this file. Nothing here touches jsPDF at parse time — the
 * "jsPDF is not loaded" guards are inside each generate() — but do not
 * reorder the loader on the strength of that.
 *
 * Defines three globals, each an IIFE over `global` exposing one entry point:
 *   FindingsReport.generate(data, options)   — inspection report
 *   InvoiceReport.generate(data, options)    — invoice
 *   StatementReport.generate(data, options)  — owner statement
 *
 * scripts/smoke-test.mjs asserts all three are ABSENT at boot and present
 * after loadPdfEngine(), so restoring a <script> tag fails loudly instead of
 * quietly costing every launch.
 */

/* ============================================================================
 * MODERNIST — the design tokens all three generators draw from.
 *
 * Ported from the Claude Design "Modernist" system (styles.css). This is the
 * ONE place a colour or a type size is defined; the three IIFEs below read
 * from it rather than carrying their own palettes, which is what stopped the
 * statement/invoice/report trio drifting apart the first time.
 *
 * Two translations were needed to get CSS into a PDF:
 *
 * 1. px -> pt. The template is a 0.6in-margin A4 doc-page, so its CSS pixel
 *    grid maps to PDF points at exactly the 96dpi ratio: 1px = 0.75pt. Every
 *    size below is `px * PX`, kept in that form so it reads against the CSS.
 *
 * 2. color-mix() -> flat hex. A PDF has no compositing for text colour, so
 *    mix() below pre-blends against the paper. Paper is WHITE, not the
 *    system's --color-bg (#f3f2f2): this is a financial document that gets
 *    printed, and a full-bleed tint either drops out at print time (giving
 *    white anyway) or burns toner on every page. Every other token is the
 *    system's own value.
 *
 * NOTE ON THE `var`: pdf-reports.js is a classic <script>, so this becomes a
 * window property. It is deliberately named to not collide with anything in
 * index.html — a top-level `const MODERNIST` there would make this throw and
 * take all three generators down with it. See "Top-level code in the script
 * block" in CLAUDE.md.
 * ========================================================================== */
var MODERNIST = (function () {
  var PX = 0.75;                 // 1 CSS px at 96dpi, in PDF points
  var PAPER = [255, 255, 255];   // what translucent tokens composite against

  // color-mix(in srgb, <hex> <pct>%, transparent) resolved over the paper.
  function mix(hex, pct) {
    var h = hex.replace("#", "");
    var out = "#";
    for (var i = 0; i < 3; i++) {
      var c = parseInt(h.slice(i * 2, i * 2 + 2), 16);
      var v = Math.round(c * pct + PAPER[i] * (1 - pct));
      out += ("0" + v.toString(16)).slice(-2);
    }
    return out;
  }

  var text = "#201e1d";
  return {
    PX: PX,
    px: function (n) { return n * PX; },
    mix: mix,
    color: {
      text: text,
      accent: "#ec3013",
      accent700: "#ae1800",
      surface: "#eae9e9",
      white: "#ffffff",
      // --color-divider is text at 40%; the muted greys are the template's
      // own color-mix(text N%) values, resolved.
      divider: mix(text, 0.40),
      muted55: mix(text, 0.55),
      muted60: mix(text, 0.60),
      muted65: mix(text, 0.65),
      muted70: mix(text, 0.70)
    },
    // Rule weights. The template uses exactly two: a 2px structural rule and
    // a 1px internal divider. Keeping it to two is most of the look.
    rule: { major: 2 * PX, minor: 1 * PX },
    // Tracking, in em — applied with doc.setCharSpace(em * fontSize).
    track: { kicker: 0.12, label: 0.10, display: -0.03, heading: -0.02, tight: -0.01, footer: 0.08 }
  };
})();

/* ---- Findings Report generator (embedded, single-file) ---- */
/*
 * findingsReport.js — client-side findings-report PDF generator.
 *
 * Builds a findings table + a portrait photo grid with two-way clickable links,
 * entirely in the browser. This is a faithful JS port of the validated Python
 * generator (generate_report.py): same A4 layout, same 3:4 portrait crop, same
 * EXIF-orientation handling, same bidirectional finding <-> photo links.
 *
 * Depends on two globals, loaded via <script> before this file:
 *   - jsPDF            (window.jspdf.jsPDF)
 *   - jspdf-autotable  (registers doc.autoTable)
 *
 * And loads one on demand:
 *   - heic2any         (window.heic2any) — only used if a photo is HEIC/HEIF
 *
 * heic2any is 1.32 MB, which was 69% of the 1.92 MB of JavaScript this app
 * blocked on before it could paint anything — for a library that does nothing
 * unless someone generates an inspection PDF from an iPhone photo. It is now
 * fetched by loadHeic2Any() at the top of generate() instead. The service
 * worker still pre-caches it (SHELL_FILES in sw.js), so the offline path is
 * unchanged: pre-caching a file and blocking the first paint on it are
 * different things, and only the second one was buying us anything.
 *
 * Public API:
 *   await FindingsReport.generate(data, options)
 *
 *   data = {
 *     title: "Site Findings Report",
 *     meta:  { Site: "...", Reference: "...", Date: "...", "Prepared by": "..." }, // optional
 *     findings: [
 *       {
 *         item: "Cracked concrete slab",
 *         description: "…",
 *         photos: [ url | { url, name } | Blob | { blob, name } ]   // 0..n
 *       }
 *     ]
 *   }
 *
 *   options = {
 *     fileName: "findings-report.pdf",   // download name
 *     download: true,                    // auto-trigger a download
 *   }
 *
 * Returns: Promise<Blob> (the PDF), so callers can also upload it to Supabase.
 */
(function (global) {
  "use strict";

  // ---- Layout constants (points; A4). Mirrors generate_report.py. ----------
  var PAGE_W = 595.28, PAGE_H = 841.89;
  var MARGIN = 43.2;                 // 0.6 inch
  var USABLE_W = PAGE_W - 2 * MARGIN;
  var GRID_COLS = 3;
  var PHOTO_RATIO = 3 / 4;           // vertical iPhone photo: width / height
  var MAX_IMAGE_DIM = 1600;
  var JPEG_QUALITY = 0.85;

  /* Modernist tokens — see the block at the top of this file. The findings
     table keeps its row rules rather than going fully unruled like the
     statement's: its cells wrap to several lines each and carry the photo
     cross-references, so the horizontal separation is doing real work here. */
  var PX = MODERNIST.px, TRACK = MODERNIST.track, RULE = MODERNIST.rule;
  var COLORS = {
    header: MODERNIST.color.text,
    grid: MODERNIST.color.divider,
    altRow: MODERNIST.color.surface,
    link: MODERNIST.color.accent700,
    missingBg: MODERNIST.color.surface,
    missingBorder: MODERNIST.color.divider,
    footer: MODERNIST.color.muted55,
    note: MODERNIST.color.muted60,
    text: MODERNIST.color.text,
    accent: MODERNIST.color.accent,
    accent700: MODERNIST.color.accent700,
    label: MODERNIST.color.muted55,
  };

  var FS = {
    body: PX(13.5), caption: PX(11.5), note: PX(11.5), footer: PX(10),
    title: PX(44), heading: PX(22), kicker: PX(10)
  };
  var CELL_PADDING = PX(6);          // autotable cell padding (pt)

  // Findings table column widths (fractions match the Python version).
  var COL_W = [0.06, 0.20, 0.54, 0.20].map(function (f) { return USABLE_W * f; });

  // ---- Small helpers -------------------------------------------------------
  function hexToRgb(hex) {
    var h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function looksHeic(blob, name) {
    var t = (blob && blob.type || "").toLowerCase();
    if (t.indexOf("heic") !== -1 || t.indexOf("heif") !== -1) return true;
    var n = (name || "").toLowerCase();
    return /\.(heic|heif)$/.test(n);
  }

  /* Loads heic2any the first time a report is generated, then never again.
     The path must stay in sync with SHELL_FILES in sw.js — check-app.mjs
     asserts this file exists on disk, which is what stops the path rotting
     silently now that there is no <script src> for it to check.

     The promise is cached including its rejection: a second attempt after a
     genuine failure would fail the same way, and re-injecting a script tag per
     photo is worse than reporting it once. */
  var heic2anyPromise = null;
  var HEIC2ANY_SRC = "vendor/heic2any-0.0.4.min.js";

  function loadHeic2Any() {
    if (global.heic2any) return Promise.resolve(global.heic2any);
    if (heic2anyPromise) return heic2anyPromise;
    heic2anyPromise = new Promise(function (resolve, reject) {
      var el = document.createElement("script");
      el.src = HEIC2ANY_SRC;
      el.async = true;
      el.onload = function () {
        if (global.heic2any) resolve(global.heic2any);
        else reject(new Error(HEIC2ANY_SRC + " loaded but did not define heic2any"));
      };
      el.onerror = function () { reject(new Error(HEIC2ANY_SRC + " failed to load")); };
      document.head.appendChild(el);
    });
    return heic2anyPromise;
  }

  // Center-crop source dimensions to a target width/height ratio (cover fit),
  // returning the source rectangle to copy. Mirrors Python crop_to_ratio().
  function coverCrop(w, h, ratio) {
    var current = w / h;
    if (current > ratio) {                 // too wide -> trim sides
      var newW = Math.round(h * ratio);
      return { sx: Math.floor((w - newW) / 2), sy: 0, sw: newW, sh: h };
    }
    if (current < ratio) {                 // too tall -> trim top/bottom
      var newH = Math.round(w / ratio);
      return { sx: 0, sy: Math.floor((h - newH) / 2), sw: w, sh: newH };
    }
    return { sx: 0, sy: 0, sw: w, sh: h };
  }

  function resolveEntry(entry) {
    // Normalise a photo entry into { src, blob, name } where exactly one of
    // src (URL string) / blob (Blob) is set.
    if (entry == null) return { name: "" };
    if (typeof entry === "string") return { src: entry, name: entry.split("/").pop() };
    if (entry instanceof Blob) return { blob: entry, name: "" };
    if (entry.blob instanceof Blob) return { blob: entry.blob, name: entry.name || "" };
    if (entry.url) return { src: entry.url, name: entry.name || String(entry.url).split("/").pop() };
    return { name: entry.name || "" };
  }

  // Fetch (if needed), decode (HEIC-aware), EXIF-correct, crop to portrait,
  // downscale, and return a JPEG data URL. Throws on any failure so the caller
  // can fall back to a "photo not found" placeholder.
  async function normalizeToDataUrl(entry) {
    var resolved = resolveEntry(entry);
    var blob = resolved.blob;

    if (!blob) {
      if (!resolved.src) throw new Error("no source");
      var resp = await fetch(resolved.src);
      if (!resp.ok) throw new Error("fetch failed: " + resp.status);
      blob = await resp.blob();
    }

    if (looksHeic(blob, resolved.name)) {
      if (!global.heic2any) throw new Error("HEIC photo but heic2any not loaded");
      blob = await global.heic2any({ blob: blob, toType: "image/jpeg", quality: 0.9 });
      if (Array.isArray(blob)) blob = blob[0];
    }

    var bitmap;
    try {
      // { imageOrientation: 'from-image' } applies EXIF rotation on decode —
      // this is the browser equivalent of PIL's ImageOps.exif_transpose().
      bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch (e) {
      // Some browsers reject the options bag, or the blob was undeclared HEIC.
      if (global.heic2any && !looksHeic(blob, resolved.name)) {
        try {
          var conv = await global.heic2any({ blob: blob, toType: "image/jpeg", quality: 0.9 });
          blob = Array.isArray(conv) ? conv[0] : conv;
        } catch (ignored) { /* fall through to a plain decode */ }
      }
      bitmap = await createImageBitmap(blob);
    }

    var crop = coverCrop(bitmap.width, bitmap.height, PHOTO_RATIO);
    var scale = Math.min(1, MAX_IMAGE_DIM / Math.max(crop.sw, crop.sh));
    var outW = Math.max(1, Math.round(crop.sw * scale));
    var outH = Math.max(1, Math.round(crop.sh * scale));

    var canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, outW, outH);
    if (bitmap.close) bitmap.close();
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  }

  function getAutoTable(doc) {
    if (typeof doc.autoTable === "function") return doc.autoTable.bind(doc);
    if (global.jspdf && typeof global.jspdf.autoTable === "function") {
      return function (opts) { return global.jspdf.autoTable(doc, opts); };
    }
    throw new Error("jspdf-autotable is not loaded");
  }

  // ---- Main entry ----------------------------------------------------------
  async function generate(data, options) {
    options = options || {};
    var fileName = options.fileName || "findings-report.pdf";
    var doDownload = options.download !== false;

    if (!global.jspdf || !global.jspdf.jsPDF) throw new Error("jsPDF is not loaded");
    var JsPDF = global.jspdf.jsPDF;

    // Best-effort: a HEIC photo needs this, every other format does not, and
    // we cannot tell which we have until each blob is inspected. Failing to
    // load it must not fail the whole report — normalizeToDataUrl() already
    // handles the library being absent, and says so for the one photo that
    // actually needed it.
    await loadHeic2Any().catch(function (err) {
      console.warn("[report] heic2any could not be loaded — HEIC photos will fail to convert", err);
    });

    var title = data.title || "Findings Report";
    var meta = data.meta || {};
    var findings = data.findings || [];

    // Flat, ordered list of photo references: one per (finding, photo) pair.
    // record = { n, m, label, entry, item }
    var records = [];
    var refsByFinding = {};   // n -> [{ m, label }]
    findings.forEach(function (f, i) {
      var n = i + 1;
      refsByFinding[n] = [];
      (f.photos || []).forEach(function (entry, j) {
        var m = j + 1;
        var label = n + "." + m;
        records.push({ n: n, m: m, label: label, entry: entry, item: f.item || "" });
        refsByFinding[n].push({ m: m, label: label });
      });
    });

    // Pre-normalise every image up front (in parallel) so the layout pass is
    // synchronous and page/position bookkeeping is deterministic.
    await Promise.all(records.map(async function (rec) {
      try {
        rec.dataUrl = await normalizeToDataUrl(rec.entry);
        rec.ok = true;
      } catch (err) {
        rec.ok = false;
        rec.missingLabel = resolveEntry(rec.entry).name || String(rec.entry) || "(no source)";
        if (global.console) console.warn("findingsReport: photo " + rec.label + " unavailable:", err && err.message);
      }
    }));

    var doc = new JsPDF({ unit: "pt", format: "a4" });
    doc.setProperties({ title: title });
    var autoTable = getAutoTable(doc);

    var findingAnchors = {};   // n -> { page, y }        (target of a back-link)
    var photosCellInfo = {};   // n -> { page, x, y, w, h } (source of forward-links)
    var photoTargets = {};     // label -> { page, y }    (target of a forward-link)
    var backLinks = [];        // { page, x, y, w, h, targetN }

    // --- Header block -------------------------------------------------------
    /* Masthead in the same shape as the owner statement: a tracked kicker,
       the document name set large and tight in ink, then a 2px rule. */
    var y = MARGIN;
    var totalPhotos = records.length;
    kicker(doc, "Inspection report", MARGIN, y + FS.kicker, COLORS.accent700);

    var titleBase = y + FS.kicker + PX(10) + FS.title;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(FS.title);
    setText(doc, COLORS.text);
    doc.setCharSpace(TRACK.heading * FS.title);
    var titleLines = doc.splitTextToSize(String(title), USABLE_W);
    titleLines.forEach(function (line, i) { doc.text(line, MARGIN, titleBase + i * FS.title); });
    doc.setCharSpace(0);
    y = titleBase + (titleLines.length - 1) * FS.title + PX(14);
    rule(doc, MARGIN, PAGE_W - MARGIN, y, RULE.major);

    /* Meta strip: the caller's key/value pairs plus the two counts, laid out
       as tracked-label-over-value cells like the statement's. */
    var metaCells = Object.keys(meta).map(function (k) { return [k, String(meta[k])]; })
      .concat([["Findings", String(findings.length)], ["Photos", String(totalPhotos)]]);
    if (metaCells.length) {
      var perRow = 4;
      var cellW = USABLE_W / perRow;
      var rows = Math.ceil(metaCells.length / perRow);
      var stripTop = y;
      for (var r = 0; r < rows; r++) {
        var labelY = y + PX(10) + FS.kicker;
        var tallest = 1;
        metaCells.slice(r * perRow, (r + 1) * perRow).forEach(function (cell, i) {
          var cx = MARGIN + i * cellW + (i === 0 ? 0 : PX(14));
          kicker(doc, cell[0], cx, labelY, COLORS.label);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(FS.caption);
          setText(doc, COLORS.text);
          // Wrap rather than clip: a truncated site address or reference in an
          // inspection report is lost evidence, not a cosmetic problem.
          var lines = doc.splitTextToSize(cell[1], cellW - PX(18));
          lines.forEach(function (line, li) {
            doc.text(line, cx, labelY + PX(3) + FS.caption + li * FS.caption * 1.3);
          });
          if (lines.length > tallest) tallest = lines.length;
        });
        y = labelY + PX(3) + FS.caption + (tallest - 1) * FS.caption * 1.3 + PX(10);
      }
      for (var ci = 1; ci < perRow; ci++) {
        setDraw(doc, COLORS.grid);
        doc.setLineWidth(RULE.minor);
        doc.line(MARGIN + ci * cellW, stripTop, MARGIN + ci * cellW, y);
      }
      rule(doc, MARGIN, PAGE_W - MARGIN, y, RULE.major);
    }

    y += PX(24) + FS.heading;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(FS.heading);
    setText(doc, COLORS.text);
    doc.setCharSpace(TRACK.tight * FS.heading);
    doc.text("Findings", MARGIN, y);
    doc.setCharSpace(0);
    y += PX(10);

    // --- Findings table -----------------------------------------------------
    var body = findings.map(function (f, i) {
      var n = i + 1;
      var refText = refsByFinding[n].map(function (r) { return r.label; }).join(", ") || "—";
      return [String(n), f.item || "", f.description || "", refText];
    });

    autoTable({
      startY: y,
      head: [["#", "Item", "Description", "Photos"]],
      body: body,
      theme: "plain",
      styles: {
        font: "helvetica", fontSize: FS.body, valign: "top", lineWidth: 0,
        cellPadding: { top: CELL_PADDING, bottom: CELL_PADDING, left: 0, right: PX(12) },
        textColor: hexToRgb(COLORS.text), overflow: "linebreak",
      },
      headStyles: {
        fontStyle: "bold", fontSize: FS.kicker, textColor: hexToRgb(COLORS.label),
        cellPadding: { top: 0, bottom: PX(6), left: 0, right: PX(12) }
      },
      columnStyles: {
        0: { cellWidth: COL_W[0], fontStyle: "bold", textColor: hexToRgb(COLORS.accent) },
        1: { cellWidth: COL_W[1], fontStyle: "bold" },
        2: { cellWidth: COL_W[2] },
        3: { cellWidth: COL_W[3], textColor: hexToRgb(COLORS.link) },
      },
      margin: { left: MARGIN, right: MARGIN },
      willDrawCell: function (d) {
        doc.setCharSpace(d.section === "head" ? TRACK.label * FS.kicker : 0);
        if (d.section === "head") d.cell.text = d.cell.text.map(function (t) { return String(t).toUpperCase(); });
      },
      didDrawCell: function (d) {
        if (d.section === "head") {
          rule(doc, d.cell.x, d.cell.x + d.cell.width, d.cell.y + d.cell.height, RULE.major);
          return;
        }
        if (d.section !== "body") return;
        // Hairline between findings — these cells wrap to several lines, so
        // the row boundary is load-bearing here in a way it isn't elsewhere.
        rule(doc, d.cell.x, d.cell.x + d.cell.width, d.cell.y + d.cell.height, RULE.minor, COLORS.grid);
        var n = d.row.index + 1;
        var page = doc.internal.getCurrentPageInfo().pageNumber;
        if (d.column.index === 0) {
          findingAnchors[n] = { page: page, y: d.cell.y };
        } else if (d.column.index === 3) {
          photosCellInfo[n] = { page: page, x: d.cell.x, y: d.cell.y, w: d.cell.width, h: d.cell.height };
        }
      },
    });
    doc.setCharSpace(0);

    // --- Attachments (portrait photo grid) ----------------------------------
    if (records.length) {
      doc.addPage();
      var ay = MARGIN;
      kicker(doc, "Evidence", MARGIN, ay + FS.kicker, COLORS.accent700);
      ay += FS.kicker + PX(6);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(FS.heading);
      setText(doc, COLORS.text);
      doc.setCharSpace(TRACK.tight * FS.heading);
      doc.text("Attachments", MARGIN, ay + FS.heading);
      doc.setCharSpace(0);
      ay += FS.heading + PX(10);
      rule(doc, MARGIN, PAGE_W - MARGIN, ay, RULE.major);
      ay += PX(10);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(FS.note);
      setText(doc, COLORS.note);
      var intro = "Each photo caption links back to its finding; each “Photos” reference in the table links to the photo here.";
      doc.splitTextToSize(intro, USABLE_W).forEach(function (line) {
        doc.text(line, MARGIN, ay + FS.note);
        ay += FS.note + 3;
      });
      ay += 6;

      var colW = USABLE_W / GRID_COLS;
      var imgW = colW - 16;
      var imgH = imgW / PHOTO_RATIO;
      var padTop = 8, gapImgCap = 6, captionH = 34, padBottom = 8;
      var rowH = padTop + imgH + gapImgCap + captionH + padBottom;
      var bottomLimit = PAGE_H - MARGIN - 24;

      var rowTopY = ay;
      var currentPage = doc.internal.getCurrentPageInfo().pageNumber;

      records.forEach(function (rec, i) {
        var col = i % GRID_COLS;
        if (col === 0) {
          if (i !== 0) rowTopY += rowH;
          if (rowTopY + rowH > bottomLimit) { doc.addPage(); currentPage += 1; rowTopY = MARGIN; }
        }
        var cellX = MARGIN + col * colW;
        var imgX = cellX + (colW - imgW) / 2;
        var imgY = rowTopY + padTop;

        // uniform cell border
        setDraw(doc, COLORS.missingBorder);
        doc.setLineWidth(0.5);
        doc.rect(cellX, rowTopY, colW, rowH);

        if (rec.ok) {
          doc.addImage(rec.dataUrl, "JPEG", imgX, imgY, imgW, imgH);
        } else {
          setFill(doc, COLORS.missingBg);
          setDraw(doc, COLORS.missingBorder);
          doc.rect(imgX, imgY, imgW, imgH, "FD");
          doc.setFont("helvetica", "normal");
          doc.setFontSize(FS.caption);
          setText(doc, COLORS.text);
          var msg = doc.splitTextToSize("Photo not found:\n" + rec.missingLabel, imgW - 12);
          var startY = imgY + imgH / 2 - (msg.length - 1) * (FS.caption + 2) / 2;
          msg.forEach(function (line, k) {
            doc.text(line, imgX + imgW / 2, startY + k * (FS.caption + 2), { align: "center" });
          });
        }

        photoTargets[rec.label] = { page: currentPage, y: imgY };

        // caption: a clickable "Photo n.m" line + the item text below it
        var capBaseY = imgY + imgH + gapImgCap;
        var centerX = cellX + colW / 2;
        var prefix = "Photo " + rec.label;

        doc.setFont("helvetica", "normal");
        doc.setFontSize(FS.caption);
        setText(doc, COLORS.link);
        doc.text(prefix, centerX, capBaseY + FS.caption, { align: "center" });
        var prefixW = doc.getTextWidth(prefix);
        // underline + record the hotspot for the back-link
        doc.setLineWidth(0.4);
        setDraw(doc, COLORS.link);
        doc.line(centerX - prefixW / 2, capBaseY + FS.caption + 1.5, centerX + prefixW / 2, capBaseY + FS.caption + 1.5);
        backLinks.push({
          page: currentPage, x: centerX - prefixW / 2, y: capBaseY,
          w: prefixW, h: FS.caption + 3, targetN: rec.n,
        });

        setText(doc, COLORS.text);
        var itemLines = doc.splitTextToSize(rec.item || "", colW - 8).slice(0, 2);
        itemLines.forEach(function (line, k) {
          doc.text(line, centerX, capBaseY + FS.caption + 12 + k * (FS.caption + 2), { align: "center" });
        });
      });
    }

    // --- Wire up the links --------------------------------------------------
    // Back-links: photo caption -> its finding row.
    backLinks.forEach(function (bl) {
      var target = findingAnchors[bl.targetN];
      if (!target) return;
      doc.setPage(bl.page);
      doc.link(bl.x, bl.y, bl.w, bl.h, { pageNumber: target.page, top: target.y });
    });

    // Forward-links: each "n.m" ref in a finding's Photos cell -> that photo.
    // The ref text is laid out by autotable inside the cell; we overlay
    // invisible clickable hotspots along the first line(s), wrapping within
    // the cell just as the drawn text does.
    doc.setFontSize(FS.body);
    doc.setFont("helvetica", "normal");
    Object.keys(photosCellInfo).forEach(function (nKey) {
      var n = parseInt(nKey, 10);
      var cell = photosCellInfo[n];
      var refs = refsByFinding[n];
      if (!refs || !refs.length) return;

      var lineH = FS.body * 1.15;
      var left = cell.x + CELL_PADDING;
      var right = cell.x + cell.w - CELL_PADDING;
      var x = left;
      var lineY = cell.y + CELL_PADDING;
      var sepW = doc.getTextWidth(", ");

      doc.setPage(cell.page);
      refs.forEach(function (r, idx) {
        var tokenW = doc.getTextWidth(r.label);
        if (x + tokenW > right && x > left) { x = left; lineY += lineH; }
        var target = photoTargets[r.label];
        if (target) doc.link(x, lineY, tokenW, FS.body + 2, { pageNumber: target.page, top: target.y });
        x += tokenW;
        if (idx < refs.length - 1) x += sepW;
      });
    });

    // --- Footer: "Page X of Y" on every page --------------------------------
    var totalPages = doc.internal.getNumberOfPages();
    for (var p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      rule(doc, MARGIN, PAGE_W - MARGIN, PAGE_H - 37, RULE.major);
      kicker(doc, title, MARGIN, PAGE_H - 26, COLORS.text);
      kicker(doc, "Page " + p + " of " + totalPages, PAGE_W - MARGIN, PAGE_H - 26, COLORS.footer, "right");
    }

    var blob = doc.output("blob");
    if (doDownload) doc.save(fileName);
    return blob;
  }

  // color setters (jsPDF wants numeric r,g,b for cross-version safety)
  function setText(doc, hex) { var c = hexToRgb(hex); doc.setTextColor(c[0], c[1], c[2]); }
  function setFill(doc, hex) { var c = hexToRgb(hex); doc.setFillColor(c[0], c[1], c[2]); }
  function setDraw(doc, hex) { var c = hexToRgb(hex); doc.setDrawColor(c[0], c[1], c[2]); }

  /* The system's micro-label and its two rule weights — same helpers as the
     other two generators. Char spacing is reset every time: it is document
     state, and a leftover value widens whatever autoTable draws next. */
  function kicker(doc, str, x, y, hex, align) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(FS.kicker);
    setText(doc, hex || COLORS.accent700);
    doc.setCharSpace(TRACK.kicker * FS.kicker);
    var s = String(str).toUpperCase();
    if (align === "right") doc.text(s, x - (doc.getTextWidth(s) + TRACK.kicker * FS.kicker * Math.max(s.length - 1, 0)), y);
    else doc.text(s, x, y);
    doc.setCharSpace(0);
  }

  function rule(doc, x1, x2, y, weight, hex) {
    setDraw(doc, hex || COLORS.text);
    doc.setLineWidth(weight);
    doc.line(x1, y, x2, y);
  }

  global.FindingsReport = { generate: generate, normalizeToDataUrl: normalizeToDataUrl };
})(typeof window !== "undefined" ? window : this);

/*
 * InvoiceReport — client-side NZ tax-invoice PDF generator.
 *
 * Ported from msz's invoice_generator.py (reportlab) so the on-screen PDF
 * matches that layout: accent-teal "TAX INVOICE" header with an optional
 * logo, sender block top-right, Bill To + a meta table (invoice #,
 * reference, dates, terms), a line-item table with hairline row rules and
 * an accent header bar, an emphasised total bar, a Payment Details block,
 * notes, and a footer credit line. Pure browser JS (jsPDF + jspdf-autotable)
 * — no server/Python involved at generation time. invoice_generator.py +
 * invoice_data.json remain a valid offline path too; paste that JSON into
 * the "Import invoice (JSON)" box on the Invoices page to load it straight
 * into this same form/PDF.
 *
 * Public API: await InvoiceReport.generate(data, options)
 *   data = {
 *     invoiceNumber, reference, issueDate, dueDate, paymentTermsDays, status,
 *     from:   { name, address:[lines], email, phone, gstNumber, logoPath,
 *               bank: { accountName, bankName, accountNumber, referenceNote } },
 *     billTo: { name, attention, address, email },   // address: string or [lines]
 *     items:  [{ description, quantity, unitPrice, amount }],
 *     gstMode: 'exclusive' | 'inclusive' | 'none',
 *     subtotal, gst, total,
 *     notes
 *   }
 *   options = { fileName, download }
 *   Returns: Promise<Blob>
 */
(function (global) {
  "use strict";

  var PAGE_W = 595.28, PAGE_H = 841.89;
  var MARGIN = 43.2;
  var USABLE_W = PAGE_W - 2 * MARGIN;
  var MM = 2.834645669; // 1mm in pt — used for the logo max-size box

  /* Modernist tokens. The invoice keeps its own layout — only the statement
     was designed in the system — but it draws from the same palette, the same
     two rule weights and the same tracked-uppercase label treatment, so the
     three documents read as one set. */
  var PX = MODERNIST.px, TRACK = MODERNIST.track, RULE = MODERNIST.rule;
  var COLORS = {
    accent: MODERNIST.color.accent,
    accent700: MODERNIST.color.accent700,
    grey: MODERNIST.color.muted55,
    rule: MODERNIST.color.divider,
    text: MODERNIST.color.text,
    white: MODERNIST.color.white
  };
  var FS = {
    title: PX(40), titleWithLogo: PX(30), label: PX(10),
    body: PX(13.5), small: PX(12), footer: PX(10)
  };

  function hexToRgb(hex) {
    var h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function setText(doc, hex) { var c = hexToRgb(hex); doc.setTextColor(c[0], c[1], c[2]); }
  function setDraw(doc, hex) { var c = hexToRgb(hex); doc.setDrawColor(c[0], c[1], c[2]); }
  function setFill(doc, hex) { var c = hexToRgb(hex); doc.setFillColor(c[0], c[1], c[2]); }
  function money(n) { return "$" + (Number(n) || 0).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  function getAutoTable(doc) {
    if (typeof doc.autoTable === "function") return doc.autoTable.bind(doc);
    if (global.jspdf && typeof global.jspdf.autoTable === "function") {
      return function (opts) { return global.jspdf.autoTable(doc, opts); };
    }
    throw new Error("jspdf-autotable is not loaded");
  }

  /* The system's micro-label: uppercase, tracked, accent-coloured. Char
     spacing is document state in jsPDF, so it is always reset — a leftover
     value silently widens the next thing drawn, autoTable cells included. */
  function kicker(doc, str, x, y, hex, align) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(FS.label);
    setText(doc, hex || COLORS.accent700);
    doc.setCharSpace(TRACK.kicker * FS.label);
    var s = String(str).toUpperCase();
    if (align === "right") doc.text(s, x - (doc.getTextWidth(s) + TRACK.kicker * FS.label * Math.max(s.length - 1, 0)), y);
    else doc.text(s, x, y);
    doc.setCharSpace(0);
  }

  function rule(doc, x1, x2, y, weight, hex) {
    setDraw(doc, hex || COLORS.text);
    doc.setLineWidth(weight);
    doc.line(x1, y, x2, y);
  }

  // Best-effort logo fetch — mirrors the Python script's try/except: a
  // missing path, a 404, or a decode failure just means the invoice prints
  // without a logo. It never blocks generation. Only works for a logo file
  // hosted alongside index.html (e.g. logo.png on GitHub Pages), since the
  // browser can't read an arbitrary local filesystem path.
  async function loadLogo(path) {
    if (!path) return null;
    try {
      var res = await fetch(path);
      if (!res.ok) return null;
      var blob = await res.blob();
      var bitmap = await createImageBitmap(blob);
      var canvas = document.createElement("canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      if (bitmap.close) bitmap.close();
      return { dataUrl: canvas.toDataURL("image/png"), w: canvas.width, h: canvas.height };
    } catch (err) {
      if (global.console) console.warn("InvoiceReport: logo unavailable:", err && err.message);
      return null;
    }
  }

  async function generate(data, options) {
    options = options || {};
    var fileName = options.fileName || "invoice.pdf";
    var doDownload = options.download !== false;

    if (!global.jspdf || !global.jspdf.jsPDF) throw new Error("jsPDF is not loaded");
    var JsPDF = global.jspdf.jsPDF;

    var from = data.from || {};
    var bank = from.bank || {};
    var billTo = data.billTo || {};
    var items = data.items || [];
    var fromAddress = Array.isArray(from.address) ? from.address : (from.address ? [from.address] : []);
    var billAddress = Array.isArray(billTo.address) ? billTo.address : (billTo.address ? String(billTo.address).split("\n").filter(Boolean) : []);

    var logo = await loadLogo(from.logoPath);

    var doc = new JsPDF({ unit: "pt", format: "a4" });
    doc.setProperties({ title: "Invoice " + (data.invoiceNumber || "") });
    var autoTable = getAutoTable(doc);

    var left = MARGIN, right = PAGE_W - MARGIN;
    var y = MARGIN + 4;

    // --- Logo + "TAX INVOICE" title (top-left) ---
    var titleBottom;
    // Set like the statement's masthead: the document name large and tight in
    // ink, the number carrying the accent (below, in the meta column).
    function drawTitle(size, baseline) {
      setText(doc, COLORS.text);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(size);
      doc.setCharSpace(TRACK.heading * size);
      doc.text("Tax Invoice", left, baseline);
      doc.setCharSpace(0);
    }
    if (logo) {
      var maxW = 50 * MM, maxH = 22 * MM;
      var scale = Math.min(maxW / logo.w, maxH / logo.h, 1);
      var dw = logo.w * scale, dh = logo.h * scale;
      doc.addImage(logo.dataUrl, "PNG", left, y, dw, dh);
      drawTitle(FS.titleWithLogo, y + dh + 18 + FS.titleWithLogo * 0.3);
      titleBottom = y + dh + 24 + FS.titleWithLogo * 0.3;
    } else {
      drawTitle(FS.title, y + FS.title);
      titleBottom = y + FS.title + 6;
    }

    // --- Sender block (top-right) ---
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    setText(doc, COLORS.text);
    doc.text(from.name || "—", right, y + 11, { align: "right" });
    var sy = y + 11 + 14;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(FS.small);
    setText(doc, COLORS.grey);
    fromAddress.forEach(function (line) { doc.text(line, right, sy, { align: "right" }); sy += 12; });
    if (from.email) { doc.text(from.email, right, sy, { align: "right" }); sy += 12; }
    if (from.phone) { doc.text(from.phone, right, sy, { align: "right" }); sy += 12; }
    if (from.gstNumber) { doc.text("GST No: " + from.gstNumber, right, sy, { align: "right" }); sy += 12; }

    y = Math.max(titleBottom, sy) + 26;

    // --- Bill To (left) / meta table (right) ---
    var colW = USABLE_W / 2 - 10;
    rule(doc, left, right, y - PX(14), RULE.major);
    kicker(doc, "Bill to", left, y);
    var by = y + 14;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(FS.body);
    setText(doc, COLORS.text);
    doc.text(billTo.name || "—", left, by); by += 12;
    if (billTo.attention) { doc.text("Attn: " + billTo.attention, left, by); by += 12; }
    billAddress.forEach(function (line) {
      doc.splitTextToSize(line, colW).forEach(function (l) { doc.text(l, left, by); by += 12; });
    });
    if (billTo.email) { setText(doc, COLORS.grey); doc.text(billTo.email, left, by); by += 12; setText(doc, COLORS.text); }

    var meta = [["Invoice number", data.invoiceNumber || "—"]];
    if (data.reference) meta.push(["Reference", data.reference]);
    meta.push(["Invoice date", data.issueDate || "—"]);
    if (data.paymentTermsDays != null && data.paymentTermsDays !== "") meta.push(["Payment terms", data.paymentTermsDays + " days"]);
    if (data.dueDate) meta.push(["Due date", data.dueDate]);
    if (data.status) meta.push(["Status", data.status]);

    var my = y;
    meta.forEach(function (row) {
      kicker(doc, row[0], right - colW, my, COLORS.grey);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(FS.small);
      setText(doc, COLORS.text);
      doc.text(String(row[1]), right, my, { align: "right" });
      my += 15;
    });

    y = Math.max(by, my) + 22;

    // --- Line items table (hairline row rules, accent header bar) ---
    var body = items.map(function (it) {
      var amt = it.amount != null ? it.amount : (it.quantity || 0) * (it.unitPrice || 0);
      return [it.description || "", String(it.quantity != null ? it.quantity : ""), money(it.unitPrice), money(amt)];
    });

    autoTable({
      startY: y,
      head: [["Description", "Qty", "Unit price", "Amount (excl. GST)"]],
      body: body,
      theme: "plain",
      styles: { font: "helvetica", fontSize: FS.body, cellPadding: { top: 6, bottom: 6, left: 0, right: 0 }, textColor: hexToRgb(COLORS.text) },
      // Same head as the statement: no filled bar, just a tracked uppercase
      // row sitting on a 2px rule.
      headStyles: { fontStyle: "bold", fontSize: FS.label, textColor: hexToRgb(COLORS.grey), cellPadding: { top: 0, bottom: PX(6), left: 0, right: 0 } },
      columnStyles: {
        0: { cellWidth: USABLE_W * 0.5 },
        1: { cellWidth: USABLE_W * 0.12, halign: "right" },
        2: { cellWidth: USABLE_W * 0.19, halign: "right" },
        3: { cellWidth: USABLE_W * 0.19, halign: "right" }
      },
      margin: { left: MARGIN, right: MARGIN },
      willDrawCell: function (d) {
        doc.setCharSpace(d.section === "head" ? TRACK.label * FS.label : 0);
        if (d.section === "head") d.cell.text = d.cell.text.map(function (t) { return String(t).toUpperCase(); });
      },
      didDrawCell: function (d) {
        if (d.section === "head") {
          rule(doc, d.cell.x, d.cell.x + d.cell.width, d.cell.y + d.cell.height, RULE.major);
        } else if (d.section === "body") {
          rule(doc, d.cell.x, d.cell.x + d.cell.width, d.cell.y + d.cell.height, RULE.minor, COLORS.rule);
        }
      }
    });
    doc.setCharSpace(0);

    var afterTableY = doc.lastAutoTable.finalY + 16;

    // --- Totals (right-aligned; total row emphasised with an accent bar) ---
    var boxW = 220;
    var totalRows = [["Subtotal (excl. GST)", money(data.subtotal)]];
    if (data.gstMode !== "none") totalRows.push(["GST (15%)", money(data.gst)]);
    totalRows.push([(data.gstMode === "none" ? "Total" : "Total (incl. GST)") + " NZD", money(data.total)]);

    if (afterTableY + totalRows.length * 20 + 150 > PAGE_H - MARGIN) { doc.addPage(); afterTableY = MARGIN; }

    var boxX = right - boxW;
    var ty = afterTableY;
    totalRows.forEach(function (row, i) {
      var isLast = i === totalRows.length - 1;
      if (isLast) {
        setFill(doc, COLORS.accent);
        doc.rect(boxX - 4, ty - 2, boxW + 4, 20, "F");
        setText(doc, COLORS.white);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(FS.label + 1);
      } else {
        setText(doc, COLORS.text);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(FS.body);
      }
      doc.text(row[0], boxX, ty + 12);
      doc.text(row[1], boxX + boxW, ty + 12, { align: "right" });
      ty += isLast ? 22 : 18;
    });

    // --- Payment details (only shown once at least one bank field is set) ---
    var hasBank = bank.accountName || bank.bankName || bank.accountNumber || bank.referenceNote;
    var py = ty + 24;
    if (hasBank) {
      rule(doc, left, right, py - PX(14), RULE.major);
      kicker(doc, "Payment details", left, py);
      py += 14;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(FS.body);
      setText(doc, COLORS.text);
      if (bank.accountName) { doc.text("Account name: " + bank.accountName, left, py); py += 12; }
      if (bank.bankName) { doc.text("Bank: " + bank.bankName, left, py); py += 12; }
      if (bank.accountNumber) { doc.text("Account number: " + bank.accountNumber, left, py); py += 12; }
      if (bank.referenceNote) { setText(doc, COLORS.grey); doc.text(bank.referenceNote, left, py); py += 14; setText(doc, COLORS.text); }
    }

    // --- Notes ---
    if (data.notes) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(FS.body);
      setText(doc, COLORS.text);
      doc.splitTextToSize(data.notes, USABLE_W).forEach(function (line) { doc.text(line, left, py); py += 12; });
    }

    // --- Footer on every page ---
    var totalPages = doc.internal.getNumberOfPages();
    var footerBits = [from.name || "Invoice"];
    if (from.gstNumber) footerBits.push("GST No: " + from.gstNumber);
    var generatedOn = new Date().toLocaleDateString("en-NZ", { day: "2-digit", month: "short", year: "numeric" });
    for (var p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      rule(doc, MARGIN, PAGE_W - MARGIN, PAGE_H - 37, RULE.major);
      kicker(doc, footerBits.join(" · "), MARGIN, PAGE_H - 26, COLORS.text);
      kicker(doc, "Generated " + generatedOn + " · Page " + p + " of " + totalPages,
             PAGE_W - MARGIN, PAGE_H - 26, COLORS.grey, "right");
    }

    var blob = doc.output("blob");
    if (doDownload) doc.save(fileName);
    return blob;
  }

  global.InvoiceReport = { generate: generate };
})(typeof window !== "undefined" ? window : this);

/*
 * StatementReport — client-side monthly owner-statement PDF generator,
 * same pattern as InvoiceReport/FindingsReport above (pure browser JS,
 * jsPDF + jspdf-autotable, no server).
 *
 * NOTE FOR msz: this is a working placeholder so the Statements section
 * is functional today, in the same spirit as the InvoiceReport note
 * above. Once your monthly-statement JSON generator exists, either feed
 * its output through window.importStatementJSON(data) (see the comment
 * above loadStatementJSON() in the STATEMENTS MODULE script) to reuse
 * this layout as-is, or port your own layout logic into generate()
 * below — keep the same data shape so nothing else in the app needs
 * to change.
 *
 * Public API: await StatementReport.generate(data, options)
 *   data = {
 *     statementNumber, periodStart, periodEnd, status,
 *     from:  { name, address, gstNumber, email, phone, bankAccount },
 *     owner: { name, email },
 *     properties: [{
 *       propertyAddress,
 *       openingBalance,
 *       income:   [{ date, description, amount }],
 *       expenses: [{ date, description, amount }],
 *       totalIncome, totalExpenses, netAmount, closingBalance,
 *       notes
 *     }],
 *     openingBalance, totalIncome, totalExpenses, netAmount, closingBalance, // combined across all properties
 *     notes
 *   }
 *   options = { fileName, download }
 *   Returns: Promise<Blob>
 */
(function (global) {
  "use strict";

  var PAGE_W = 595.28, PAGE_H = 841.89;
  var MARGIN = 43.2;
  var USABLE_W = PAGE_W - 2 * MARGIN;

  var COLORS = MODERNIST.color;
  var PX = MODERNIST.px, TRACK = MODERNIST.track, RULE = MODERNIST.rule;

  /* Type scale, straight off the template's inline styles (px -> pt).
     Named for the element rather than the size so the mapping back to the
     HTML stays obvious. */
  var FS = {
    kicker: PX(10),        // uppercase tracked labels
    display: PX(64),       // the statement numeral
    title: PX(44),         // "Owner / Statement"
    total: PX(52),         // the combined-total figure
    property: PX(22),      // property address heading
    section: PX(12),       // INCOME / EXPENSES
    partyName: PX(17),
    metaValue: PX(15),
    balance: PX(16),
    totalValue: PX(17),
    body: PX(13.5),        // table rows
    note: PX(11.5),
    notesBlock: PX(12),
    footer: PX(10)
  };

  function hexToRgb(hex) {
    var h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function setText(doc, hex) { var c = hexToRgb(hex); doc.setTextColor(c[0], c[1], c[2]); }
  function setDraw(doc, hex) { var c = hexToRgb(hex); doc.setDrawColor(c[0], c[1], c[2]); }
  function setFill(doc, hex) { var c = hexToRgb(hex); doc.setFillColor(c[0], c[1], c[2]); }
  function money(n) { return "$" + (Number(n) || 0).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  /* --- Drawing helpers -----------------------------------------------------
     The template's whole visual system is: tracked uppercase micro-labels,
     two rule weights, and one accent block. These three helpers are what
     draw all of it, so the layout code below stays readable as layout. */

  // A horizontal rule. weight is RULE.major (2px) or RULE.minor (1px).
  function rule(doc, x1, x2, y, weight, hex) {
    setDraw(doc, hex || COLORS.text);
    doc.setLineWidth(weight);
    doc.line(x1, y, x2, y);
  }

  /* Text with the template's tracking applied. jsPDF's letter-spacing is
     absolute points, and CSS letter-spacing is em, so it has to be resolved
     against the font size at every call. Always reset to 0 — char spacing is
     document state, and leaving it set silently widens the next thing drawn,
     including autoTable's cells. */
  function tx(doc, str, x, y, o) {
    o = o || {};
    var size = o.size || FS.body;
    doc.setFont("helvetica", o.bold ? "bold" : "normal");
    doc.setFontSize(size);
    setText(doc, o.color || COLORS.text);
    if (o.track) doc.setCharSpace(o.track * size);
    doc.text(o.upper ? String(str).toUpperCase() : String(str), x, y, o.align ? { align: o.align } : undefined);
    if (o.track) doc.setCharSpace(0);
  }

  /* Largest size at or below `size` that fits `str` into `maxW`. The meta
     strip gives every cell a flat quarter of the page, and the period string
     is the one that can outgrow that — a value silently overlapping its
     neighbour is a worse outcome than one set a point smaller. */
  function fitSize(doc, str, maxW, size, bold) {
    if (!maxW) return size;
    doc.setFont("helvetica", bold ? "bold" : "normal");
    for (var s = size; s > size * 0.6; s -= 0.25) {
      doc.setFontSize(s);
      if (doc.getTextWidth(String(str)) <= maxW) return s;
    }
    return size * 0.6;
  }

  // The recurring "tiny tracked label above a bold value" pair, used by the
  // meta strip, the balance strips and the totals block.
  function stat(doc, label, value, x, y, o) {
    o = o || {};
    var size = o.size || FS.balance;
    tx(doc, label, x, y, { size: FS.kicker, track: TRACK.label, upper: true, color: o.labelColor || COLORS.muted55, align: o.align });
    tx(doc, value, x, y + PX(3) + size,
       { size: fitSize(doc, value, o.maxW, size, true), bold: true, color: o.valueColor || COLORS.text, align: o.align });
    return y + PX(3) + size;
  }

  function getAutoTable(doc) {
    if (typeof doc.autoTable === "function") return doc.autoTable.bind(doc);
    if (global.jspdf && typeof global.jspdf.autoTable === "function") {
      return function (opts) { return global.jspdf.autoTable(doc, opts); };
    }
    throw new Error("jspdf-autotable is not loaded");
  }

  async function generate(data, options) {
    options = options || {};
    var fileName = options.fileName || "statement.pdf";
    var doDownload = options.download !== false;

    if (!global.jspdf || !global.jspdf.jsPDF) throw new Error("jsPDF is not loaded");
    var JsPDF = global.jspdf.jsPDF;

    var from = data.from || {};
    var owner = data.owner || {};
    var properties = (data.properties && data.properties.length) ? data.properties : [{}];

    var doc = new JsPDF({ unit: "pt", format: "a4" });
    doc.setProperties({ title: "Owner Statement " + (data.statementNumber || "") });
    var autoTable = getAutoTable(doc);

    var left = MARGIN, right = PAGE_W - MARGIN;
    var FOOTER_RESERVE = 52;          // rule at PAGE_H-37, text at PAGE_H-26
    var y = MARGIN;

    /* The template carried two component props, showNotes and showPropertyNet.
       They become options here so the caller keeps the same two switches. */
    var showNotes = options.showNotes !== false;
    var showPropertyNet = options.showPropertyNet !== false;

    var statementNo = data.statementNumber || "—";

    /* "01 Jul 2026 – 31 Jul 2026" is too wide for a quarter-page meta cell, and
       the template writes it the short way anyway: when both ends share a
       month and year, print it once. Falls back to the full range whenever
       they differ (or the dates aren't in the expected shape). */
    function periodText(a, b) {
      a = a || ""; b = b || "";
      if (!a || !b) return a || b || "—";
      var pa = a.split(/\s+/), pb = b.split(/\s+/);
      if (pa.length === 3 && pb.length === 3 && pa[1] === pb[1] && pa[2] === pb[2]) {
        return pa[0] + " – " + pb[0] + " " + pb[1] + " " + pb[2];
      }
      return a + " – " + b;
    }
    var periodLabel = periodText(data.periodStart, data.periodEnd);

    function ensure(space) {
      if (y + space > PAGE_H - FOOTER_RESERVE) { doc.addPage(); y = MARGIN; return true; }
      return false;
    }

    /* ---- Masthead ---------------------------------------------------------
       Business kicker, a two-line title, and the statement number set huge in
       accent and bottom-aligned against it (align-items:flex-end). That
       numeral is the design's anchor; everything else is quieter than it. */
    var kickerBase = y + FS.kicker;
    tx(doc, from.name || "Owner Statement", left, kickerBase,
       { size: FS.kicker, bold: true, upper: true, track: TRACK.kicker, color: COLORS.accent700 });

    var line1 = kickerBase + PX(10) + FS.title;
    var line2 = line1 + FS.title;                     // line-height: 1
    tx(doc, "Owner", left, line1, { size: FS.title, bold: true, track: TRACK.heading });
    tx(doc, "Statement", left, line2, { size: FS.title, bold: true, track: TRACK.heading });
    tx(doc, statementNo, right, line2,
       { size: FS.display, bold: true, track: TRACK.display, color: COLORS.accent, align: "right" });

    y = line2 + PX(14);
    rule(doc, left, right, y, RULE.major);

    /* ---- Meta strip: four cells divided by hairlines ---------------------- */
    /* "Statement No.", not the template's "Statement №": jsPDF's built-in
       Helvetica is WinAnsi-encoded and has no U+2116, which silently renders
       as "!" rather than failing. Same reason to keep to en/em dashes and
       the middle dot below — those ARE in WinAnsi. */
    var metaCells = [
      ["Statement No.", statementNo, COLORS.text],
      ["Period", periodLabel, COLORS.text],
      ["Status", data.status || "—", COLORS.accent700],
      ["Properties", String(properties.length), COLORS.text]
    ];
    var metaTop = y;
    var cellW = USABLE_W / 4;
    var metaLabelY = metaTop + PX(10) + FS.kicker;
    metaCells.forEach(function (cell, i) {
      var cx = left + i * cellW + (i === 0 ? 0 : PX(14));
      stat(doc, cell[0], cell[1], cx, metaLabelY,
           { size: FS.metaValue, valueColor: cell[2], maxW: cellW - PX(18) });
    });
    y = metaLabelY + PX(3) + FS.metaValue + PX(12);
    for (var mi = 1; mi < 4; mi++) {
      setDraw(doc, COLORS.divider);
      doc.setLineWidth(RULE.minor);
      doc.line(left + mi * cellW, metaTop, left + mi * cellW, y);
    }
    rule(doc, left, right, y, RULE.major);

    /* ---- Parties: property manager | statement recipient ------------------ */
    var partyTop = y;
    var halfW = USABLE_W / 2;
    var propertyNames = properties.map(function (p) { return p.propertyAddress; }).filter(Boolean);

    function party(label, name, lines, x, maxW) {
      var ly = partyTop + PX(16) + FS.kicker;
      tx(doc, label, x, ly, { size: FS.kicker, bold: true, upper: true, track: TRACK.kicker, color: COLORS.accent700 });
      var ny = ly + PX(8) + FS.partyName;
      tx(doc, name || "—", x, ny, { size: FS.partyName, bold: true });
      var sy = ny;
      (lines || []).forEach(function (line) {
        if (!line) return;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(FS.body);
        doc.splitTextToSize(String(line), maxW).forEach(function (l) {
          sy += PX(13.5) * 1.55;
          tx(doc, l, x, sy, { size: FS.body, color: COLORS.muted65 });
        });
      });
      return sy;
    }

    var fromLines = [from.address].concat(from.gstNumber ? ["GST No: " + from.gstNumber] : [], from.email ? [from.email] : []);
    var p1 = party("Property manager", from.name, fromLines, left, halfW - PX(24));
    var p2 = party("Statement for", owner.name, propertyNames.concat(owner.email ? [owner.email] : []),
                   left + halfW + PX(24), halfW - PX(24));

    y = Math.max(p1, p2) + PX(20);
    setDraw(doc, COLORS.divider);
    doc.setLineWidth(RULE.minor);
    doc.line(left + halfW, partyTop, left + halfW, y);
    rule(doc, left, right, y, RULE.major);

    /* ---- Income / expense tables -----------------------------------------
       theme "plain" because the template's tables have no grid and no zebra:
       a tracked uppercase head over a 2px rule, then unruled rows. The whole
       table reads as a list, which is why the numbers carry so well. */
    function sectionLabel(text) {
      y += PX(20) + FS.section;
      tx(doc, text, left, y, { size: FS.section, bold: true, upper: true, track: TRACK.kicker });
      var labelW = doc.getTextWidth(String(text).toUpperCase()) + TRACK.kicker * FS.section * text.length;
      setDraw(doc, COLORS.divider);
      doc.setLineWidth(RULE.minor);
      doc.line(left + labelW + PX(10), y - FS.section * 0.32, right, y - FS.section * 0.32);
      y += PX(10);
    }

    function lineTable(items, emptyLabel) {
      var body = (items || []).map(function (it) {
        return [it.date || "", it.description || "", money(it.amount)];
      });
      if (!body.length) body = [["—", emptyLabel, money(0)]];
      autoTable({
        startY: y,
        head: [["Date", "Description", "Amount"]],
        body: body,
        theme: "plain",
        styles: {
          font: "helvetica", fontSize: FS.body, valign: "top", lineWidth: 0,
          cellPadding: { top: PX(3), bottom: PX(3), left: 0, right: 0 },
          textColor: hexToRgb(COLORS.text)
        },
        headStyles: {
          fontSize: FS.kicker, fontStyle: "bold", textColor: hexToRgb(COLORS.muted55),
          cellPadding: { top: 0, bottom: PX(6), left: 0, right: 0 }
        },
        // Widths come straight from the CSS: a 92px date column, a right-set
        // amount column, description takes the rest.
        columnStyles: {
          0: { cellWidth: PX(92) },
          1: { cellWidth: "auto" },
          2: { cellWidth: PX(100), halign: "right" }
        },
        margin: { left: left, right: MARGIN, bottom: FOOTER_RESERVE },
        willDrawCell: function (d) {
          // Tracking belongs to the head row only. autoTable draws cell text
          // itself, so this has to be set per cell and cleared for the body —
          // a stray char space would widen every currency figure.
          doc.setCharSpace(d.section === "head" ? TRACK.label * FS.kicker : 0);
          if (d.section === "head") d.cell.text = d.cell.text.map(function (t) { return String(t).toUpperCase(); });
        },
        didDrawCell: function (d) {
          if (d.section === "head") {
            rule(doc, d.cell.x, d.cell.x + d.cell.width, d.cell.y + d.cell.height, RULE.major);
          }
        }
      });
      doc.setCharSpace(0);
      y = doc.lastAutoTable.finalY;
    }

    /* ---- Per-property sections -------------------------------------------
       The template puts break-before:page on every property after the first,
       so each address opens its own page. */
    properties.forEach(function (prop, idx) {
      if (idx > 0) { doc.addPage(); y = MARGIN; } else { y += PX(28); }
      ensure(160);

      var headTop = y;
      tx(doc, "Property " + ("0" + (idx + 1)).slice(-2), left, headTop + FS.kicker,
         { size: FS.kicker, bold: true, upper: true, track: TRACK.kicker, color: COLORS.accent });
      var addrY = headTop + FS.kicker + PX(6) + FS.property;
      var addr = prop.propertyAddress || ("Property " + (idx + 1));
      var addrMaxW = showPropertyNet ? USABLE_W - PX(120) : USABLE_W;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(FS.property);
      var addrLines = doc.splitTextToSize(addr, addrMaxW);
      addrLines.forEach(function (l, i) {
        tx(doc, l, left, addrY + i * FS.property * 1.12, { size: FS.property, bold: true, track: TRACK.tight });
      });
      var addrBottom = addrY + (addrLines.length - 1) * FS.property * 1.12;

      if (showPropertyNet) {
        // Label sits a full value-line above the figure, both bottom-aligned
        // with the address (align-items:flex-end in the template).
        tx(doc, "Net", right, addrBottom - PX(19),
           { size: FS.kicker, track: TRACK.label, upper: true, color: COLORS.muted55, align: "right" });
        tx(doc, money(prop.netAmount), right, addrBottom, { size: FS.property, bold: true, align: "right" });
      }

      y = addrBottom + PX(10);
      rule(doc, left, right, y, RULE.major);

      sectionLabel("Income");
      lineTable(prop.income, "No income recorded this period");

      sectionLabel("Expenses");
      lineTable(prop.expenses, "No expenses recorded this period");

      /* Balance strip: opening / net / closing, hairline-divided. */
      ensure(70);
      y += PX(18);
      rule(doc, left, right, y, RULE.major);
      var balTop = y;
      var balW = USABLE_W / 3;
      var balLabelY = balTop + PX(10) + FS.kicker;
      [["Opening balance", money(prop.openingBalance), COLORS.text],
       ["Net amount", money(prop.netAmount), COLORS.text],
       ["Closing balance", money(prop.closingBalance), COLORS.accent700]
      ].forEach(function (cell, i) {
        stat(doc, cell[0], cell[1], left + i * balW + (i === 0 ? 0 : PX(14)), balLabelY,
             { size: FS.balance, valueColor: cell[2] });
      });
      y = balLabelY + PX(3) + FS.balance;
      for (var bi = 1; bi < 3; bi++) {
        setDraw(doc, COLORS.divider);
        doc.setLineWidth(RULE.minor);
        doc.line(left + bi * balW, balTop, left + bi * balW, y);
      }

      if (showNotes && prop.notes) {
        y += PX(14);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(FS.note);
        doc.splitTextToSize(String(prop.notes), USABLE_W * 0.88).forEach(function (line) {
          ensure(FS.note * 1.5);
          y += FS.note * 1.5;
          tx(doc, line, left, y, { size: FS.note, color: COLORS.muted60 });
        });
      }
    });

    /* ---- Combined totals: the one filled block in the document ------------
       break-inside:avoid in the template, so it is measured up front and
       moved to a fresh page whole rather than split across two. */
    var totalsH = PX(26) * 2 + FS.kicker + PX(14) + FS.total + PX(18) + PX(16) + FS.kicker + PX(3) + FS.totalValue;
    y += PX(34);
    if (y + totalsH > PAGE_H - FOOTER_RESERVE) { doc.addPage(); y = MARGIN; }

    setFill(doc, COLORS.accent);
    doc.rect(left, y, USABLE_W, totalsH, "F");

    var tPad = PX(24), tx0 = left + tPad, tx1 = right - tPad;
    var ty = y + PX(26) + FS.kicker;
    tx(doc, "Combined totals — all properties", tx0, ty,
       { size: FS.kicker, bold: true, upper: true, track: TRACK.kicker, color: COLORS.white });

    ty += PX(14) + FS.total;
    tx(doc, money(data.netAmount), tx0, ty, { size: FS.total, bold: true, track: TRACK.display, color: COLORS.white });
    tx(doc, "Net amount paid", tx1, ty - PX(6), { size: FS.section, upper: true, track: TRACK.label, color: COLORS.white, align: "right" });

    ty += PX(18);
    setDraw(doc, COLORS.white);
    doc.setLineWidth(RULE.major);
    doc.line(tx0, ty, tx1, ty);

    var tCellW = (USABLE_W - tPad * 2) / 4;
    var tLabelY = ty + PX(16) + FS.kicker;
    [["Opening balance", money(data.openingBalance)],
     ["Total income", money(data.totalIncome)],
     ["Total expenses", money(data.totalExpenses)],
     ["Closing balance", money(data.closingBalance)]
    ].forEach(function (cell, i) {
      stat(doc, cell[0], cell[1], tx0 + i * tCellW + (i === 0 ? 0 : PX(14)), tLabelY,
           { size: FS.totalValue, labelColor: COLORS.white, valueColor: COLORS.white });
    });
    y += totalsH;

    /* ---- Notes ------------------------------------------------------------ */
    var noteText = (showNotes && data.notes ? String(data.notes) : "") +
                   (from.bankAccount ? ((showNotes && data.notes) ? "\n" : "") + "Bank account: " + from.bankAccount : "");
    if (noteText) {
      y += PX(28);
      ensure(60);
      rule(doc, left, right, y, RULE.major);
      y += PX(12) + FS.kicker;
      tx(doc, "Notes", left, y, { size: FS.kicker, bold: true, upper: true, track: TRACK.kicker, color: COLORS.accent700 });
      y += PX(8);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(FS.notesBlock);
      doc.splitTextToSize(noteText, USABLE_W * 0.82).forEach(function (line) {
        ensure(FS.notesBlock * 1.6);
        y += FS.notesBlock * 1.6;
        tx(doc, line, left, y, { size: FS.notesBlock, color: COLORS.muted70 });
      });
    }

    /* ---- Footer on every page --------------------------------------------
       The template's footer is business name | statement descriptor. Page
       numbering is added to the right slot: the design was drawn for a
       two-property statement, but this is a document people print and file,
       and a multi-page statement with no page numbers is a filing hazard. */
    var totalPages = doc.internal.getNumberOfPages();
    for (var p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      rule(doc, left, right, PAGE_H - 37, RULE.major);
      tx(doc, from.name || "Owner Statement", left, PAGE_H - 26,
         { size: FS.footer, bold: true, upper: true, track: TRACK.footer });
      tx(doc, "Statement " + statementNo + " · " + periodLabel + " · Page " + p + " of " + totalPages,
         right, PAGE_H - 26,
         { size: FS.footer, upper: true, track: TRACK.footer, color: COLORS.muted55, align: "right" });
    }

    var blob = doc.output("blob");
    if (doDownload) doc.save(fileName);
    return blob;
  }

  global.StatementReport = { generate: generate };
})(typeof window !== "undefined" ? window : this);
