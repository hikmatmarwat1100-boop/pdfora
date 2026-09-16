(() => {
  const input=document.getElementById('signFile'); const pad=document.getElementById('signaturePad');
  if(!input||!pad||!window.PDFLib)return;
  const {PDFDocument,StandardFonts,rgb}=window.PDFLib;
  const ctx=pad.getContext('2d'); ctx.lineWidth=2.2;ctx.lineCap='round';ctx.strokeStyle='#111827';
  let drawing=false,last=null,file=null;
  const status=document.getElementById('signStatus'); const clear=document.getElementById('signClear'); const save=document.getElementById('signDownload');
  const pageInput=document.getElementById('signPage'); const position=document.getElementById('signPosition'); const typed=document.getElementById('typedSignature');
  const set=(m,k='')=>{status.textContent=m;status.dataset.kind=k;};
  const p=(e)=>{const r=pad.getBoundingClientRect();return{x:(e.clientX-r.left)*pad.width/r.width,y:(e.clientY-r.top)*pad.height/r.height};};
  pad.addEventListener('pointerdown',e=>{drawing=true;last=p(e);pad.setPointerCapture?.(e.pointerId)});
  pad.addEventListener('pointermove',e=>{if(!drawing)return;const n=p(e);ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(n.x,n.y);ctx.stroke();last=n});
  pad.addEventListener('pointerup',()=>{drawing=false;last=null});
  clear.addEventListener('click',()=>ctx.clearRect(0,0,pad.width,pad.height));
  input.addEventListener('change',async()=>{file=input.files?.[0]||null;if(!file)return;try{const d=await PDFDocument.load(await file.arrayBuffer(),{updateMetadata:false});pageInput.max=d.getPageCount();pageInput.value=Math.min(Number(pageInput.value||1),d.getPageCount());set(`${d.getPageCount()} page${d.getPageCount()===1?'':'s'} detected. Draw or type your signature.`,'success')}catch(_){set('This PDF could not be opened. Password-protected or damaged files may need Unlock PDF first.','error')}});
  save.addEventListener('click',async()=>{if(!file){set('Choose a PDF first.','error');return}save.disabled=true;set('Adding signature…');try{const doc=await PDFDocument.load(await file.arrayBuffer(),{updateMetadata:false});const pageNo=Math.max(1,Math.min(doc.getPageCount(),Number(pageInput.value||1)));const page=doc.getPage(pageNo-1);const {width,height}=page.getSize();const pos=position.value;let x=width-190,y=38;if(pos==='bottom-left'){x=38;y=38}else if(pos==='top-right'){x=width-190;y=height-92}else if(pos==='top-left'){x=38;y=height-92}else if(pos==='center'){x=width/2-90;y=height/2-35}
    const hasInk=ctx.getImageData(0,0,pad.width,pad.height).data.some((v,i)=>i%4===3&&v>0);
    if(hasInk){const data=pad.toDataURL('image/png');const bytes=Uint8Array.from(atob(data.split(',')[1]),c=>c.charCodeAt(0));const img=await doc.embedPng(bytes);page.drawImage(img,{x,y,width:150,height:70});}
    const name=typed.value.trim();if(name){const font=await doc.embedFont(StandardFonts.HelveticaOblique);page.drawText(name,{x,y:hasInk?y-2:y+24,size:18,font,color:rgb(.08,.1,.16)});}
    if(!hasInk&&!name)throw new Error('Draw a signature or type your name first.');
    const blob=new Blob([await doc.save({useObjectStreams:true})],{type:'application/pdf'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`${file.name.replace(/\.pdf$/i,'')}-signed.pdf`;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);set('Signed PDF ready and downloaded.','success');
  }catch(e){set(e.message||'Could not sign this PDF.','error')}finally{save.disabled=false}});
})();
