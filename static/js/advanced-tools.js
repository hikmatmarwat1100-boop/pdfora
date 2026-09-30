(() => {
  if (!window.PDForaProcessor || !window.PDFLib || !window.pdfjsLib || !window.JSZip) return;

  const { PDFDocument, StandardFonts, rgb, degrees } = window.PDFLib;
  const baseProcessor = window.PDForaProcessor;
  const fileBytes = async (file) => new Uint8Array(await file.arrayBuffer());
  const stem = (name = 'document') => name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'document';
  const pdfBlob = (bytes) => new Blob([bytes], { type: 'application/pdf' });
  const toDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read generated image.'));
    reader.readAsDataURL(blob);
  });
  const dataUrlBytes = (url) => Uint8Array.from(atob(String(url).split(',')[1]), c => c.charCodeAt(0));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[m]));
  const hexColor = (hex = '#6d3df5') => {
    const h = String(hex).replace('#','').trim();
    const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6,'0').slice(0,6);
    return rgb(parseInt(v.slice(0,2),16)/255, parseInt(v.slice(2,4),16)/255, parseInt(v.slice(4,6),16)/255);
  };

  const loadScript = (src, globalName) => new Promise((resolve, reject) => {
    if (globalName && window[globalName]) return resolve(window[globalName]);
    const existing = document.querySelector(`script[data-pdfora-src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(globalName ? window[globalName] : true), { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.pdforaSrc = src;
    script.onload = () => resolve(globalName ? window[globalName] : true);
    script.onerror = () => reject(new Error('A required browser library could not be loaded. Check your connection and try again.'));
    document.head.appendChild(script);
  });

  const batch = async (files, converter, zipName, progress) => {
    if (files.length === 1) return converter(files[0], (value) => progress?.(value));
    const zip = new JSZip();
    const used = new Set();
    for (let i = 0; i < files.length; i += 1) {
      const result = await converter(files[i], (value) => progress?.((i + value) / files.length));
      let name = result.name || `result-${i + 1}`;
      if (used.has(name)) {
        const dot = name.lastIndexOf('.');
        name = dot > 0 ? `${name.slice(0,dot)}-${i + 1}${name.slice(dot)}` : `${name}-${i + 1}`;
      }
      used.add(name);
      zip.file(name, await result.blob.arrayBuffer());
    }
    return {
      blob: await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }),
      name: `${zipName}-batch.zip`
    };
  };

  const loadPdfJs = async (file) => {
    try {
      return await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    } catch (_) {
      throw new Error('This PDF could not be read. It may be damaged or password-protected.');
    }
  };

  const extractPdfText = async (file, progress) => {
    const doc = await loadPdfJs(file);
    const pages = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const rows = new Map();
      for (const item of content.items) {
        const y = Math.round((item.transform?.[5] || 0) / 4) * 4;
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push({ x: item.transform?.[4] || 0, text: item.str || '' });
      }
      const lines = [...rows.entries()]
        .sort((a,b) => b[0]-a[0])
        .map(([, items]) => items.sort((a,b) => a.x-b.x).map(i => i.text).join(' ').replace(/\s+/g,' ').trim())
        .filter(Boolean);
      pages.push(lines);
      page.cleanup();
      progress?.(p / doc.numPages);
    }
    await doc.destroy();
    return pages;
  };


  const extractPdfRows = async (file, progress) => {
    const doc = await loadPdfJs(file);
    const pages = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const buckets = [];
      const items = content.items
        .filter(item => String(item.str || '').trim())
        .map(item => ({
          x: Number(item.transform?.[4] || 0),
          y: Number(item.transform?.[5] || 0),
          width: Math.max(0, Number(item.width || 0)),
          text: String(item.str || '').replace(/\s+/g, ' ').trim()
        }))
        .sort((a,b) => b.y - a.y || a.x - b.x);
      for (const item of items) {
        let row = buckets.find(r => Math.abs(r.y - item.y) <= 3.5);
        if (!row) { row = { y:item.y, items:[] }; buckets.push(row); }
        row.items.push(item);
      }
      buckets.sort((a,b) => b.y-a.y);
      const rows = buckets.map(row => {
        const ordered = row.items.sort((a,b)=>a.x-b.x);
        const cells=[]; let current=''; let right=null;
        for (const item of ordered) {
          const gap = right == null ? 0 : item.x - right;
          if (right != null && gap > 16) {
            cells.push(current.trim()); current=item.text;
          } else {
            current += (current ? ' ' : '') + item.text;
          }
          right = item.x + Math.max(item.width, item.text.length * 4);
        }
        if (current.trim() || !cells.length) cells.push(current.trim());
        return cells;
      }).filter(row => row.some(Boolean));
      pages.push(rows.length ? rows : [['']]);
      page.cleanup(); progress?.(p/doc.numPages);
    }
    await doc.destroy();
    return pages;
  };

  const renderPdfPages = async (file, dpi = 120, format = 'jpeg', progress) => {
    const doc = await loadPdfJs(file);
    const pages = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: dpi / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const mime = format === 'png' ? 'image/png' : 'image/jpeg';
      const blob = await new Promise((resolve, reject) => canvas.toBlob(v => v ? resolve(v) : reject(new Error('Could not render a PDF page.')), mime, format === 'png' ? undefined : .9));
      const sourceViewport = page.getViewport({ scale: 1 });
      pages.push({
        blob,
        width: viewport.width,
        height: viewport.height,
        sourceWidth: sourceViewport.width,
        sourceHeight: sourceViewport.height,
        dpi
      });
      page.cleanup();
      progress?.(p / doc.numPages);
    }
    await doc.destroy();
    return pages;
  };

  const watermarkOne = async (file, options, progress) => {
    const doc = await PDFDocument.load(await fileBytes(file), { updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const text = String(options.get('watermark_text') || 'CONFIDENTIAL').slice(0,120);
    const size = Math.max(12, Math.min(96, Number(options.get('font_size') || 44)));
    const opacity = Math.max(.05, Math.min(.85, Number(options.get('opacity') || .18)));
    const color = hexColor(options.get('color') || '#6d3df5');
    const angle = Number(options.get('rotation') || -35);
    const pages = doc.getPages();
    pages.forEach((page, index) => {
      const { width, height } = page.getSize();
      const tw = font.widthOfTextAtSize(text, size);
      page.drawText(text, { x: Math.max(18, (width - tw) / 2), y: height / 2, size, font, color, opacity, rotate: degrees(angle) });
      progress?.((index + 1) / pages.length);
    });
    return { blob: pdfBlob(await doc.save({ useObjectStreams: true })), name: `${stem(file.name)}-watermarked.pdf` };
  };

  const pageNumbersOne = async (file, options, progress) => {
    const doc = await PDFDocument.load(await fileBytes(file), { updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const size = Math.max(8, Math.min(28, Number(options.get('font_size') || 11)));
    const start = Math.max(1, Number(options.get('start_number') || 1));
    const format = options.get('number_format') || 'page-x-of-y';
    const position = options.get('position') || 'bottom-center';
    const pages = doc.getPages();
    pages.forEach((page, index) => {
      const { width, height } = page.getSize();
      const n = start + index;
      const text = format === 'number-only' ? `${n}` : format === 'page-x' ? `Page ${n}` : `Page ${n} of ${start + pages.length - 1}`;
      const tw = font.widthOfTextAtSize(text, size);
      const margin = 24;
      let x = (width - tw) / 2; let y = margin;
      if (position.includes('top')) y = height - margin - size;
      if (position.includes('left')) x = margin;
      if (position.includes('right')) x = width - margin - tw;
      page.drawText(text, { x, y, size, font, color: rgb(.23,.27,.36) });
      progress?.((index + 1) / pages.length);
    });
    return { blob: pdfBlob(await doc.save({ useObjectStreams: true })), name: `${stem(file.name)}-numbered.pdf` };
  };

  let qpdfFactoryPromise = null;
  const getQpdfFactory = async () => {
    if (!qpdfFactoryPromise) qpdfFactoryPromise = (async () => {
      let mod;
      try {
        mod = await import('https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/+esm');
      } catch (_) {
        throw new Error('The PDF security engine could not load. Check your internet connection and try again.');
      }
      return mod.default || mod;
    })();
    return qpdfFactoryPromise;
  };

  const qpdfOne = async (file, options, mode, progress) => {
    const createModule = await getQpdfFactory();
    progress?.(.08);
    const qpdf = await createModule({
      noInitialRun: true,
      locateFile: (path) => path.endsWith('.wasm') ? 'https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.wasm' : path
    });
    progress?.(.25);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const input = `/input-${id}.pdf`;
    const output = `/output-${id}.pdf`;
    qpdf.FS.writeFile(input, await fileBytes(file));
    progress?.(.4);
    try {
      if (mode === 'protect') {
        const password = String(options.get('password') || '');
        if (password.length < 4) throw new Error('Use a password with at least 4 characters.');
        const owner = String(options.get('owner_password') || password);
        qpdf.callMain(['--encrypt', password, owner, '256', '--', input, output]);
      } else {
        const password = String(options.get('password') || '');
        qpdf.callMain([`--password=${password}`, '--decrypt', input, output]);
      }
      progress?.(.82);
      const out = qpdf.FS.readFile(output);
      if (!out?.length) throw new Error('The PDF security operation did not create an output file.');
      progress?.(1);
      return { blob: pdfBlob(new Uint8Array(out)), name: `${stem(file.name)}-${mode === 'protect' ? 'protected' : 'unlocked'}.pdf` };
    } catch (error) {
      const msg = String(error?.message || error || '');
      if (mode === 'unlock') throw new Error('Could not unlock this PDF. Check the password and make sure the file is a supported encrypted PDF.');
      if (msg.includes('password')) throw error;
      throw new Error('Could not protect this PDF. Please try another file.');
    } finally {
      try { qpdf.FS.unlink(input); } catch (_) {}
      try { qpdf.FS.unlink(output); } catch (_) {}
    }
  };

  const pdfToWordOne = async (file, options, progress) => {
    const mode = String(options?.get('conversion_mode') || 'preserve-layout');
    let docx;
    try { docx = await import('https://cdn.jsdelivr.net/npm/docx@9.7.1/+esm'); }
    catch (_) { throw new Error('The Word export engine could not load. Check your connection and try again.'); }
    const { Document, Packer, Paragraph, TextRun, PageBreak, ImageRun, AlignmentType } = docx;

    if (mode === 'editable-text') {
      const pages = await extractPdfText(file, progress);
      const children = [];
      pages.forEach((lines, pageIndex) => {
        if (pageIndex > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
        (lines.length ? lines : ['']).forEach(line => children.push(new Paragraph({ children: [new TextRun(line)] })));
      });
      const document = new Document({ sections: [{ children }] });
      const blob = await Packer.toBlob(document);
      return { blob, name: `${stem(file.name)}-editable.docx` };
    }

    // Layout-preserving mode: each PDF page is rendered at high resolution and
    // placed on a Word page with the same physical aspect ratio. This keeps the
    // visual syntax (tables, spacing, logos, signatures, fonts and positioning)
    // intact instead of reflowing PDF text into new Word paragraphs.
    const rendered = await renderPdfPages(file, 144, 'png', progress);
    const sections = [];
    for (const page of rendered) {
      const widthPt = Number(page.sourceWidth || (page.width * 72 / (page.dpi || 144)));
      const heightPt = Number(page.sourceHeight || (page.height * 72 / (page.dpi || 144)));
      const widthPx = Math.max(1, Math.round(widthPt * 96 / 72));
      const heightPx = Math.max(1, Math.round(heightPt * 96 / 72));
      const data = new Uint8Array(await page.blob.arrayBuffer());
      sections.push({
        properties: {
          page: {
            size: { width: Math.round(widthPt * 20), height: Math.round(heightPt * 20) },
            margin: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0, gutter: 0 }
          }
        },
        children: [new Paragraph({
          alignment: AlignmentType?.CENTER,
          spacing: { before: 0, after: 0 },
          children: [new ImageRun({ data, type: 'png', transformation: { width: widthPx, height: heightPx } })]
        })]
      });
    }
    const document = new Document({ sections });
    const blob = await Packer.toBlob(document);
    return { blob, name: `${stem(file.name)}-layout-preserved.docx` };
  };

  const ensureHtml2Canvas = async () => loadScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js', 'html2canvas');

  const wordToPdfOne = async (file, progress) => {
    await loadScript('https://cdn.jsdelivr.net/npm/docx-preview@0.4.0/dist/docx-preview.min.js', 'docx');
    await ensureHtml2Canvas();
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:max-content;background:white;z-index:-1;';
    document.body.appendChild(host);
    try {
      await window.docx.renderAsync(await file.arrayBuffer(), host, undefined, {
        ignoreWidth: false,
        ignoreHeight: false,
        breakPages: true,
        ignoreLastRenderedPageBreak: false,
        useBase64URL: true
      });
      const candidates = [...host.querySelectorAll('.docx-wrapper > section, section.docx, .docx')].filter(el => el.offsetWidth && el.offsetHeight);
      const pages = candidates.length ? candidates : [host];
      const output = await PDFDocument.create();
      for (let i = 0; i < pages.length; i += 1) {
        const el = pages[i];
        const cssWidth = Math.max(1, el.getBoundingClientRect().width || el.offsetWidth);
        const cssHeight = Math.max(1, el.getBoundingClientRect().height || el.offsetHeight);
        const canvas = await window.html2canvas(el, { backgroundColor: '#ffffff', scale: 1.8, useCORS: true, logging: false });
        const png = await output.embedPng(dataUrlBytes(canvas.toDataURL('image/png')));
        // CSS pixels are 96 dpi; PDF points are 72 dpi. Preserve the rendered
        // Word page dimensions rather than forcing every document into A4.
        const pageW = Math.max(72, cssWidth * 72 / 96);
        const pageH = Math.max(72, cssHeight * 72 / 96);
        const page = output.addPage([pageW, pageH]);
        page.drawImage(png, { x: 0, y: 0, width: pageW, height: pageH });
        progress?.((i + 1) / pages.length);
      }
      return { blob: pdfBlob(await output.save({ useObjectStreams: true })), name: `${stem(file.name)}.pdf` };
    } finally { host.remove(); }
  };

  const getXLSX = async () => {
    await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', 'XLSX');
    if (!window.XLSX) throw new Error('The spreadsheet engine could not load.');
    return window.XLSX;
  };

  const getExcelJS = async () => {
    await loadScript('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js', 'ExcelJS');
    if (!window.ExcelJS) throw new Error('The layout-preserving spreadsheet engine could not load.');
    return window.ExcelJS;
  };

  const pdfToExcelOne = async (file, options, progress) => {
    const mode = String(options?.get('conversion_mode') || 'preserve-layout');
    if (mode === 'editable-table') {
      const XLSX = await getXLSX();
      const pages = await extractPdfRows(file, progress);
      const wb = XLSX.utils.book_new();
      pages.forEach((rows, i) => {
        const ws = XLSX.utils.aoa_to_sheet(rows.length ? rows : [['']]);
        const maxCols = Math.max(1, ...rows.map(r => r.length));
        ws['!cols'] = Array.from({length:maxCols}, (_,c) => ({ wch: Math.min(45, Math.max(12, ...rows.map(r => String(r[c] ?? '').length + 2))) }));
        XLSX.utils.book_append_sheet(wb, ws, `Page ${i + 1}`.slice(0,31));
      });
      const bytes = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      return { blob: new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name: `${stem(file.name)}-editable.xlsx` };
    }

    // Layout-preserving mode stores every PDF page as a high-resolution image
    // on its own worksheet. The result looks like the source instead of trying
    // to guess table cells from arbitrary PDF coordinates.
    const ExcelJS = await getExcelJS();
    const rendered = await renderPdfPages(file, 144, 'png', progress);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'PDFora';
    wb.created = new Date();
    for (let i = 0; i < rendered.length; i += 1) {
      const p = rendered[i];
      const ws = wb.addWorksheet(`Page ${i + 1}`.slice(0,31), { views: [{ showGridLines: false }] });
      const widthPx = Math.max(1, Math.round((p.sourceWidth || p.width * 72 / 144) * 96 / 72));
      const heightPx = Math.max(1, Math.round((p.sourceHeight || p.height * 72 / 144) * 96 / 72));
      const imageId = wb.addImage({ base64: await toDataUrl(p.blob), extension: 'png' });
      ws.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: widthPx, height: heightPx } });
      ws.getColumn(1).width = Math.max(12, Math.min(120, widthPx / 7));
      ws.getRow(1).height = Math.max(20, Math.min(900, heightPx * .75));
      ws.pageSetup = {
        orientation: widthPx > heightPx ? 'landscape' : 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 1,
        margins: { left: 0.15, right: 0.15, top: 0.15, bottom: 0.15, header: 0, footer: 0 }
      };
    }
    const bytes = await wb.xlsx.writeBuffer();
    return {
      blob: new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      name: `${stem(file.name)}-layout-preserved.xlsx`
    };
  };

  const excelToPdfOne = async (file, progress) => {
    const XLSX = await getXLSX();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const output = await PDFDocument.create();
    const font = await output.embedFont(StandardFonts.Helvetica);
    const bold = await output.embedFont(StandardFonts.HelveticaBold);
    const pageW = 842, pageH = 595, margin = 28, rowH = 18;
    const maxColsPerPage = 10;
    const printableW = pageW - margin * 2;
    let done = 0;

    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: '' });
      const normalized = rows.length ? rows : [['']];
      const maxCols = Math.max(1, ...normalized.map(r => r.length));
      const perPage = Math.max(8, Math.floor((pageH - margin * 2 - 30) / rowH));

      // Wide sheets are split into horizontal column groups instead of silently
      // dropping every column after the first 10.
      for (let start = 0; start < normalized.length; start += perPage) {
        const slice = normalized.slice(start, start + perPage);

        for (let colStart = 0; colStart < maxCols; colStart += maxColsPerPage) {
          const colEnd = Math.min(maxCols, colStart + maxColsPerPage);
          const visibleCols = Math.max(1, colEnd - colStart);
          const colW = Math.max(70, Math.min(180, printableW / visibleCols));

          const page = output.addPage([pageW, pageH]);
          const title = maxCols > maxColsPerPage
            ? `${sheetName} · Columns ${colStart + 1}-${colEnd}`
            : sheetName;

          page.drawText(title, {
            x: margin,
            y: pageH - margin - 14,
            font: bold,
            size: 12,
            color: rgb(.18,.21,.29)
          });

          slice.forEach((row, r) => {
            const y = pageH - margin - 34 - (r + 1) * rowH;

            for (let c = colStart; c < colEnd; c += 1) {
              const x = margin + (c - colStart) * colW;
              const isHeader = r === 0 && start === 0;

              page.drawRectangle({
                x,
                y,
                width: colW,
                height: rowH,
                borderColor: rgb(.82,.84,.88),
                borderWidth: .4,
                color: isHeader ? rgb(.96,.97,.99) : rgb(1,1,1)
              });

              let txt = String(row[c] ?? '').replace(/\s+/g, ' ');
              while (font.widthOfTextAtSize(txt, 8) > colW - 8 && txt.length > 2) {
                txt = `${txt.slice(0,-2)}…`;
              }

              page.drawText(txt, {
                x: x + 4,
                y: y + 5,
                font: isHeader ? bold : font,
                size: 8,
                color: rgb(.2,.23,.3)
              });
            }
          });
        }
      }

      done += 1;
      progress?.(done / wb.SheetNames.length);
    }

    return { blob: pdfBlob(await output.save({ useObjectStreams: true })), name: `${stem(file.name)}.pdf` };
  };

  const pdfToPptOne = async (file, progress) => {
    await loadScript('https://cdn.jsdelivr.net/gh/gitbrent/pptxgenjs@3.12.0/dist/pptxgen.bundle.js', 'PptxGenJS');
    const pages = await renderPdfPages(file, 144, 'png', progress);
    if (!pages.length) throw new Error('No PDF pages were available to convert.');
    const pptx = new window.PptxGenJS();
    const firstW = Number(pages[0].sourceWidth || pages[0].width);
    const firstH = Number(pages[0].sourceHeight || pages[0].height);
    const ratio = firstH / Math.max(1, firstW);
    const slideW = 10;
    const slideH = Math.max(3, Math.min(20, slideW * ratio));
    const layoutName = 'PDFORA_SOURCE_PAGE';
    if (typeof pptx.defineLayout === 'function') pptx.defineLayout({ name: layoutName, width: slideW, height: slideH });
    pptx.layout = typeof pptx.defineLayout === 'function' ? layoutName : 'LAYOUT_WIDE';
    pptx.author = 'PDFora';
    pptx.subject = 'Converted from PDF with source layout preserved';
    pptx.title = stem(file.name);
    for (const p of pages) {
      const slide = pptx.addSlide();
      slide.background = { color: 'FFFFFF' };
      const pw = Number(p.sourceWidth || p.width), ph = Number(p.sourceHeight || p.height);
      const sourceRatio = ph / Math.max(1, pw);
      const targetH = typeof pptx.defineLayout === 'function' ? slideH : 7.5;
      const targetW = typeof pptx.defineLayout === 'function' ? slideW : 13.333;
      let w = targetW, h = targetW * sourceRatio;
      if (h > targetH) { h = targetH; w = targetH / sourceRatio; }
      slide.addImage({ data: await toDataUrl(p.blob), x: (targetW-w)/2, y: (targetH-h)/2, w, h });
    }
    const blob = await pptx.write({ outputType: 'blob', compression: true });
    return { blob, name: `${stem(file.name)}-layout-preserved.pptx` };
  };

  const pptToPdfOne = async (file, progress) => {
    await ensureHtml2Canvas();
    let pptMod;
    try { pptMod = await import('https://cdn.jsdelivr.net/npm/@jvmr/pptx-to-html@1.1.2/+esm'); }
    catch (_) { throw new Error('The PowerPoint rendering engine could not load. Check your connection and try again.'); }
    const slides = await pptMod.pptxToHtml(await file.arrayBuffer(), { width: 960, height: 540, scaleToFit: true, letterbox: true });
    if (!slides?.length) throw new Error('No slides could be rendered from this presentation.');
    const output = await PDFDocument.create();
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:960px;height:540px;background:white;z-index:-1;overflow:hidden;';
    document.body.appendChild(host);
    try {
      for (let i = 0; i < slides.length; i += 1) {
        host.innerHTML = slides[i];
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const canvas = await window.html2canvas(host, { backgroundColor: '#ffffff', scale: 1.25, useCORS: true, logging: false });
        const image = await output.embedJpg(dataUrlBytes(canvas.toDataURL('image/jpeg', .92)));
        const page = output.addPage([960, 540]);
        page.drawImage(image, { x:0, y:0, width:960, height:540 });
        progress?.((i+1)/slides.length);
      }
      return { blob: pdfBlob(await output.save({ useObjectStreams: true })), name: `${stem(file.name)}.pdf` };
    } finally { host.remove(); }
  };

  const ocrPdfOne = async (file, options, progress) => {
    // Load the official Tesseract.js browser build. Using the plain browser
    // build exposes window.Tesseract.createWorker; importing tesseract.min.js
    // as an ES module can cause "createWorker is not a function".
    let tess = window.Tesseract;
    if (!tess || typeof tess.createWorker !== 'function') {
      const cdnCandidates = [
        'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
        'https://unpkg.com/tesseract.js@5/dist/tesseract.min.js'
      ];
      let lastError = null;
      for (const src of cdnCandidates) {
        try {
          await loadScript(src);
          tess = window.Tesseract;
          if (tess && typeof tess.createWorker === 'function') break;
        } catch (err) {
          lastError = err;
        }
      }
      if (!tess || typeof tess.createWorker !== 'function') {
        throw new Error(lastError?.message || 'The OCR engine could not load. Check your connection and try again.');
      }
    }

    const lang = String(options.get('language') || 'eng');
    const rendered = await renderPdfPages(file, 150, 'png', (v) => progress?.(v * .2));
    let worker;
    try {
      // Let Tesseract.js v5 choose the matching worker/core/language assets.
      // This avoids version mismatches between the API, worker, and WASM core.
      worker = await tess.createWorker(lang, 1, {
        logger: (m) => {
          if (m.status === 'recognizing text' && Number.isFinite(m.progress)) {
            progress?.(.2 + .75 * m.progress);
          }
        }
      });
    } catch (err) {
      throw new Error(`OCR engine initialization failed: ${err?.message || 'Please refresh and try again.'}`);
    }

    const output = await PDFDocument.create();
    const font = await output.embedFont(StandardFonts.Helvetica);
    try {
      for (let i = 0; i < rendered.length; i += 1) {
        const imgBlob = rendered[i].blob;
        const result = await worker.recognize(imgBlob);
        const img = await output.embedPng(await imgBlob.arrayBuffer());
        const pageW = Number(rendered[i].sourceWidth || rendered[i].width * 72 / (rendered[i].dpi || 150));
        const pageH = Number(rendered[i].sourceHeight || rendered[i].height * 72 / (rendered[i].dpi || 150));
        const page = output.addPage([pageW, pageH]);
        page.drawImage(img, { x:0, y:0, width:pageW, height:pageH });
        const text = String(result.data.text || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g,' ').trim();
        if (text) {
          const chunks = text.match(/.{1,90}(?:\s|$)/g) || [text];
          chunks.slice(0,120).forEach((chunk, idx) => page.drawText(chunk.trim(), {
            x: 4,
            y: Math.max(2, 12 + idx * 4),
            size: 3,
            font,
            opacity: 0.001,
            color: rgb(1,1,1)
          }));
        }
        progress?.(.2 + .8 * ((i+1)/rendered.length));
      }
    } finally {
      if (worker) await worker.terminate();
    }
    return { blob: pdfBlob(await output.save({ useObjectStreams: true })), name: `${stem(file.name)}-ocr-searchable.pdf` };
  };

  const process = async ({ action, files, options, progress }) => {
    if (action === '/api/watermark-pdf') return batch(files, (f,p) => watermarkOne(f, options, p), 'watermarked-pdfs', progress);
    if (action === '/api/add-page-numbers') return batch(files, (f,p) => pageNumbersOne(f, options, p), 'numbered-pdfs', progress);
    if (action === '/api/protect-pdf') return batch(files, (f,p) => qpdfOne(f, options, 'protect', p), 'protected-pdfs', progress);
    if (action === '/api/unlock-pdf') return batch(files, (f,p) => qpdfOne(f, options, 'unlock', p), 'unlocked-pdfs', progress);
    if (action === '/api/pdf-to-word') return batch(files, (f,p) => pdfToWordOne(f, options, p), 'pdf-to-word', progress);
    if (action === '/api/word-to-pdf') return batch(files, (f,p) => wordToPdfOne(f,p), 'word-to-pdf', progress);
    if (action === '/api/pdf-to-excel') return batch(files, (f,p) => pdfToExcelOne(f, options, p), 'pdf-to-excel', progress);
    if (action === '/api/excel-to-pdf') return batch(files, (f,p) => excelToPdfOne(f,p), 'excel-to-pdf', progress);
    if (action === '/api/pdf-to-powerpoint') return batch(files, (f,p) => pdfToPptOne(f,p), 'pdf-to-powerpoint', progress);
    if (action === '/api/powerpoint-to-pdf') return batch(files, (f,p) => pptToPdfOne(f,p), 'powerpoint-to-pdf', progress);
    if (action === '/api/ocr-pdf') return batch(files, (f,p) => ocrPdfOne(f, options, p), 'ocr-pdfs', progress);
    return baseProcessor.process({ action, files, options, progress });
  };

  window.PDForaProcessor = { ...baseProcessor, process };
})();
