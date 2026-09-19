(() => {
  const workspace = document.querySelector('[data-pdf-tool]');
  if (!workspace) return;

  const form = document.getElementById('toolForm');
  const input = document.getElementById('toolFileInput');
  const dropZone = document.getElementById('dropZone');
  const selectedFiles = document.getElementById('selectedFiles');
  const fileList = document.getElementById('fileList');
  const clearFiles = document.getElementById('clearFiles');
  const pdfInfo = document.getElementById('pdfInfo');
  const toolOptions = document.getElementById('toolOptions');
  const processActions = document.getElementById('processActions');
  const processButton = document.getElementById('processButton');
  const progressPanel = document.getElementById('progressPanel');
  const progressTitle = document.getElementById('progressTitle');
  const progressPercent = document.getElementById('progressPercent');
  const progressBar = document.getElementById('progressBar');
  const progressTrack = document.getElementById('progressTrack');
  const progressText = document.getElementById('progressText');
  const cancelProcess = document.getElementById('cancelProcess');
  const errorPanel = document.getElementById('errorPanel');
  const errorText = document.getElementById('errorText');
  const dismissError = document.getElementById('dismissError');
  const resultPanel = document.getElementById('resultPanel');
  const resultMeta = document.getElementById('resultMeta');
  const resultHeading = resultPanel?.querySelector('h2');
  const compressionStats = document.getElementById('compressionStats');
  const downloadButton = document.getElementById('downloadButton');
  const resetTool = document.getElementById('resetTool');

  const multiple = workspace.dataset.multiple === 'true';
  const minFiles = Number(workspace.dataset.minFiles || 1);
  const controls = workspace.dataset.controls;
  const action = workspace.dataset.action;
  const output = workspace.dataset.output || 'PDF';
  const maxFileBytes = Number(workspace.dataset.maxFileMb || 50) * 1024 * 1024;
  const maxTotalBytes = Number(workspace.dataset.maxTotalMb || 150) * 1024 * 1024;
  const maxFiles = Number(workspace.dataset.maxFiles || 20);
  const acceptedExtensions = (workspace.dataset.accept || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.startsWith('.'));

  let currentFiles = [];
  let detectedPageCount = null;
  let draggedIndex = null;
  let activeXhr = null;
  let activeJob = 0;
  let processingController = null;
  let progressTicker = null;
  let inspectController = null;
  let inspectGeneration = 0;
  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes)) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  };

  const fileExtension = (file) => {
    const name = (file.name || '').toLowerCase();
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot) : '';
  };

  const fileExtensionLabel = (file) => {
    const ext = (fileExtension(file).replace('.', '') || 'FILE').toUpperCase();
    return ext.length > 5 ? 'FILE' : ext;
  };

  const setProgress = (value) => {
    const percent = Math.max(0, Math.min(100, Math.round(value)));
    progressPercent.textContent = `${percent}%`;
    progressBar.style.width = `${percent}%`;
    progressTrack?.setAttribute('aria-valuenow', String(percent));
  };

  const stopProgressTicker = () => {
    if (progressTicker) window.clearInterval(progressTicker);
    progressTicker = null;
  };

  const startProcessingTicker = () => {
    stopProgressTicker();
    let displayed = Number.parseInt(progressPercent.textContent, 10) || 90;
    progressTicker = window.setInterval(() => {
      if (displayed < 98) {
        displayed += 1;
        setProgress(displayed);
      }
    }, 850);
  };

  const transferToInput = () => {
    try {
      const transfer = new DataTransfer();
      currentFiles.forEach((file) => transfer.items.add(file));
      input.files = transfer.files;
    } catch (_) {
      // Some browsers restrict assigning FileList. currentFiles is authoritative.
    }
  };

  const hideResultAndError = () => {
    errorPanel.hidden = true;
    resultPanel.hidden = true;
  };

  const showError = (message) => {
    stopProgressTicker();
    progressPanel.hidden = true;
    resultPanel.hidden = true;
    errorText.textContent = message || 'Something went wrong while processing your file. Please try again.';
    errorPanel.hidden = false;
    processButton.disabled = currentFiles.length < minFiles;
    activeXhr = null;
    window.PDForaAnalytics?.track('tool_error', { action, message });
  };

  const validateFiles = (files) => {
    if (!files.length) return 'Please choose at least one file.';
    if (!multiple && files.length > 1) return 'This tool accepts one file at a time.';
    if (multiple && files.length > maxFiles) return `Please upload no more than ${maxFiles} files at once.`;

    let total = 0;
    for (const file of files) {
      if (!file.size) return `${file.name || 'A selected file'} is empty.`;
      if (file.size > maxFileBytes) return `${file.name} exceeds the per-file upload limit.`;
      total += file.size;
      const ext = fileExtension(file);
      if (acceptedExtensions.length && !acceptedExtensions.includes(ext)) {
        return `${file.name} is not a supported file type for this tool.`;
      }
    }
    if (total > maxTotalBytes) return 'The combined file size exceeds the current upload limit.';
    return '';
  };

  const moveFile = (from, to) => {
    if (from === to || from < 0 || to < 0 || from >= currentFiles.length || to >= currentFiles.length) return;
    const [moved] = currentFiles.splice(from, 1);
    currentFiles.splice(to, 0, moved);
    transferToInput();
    renderFiles();
  };

  const renderFiles = () => {
    fileList.innerHTML = '';
    currentFiles.forEach((file, index) => {
      const row = document.createElement('div');
      row.className = 'file-row';
      row.draggable = multiple && currentFiles.length > 1;
      row.dataset.index = String(index);
      row.innerHTML = `
        <span class="file-type">${fileExtensionLabel(file)}</span>
        <span class="file-info"><strong></strong><small>${formatBytes(file.size)}</small></span>
        <span class="file-order-actions">
          <button class="order-file" type="button" data-direction="up" aria-label="Move file up" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button class="order-file" type="button" data-direction="down" aria-label="Move file down" ${index === currentFiles.length - 1 ? 'disabled' : ''}>↓</button>
        </span>
        <span class="drag-handle" title="Drag to reorder" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"/></svg></span>
        <button class="remove-file" type="button" aria-label="Remove file"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
      row.querySelector('.file-info strong').textContent = file.name;
      row.querySelector('.remove-file').addEventListener('click', () => {
        currentFiles.splice(index, 1);
        transferToInput();
        renderFiles();
        if (!currentFiles.length) resetSelection();
        else inspectPdfIfNeeded();
      });
      row.querySelectorAll('.order-file').forEach((button) => button.addEventListener('click', () => {
        moveFile(index, button.dataset.direction === 'up' ? index - 1 : index + 1);
      }));
      row.addEventListener('dragstart', (event) => {
        draggedIndex = index;
        row.classList.add('dragging');
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragover', (event) => {
        if (!multiple) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      });
      row.addEventListener('drop', (event) => {
        event.preventDefault();
        if (draggedIndex === null) return;
        moveFile(draggedIndex, index);
        draggedIndex = null;
      });
      row.addEventListener('dragend', () => {
        draggedIndex = null;
        row.classList.remove('dragging');
      });
      fileList.appendChild(row);
    });

    const hasFiles = currentFiles.length > 0;
    selectedFiles.hidden = !hasFiles;
    toolOptions.hidden = !hasFiles;
    processActions.hidden = !hasFiles;
    processButton.disabled = hasFiles && currentFiles.length < minFiles;
    if (processButton.disabled) processButton.title = `Choose at least ${minFiles} files to continue.`;
    else processButton.removeAttribute('title');
  };

  const resetSelection = () => {
    inspectGeneration += 1;
    inspectController?.abort();
    inspectController = null;
    currentFiles = [];
    detectedPageCount = null;
    input.value = '';
    fileList.innerHTML = '';
    selectedFiles.hidden = true;
    toolOptions.hidden = true;
    processActions.hidden = true;
    pdfInfo.hidden = true;
    pdfInfo.textContent = '';
    processButton.disabled = false;
  };

  const addFiles = (fileListLike) => {
    const incoming = [...fileListLike];
    if (!incoming.length) return;
    const candidate = multiple ? [...currentFiles, ...incoming] : [incoming[0]];
    const error = validateFiles(candidate);
    input.value = '';
    if (error) {
      showError(error);
      return;
    }
    currentFiles = candidate;
    transferToInput();
    renderFiles();
    inspectPdfIfNeeded();
    hideResultAndError();
    window.PDForaAnalytics?.track('file_uploaded', { count: currentFiles.length });
  };

  const inspectPdfIfNeeded = async () => {
    inspectGeneration += 1;
    const generation = inspectGeneration;
    inspectController?.abort();
    inspectController = null;

    if (currentFiles.length !== 1 || fileExtension(currentFiles[0]) !== '.pdf' || !['pages', 'order', 'rotate'].includes(controls)) {
      pdfInfo.hidden = true;
      return;
    }

    pdfInfo.hidden = false;
    pdfInfo.textContent = 'Checking PDF page count…';
    try {
      if (!window.PDForaProcessor) throw new Error('The secure processing engine could not load. Refresh the page and try again.');
      const json = await window.PDForaProcessor.inspect(currentFiles[0]);
      if (generation !== inspectGeneration) return;
      detectedPageCount = json.pages;
      pdfInfo.textContent = `${json.pages} page${json.pages === 1 ? '' : 's'} detected • processed privately in your browser`;
      if (controls === 'order') {
        const orderInput = form.querySelector('[name="order"]');
        if (orderInput && !orderInput.value) {
          const example = Array.from({ length: Math.min(json.pages, 10) }, (_, i) => i + 1).join(',');
          orderInput.placeholder = `${example}${json.pages > 10 ? ',…' : ''}`;
        }
      }
    } catch (error) {
      if (generation !== inspectGeneration) return;
      detectedPageCount = null;
      pdfInfo.textContent = error.message || 'Could not inspect this PDF.';
    } finally {
      if (generation === inspectGeneration) inspectController = null;
    }
  };

  input.addEventListener('change', () => addFiles(input.files));
  dropZone.addEventListener('dragover', (event) => { event.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragover');
    addFiles(event.dataTransfer.files);
  });
  dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  clearFiles.addEventListener('click', resetSelection);
  dismissError.addEventListener('click', () => { errorPanel.hidden = true; });

  const buildFormData = () => {
    const data = new FormData();
    const fieldName = multiple ? 'files' : 'file';
    currentFiles.forEach((file) => data.append(fieldName, file, file.name));
    const controlsData = new FormData(form);
    for (const [key, value] of controlsData.entries()) {
      if (key === 'file' || key === 'files') continue;
      data.append(key, value);
    }
    return data;
  };

  const messageForStatus = (status, payload) => {
    if (payload?.error) return payload.error;
    if (payload?.detail) return payload.detail;
    if (status === 413) return 'The upload is too large for the current processing limits.';
    if (status === 400) return 'Please check the selected files and options, then try again.';
    if (status === 503) return 'The processing service is warming up or temporarily unavailable. Please try again in a moment.';
    if (status >= 500) return 'The server could not process this file right now. Please try again.';
    return 'Something went wrong while processing your file. Please try again.';
  };

  let currentDownloadUrl = null;

  const clearDownloadUrl = () => {
    if (currentDownloadUrl) URL.revokeObjectURL(currentDownloadUrl);
    currentDownloadUrl = null;
    downloadButton.removeAttribute('href');
  };

  const parseErrorBlob = async (blob) => {
    try {
      const text = await blob.text();
      if (!text) return {};
      return JSON.parse(text);
    } catch (_) {
      return {};
    }
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentFiles.length) { showError('Please choose a file first.'); return; }
    const selectionError = validateFiles(currentFiles);
    if (selectionError) { showError(selectionError); return; }
    if (currentFiles.length < minFiles) { showError(`Please choose at least ${minFiles} files to continue.`); return; }
    if (!form.reportValidity()) return;

    hideResultAndError();
    clearDownloadUrl();
    progressPanel.hidden = false;
    progressTitle.textContent = 'Processing securely…';
    progressText.textContent = 'Keep this tab open. Your files stay on this device and are processed in your browser.';
    setProgress(4);
    processButton.disabled = true;
    window.PDForaAnalytics?.track('processing_started', { action });
    processingController?.abort();
    const controller = new AbortController();
    processingController = controller;
    const job = ++activeJob;
    try {
      if (!window.PDForaProcessor) throw new Error('The secure processing engine could not load. Refresh the page and try again.');
      const result = await window.PDForaProcessor.process({
        action,
        files: currentFiles,
        options: new FormData(form),
        signal: controller.signal,
        progress: (value) => {
          if (controller.signal.aborted) throw new DOMException('Processing cancelled.', 'AbortError');
          if (job !== activeJob) throw new DOMException('Processing cancelled.', 'AbortError');
          setProgress(8 + value * 88);
          progressTitle.textContent = value > 0.9 ? 'Finishing your file…' : 'Processing securely…';
        }
      });
      if (controller.signal.aborted || job !== activeJob) return;
      const blob = result.blob;
      if (!blob || !blob.size) throw new Error('The PDF engine returned an empty result. Please try again.');
      setProgress(100);
      progressPanel.hidden = true;
      currentDownloadUrl = URL.createObjectURL(blob);
      const downloadName = result.name || 'pdfora-download';
      downloadButton.href = currentDownloadUrl;
      downloadButton.setAttribute('download', downloadName);
      resultMeta.textContent = `${downloadName} is ready to download (${formatBytes(blob.size)}).`;
      const isZip = downloadName.toLowerCase().endsWith('.zip');
      if (resultHeading) resultHeading.textContent = isZip ? 'Your files are ready.' : `${output || 'File'} is ready.`;
      downloadButton.textContent = isZip ? 'Download ZIP' : `Download ${output || 'file'}`;

      const originalSize = Number(result.originalSize || 0);
      const reduction = originalSize ? Math.max(0, (1 - blob.size / originalSize) * 100) : 0;
      if (originalSize) {
        compressionStats.hidden = false;
        compressionStats.innerHTML = `
          <div><small>Original</small><strong>${formatBytes(originalSize)}</strong></div>
          <div><small>Compressed</small><strong>${formatBytes(blob.size)}</strong></div>
          <div><small>Reduction</small><strong>${reduction.toFixed(1)}%</strong></div>`;
      } else {
        compressionStats.hidden = true;
        compressionStats.innerHTML = '';
      }

      resultPanel.hidden = false;
      processButton.disabled = false;
      resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      window.PDForaAnalytics?.track('processing_completed', { action });
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError' || job !== activeJob) return;
      showError(error?.message || 'Something went wrong while processing your file. Please try again.');
    } finally {
      if (processingController === controller) processingController = null;
    }
  });

  cancelProcess.addEventListener('click', () => {
    if (!processingController) return;
    processingController.abort();
    if (activeXhr) activeXhr.abort();
    activeXhr = null;
    activeJob += 1;
    stopProgressTicker();
    progressPanel.hidden = true;
    processButton.disabled = false;
    showError('Processing was cancelled. Your current selection is still available.');
  });

  downloadButton.addEventListener('click', () => window.PDForaAnalytics?.track('download_clicked', { action }));
  resetTool.addEventListener('click', () => {
    processingController?.abort();
    processingController = null;
    activeJob += 1;
    if (activeXhr) activeXhr.abort();
    activeXhr = null;
    stopProgressTicker();
    clearDownloadUrl();
    hideResultAndError();
    progressPanel.hidden = true;
    compressionStats.hidden = true;
    resetSelection();
    form.reset();
    dropZone.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  window.addEventListener('beforeunload', () => {
    processingController?.abort();
    clearDownloadUrl();
  });
})();
