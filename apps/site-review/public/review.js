(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const parts = location.pathname.split('/').filter(Boolean);
  const invite = parts.length === 2 ? parts[1] : '';
  const owner = new URLSearchParams(location.hash.slice(1)).get('owner');
  const apiRoot = '/api/reviews/' + encodeURIComponent(invite);
  const channel = 'fgs-site-review-v1';
  let data, page, capture, target, frame, frameOrigin, frameReady, currentFrameUrl;
  let toastTimer, frameTimer, clientId, notePageId, stagedImage, stagedFilename;
  let imageSequence=0, refreshSequence=0, view='website', picking=false, isSending=false, statusBusy=false;
  function storage(action, key, value, persistent = false) {
    try {
      const store = persistent ? localStorage : sessionStorage;
      if (action === 'get') return store.getItem(key);
      if (action === 'set') store.setItem(key, value);
      if (action === 'remove') store.removeItem(key);
    } catch { /* Storage is optional in private browsing. */ }
    return null;
  }
  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  }
  function announce(message) {
    clearTimeout(toastTimer);
    el('toast').textContent = message;
    toastTimer = setTimeout(() => { el('toast').textContent = ''; }, 6500);
  }
  async function api(path, method = 'GET', body, includeOwner = true) {
    const headers = {Accept:'application/json'};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (includeOwner && owner) headers.Authorization = 'Bearer ' + owner;
    let response;
    try {
      response = await fetch(path, {method, headers, credentials:'omit', cache:'no-store',
        referrerPolicy:'no-referrer', body:body === undefined ? undefined : JSON.stringify(body)});
    } catch { throw Error('Could not reach Site Review. Check your connection and try again.'); }
    let result;
    try { result = await response.json(); } catch { throw Error('Site Review could not load this request. Please try again.'); }
    if (!response.ok) throw Error(result.error || 'This request could not be completed.');
    return result;
  }
  function website(value) {
    let text = value.trim();
    if (!/^[a-z][a-z\d+.-]*:/i.test(text)) text = 'https://' + text;
    let url;
    try { url = new URL(text); } catch { throw Error('Enter a website address, such as example.com.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw Error('Enter an http or https website address without sign-in details.');
    return url.href;
  }
  function isOwner() { return data?.review.role === 'owner'; }
  function registerForm(id, handler) {
    const form = el(id);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (form.dataset.busy) return;
      const error = form.querySelector('.form-error');
      const submit = form.querySelector('button[type=submit], button:not([type])');
      form.dataset.busy = 'yes';
      submit.disabled = true;
      form.setAttribute('aria-busy', 'true');
      error.textContent = '';
      try { await handler(form); }
      catch (failure) { error.textContent = failure.message || 'Please try again.'; }
      finally { delete form.dataset.busy; submit.disabled = false; form.removeAttribute('aria-busy'); }
    });
  }
  function setOptions(select, items, selected, label) {
    select.replaceChildren(...items.map(item => new Option(label(item), item.id)));
    if (items.some(item => item.id === selected)) select.value = selected;
  }
  function pageLabel(p) { return p.label || new URL(p.url).pathname || p.url; }
  function modal(id) {
    const wanted=el(id);
    if(wanted.open)return;
    for(const d of document.querySelectorAll('dialog[open]')) d.close();
    wanted.showModal();
  }
  function closeDialogs() {
    for(const d of document.querySelectorAll('dialog[open]')) d.close();
  }
  for(const btn of document.querySelectorAll('[data-close]')) btn.onclick=()=>btn.closest('dialog').close();
  for(const d of document.querySelectorAll('dialog.drawer')) d.addEventListener('click', e=>{
    if(e.target!==d || isSending)return;
    const r=d.getBoundingClientRect();
    if(e.clientX<r.left || e.clientX>r.right || e.clientY<r.top || e.clientY>r.bottom)d.close();
  });
  function inviteUrl() { return location.origin + data.review.reviewerPath; }
  function ownerUrl() { return location.origin + '/' + encodeURIComponent(data.review.host) + '/' + encodeURIComponent(data.review.id) + '#owner=' + encodeURIComponent(owner); }
  async function copy(value, caption) {
    try { await navigator.clipboard.writeText(value);
      const button=document.activeElement;
      if (button?.tagName==='BUTTON' && button.closest('dialog')) {
        if (!button.dataset.original)button.dataset.original=button.textContent;
        button.textContent='Copied';
        setTimeout(()=>{ if(button.textContent==='Copied')button.textContent=button.dataset.original; },1800);
      }
      announce(caption + ' copied.'); }
    catch { el('copy-title').textContent=caption; el('copy-value').value=value; modal('copy-dialog'); el('copy-value').select(); }
  }
  async function createReview(url) {
    const r = await api('/api/reviews', 'POST', {url},false);
    const destination=new URL(r.ownerPath,location.origin);
    if (destination.origin!==location.origin || !destination.hash.startsWith('#owner=')) throw Error('The new review could not be opened.');
    location.assign(destination.href);
  }
  registerForm('create',async form=>{
    const button=form.querySelector('[type=submit]'); button.textContent='Opening website…';
    try { await createReview(website(form.elements.url.value)); } finally { button.textContent='Open website →'; }
  });
  el('start-demo').onclick=async ()=>{
    const btn=el('start-demo'); btn.disabled=true; el('demo-error').textContent='';
    try { await createReview('https://www.fernandezgrowthsystems.com/'); }
    catch(error) { el('demo-error').textContent=error.message; }
    finally { btn.disabled=false; }
  };
  el('reload').onclick=()=>location.reload();
  el('notes-open').onclick=()=>{ drawNotes(); modal('notes-dialog'); refresh(true).catch(()=>{}); };
  el('options').onclick=()=>modal('menu-dialog');
  el('share').onclick=()=>{ el('reviewer-link').value=inviteUrl(); modal('share-dialog'); };
  el('copy-review').onclick=()=>copy(inviteUrl(),'Reviewer link');
  el('copy-owner').onclick=()=>copy(ownerUrl(),'Private owner link');
  el('copy-snippet').onclick=()=>copy(el('snippet').textContent,'Preview script');
  function reviewerContext() {
    const ua = navigator.userAgent;
    const browser = /Edg(?:A|iOS)?\//.test(ua) ? 'Edge' : /(?:Firefox|FxiOS)\//.test(ua) ? 'Firefox'
      : /(?:Chrome|CriOS)\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
    const iPad = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    const device = /iPad|Tablet/.test(ua) || iPad || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'Tablet'
      : /Mobi|iPhone|iPod/.test(ua) ? 'Phone' : 'Desktop';
    const os = iPad || /iP(?:hone|ad|od)/.test(ua) ? 'iOS / iPadOS' : /Android/.test(ua) ? 'Android'
      : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS'
      : /Linux/.test(ua) ? 'Linux' : 'Other';
    return {browser, device, os, viewport:{width:innerWidth,height:innerHeight},
      screen:{width:screen.width,height:screen.height}, language:navigator.language};
  }
  function draftKey() { return 'fgs-note:' + invite + ':' + (notePageId || page.id); }
  function saveDraft() {
    if(!page || !clientId)return;
    storage('set',draftKey(),JSON.stringify({clientId,text:el('feedback').value,name:el('reviewer-name').value,target, url:el('note-url').value}));
  }
  function restoreDraft() {
    notePageId=page.id;
    let draft;
    try { draft=JSON.parse(storage('get',draftKey())); } catch { /* Optional local draft. */ }
    el('feedback').value=draft?.text || '';
    el('reviewer-name').value=draft?.name || storage('get','fgs-reviewer-name',null,true) || '';
    el('note-url').value=draft?.url || '';
    clientId=draft?.clientId || crypto.randomUUID();
    target=draft?.target || null;
    if(target?.captureId && !data.captures.some(c=>c.id===target.captureId))target=null;
    el('note-form').querySelector('.form-error').textContent='';
  }
  for(const id of ['feedback','reviewer-name','note-url'])el(id).addEventListener('input',saveDraft);
  function openComposer(nextTarget) {
    if(!page || data.review.closed || isSending)return;
    setPicking(false);
    if(nextTarget!==undefined)target=nextTarget;
    else if(!target || !el('feedback').value)target={mode:'page',pageUrl:currentFrameUrl || page.url};
    notePageId=page.id;
    el('note-target').textContent=target?.mode==='screenshot' ? 'Pinned to ' + target.label : target?.mode==='live' ? 'On this page · ' + target.label : 'Page note · ' + (target?.pageUrl || currentFrameUrl || page.url);
    el('generalize-note').hidden=!target || target.mode==='page';
    el('note-location').hidden=frameReady || target?.mode==='screenshot';
    el('note-form').querySelector('.form-error').textContent='';
    saveDraft(); drawMarkers(); modal('composer'); el('feedback').focus({preventScroll:true});
  }
  let navigatedWithoutBridge=false;
  function pageNote() {
    const url=currentFrameUrl || page.url;
    openComposer({mode:'page',pageUrl:url});
    if(!frameReady && navigatedWithoutBridge) {
      el('note-target').textContent='Opened from ' + page.url;
      el('note-location').open=true;
    }
  }
  function beginFeedback(keyboard=false) {
    if(isSending || data.review.closed)return;
    if(el('feedback').value.trim()) { openComposer(); return; }
    if((view==='website'&&frameReady)||(view==='screenshot'&&capture))setPicking(true,keyboard);
    else pageNote();
  }
  el('leave-feedback').onclick=e=>beginFeedback(e.detail===0);
  for(const name of ['pointerdown','mousedown'])el('leave-feedback').addEventListener(name,e=>e.preventDefault());
  el('cancel-pick').onclick=()=>{setPicking(false); el('leave-feedback').focus();};
  el('whole-note').onclick=pageNote;
  el('composer').addEventListener('cancel',e=>{if(isSending)e.preventDefault();});
  el('composer').addEventListener('close',()=>{if(!isSending && data)saveDraft();});
  el('help-note').onclick=pageNote;
  el('generalize-note').onclick=pageNote;
  function setPicking(on,keyboard=false) {
    picking=on;
    el('pick-actions').hidden=!on; el('leave-feedback').hidden=on || !!data?.review.closed;
    el('page-help').hidden=on || view!=='website' || !frameHelpAvailable;
    el('keyboard-pin').hidden=!on || view!=='screenshot';
    el('shot-stage').classList.toggle('picking',on && view==='screenshot');
    if(frameReady)postFrame('mode',on?'pick':'browse',keyboard);
    if(on && keyboard) {
      if(view==='website')frame?.focus();
      else { el('keyboard-pin').open=true; el('pin-x').focus(); }
    }
    if(on)el('pick-label').textContent=view==='screenshot'?'Tap a spot on the screenshot.':'Tap the part you want to discuss.';
  }
  document.addEventListener('keydown',e=>{if(e.key==='Escape' && picking){setPicking(false);el('leave-feedback').focus();}});
  function pick(x,y) {
    if(!capture || data.review.closed || isSending)return;
    const clamp=n=>Math.max(0,Math.min(1,n));
    openComposer({mode:'screenshot',pageUrl:page.url,captureId:capture.id,label:capture.label,x:clamp(x),y:clamp(y)});
  }
  el('shot-stage').addEventListener('click',e=>{
    if(e.target.closest('button') || !el('capture-image').naturalWidth)return;
    const r=el('capture-image').getBoundingClientRect();
    pick((e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height);
  });
  el('set-pin').onclick=()=>{
    const x=el('pin-x'), y=el('pin-y');
    if(x.value!=='' && y.value!=='' && x.reportValidity() && y.reportValidity())pick(+x.value/100,+y.value/100);
  };
  function place(marker, x, y) {
    marker.style.left = (x*100) + '%'; marker.style.top = (y*100) + '%';
    return marker;
  }
  function drawMarkers() {
    const markers = el('markers'); markers.replaceChildren();
    if (!capture) return;
    for (const [i, note] of data.notes.entries()) {
      if (note.captureId !== capture.id || note.x == null || note.y == null) continue;
      const pin = node('button',undefined,'marker');
      pin.type = 'button'; pin.setAttribute('aria-label','Read note ' + (i + 1) + ' by ' + note.name);
      pin.append(node('span',String(i+1)));
      pin.onclick = () => {
        const item = el('note-' + note.id);
        if (item) { modal('notes-dialog'); item.focus(); item.scrollIntoView({block:'center'}); }
      };
      markers.append(place(pin,note.x,note.y));
    }
    if (target?.captureId === capture.id) {
      const marker = node('span','+','marker-pending'); marker.setAttribute('aria-hidden','true');
      markers.append(place(marker,target.x,target.y));
    }
  }
  function drawCapture(id) {
    const items=data.captures.filter(c=>c.pageId===page.id);
    capture=items.find(c=>c.id===id) || items[items.length-1] || null;
    setOptions(el('capture-select'),items,capture?.id,c=>c.label + ' · ' + c.width + ' × ' + c.height);
    el('existing-shot').hidden=!items.length;
    if(capture){
      if(el('capture-image').getAttribute('src')!==capture.imageUrl)el('capture-image').src=capture.imageUrl;
      el('capture-image').alt='Screenshot of ' + page.url + ', ' + capture.width + ' by ' + capture.height + ' pixels.';
    } else el('capture-image').removeAttribute('src');
    drawMarkers();
  }
  function drawNotes() {
    el('scope-control').hidden = data.pages.length < 2;
    const list = el('note-list'); list.replaceChildren();
    const notes = data.notes.filter(n => el('scope').value === 'all' || n.pageId === page.id);
    el('bar-count').textContent = data.notes.length;
    if (!notes.length) { list.append(node('li','No feedback yet.','helper')); return; }
    const byDate = notes.slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt));
    for (const note of byDate) {
      const item = node('li'); item.id = 'note-' + note.id; item.tabIndex = -1;
      const number = data.notes.indexOf(note) + 1;
      item.append(node('strong','#' + number + ' · ' + note.name + (note.resolved ? ' · Resolved' : '')));
      item.append(node('p', note.text));
      const shot = data.captures.find(c => c.id === note.captureId);
      const original = data.pages.find(p => p.id === note.pageId);
      const ctx = note.context || {};
      const where = shot ? shot.label + ' (' + shot.width + ' x ' + shot.height + ')'
        : ctx.elementLabel || ctx.element?.label || 'Page note';
      const info = [where, original && pageLabel(original), new Date(note.createdAt).toLocaleString()];
      item.append(node('div', info.filter(Boolean).join(' · '),'notes-meta'));
      const width = ctx.viewport?.width || ctx.viewportWidth, height = ctx.viewport?.height || ctx.viewportHeight;
      const deviceInfo = [ctx.browser, ctx.device, width && height ? width + ' x ' + height : ''].filter(Boolean);
      if (deviceInfo.length) item.append(node('div','Reviewer: ' + deviceInfo.join(' · '),'notes-meta'));
      if (ctx.liveViewport?.width && ctx.liveViewport?.height && (ctx.liveViewport.width!==width || ctx.liveViewport.height!==height))
        item.append(node('div','Live preview: ' + ctx.liveViewport.width + ' x ' + ctx.liveViewport.height,'notes-meta'));
      if (ctx.pageUrl && ctx.pageUrl !== original?.url) item.append(node('div',ctx.pageUrl,'notes-meta'));
      if (shot && (shot.id !== capture?.id || view==='website')) {
        const look = node('button','View screenshot');
        look.onclick = () => {
          switchPage(note.pageId,false); showCapture(shot.id); closeDialogs(); el('capture-select').focus();
        }; item.append(look);
      }
      if (isOwner()) {
        const btn = node('button',note.resolved ? 'Reopen note' : 'Mark resolved');
        btn.onclick = async () => {
          btn.disabled = true;
          try {
            const res = await api(apiRoot + '/notes/' + encodeURIComponent(note.id),'PATCH',{resolved:!note.resolved});
            refreshSequence++;
            const old = data.notes.findIndex(n => n.id === note.id);
            if (old !== -1) data.notes[old] = res.note;
            drawNotes(); announce(res.note.resolved ? 'Note resolved.' : 'Note reopened.');
            const restored = el('note-' + note.id); restored?.focus();
          } catch(error) { btn.disabled=false; announce(error.message); }
        }; item.append(btn);
      }
      list.append(item);
    }
  }
  el('scope').onchange = drawNotes;

  function renderView() {
    const live = view==='website', still = view==='screenshot';
    el('frame-slot').hidden=!live; el('snapshot').hidden=!still; el('fallback').hidden=live || still;
    el('page-help').hidden=picking || !live || !frameHelpAvailable;
    el('view-label').textContent=data.review.closed ? 'Closed review' : still ? 'Screenshot review' : frameReady ? 'Live website' : 'Website review';
    const address=currentFrameUrl || page.url;
    for(const id of ['open-page','help-open','fallback-open'])el(id).href=address;
    el('return-live').hidden=live || new URL(page.url).protocol!=='https:';
    el('leave-feedback').hidden=picking || data.review.closed;
  }
  function render() {
    el('mast').hidden=true; el('loading').hidden=true; el('workspace').hidden=false;
    el('host').textContent=data.review.host; document.title=data.review.host+' · Site Review';
    el('round').textContent=data.review.title; el('owner-panel').hidden=!isOwner(); el('owner-link-panel').hidden=!isOwner();
    el('add-page').hidden=data.review.closed; el('close-round').textContent=data.review.closed?'Reopen review':'Close review';
    el('page-list').hidden=data.pages.length<2;
    setOptions(el('page-select'),data.pages,page.id,pageLabel);
    el('snippet').textContent='<script defer src="https://sitereview.fernandezgrowthsystems.com/live.js"></script>';
    el('auto-controls').hidden=data.review.closed || !page.autoCaptureAvailable; el('upload').hidden=data.review.closed;
    const float=el('floating-notes');
    if(float)float.hidden=data.review.closed || !window.FGSReviewCompanion?.available();
    drawCapture(capture?.id); drawNotes(); renderView();
  }
  function openWebsite() {
    closeDialogs(); setPicking(false); frameStop();
    if(new URL(page.url).protocol!=='https:') {
      view='fallback';
      el('fallback-title').textContent='Open this website in a new tab';
      el('fallback-detail').textContent='This site uses HTTP. Open the original to browse, then return here to leave a note or review a screenshot.';
      renderView();
    } else {view='website'; renderView(); frameStart();}
  }
  function switchPage(id,open=true) {
    if(isSending) { el('page-select').value=page.id; return; }
    saveDraft(); frameStop(); setPicking(false); discardImage();
    page=data.pages.find(p=>p.id===id) || data.pages[0]; capture=null;
    restoreDraft(); render(); if(open)openWebsite();
  }
  el('page-select').onchange=()=>switchPage(el('page-select').value);
  el('return-live').onclick=openWebsite;
  el('page-help').onclick=()=>modal('help-dialog');
  el('help-screenshot').onclick=()=>openImages({automatic:true});
  el('fallback-screenshot').onclick=()=>openImages({automatic:true});
  el('open-images').onclick=()=>openImages();
  registerForm('add-page',async form=>{
    const r=await api(apiRoot+'/pages','POST',{url:website(form.elements.url.value)});
    refreshSequence++;
    if(!data.pages.some(p=>p.id===r.page.id))data.pages.push(r.page);
    switchPage(r.page.id); form.reset(); announce('Page opened.');
  });

  async function confirmChange(action, detail) {
    const dialog = el('confirm-dialog');
    if (dialog.open) return false;
    el('confirm-title').textContent = action + '?';
    el('confirm-detail').textContent = detail;
    el('confirm-action').textContent = action;
    dialog.returnValue = 'cancel';
    const result = new Promise(resolve => dialog.addEventListener('close',
      () => resolve(dialog.returnValue === 'confirm'), {once:true}));
    dialog.showModal();
    return result;
  }
  el('close-round').onclick = async () => {
    if (statusBusy || isSending) return;
    if (!data.review.closed && !await confirmChange('Close review', 'Guests can still read existing feedback. You can reopen this round anytime.')) return;
    statusBusy = true; el('close-round').disabled = true;
    try {
      const res = await api(apiRoot,'PATCH',{closed:!data.review.closed});
      refreshSequence++;
      data.review = {...data.review, ...res.review}; if(data.review.closed)setPicking(false); render();
      announce(data.review.closed ? 'Review closed.' : 'Review reopened.');
    } catch(error) { announce(error.message); }
    finally { statusBusy=false; el('close-round').disabled=false; }
  };
  el('rotate-link').onclick=async () => {
    if (statusBusy || !await confirmChange('Replace reviewer link', 'Anyone with the old link will need the new one. You can keep using your private owner link.')) return;
    statusBusy=true; el('rotate-link').disabled=true;
    try {
      const res=await api(apiRoot+'/rotate-invite','POST',{});
      data.review={...data.review,...res.review,reviewerPath:res.reviewerPath};
      await refresh(true);
      await copy(inviteUrl(),'New reviewer link');
    } catch(error) { announce(error.message); }
    finally { statusBusy=false; el('rotate-link').disabled=false; }
  };

  async function sendNote(body) {
    const result=await api(apiRoot+'/notes','POST',body);
    refreshSequence++;
    if(result.page && !data.pages.some(p=>p.id===result.page.id)) data.pages.push(result.page);
    if(!data.notes.some(n=>n.id===result.note.id))data.notes.push(result.note);
    render();
    return result.note;
  }
  function exactAddress(value) {
    const url=new URL(website(value));
    if(url.hostname!==new URL(page.url).hostname)throw Error('Use a page address from '+new URL(page.url).hostname+'.');
    url.hash=''; return url.href;
  }
  registerForm('note-form',async ()=>{
    const name=el('reviewer-name').value.trim(),text=el('feedback').value.trim();
    if(!text)throw Error('Write your feedback before sending.');
    const override=!el('note-location').hidden && el('note-url').value.trim();
    const address=override ? exactAddress(override) : target?.pageUrl || currentFrameUrl || page.url;
    const context={...reviewerContext(),pageUrl:address,mode:target?.mode || 'page'};
    if(view==='website'&&!frameReady&&!override)context.source='opening-page';
    if(target?.mode==='live')Object.assign(context,{elementLabel:target.label,selector:target.selector,scrollX:target.scrollX,scrollY:target.scrollY,liveViewport:target.viewport});
    const body={clientId,pageId:notePageId || page.id,name:name || 'Guest',text,context};
    if(target?.mode==='screenshot')Object.assign(body,{captureId:target.captureId,x:target.x,y:target.y});
    isSending=true; saveDraft(); el('feedback').readOnly=true; el('reviewer-name').readOnly=true;
    try {
      await sendNote(body);
      storage('set','fgs-reviewer-name',name,true); storage('remove',draftKey());
      el('feedback').value=''; el('note-url').value=''; target=null; clientId=crypto.randomUUID();
      closeDialogs(); drawMarkers(); announce('Feedback saved.'); el('leave-feedback').focus({preventScroll:true});
    } finally { isSending=false; el('feedback').readOnly=false; el('reviewer-name').readOnly=false; }
  });
  el('floating-notes').onclick=async ()=>{
    if(!window.FGSReviewCompanion?.available() || data.review.closed)return;
    const first=storage('get','fgs-reviewer-name',null,true) || '';
    try {
      await window.FGSReviewCompanion.open({pageId:page.id,pageUrl:currentFrameUrl || page.url,reviewerName:first,
        saveNote:async input=>{
          const addr=new URL(website(input.pageUrl));
          if(addr.hostname!==new URL(data.review.url).hostname)throw Error('Use an address on the website being reviewed.');
          await sendNote({clientId:input.clientId,pageId:input.pageId,text:input.text,name:input.name || 'Guest',context:{...reviewerContext(),mode:'page',source:'floating-notes',pageUrl:addr.href}});
          if(input.name)storage('set','fgs-reviewer-name',input.name,true);
        }});
      closeDialogs();
    } catch(error) { announce(error.message || 'The floating notes window could not open.'); }
  };


  async function refresh(silent=true) {
    const seq=++refreshSequence, response=await api(apiRoot);
    if(seq!==refreshSequence || isSending)return;
    if(decodeURIComponent(parts[0]).toLowerCase()!==response.review.host.toLowerCase())throw Error('Open the complete invitation link for this website.');
    data=response; const first=!page;
    page=data.pages.find(p=>p.id===page?.id) || data.pages[0];
    if(!page)throw Error('This review has no pages.');
    if(data.review.closed && picking)setPicking(false);
    render();
    if(first) { restoreDraft(); openWebsite(); }
    else if(!silent)announce('Notes refreshed.');
  }
  el('refresh-notes').onclick=async ()=>{
    el('refresh-notes').disabled=true;
    try{ await refresh(false); }catch(e){announce(e.message);}finally{el('refresh-notes').disabled=false;}
  };
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden && data && !isSending && !statusBusy)refresh().catch(()=>{});
  });
    let frameHelpAvailable = false;

  function postFrame(type, mode, keyboard = false) {
    if (frame?.contentWindow && frameOrigin) {
      frame.contentWindow.postMessage({channel, type, mode, keyboard}, frameOrigin);
    }
  }

  function frameStop() {
    clearTimeout(frameTimer);
    frame?.remove();
    frame = null;
    frameOrigin = null;
    frameReady = false;
    frameHelpAvailable = false;
    currentFrameUrl = null;
    navigatedWithoutBridge = false;
  }

  function frameStart() {
    frameStop();
    const websiteUrl = new URL(page.url);
    frameOrigin = websiteUrl.origin;
    const nextFrame = document.createElement('iframe');
    frame = nextFrame;
    nextFrame.title = 'Website under review: ' + websiteUrl.host;
    nextFrame.referrerPolicy = 'no-referrer';
    nextFrame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    let loads = 0;
    // An ordinary working iframe can remain silent forever. Offer help without
    // replacing the actual website or mistaking silence for an embedding block.
    function offerHelp() {
      if (frame !== nextFrame || frameReady) return;
      frameHelpAvailable = true;
      renderView();
    }
    function scheduleHelp() {
      clearTimeout(frameTimer);
      frameTimer = setTimeout(offerHelp, 3500);
    }
    nextFrame.addEventListener('load', () => {
      if (frame !== nextFrame) return;
      navigatedWithoutBridge = ++loads > 1;
      if (picking) setPicking(false);
      frameReady = false;
      frameHelpAvailable = false;
      currentFrameUrl = null;
      postFrame('connect');
      scheduleHelp();
      renderView();
    });
    nextFrame.addEventListener('error', offerHelp);
    nextFrame.src = websiteUrl.href;
    el('frame-slot').replaceChildren(nextFrame);
    scheduleHelp();
  }

  // The parent owns the feedback button and the data. Only the current
  // embedded document at the selected site's origin may report a selection.
  window.addEventListener('message', event => {
    if (!frame?.contentWindow || event.source !== frame.contentWindow ||
        event.origin !== frameOrigin || event.data?.channel !== channel) return;
    const msg = event.data;
    if (msg.type === 'ready') {
      postFrame('connect');
      return;
    }
    if (msg.type === 'cancelled' && frameReady && picking) {
      setPicking(false);
      el('leave-feedback').focus({preventScroll:true});
      return;
    }
    if (!['connected','selected'].includes(msg.type) || typeof msg.url !== 'string') return;
    let liveUrl;
    try { liveUrl = new URL(msg.url); } catch { return; }
    if (liveUrl.origin !== frameOrigin || liveUrl.username || liveUrl.password) return;
    const exactPage = liveUrl.origin + liveUrl.pathname;
    if (msg.type === 'connected') {
      clearTimeout(frameTimer);
      frameReady = true;
      frameHelpAvailable = false;
      navigatedWithoutBridge = false;
      currentFrameUrl = exactPage;
      renderView();
      return;
    }
    if (!frameReady || !picking || view !== 'website' || data.review.closed || isSending ||
        typeof msg.element?.label !== 'string' || !msg.element.label.trim()) return;
    currentFrameUrl = exactPage;
    const number = value => Number.isFinite(value) ? value : 0;
    openComposer({
      mode: 'live', pageUrl: exactPage, label: msg.element.label.trim().slice(0, 160),
      selector: typeof msg.element.selector === 'string' ? msg.element.selector.slice(0, 350) : '',
      scrollX: number(msg.scrollX), scrollY: number(msg.scrollY),
      viewport: {width: number(msg.viewport?.width), height: number(msg.viewport?.height)}
    });
  });

    function readImage(file) {
    return new Promise((resolve,reject) => {
      const reader = new FileReader();
      reader.onerror=()=>reject(Error('This image could not be read.'));
      reader.onload=()=>{
        const img=new Image();
        img.onerror=()=>reject(Error('Choose a valid PNG, JPEG, or WebP image.'));
        img.onload=()=>resolve({img,dataUrl:reader.result}); img.src=reader.result;
      }; reader.readAsDataURL(file);
    });
  }
  async function prepareImage(file) {
    if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw Error('Choose a PNG, JPEG, or WebP image.');
    if (file.size>16*1024*1024) throw Error('Choose an image smaller than 16 MB.');
    const {img}=await readImage(file);
    const w=img.naturalWidth, h=img.naturalHeight;
    if (w*h>50000000) throw Error('Use a smaller screenshot or crop it to the part you want to review.');
    const max=1250000;
    let scale=Math.min(1, 6500/Math.max(w,h),Math.sqrt(16000000/(w*h)));
    while (scale>.025) {
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(w*scale)); canvas.height=Math.max(1,Math.round(h*scale));
      const ctx=canvas.getContext('2d'); if (!ctx) throw Error('This browser could not resize the image.');
      ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(img,0,0,canvas.width,canvas.height);
      if (file.type==='image/png' && file.size<=max && canvas.width*canvas.height<=5000000) {
        const png=canvas.toDataURL('image/png');
        if (png.length*.75<max) return {width:canvas.width,height:canvas.height,dataUrl:png};
      }
      const url=canvas.toDataURL('image/jpeg',.83);
      if (url.length*0.75<max) return {width:canvas.width,height:canvas.height,dataUrl:url};
      scale*=.75;
    }
    throw Error('Use a smaller screenshot or crop it before uploading.');
  }
  function showCapture(id) {
    const item = data.captures.find(shot => shot.pageId === page.id && (!id || shot.id === id));
    if (!item) return false;
    setPicking(false);
    frameStop();
    view = 'screenshot';
    drawCapture(id || item.id);
    renderView();
    drawNotes();
    closeDialogs();
    return true;
  }
  function rememberCapture(item) {
    refreshSequence++;
    if (!data.captures.some(shot => shot.id === item.id)) data.captures.push(item);
    if (item.pageId !== page.id) return;
    if (el('image-dialog').open) {
      showCapture(item.id);
      el('leave-feedback').focus({preventScroll:true});
      announce('Screenshot ready. Choose Leave feedback to pin a note.');
    } else drawCapture(capture?.id);
  }
  function discardImage() {
    imageSequence++;
    stagedImage = null;
    stagedFilename = '';
    el('upload').reset();
    el('upload-preview').removeAttribute('src');
    el('image-confirm').hidden = true;
    el('upload').querySelector('.form-error').textContent = '';
  }
  let captureBusy = false;
  async function captureCurrent() {
    if (captureBusy || !page?.autoCaptureAvailable || data.review.closed) return;
    const pageId = page.id;
    const button = el('auto-capture');
    const resultText = el('image-error');
    captureBusy = true;
    button.disabled = true;
    button.textContent = 'Capturing…';
    resultText.textContent = 'Preparing a screenshot…';
    try {
      const result = await api(apiRoot + '/auto-captures', 'POST', {pageId,device:el('auto-device').value});
      if (page.id === pageId) resultText.textContent = '';
      rememberCapture(result.capture);
    } catch (error) {
      if (page.id === pageId) resultText.textContent = error.message || 'Upload a screenshot to continue.';
    } finally {
      captureBusy = false;
      button.disabled = false;
      button.textContent = 'Capture this page';
    }
  }
  function openImages({automatic = false} = {}) {
    if (!page) return;
    const items = data.captures.filter(shot => shot.pageId === page.id);
    const latest = items[items.length - 1];
    if (automatic && latest && showCapture(latest.id)) return;
    el('existing-shot').hidden = !latest;
    el('image-error').textContent = data.review.closed && !latest ? 'This round has no saved screenshot.' : '';
    modal('image-dialog');
    if (automatic && page.autoCaptureAvailable && !data.review.closed) {
      el('auto-device').value = window.matchMedia('(max-width:700px)').matches ? 'mobile' : 'desktop';
      captureCurrent();
    }
  }
  el('auto-capture').onclick = captureCurrent;
  el('existing-shot').onclick = () => {
    const items = data.captures.filter(shot => shot.pageId === page.id);
    if (items.length) showCapture(items[items.length-1].id);
  };
  el('capture-select').onchange = event => {
    if (isSending) { event.target.value = capture?.id || ''; return; }
    drawCapture(event.target.value);
    drawNotes();
  };
  async function previewFile(file) {
    const request = ++imageSequence;
    const warning = el('upload').querySelector('.form-error');
    stagedImage = null;
    warning.textContent = '';
    el('image-confirm').hidden = true;
    if (!file) return;
    try {
      const image = await prepareImage(file);
      if (request !== imageSequence) return;
      stagedImage = image;
      stagedFilename = file.name?.replace(/\.[^.]+$/, '').slice(0,75) || 'Screenshot';
      el('upload-preview').src = image.dataUrl;
      el('image-confirm').hidden = false;
      announce('Preview ready. Choose Share screenshot to add it.');
    } catch (error) {
      if (request === imageSequence) warning.textContent = error.message;
    }
  }
  el('upload').elements.file.onchange = event => previewFile(event.target.files[0]);
  el('image-dialog').addEventListener('paste', event => {
    if (!el('image-dialog').open || data.review.closed) return;
    const image = [...(event.clipboardData?.files || [])].find(file => file.type.startsWith('image/'));
    if (!image) return;
    event.preventDefault();
    previewFile(image);
  });
  el('discard-image').onclick = discardImage;
  import('/tab-capture.js').then(helper => {
    if (!helper.canCaptureTab()) return;
    el('tab-controls').hidden = false;
    el('capture-tab').onclick = async () => {
      const id = page.id;
      try {
        const image = await helper.captureTabImage();
        if (page.id === id && el('image-dialog').open) await previewFile(image);
      } catch (error) {
        if (page.id === id) el('upload').querySelector('.form-error').textContent = error.message;
      }
    };
  }).catch(() => { /* Image upload is available when tab capture is unsupported. */ });
  registerForm('upload', async form => {
    const image = stagedImage;
    if (!image) throw Error('Choose or paste an image and preview it first.');
    const pageId = page.id;
    const label = form.elements.label.value.trim() || stagedFilename;
    const result = await api(apiRoot + '/captures', 'POST', {pageId,label,...image});
    if (page.id === pageId && image === stagedImage) discardImage();
    rememberCapture(result.capture);
  });

  if(location.pathname==='/') {el('landing').hidden=false;el('loading').hidden=true;}
  else if(invite)refresh().catch(error=>{
    el('loading').querySelector('h1').textContent='Could not open review';
    el('loading-message').textContent=error.message;el('reload').hidden=false;el('back-home').hidden=false;
  });
  else {el('loading').querySelector('h1').textContent='Review link unavailable';el('loading-message').textContent='Open the complete review link or start a new review.';el('back-home').hidden=false;}
})();
