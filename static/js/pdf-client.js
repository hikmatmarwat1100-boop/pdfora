(() => {
  const { PDFDocument, degrees } = window.PDFLib || {};
  if (!PDFDocument || !window.pdfjsLib || !window.JSZip) return;

  window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdf.worker.min.js';

  const fileBytes = async (file) => new Uint8Array(await file.arrayBuffer());
  const stem = (name = 'document') => name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'document';
  const pdfBlob = (bytes) => new Blob([bytes], { type: 'application/pdf' });
  const imageBlob = (bytes, type) => new Blob([bytes], { type });

  const loadEditablePdf = async (file) => {
    try {
      return await PDFDocument.load(await fileBytes(file), { updateMetadata: false });
    } catch (_) {
      throw new Error('This PDF could not be read. Password-protected or damaged PDFs are not supported.');
    }
  };

  const parsePages = (value, pageCount, allowEmpty = false) => {
    const source = String(value || '').trim();
    if (!source && allowEmpty) return [...Array(pageCount).keys()];
    if (!source) throw new Error('Enter at least one page number.');
    const indexes = [];
    for (const part of source.split(',')) {
      const token = part.trim();
      if (!token) continue;
      const match = token.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!match) throw new Error('Use page numbers and ranges such as 1,3-5.');
      let start = Number(match[1]);
      let end = Number(match[2] || match[1]);
      if (start < 1 || end < 1 || start > pageCount || end > pageCount) throw new Error(`Choose pages between 1 and ${pageCount}.`);
      if (start > end) [start, end] = [end, start];
      for (let page = start; page <= end; page += 1) indexes.push(page - 1);
    }
    return [...new Set(indexes)];
  };

  const savePdf = async (doc) => pdfBlob(await doc.save({ useObjectStreams: true, addDefaultPage: false }));

  const renderPdfPages = async (file, dpi, format, progress) => {
    const source = await file.arrayBuffer();
    let pdfDocument;
    try {
      pdfDocument = await window.pdfjsLib.getDocument({ data: source }).promise;
    } catch (_) {
      throw new Error('This PDF could not be rendered. Password-protected or damaged PDFs are not supported.');
    }
    const output = [];
    const scale = dpi / 72;
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
      const quality = format === 'jpg' ? 0.88 : undefined;
      const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not create an image from this page.')), mime, quality));
      output.push({ blob, width: viewport.width / scale, height: viewport.height / scale, pageNumber });
      page.cleanup();
      progress?.(pageNumber / pdfDocument.numPages);
    }
    await pdfDocument.destroy();
    return output;
  };

  const compressPdf = async (file, level, progress) => {
    const settings = {
      light: { dpi: 130, quality: 0.76 },
      balanced: { dpi: 110, quality: 0.66 },
      strong: { dpi: 90, quality: 0.54 }
    }[level] || { dpi: 110, quality: 0.66 };

    const source = await file.arrayBuffer();
    const sourceDoc = await window.pdfjsLib.getDocument({ data: source.slice(0) }).promise;
    const output = await PDFDocument.create();
    for (let pageNumber = 1; pageNumber <= sourceDoc.numPages; pageNumber += 1) {
      const page = await sourceDoc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: settings.dpi / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const jpg = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not compress this page.')), 'image/jpeg', settings.quality));
      const embedded = await output.embedJpg(await jpg.arrayBuffer());
      const newPage = output.addPage([base.width, base.height]);
      newPage.drawImage(embedded, { x: 0, y: 0, width: base.width, height: base.height });
      page.cleanup();
      progress?.(pageNumber / sourceDoc.numPages);
    }
    await sourceDoc.destroy();
    const blob = await savePdf(output);
    return {
      blob: blob.size < file.size ? blob : new Blob([source], { type: 'application/pdf' }),
      name: `${stem(file.name)}-compressed.pdf`,
      originalSize: file.size
    };
  };

  const process = async ({ action, files, options, progress }) => {
    if (!files.length) throw new Error('Choose at least one file.');
    if (action === '/api/compress-pdf') return compressPdf(files[0], options.get('compression_level'), progress);

    if (action === '/api/merge-pdf') {
      const output = await PDFDocument.create();
      for (let index = 0; index < files.length; index += 1) {
        const source = await loadEditablePdf(files[index]);
        const pages = await output.copyPages(source, source.getPageIndices());
        pages.forEach((page) => output.addPage(page));
        progress?.((index + 1) / files.length);
      }
      return { blob: await savePdf(output), name: 'merged-pdf.pdf' };
    }

    if (action === '/api/split-pdf') {
      const source = await loadEditablePdf(files[0]);
      const zip = new JSZip();
      for (let index = 0; index < source.getPageCount(); index += 1) {
        const output = await PDFDocument.create();
        const [page] = await output.copyPages(source, [index]);
        output.addPage(page);
        zip.file(`page-${index + 1}.pdf`, await output.save({ useObjectStreams: true }));
        progress?.((index + 1) / source.getPageCount());
      }
      return { blob: await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), name: `${stem(files[0].name)}-split-pages.zip` };
    }

    if (['/api/rotate-pdf', '/api/delete-pdf-pages', '/api/extract-pdf-pages', '/api/reorder-pdf-pages'].includes(action)) {
      const source = await loadEditablePdf(files[0]);
      const count = source.getPageCount();
      let indexes;
      if (action === '/api/rotate-pdf') {
        indexes = parsePages(options.get('pages'), count, true);
        const rotation = Number(options.get('rotation') || 90);
        if (![90, 180, 270].includes(rotation)) throw new Error('Choose a valid rotation.');
        indexes.forEach((index) => {
          const page = source.getPage(index);
          page.setRotation(degrees((page.getRotation().angle + rotation) % 360));
        });
        return { blob: await savePdf(source), name: `${stem(files[0].name)}-rotated.pdf` };
      }
      if (action === '/api/delete-pdf-pages') {
        indexes = parsePages(options.get('pages'), count);
        if (indexes.length >= count) throw new Error('You cannot delete every page from the PDF.');
        [...indexes].sort((a, b) => b - a).forEach((index) => source.removePage(index));
        return { blob: await savePdf(source), name: `${stem(files[0].name)}-pages-removed.pdf` };
      }
      const output = await PDFDocument.create();
      if (action === '/api/extract-pdf-pages') indexes = parsePages(options.get('pages'), count);
      else {
        const raw = String(options.get('order') || '').split(',').map((value) => Number(value.trim()) - 1);
        if (raw.length !== count || raw.some((value) => !Number.isInteger(value) || value < 0 || value >= count) || new Set(raw).size !== count) {
          throw new Error(`Enter every page exactly once, using numbers 1 to ${count}.`);
        }
        indexes = raw;
      }
      const pages = await output.copyPages(source, indexes);
      pages.forEach((page) => output.addPage(page));
      return { blob: await savePdf(output), name: `${stem(files[0].name)}-${action.includes('extract') ? 'extracted' : 'reordered'}.pdf` };
    }

    if (action === '/api/pdf-to-jpg' || action === '/api/pdf-to-png') {
      const format = action.endsWith('jpg') ? 'jpg' : 'png';
      const rendered = await renderPdfPages(files[0], Number(options.get('dpi') || 150), format, progress);
      const zip = new JSZip();
      for (const page of rendered) zip.file(`page-${page.pageNumber}.${format}`, page.blob);
      return { blob: await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), name: `${stem(files[0].name)}-${format}-pages.zip` };
    }

    if (action === '/api/jpg-to-pdf' || action === '/api/png-to-pdf') {
      const output = await PDFDocument.create();
      for (let index = 0; index < files.length; index += 1) {
        const bytes = await fileBytes(files[index]);
        const image = action.includes('jpg') ? await output.embedJpg(bytes) : await output.embedPng(bytes);
        const dimensions = image.scale(1);
        const maxDimension = 14400;
        const scale = Math.min(1, maxDimension / Math.max(dimensions.width, dimensions.height));
        const width = dimensions.width * scale;
        const height = dimensions.height * scale;
        const page = output.addPage([width, height]);
        page.drawImage(image, { x: 0, y: 0, width, height });
        progress?.((index + 1) / files.length);
      }
      return { blob: await savePdf(output), name: `${action.includes('jpg') ? 'jpg' : 'png'}-images.pdf` };
    }

    throw new Error('This PDF tool is not available.');
  };

  const inspect = async (file) => {
    const source = await loadEditablePdf(file);
    return { pages: source.getPageCount() };
  };

  window.PDForaProcessor = { process, inspect };
})();
