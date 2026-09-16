(() => {
  const input = document.getElementById('editorFile');
  const stage = document.getElementById('editorStage');
  if (!input || !stage || !window.PDFLib || !window.pdfjsLib) return;
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdf.worker.min.js';

  const textInput = document.getElementById('editorText');
  const fontSize = document.getElementById('editorFontSize');
  const colorInput = document.getElementById('editorColor');
  const imageInput = document.getElementById('editorImage');
  const status = document.getElementById('editorStatus');
  const download = document.getElementById('editorDownload');
  const undo = document.getElementById('editorUndo');
  const clear = document.getElementById('editorClear');
  const toolButtons = [...document.querySelectorAll('[data-editor-tool]')];
  let activeTool = 'text';
  let file = null;
  let pdfjsDoc = null;
  let annotations = [];
  let imageDataUrl = '';
  let drag = null;

  const setStatus = (message, kind='') => { status.textContent = message; status.dataset.kind = kind; };
  const setTool = (tool) => {
    activeTool = tool;
    toolButtons.forEach(b => b.classList.toggle('active', b.dataset.editorTool === tool));
    setStatus(tool === 'text' ? 'Click a page to place text.' : tool === 'image' ? 'Choose an image, then click a page.' : `Drag on a page to add ${tool}.`);
  };
  toolButtons.forEach(b => b.addEventListener('click', () => setTool(b.dataset.editorTool)));
  setTool('text');

  const pagePoint = (event, pageWrap) => {
    const rect = pageWrap.getBoundingClientRect();
    return { x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)), y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)), w: rect.width, h: rect.height };
  };

  const addOverlay = (ann) => {
    const wrap = stage.querySelector(`[data-page-index="${ann.page}"]`);
    if (!wrap) return;
    const layer = wrap.querySelector('.editor-overlay');
    let el;
    if (ann.type === 'text') {
      el = document.createElement('div');
      el.className = 'editor-ann editor-ann-text';
      el.textContent = ann.text;
      Object.assign(el.style, { left:`${ann.x}px`, top:`${ann.y}px`, fontSize:`${ann.size}px`, color:ann.color });
    } else if (ann.type === 'image') {
      el = document.createElement('img');
      el.className = 'editor-ann editor-ann-image';
      el.src = ann.data;
      Object.assign(el.style, { left:`${ann.x}px`, top:`${ann.y}px`, width:`${ann.width}px` });
    } else if (ann.type === 'draw') {
      el = document.createElementNS('http://www.w3.org/2000/svg','svg');
      el.setAttribute('class','editor-ann editor-ann-svg');
      el.setAttribute('viewBox',`0 0 ${ann.pageW} ${ann.pageH}`);
      const pl = document.createElementNS('http://www.w3.org/2000/svg','polyline');
      pl.setAttribute('points', ann.points.map(p => `${p.x},${p.y}`).join(' '));
      pl.setAttribute('fill','none'); pl.setAttribute('stroke',ann.color); pl.setAttribute('stroke-width','3'); pl.setAttribute('stroke-linecap','round'); pl.setAttribute('stroke-linejoin','round');
      el.appendChild(pl);
    } else {
      el = document.createElement('div');
      el.className = `editor-ann editor-ann-box ${ann.type}`;
      Object.assign(el.style, { left:`${ann.x}px`, top:`${ann.y}px`, width:`${ann.width}px`, height:`${ann.height}px` });
    }
    el.dataset.annId = ann.id;
    el.title = 'Double-click to remove';
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      annotations = annotations.filter(a => a.id !== ann.id);
      el.remove();
    });
    layer.appendChild(el);
  };

  const redraw = () => {
    stage.querySelectorAll('.editor-overlay').forEach(l => l.innerHTML = '');
    annotations.forEach(addOverlay);
  };

  const render = async () => {
    stage.innerHTML = '<div class="editor-loading">Rendering PDF pages…</div>';
    const bytes = await file.arrayBuffer();
    try { pdfjsDoc = await window.pdfjsLib.getDocument({ data: bytes.slice(0) }).promise; }
    catch (_) { throw new Error('This PDF could not be opened. Password-protected or damaged files are not supported in Edit PDF.'); }
    stage.innerHTML = '';
    annotations = [];
    for (let i = 1; i <= pdfjsDoc.numPages; i += 1) {
      const page = await pdfjsDoc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const maxW = Math.min(820, stage.clientWidth - 28);
      const scale = maxW / base.width;
      const viewport = page.getViewport({ scale });
      const wrap = document.createElement('div');
      wrap.className = 'editor-page'; wrap.dataset.pageIndex = String(i-1); wrap.dataset.pdfWidth = String(base.width); wrap.dataset.pdfHeight = String(base.height);
      wrap.style.width = `${viewport.width}px`; wrap.style.height = `${viewport.height}px`;
      const badge = document.createElement('span'); badge.className = 'editor-page-label'; badge.textContent = `Page ${i}`;
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height); canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      const ctx = canvas.getContext('2d', { alpha:false }); ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
      await page.render({ canvasContext:ctx, viewport }).promise;
      const overlay = document.createElement('div'); overlay.className = 'editor-overlay';
      wrap.append(canvas,badge,overlay); stage.appendChild(wrap); page.cleanup();

      wrap.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.editor-ann')) return;
        const p = pagePoint(event, wrap);
        if (activeTool === 'text') {
          const text = textInput.value.trim();
          if (!text) { setStatus('Type the text you want to place first.', 'error'); return; }
          const ann = { id:crypto.randomUUID(), type:'text', page:i-1, x:p.x, y:p.y, text, size:Number(fontSize.value||18), color:colorInput.value, pageW:p.w, pageH:p.h };
          annotations.push(ann); addOverlay(ann); return;
        }
        if (activeTool === 'image') {
          if (!imageDataUrl) { setStatus('Choose a JPG or PNG image first.', 'error'); imageInput.click(); return; }
          const ann = { id:crypto.randomUUID(), type:'image', page:i-1, x:p.x, y:p.y, width:Math.min(180,p.w*.35), data:imageDataUrl, pageW:p.w, pageH:p.h };
          annotations.push(ann); addOverlay(ann); return;
        }
        drag = { type:activeTool, page:i-1, start:p, points:[{x:p.x,y:p.y}], wrap };
        wrap.setPointerCapture?.(event.pointerId);
      });
      wrap.addEventListener('pointermove', (event) => {
        if (!drag || drag.wrap !== wrap) return;
        const p = pagePoint(event, wrap);
        if (drag.type === 'draw') drag.points.push({x:p.x,y:p.y});
      });
      wrap.addEventListener('pointerup', (event) => {
        if (!drag || drag.wrap !== wrap) return;
        const p = pagePoint(event, wrap);
        let ann;
        if (drag.type === 'draw') {
          drag.points.push({x:p.x,y:p.y});
          ann = { id:crypto.randomUUID(), type:'draw', page:i-1, points:drag.points, color:colorInput.value, pageW:p.w, pageH:p.h };
        } else {
          const x = Math.min(drag.start.x,p.x), y = Math.min(drag.start.y,p.y), width = Math.abs(p.x-drag.start.x), height = Math.abs(p.y-drag.start.y);
          if (width < 5 || height < 5) { drag = null; return; }
          ann = { id:crypto.randomUUID(), type:drag.type, page:i-1, x,y,width,height, pageW:p.w,pageH:p.h };
        }
        annotations.push(ann); addOverlay(ann); drag = null;
      });
    }
    setStatus(`${pdfjsDoc.numPages} page${pdfjsDoc.numPages===1?'':'s'} ready. Add edits, then export a new PDF.`,'success');
  };

  input.addEventListener('change', async () => {
    const picked = input.files?.[0]; if (!picked) return;
    if (!picked.name.toLowerCase().endsWith('.pdf')) { setStatus('Please choose a PDF file.', 'error'); return; }
    file = picked;
    try { await render(); } catch (e) { setStatus(e.message || 'Could not load this PDF.', 'error'); }
  });
  imageInput.addEventListener('change', async () => {
    const img = imageInput.files?.[0]; if (!img) return;
    if (!/^image\/(png|jpeg)$/.test(img.type)) { setStatus('Choose a PNG or JPG image.', 'error'); return; }
    imageDataUrl = await new Promise((resolve,reject) => { const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(img); });
    setTool('image'); setStatus('Image ready. Click a page to place it.','success');
  });
  undo.addEventListener('click', () => { annotations.pop(); redraw(); });
  clear.addEventListener('click', () => { annotations = []; redraw(); });

  download.addEventListener('click', async () => {
    if (!file) { setStatus('Choose a PDF first.', 'error'); return; }
    download.disabled = true; setStatus('Building your edited PDF…');
    try {
      const doc = await PDFDocument.load(await file.arrayBuffer(), { updateMetadata:false });
      const font = await doc.embedFont(StandardFonts.Helvetica);
      for (const ann of annotations) {
        const page = doc.getPage(ann.page); const { width, height } = page.getSize();
        const sx = width / ann.pageW, sy = height / ann.pageH;
        const pdfX = (ann.x||0)*sx; const pdfY = height - ((ann.y||0)*sy);
        if (ann.type === 'text') {
          const size = Math.max(6, ann.size * sx);
          page.drawText(ann.text, { x:pdfX, y:pdfY-size, size, font, color:(() => { const h=ann.color.replace('#',''); return rgb(parseInt(h.slice(0,2),16)/255,parseInt(h.slice(2,4),16)/255,parseInt(h.slice(4,6),16)/255); })() });
        } else if (ann.type === 'highlight' || ann.type === 'whiteout') {
          const x=ann.x*sx, w=ann.width*sx, h=ann.height*sy, y=height-(ann.y*sy)-h;
          page.drawRectangle({ x,y,width:w,height:h,color:ann.type==='whiteout'?rgb(1,1,1):rgb(1,.9,.2),opacity:ann.type==='whiteout'?1:.36 });
        } else if (ann.type === 'draw') {
          for (let j=1;j<ann.points.length;j+=1) {
            const a=ann.points[j-1], b=ann.points[j];
            const h=ann.color.replace('#','');
            page.drawLine({ start:{x:a.x*sx,y:height-a.y*sy}, end:{x:b.x*sx,y:height-b.y*sy}, thickness:2.2*sx, color:rgb(parseInt(h.slice(0,2),16)/255,parseInt(h.slice(2,4),16)/255,parseInt(h.slice(4,6),16)/255) });
          }
        } else if (ann.type === 'image') {
          const bytes = Uint8Array.from(atob(ann.data.split(',')[1]), c => c.charCodeAt(0));
          const img = ann.data.startsWith('data:image/png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          const ratio = img.height/img.width; const w=ann.width*sx, h=w*ratio;
          page.drawImage(img,{x:ann.x*sx,y:height-ann.y*sy-h,width:w,height:h});
        }
      }
      const blob = new Blob([await doc.save({ useObjectStreams:true })],{type:'application/pdf'});
      const url=URL.createObjectURL(blob); const a=document.createElement('a');a.href=url;a.download=`${file.name.replace(/\.pdf$/i,'')}-edited.pdf`;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
      setStatus('Edited PDF ready and downloaded. Review it before replacing the original.','success');
    } catch (e) { setStatus(e.message || 'Could not create the edited PDF.','error'); }
    finally { download.disabled=false; }
  });
})();
