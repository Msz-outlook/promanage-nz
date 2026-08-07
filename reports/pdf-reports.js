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

  var COLORS = {
    header: "#37474F",
    grid: "#CCCCCC",
    altRow: "#F7F7F7",
    link: "#1155CC",
    missingBg: "#F2F2F2",
    missingBorder: "#CCCCCC",
    footer: "#666666",
    note: "#555555",
    text: "#000000",
  };

  var FS = { body: 9.5, caption: 8.5, note: 8.5, footer: 8, title: 20, heading: 15 };
  var CELL_PADDING = 5;              // autotable cell padding (pt)

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
    var y = MARGIN + 6;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(FS.title);
    setText(doc, COLORS.text);
    doc.text(title, PAGE_W / 2, y + FS.title, { align: "center" });
    y += FS.title + 14;

    var metaKeys = Object.keys(meta);
    if (metaKeys.length) {
      doc.setFontSize(FS.body);
      var labelX = MARGIN, valueX = MARGIN + 95, lineH = 14;
      metaKeys.forEach(function (k) {
        doc.setFont("helvetica", "bold");
        doc.text(String(k) + ":", labelX, y + FS.body);
        doc.setFont("helvetica", "normal");
        doc.text(String(meta[k]), valueX, y + FS.body);
        y += lineH;
      });
      y += 8;
    }

    var totalPhotos = records.length;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(FS.note);
    setText(doc, COLORS.note);
    doc.text("Total findings: " + findings.length + "     |     Total photos: " + totalPhotos, MARGIN, y + FS.note);
    y += FS.note + 12;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(FS.heading);
    setText(doc, COLORS.text);
    doc.text("Findings", MARGIN, y + FS.heading);
    y += FS.heading + 6;

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
      theme: "grid",
      styles: {
        font: "helvetica", fontSize: FS.body, cellPadding: CELL_PADDING, valign: "top",
        lineColor: hexToRgb(COLORS.grid), lineWidth: 0.5, textColor: hexToRgb(COLORS.text),
        overflow: "linebreak",
      },
      headStyles: { fillColor: hexToRgb(COLORS.header), textColor: [255, 255, 255], fontStyle: "bold" },
      alternateRowStyles: { fillColor: hexToRgb(COLORS.altRow) },
      columnStyles: {
        0: { cellWidth: COL_W[0], halign: "center", fontStyle: "bold" },
        1: { cellWidth: COL_W[1], fontStyle: "bold" },
        2: { cellWidth: COL_W[2] },
        3: { cellWidth: COL_W[3], textColor: hexToRgb(COLORS.link) },
      },
      margin: { left: MARGIN, right: MARGIN },
      didDrawCell: function (d) {
        if (d.section !== "body") return;
        var n = d.row.index + 1;
        var page = doc.internal.getCurrentPageInfo().pageNumber;
        if (d.column.index === 0) {
          findingAnchors[n] = { page: page, y: d.cell.y };
        } else if (d.column.index === 3) {
          photosCellInfo[n] = { page: page, x: d.cell.x, y: d.cell.y, w: d.cell.width, h: d.cell.height };
        }
      },
    });

    // --- Attachments (portrait photo grid) ----------------------------------
    if (records.length) {
      doc.addPage();
      var ay = MARGIN + 6;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(FS.heading);
      setText(doc, COLORS.text);
      doc.text("Attachments", MARGIN, ay + FS.heading);
      ay += FS.heading + 6;

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
      setDraw(doc, COLORS.missingBorder);
      doc.setLineWidth(0.5);
      doc.line(MARGIN, PAGE_H - 37, PAGE_W - MARGIN, PAGE_H - 37);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(FS.footer);
      setText(doc, COLORS.footer);
      doc.text(title, MARGIN, PAGE_H - 26);
      doc.text("Page " + p + " of " + totalPages, PAGE_W - MARGIN, PAGE_H - 26, { align: "right" });
    }

    var blob = doc.output("blob");
    if (doDownload) doc.save(fileName);
    return blob;
  }

  // color setters (jsPDF wants numeric r,g,b for cross-version safety)
  function setText(doc, hex) { var c = hexToRgb(hex); doc.setTextColor(c[0], c[1], c[2]); }
  function setFill(doc, hex) { var c = hexToRgb(hex); doc.setFillColor(c[0], c[1], c[2]); }
  function setDraw(doc, hex) { var c = hexToRgb(hex); doc.setDrawColor(c[0], c[1], c[2]); }

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

  var COLORS = { accent: "#1f4e5f", grey: "#666666", rule: "#dddddd", text: "#000000", white: "#ffffff" };
  var FS = { title: 26, titleWithLogo: 20, label: 10, body: 9.5, small: 9, footer: 8 };

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
    if (logo) {
      var maxW = 50 * MM, maxH = 22 * MM;
      var scale = Math.min(maxW / logo.w, maxH / logo.h, 1);
      var dw = logo.w * scale, dh = logo.h * scale;
      doc.addImage(logo.dataUrl, "PNG", left, y, dw, dh);
      setText(doc, COLORS.accent);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(FS.titleWithLogo);
      doc.text("TAX INVOICE", left, y + dh + 18);
      titleBottom = y + dh + 24;
    } else {
      setText(doc, COLORS.accent);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(FS.title);
      doc.text("TAX INVOICE", left, y + FS.title);
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
    doc.setFont("helvetica", "bold");
    doc.setFontSize(FS.label);
    setText(doc, COLORS.accent);
    doc.text("BILL TO", left, y);
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
      doc.setFont("helvetica", "normal");
      doc.setFontSize(FS.small);
      setText(doc, COLORS.grey);
      doc.text(row[0], right - colW, my);
      doc.setFont("helvetica", "bold");
      setText(doc, COLORS.text);
      doc.text(String(row[1]), right, my, { align: "right" });
      my += 14;
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
      styles: { font: "helvetica", fontSize: FS.body, cellPadding: { top: 6, bottom: 6, left: 4, right: 4 }, textColor: hexToRgb(COLORS.text) },
      headStyles: { fillColor: hexToRgb(COLORS.accent), textColor: [255, 255, 255], fontStyle: "bold", fontSize: FS.small },
      columnStyles: {
        0: { cellWidth: USABLE_W * 0.5 },
        1: { cellWidth: USABLE_W * 0.12, halign: "right" },
        2: { cellWidth: USABLE_W * 0.19, halign: "right" },
        3: { cellWidth: USABLE_W * 0.19, halign: "right" }
      },
      margin: { left: MARGIN, right: MARGIN },
      didDrawCell: function (d) {
        if (d.section !== "body") return;
        setDraw(doc, COLORS.rule);
        doc.setLineWidth(0.5);
        doc.line(d.cell.x, d.cell.y + d.cell.height, d.cell.x + d.cell.width, d.cell.y + d.cell.height);
      }
    });

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
      doc.setFont("helvetica", "bold");
      doc.setFontSize(FS.label);
      setText(doc, COLORS.accent);
      doc.text("PAYMENT DETAILS", left, py);
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
      setDraw(doc, COLORS.rule);
      doc.setLineWidth(0.5);
      doc.line(MARGIN, PAGE_H - 34, PAGE_W - MARGIN, PAGE_H - 34);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(FS.footer);
      setText(doc, COLORS.grey);
      doc.text(footerBits.join("  |  ") + "  |  Generated " + generatedOn, PAGE_W / 2, PAGE_H - 22, { align: "center" });
      doc.text("Page " + p + " of " + totalPages, PAGE_W - MARGIN, PAGE_H - 22, { align: "right" });
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

  var COLORS = {
    header: "#37474F", grid: "#CCCCCC", altRow: "#F7F7F7",
    text: "#000000", muted: "#666666", accent: "#185FA5",
    income: "#3B6D11", expense: "#A32D2D"
  };
  var FS = { title: 20, heading: 12, body: 9.5, small: 8.5, footer: 8 };

  function hexToRgb(hex) {
    var h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function setText(doc, hex) { var c = hexToRgb(hex); doc.setTextColor(c[0], c[1], c[2]); }
  function setDraw(doc, hex) { var c = hexToRgb(hex); doc.setDrawColor(c[0], c[1], c[2]); }
  function money(n) { return "$" + (Number(n) || 0).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

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

    var y = MARGIN;

    // --- Title + statement meta (top-right) ---
    doc.setFont("helvetica", "bold");
    doc.setFontSize(FS.title);
    setText(doc, COLORS.text);
    doc.text("OWNER STATEMENT", MARGIN, y + FS.title);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(FS.body);
    var metaLines = [
      ["Statement #", data.statementNumber || "—"],
      ["Period", (data.periodStart || "—") + " – " + (data.periodEnd || "—")],
      ["Status", data.status || "—"]
    ];
    var metaY = y;
    metaLines.forEach(function (row) {
      setText(doc, COLORS.muted);
      doc.text(row[0] + ":", PAGE_W - MARGIN - 200, metaY, { align: "left" });
      setText(doc, COLORS.text);
      doc.setFont("helvetica", "bold");
      doc.text(String(row[1]), PAGE_W - MARGIN, metaY, { align: "right" });
      doc.setFont("helvetica", "normal");
      metaY += 14;
    });
    y += FS.title + 24;

    // --- From (manager) / Owner / Property ---
    var colW = USABLE_W / 2 - 10;
    function addressBlock(label, name, addressLines, extra, x) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(FS.small);
      setText(doc, COLORS.muted);
      doc.text(label.toUpperCase(), x, y);
      var by = y + 14;
      doc.setFontSize(FS.body);
      setText(doc, COLORS.text);
      doc.text(name || "—", x, by);
      by += 13;
      doc.setFont("helvetica", "normal");
      (addressLines || []).forEach(function (line) {
        if (!line) return;
        doc.splitTextToSize(line, colW).forEach(function (l) {
          doc.text(l, x, by);
          by += 12;
        });
      });
      (extra || []).forEach(function (line) {
        setText(doc, COLORS.muted);
        doc.text(line, x, by);
        by += 12;
      });
      return by;
    }
    var fromExtra = [];
    if (from.gstNumber) fromExtra.push("GST #: " + from.gstNumber);
    if (from.email) fromExtra.push(from.email);
    if (from.phone) fromExtra.push(from.phone);
    var y1 = addressBlock("Property manager", from.name, [from.address], fromExtra, MARGIN);

    var ownerExtra = [];
    if (owner.email) ownerExtra.push(owner.email);
    var propertyNames = properties.map(function (p) { return p.propertyAddress; }).filter(Boolean);
    var ownerAddressLines = propertyNames.length
      ? [propertyNames.length + " propert" + (propertyNames.length > 1 ? "ies" : "y") + ":"].concat(propertyNames)
      : [];
    var y2 = addressBlock("Statement for", owner.name, ownerAddressLines, ownerExtra, MARGIN + colW + 20);

    y = Math.max(y1, y2) + 18;

    function itemTable(title, items, color) {
      if (y > PAGE_H - 200) { doc.addPage(); y = MARGIN; }
      setText(doc, color);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(FS.heading);
      doc.text(title, MARGIN, y);
      y += 10;
      var body = (items || []).map(function (it) {
        return [it.date || "", it.description || "", money(it.amount)];
      });
      if (!body.length) body = [["—", "No " + title.toLowerCase() + " recorded this period", money(0)]];
      autoTable({
        startY: y,
        head: [["Date", "Description", "Amount"]],
        body: body,
        theme: "grid",
        styles: { font: "helvetica", fontSize: FS.body, cellPadding: 6, textColor: hexToRgb(COLORS.text), lineColor: hexToRgb(COLORS.grid), lineWidth: 0.5 },
        headStyles: { fillColor: hexToRgb(COLORS.header), textColor: [255, 255, 255], fontStyle: "bold" },
        alternateRowStyles: { fillColor: hexToRgb(COLORS.altRow) },
        columnStyles: {
          0: { cellWidth: USABLE_W * 0.18 },
          1: { cellWidth: USABLE_W * 0.57 },
          2: { cellWidth: USABLE_W * 0.25, halign: "right" }
        },
        margin: { left: MARGIN, right: MARGIN }
      });
      y = doc.lastAutoTable.finalY + 16;
    }

    function propertyTotalsBox(prop) {
      if (y > PAGE_H - 110) { doc.addPage(); y = MARGIN; }
      var boxW = 230, rowH = 14;
      var rows = [
        ["Opening balance", money(prop.openingBalance)],
        ["Net amount", money(prop.netAmount)],
        ["Closing balance", money(prop.closingBalance)]
      ];
      var boxX = PAGE_W - MARGIN - boxW;
      var by = y;
      rows.forEach(function (row, i) {
        var isLast = i === rows.length - 1;
        doc.setFont("helvetica", isLast ? "bold" : "normal");
        doc.setFontSize(FS.small);
        setText(doc, isLast ? COLORS.text : COLORS.muted);
        doc.text(row[0], boxX, by + 10);
        doc.text(row[1], boxX + boxW, by + 10, { align: "right" });
        by += rowH;
      });
      y = by + 6;
    }

    // --- Per-property sections: each property gets its own income/expenses/subtotal ---
    properties.forEach(function (prop, idx) {
      if (y > PAGE_H - 220) { doc.addPage(); y = MARGIN; }
      setText(doc, COLORS.text);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(FS.heading + 1);
      doc.text(prop.propertyAddress || ("Property " + (idx + 1)), MARGIN, y);
      y += 6;
      setDraw(doc, COLORS.grid);
      doc.setLineWidth(0.75);
      doc.line(MARGIN, y, PAGE_W - MARGIN, y);
      y += 16;

      itemTable("Income", prop.income, COLORS.income);
      itemTable("Expenses", prop.expenses, COLORS.expense);
      propertyTotalsBox(prop);

      if (prop.notes) {
        setText(doc, COLORS.muted);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(FS.small);
        doc.splitTextToSize(prop.notes, USABLE_W).forEach(function (line) {
          doc.text(line, MARGIN, y);
          y += 11;
        });
      }
      y += 18;
    });

    // --- Combined totals box (bottom-right) ---
    if (y > PAGE_H - 160) { doc.addPage(); y = MARGIN; }
    setText(doc, COLORS.text);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(FS.heading);
    doc.text("Combined totals — all properties", MARGIN, y);
    var afterTableY = y + 6;
    var boxW = 230, rowH = 16;
    var totalRows = [
      ["Opening balance", money(data.openingBalance)],
      ["Total income", money(data.totalIncome)],
      ["Total expenses", money(data.totalExpenses)],
      ["Net amount", money(data.netAmount)],
      ["Closing balance", money(data.closingBalance)]
    ];

    var boxX = PAGE_W - MARGIN - boxW;
    var by = afterTableY;
    totalRows.forEach(function (row, i) {
      var isLast = i === totalRows.length - 1;
      if (isLast) {
        setDraw(doc, COLORS.grid);
        doc.setLineWidth(0.5);
        doc.line(boxX, by, boxX + boxW, by);
        by += 6;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(FS.heading);
      } else {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(FS.body);
      }
      setText(doc, COLORS.text);
      doc.text(row[0], boxX, by + 10);
      doc.text(row[1], boxX + boxW, by + 10, { align: "right" });
      by += rowH;
    });

    // --- Notes / payment details ---
    var noteY = Math.max(by, afterTableY) + 20;
    if (data.notes || from.bankAccount) {
      if (noteY > PAGE_H - 80) { doc.addPage(); noteY = MARGIN; }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(FS.small);
      setText(doc, COLORS.muted);
      doc.text("NOTES", MARGIN, noteY);
      noteY += 14;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(FS.body);
      setText(doc, COLORS.text);
      var noteText = (data.notes || "") + (from.bankAccount ? (data.notes ? "\n" : "") + "Bank account: " + from.bankAccount : "");
      doc.splitTextToSize(noteText, USABLE_W).forEach(function (line) {
        doc.text(line, MARGIN, noteY);
        noteY += 12;
      });
    }

    // --- Footer on every page ---
    var totalPages = doc.internal.getNumberOfPages();
    for (var p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      setDraw(doc, COLORS.grid);
      doc.setLineWidth(0.5);
      doc.line(MARGIN, PAGE_H - 37, PAGE_W - MARGIN, PAGE_H - 37);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(FS.footer);
      setText(doc, COLORS.muted);
      doc.text((from.name || "Owner Statement") + " — " + (data.statementNumber || ""), MARGIN, PAGE_H - 26);
      doc.text("Page " + p + " of " + totalPages, PAGE_W - MARGIN, PAGE_H - 26, { align: "right" });
    }

    var blob = doc.output("blob");
    if (doDownload) doc.save(fileName);
    return blob;
  }

  global.StatementReport = { generate: generate };
})(typeof window !== "undefined" ? window : this);
