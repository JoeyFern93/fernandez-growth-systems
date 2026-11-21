(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const parts = location.pathname.split('/').filter(Boolean);
  const invite = parts.length === 2 ? parts[1] : '';
  const linkOptions = new URLSearchParams(location.hash.slice(1));
  const owner = linkOptions.get('owner');
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
  function inviteUrl() {
    const link = new URL(data.review.reviewerPath, location.origin);
    link.hash = view === 'screenshot' && capture ? 'shot=' + encodeURIComponent(capture.id) : '';
    return link.href;
  }
  function ownerUrl() { return location.origin + '/' + encodeURIComponent(data.review.host) + '/' + encodeURIComponent(data.review.id) + '#owner=' + encodeURIComponent(owner); }
  const savedReviewPrefix = 'fgs-owned-review:';
  function validSavedReview(entry) {
    return entry && typeof entry.host === 'string' && /^[a-z0-9.-]+$/i.test(entry.host)
      && /^[A-Za-z0-9_-]{24}$/.test(entry.id) && /^[A-Za-z0-9_-]{43}$/.test(entry.owner)
      && Number.isFinite(entry.opened);
  }
  function rememberOwnerReview(review, ownerToken) {
    if (review?.role !== 'owner') return;
    const entry = {host:review.host, id:review.id, owner:ownerToken, opened:Date.now()};
    if (validSavedReview(entry)) storage('set',savedReviewPrefix + entry.id,JSON.stringify(entry),true);
  }
  function drawSavedReviews() {
    const hint = el('saved-review-hint');
    const list = el('saved-review-list');
    list.replaceChildren();
    const entries = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(savedReviewPrefix)) continue;
        let entry;
        try { entry = JSON.parse(localStorage.getItem(key)); } catch { continue; }
        if (validSavedReview(entry) && key === savedReviewPrefix + entry.id) entries.push(entry);
      }
    } catch {
      hint.textContent = 'To return to your notes, bookmark your private owner link. This browser could not load a saved review list.';
      return;
    }
    hint.textContent = entries.length
      ? 'Saved in this browser. Open notes to read feedback, or share a reviewer link with your client.'
      : 'Reviews you manage in this browser appear here. To bring back an earlier review, open its private owner link.';
    entries.sort((a,b) => b.opened - a.opened);
    for (const entry of entries) {
      const row = node('li');
      const details = node('div');
      const opened = new Date(entry.opened).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
      details.append(node('strong',entry.host),node('small','Opened ' + opened));
      const actions = node('div',undefined,'saved-review-actions');
      const notes = node('button','Open notes');
      const share = node('button','Share');
      const privatePath = '/' + encodeURIComponent(entry.host) + '/' + encodeURIComponent(entry.id) + '#owner=' + encodeURIComponent(entry.owner);
      notes.onclick = () => location.assign(privatePath + '&panel=notes');
      share.onclick = () => location.assign(privatePath + '&panel=share');
      actions.append(notes,share);
      row.append(details,actions);
      list.append(row);
    }
  }
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
  let createRequest, pendingCreation, browserCreatorId;
  async function openReview(url) {
    const key = 'fgs-create-pending';
    if (!pendingCreation) {
      try { pendingCreation = JSON.parse(storage('get', key)); } catch { /* Optional retry state. */ }
    }
    if (!pendingCreation || pendingCreation.url !== url || !/^[0-9a-f]{64}$/.test(pendingCreation.creationKey)) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      pendingCreation = {url, creationKey: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')};
      storage('set', key, JSON.stringify(pendingCreation));
    }
    if (!browserCreatorId) {
      browserCreatorId = storage('get','fgs-creator-id',null,true) || crypto.randomUUID();
      storage('set','fgs-creator-id',browserCreatorId,true);
    }
    const r = await api('/api/reviews', 'POST', {...pendingCreation, creatorId:browserCreatorId},false);
    const destination=new URL(r.ownerPath,location.origin);
    if (destination.origin!==location.origin || !destination.hash.startsWith('#owner=')) throw Error('The new review could not be opened.');
    rememberOwnerReview(r.review,new URLSearchParams(destination.hash.slice(1)).get('owner'));
    pendingCreation = null;
    storage('remove', key);
    location.assign(destination.href);
  }
  function createReview(url) {
    const clean = new URL(url);
    clean.hash = '';
    if (!createRequest) createRequest = openReview(clean.href).finally(() => { createRequest = null; });
    return createRequest;
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
  function openShare() {
    el('reviewer-link').value=inviteUrl();
    el('share-detail').textContent=view==='screenshot' && capture
      ? 'This link opens the screenshot you are viewing. Anyone with the link can leave feedback.'
      : 'Anyone with this link can open the website and leave feedback.';
    modal('share-dialog');
  }
  el('share').onclick = openShare;
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
    if (target?.annotation) {
      el('note-target').textContent = (target.mode === 'draw' ? 'Drawing on ' : 'Point on ') + target.label;
    }
    el('note-location').hidden=frameReady || !!target?.annotation || target?.mode==='screenshot';
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
  let activeMethod=null, pendingShotMethod=null, visualEditor, liveGeometry, supportsLayout=false, layoutTimer;
  function markEditor() {
    if (!visualEditor) visualEditor=window.FGSVisualMarks.editor({point:pick,finish:finishDrawing,announce,
      changed:count=>{el('undo-draw').disabled=el('finish-draw').disabled=!count;}});
    return visualEditor;
  }
  function explainMethods(elementRequested=false) {
    const screenshot=view==='screenshot' && capture;
    const original=currentFrameUrl || page.url;
    const panel=el('method-status');
    panel.hidden=!elementRequested && (screenshot || frameReady);
    el('method-original').href=original;
    el('method-shot').textContent=screenshot ? 'Pin a point on this screenshot' : 'Choose a screenshot';
    el('method-live').hidden=!elementRequested || !screenshot || new URL(page.url).protocol!=='https:';
    el('method-detail').textContent=elementRequested ? (screenshot
      ? 'A screenshot is an image. Select an element on the live site, or pin the spot here.'
      : 'For exact elements, open the original site and use the FGS Chrome extension. On a phone, pin the spot on a screenshot.')
      : 'If the preview is blank, open the original site. Use the Chrome extension there or mark a screenshot in this review.';
  }
  function beginFeedback() {
    if(isSending || data.review.closed)return;
    el('method-draft').hidden=!el('feedback').value.trim();
    explainMethods(); modal('feedback-tools');
  }
  el('leave-feedback').onclick=beginFeedback;
  el('feedback-page').onclick=pageNote;
  el('method-draft').onclick=()=>openComposer();
  el('method-live').onclick=()=>{closeDialogs();openWebsite(false);};
  function requestScreenshot(method) {
    openImages({method});
  }
  el('method-shot').onclick=()=>view==='screenshot' && capture ? beginVisual('point',false) : requestScreenshot('point');
  el('feedback-element').onclick=event=>{
    if(view!=='website' || !frameReady) {
      explainMethods(true); el('method-original').focus(); return;
    }
    closeDialogs(); activeMethod='element'; setPicking(true,event.detail===0);
  };
  for(const method of ['point','draw']) el('feedback-'+method).onclick=event=>{
    if(view==='screenshot' && capture || view==='website' && frameReady && supportsLayout) beginVisual(method,event.detail===0);
    else requestScreenshot(method);
  };
  function beginVisual(method,keyboard) {
    if(data.review.closed || isSending)return;
    closeDialogs(); activeMethod=method; setPicking(true,keyboard);
    if(view==='screenshot' && capture){
      markEditor().begin(el('shot-stage'),method,{width:capture.width,height:capture.height},keyboard);
      return;
    }
    liveGeometry=null;
    if(frameReady && supportsLayout) {
      frame.contentWindow.postMessage({channel,type:'request-layout',keyboard},frameOrigin);
      layoutTimer=setTimeout(()=>{
        if(picking && !liveGeometry){setPicking(false);requestScreenshot(method);}
      },1500);
    }
  }
  function visualTarget(annotation) {
    const shot=view==='screenshot' && capture;
    if(!shot && !liveGeometry)return;
    openComposer({mode:annotation.kind,annotation,pageUrl:shot ? page.url : liveGeometry.url,
      label:shot ? capture.label : 'the live page',...(shot ? {captureId:capture.id} :
        {scrollX:liveGeometry.scrollX,scrollY:liveGeometry.scrollY,viewport:{width:annotation.width,height:annotation.height}})});
  }
  function finishDrawing() {
    if(!picking || activeMethod!=='draw' || !visualEditor?.ready())return;
    const annotation=visualEditor.geometry();
    if(annotation.strokes.length)visualTarget(annotation);
  }
  el('undo-draw').onclick=()=>visualEditor?.undo();
  el('finish-draw').onclick=finishDrawing;
  el('draw-pan').onclick=()=>{
    const button=el('draw-pan'), scrolling=button.getAttribute('aria-pressed')!=='true';
    button.setAttribute('aria-pressed',String(scrolling));button.textContent=scrolling?'Resume drawing':'Scroll';
    el('shot-stage').classList.toggle('scroll-drawing',scrolling);
    el('pick-label').textContent=scrolling?'Scroll to the next area.':'Draw, then choose Add note.';
  };
  for(const name of ['pointerdown','mousedown'])el('leave-feedback').addEventListener(name,e=>e.preventDefault());
  el('cancel-pick').onclick=()=>{setPicking(false); el('leave-feedback').focus();};
  el('whole-note').onclick=pageNote;
  el('composer').addEventListener('cancel',e=>{if(isSending)e.preventDefault();});
  el('composer').addEventListener('close',()=>{if(!isSending && data)saveDraft();});
  el('help-note').onclick=pageNote;
  el('generalize-note').onclick=pageNote;
  function setPicking(on,keyboard=false) {
    picking=on;
    if(!on){clearTimeout(layoutTimer);visualEditor?.remove();activeMethod=null;liveGeometry=null;}
    const drawing=on && activeMethod==='draw', point=on && activeMethod==='point';
    el('draw-pan').hidden=!drawing || view!=='screenshot';
    el('draw-pan').setAttribute('aria-pressed','false');el('draw-pan').textContent='Scroll';
    el('shot-stage').classList.remove('scroll-drawing');
    el('undo-draw').hidden=el('finish-draw').hidden=!drawing;
    if(drawing)el('undo-draw').disabled=el('finish-draw').disabled=true;
    el('pick-actions').hidden=!on; el('leave-feedback').hidden=on || !!data?.review.closed;
    el('page-help').hidden=on || view!=='website' || !frameHelpAvailable;
    el('keyboard-pin').hidden=!point;
    el('keyboard-pin').open=false;
    el('shot-stage').classList.toggle('picking',on && view==='screenshot');
    if(frameReady)postFrame('mode',on && activeMethod==='element' ? 'pick':'browse',keyboard);
    if(on && keyboard && activeMethod==='element')frame?.focus();
    if(on)el('pick-label').textContent=drawing ? 'Draw, then choose Add note.' : point ? 'Tap the spot you mean.' : 'Tap the element you mean.';
  }
  document.addEventListener('keydown',e=>{if(e.key==='Escape' && picking){setPicking(false);el('leave-feedback').focus();}});
  function pick(x,y) {
    if(!picking || activeMethod!=='point' || data.review.closed || isSending)return;
    const clamp=n=>Math.max(0,Math.min(1,n));
    const size=view==='screenshot' ? capture : liveGeometry;
    if(size)visualTarget({kind:'point',width:size.width,height:size.height,point:[clamp(x),clamp(y)]});
  }
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
      if (note.captureId !== capture.id) continue;
      const mark = note.context?.annotation;
      if (mark?.kind === 'draw') markers.append(window.FGSVisualMarks.geometryLayer(mark));
      const anchor = mark?.kind === 'draw' ? mark.strokes?.[0]?.[0] : mark?.point || [note.x,note.y];
      if (!anchor || !anchor.every(Number.isFinite)) continue;
      const pin = node('button',undefined,'marker');
      pin.type = 'button'; pin.dataset.noteId = note.id; pin.setAttribute('aria-label','Read note ' + (i + 1) + ' by ' + note.name);
      pin.append(node('span',String(i+1)));
      pin.onclick = () => {
        const item = el('note-' + note.id);
        if (item) { modal('notes-dialog'); item.focus(); item.scrollIntoView({block:'center'}); }
      };
      markers.append(place(pin,...anchor));
    }
    if (target?.captureId === capture.id) {
      if(target.annotation?.kind==='draw'){markers.append(window.FGSVisualMarks.geometryLayer(target.annotation));return;}
      const marker = node('span','+','marker-pending'); marker.setAttribute('aria-hidden','true');
      markers.append(place(marker,...(target.annotation?.point || [target.x,target.y])));
    }
  }
  function drawCapture(id) {
    const items=data.captures.filter(c=>c.pageId===page.id);
    capture=items.find(c=>c.id===id) || items[items.length-1] || null;
    setOptions(el('capture-select'),items,capture?.id,c=>c.label + ' · ' + c.width + ' × ' + c.height);
    if(!el('image-dialog').open)el('existing-shot').hidden=!items.length;
    const stage=el('shot-stage'), image=el('capture-image');
    if(capture && stage.dataset.shot!==capture.id){
      const tiles=capture.tiles?.length ? capture.tiles : [capture];
      stage.dataset.shot=capture.id;
      stage.style.width='min(100%, '+capture.width+'px)';
      el('capture-tiles').replaceChildren();
      tiles.forEach((tile,index)=>{
        const img=index===0 ? image : document.createElement('img');
        img.width=tile.width; img.height=tile.height;
        img.alt=index===0 ? 'Screenshot of '+page.url : '';
        img.src=tile.imageUrl;
        if(index>0)el('capture-tiles').append(img);
      });
      el('snapshot').scrollTop=0;
    }else if(!capture){
      delete stage.dataset.shot;
      image.removeAttribute('src');el('capture-tiles').replaceChildren();
    }
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
      const preview = window.fgsAnnotationPreview?.(note, shot);
      if (preview) item.append(preview);
      const where = shot ? shot.label + ' (' + shot.width + ' x ' + shot.height + ')'
        : ctx.elementLabel || ctx.element?.label || (ctx.annotation?.kind === 'point' ? 'Point' : ctx.annotation?.kind === 'draw' ? 'Drawing' : 'Page note');
      const info = [where, original && pageLabel(original), new Date(note.createdAt).toLocaleString()];
      item.append(node('div', info.filter(Boolean).join(' · '),'notes-meta'));
      const width = ctx.viewport?.width || ctx.viewportWidth, height = ctx.viewport?.height || ctx.viewportHeight;
      const deviceInfo = [ctx.browser, ctx.device, width && height ? width + ' x ' + height : ''].filter(Boolean);
      if (deviceInfo.length) item.append(node('div','Reviewer: ' + deviceInfo.join(' · '),'notes-meta'));
      if (ctx.liveViewport?.width && ctx.liveViewport?.height && (ctx.liveViewport.width!==width || ctx.liveViewport.height!==height))
        item.append(node('div','Live preview: ' + ctx.liveViewport.width + ' x ' + ctx.liveViewport.height,'notes-meta'));
      if (ctx.pageUrl && ctx.pageUrl !== original?.url) item.append(node('div',ctx.pageUrl,'notes-meta'));
      if (shot) {
        const look = node('button',preview ? 'Show mark on screenshot' : 'View screenshot');
        look.onclick = () => {
          if (page.id !== note.pageId) switchPage(note.pageId,false);
          showCapture(shot.id);
          const marker = [...el('markers').querySelectorAll('button')].find(pin => pin.dataset.noteId===note.id);
          if (marker) {
            marker.focus({preventScroll:true});
            marker.scrollIntoView({block:'center',inline:'nearest'});
          } else el('capture-select').focus();
        };
        item.append(look);
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
    const live = view==='website', checking=view==='connecting', still = view==='screenshot';
    el('frame-slot').hidden=!(live || checking); el('frame-slot').classList.toggle('preview-pending',checking);
    el('snapshot').hidden=!still; el('fallback').hidden=live || still;
    el('page-help').hidden=picking || !live || !frameHelpAvailable;
    el('view-label').textContent=data.review.closed ? 'Closed review' : still ? 'Screenshot review' : frameReady ? 'Live website' : 'Website review';
    const address=currentFrameUrl || page.url;
    for(const id of ['open-page','help-open','fallback-open','canvas-original','image-original'])el(id).href=address;
    const canEmbed=new URL(page.url).protocol==='https:' && !page.frameBlocked && page.frameMode!=='blocked' && !deniedPages.has(page.id);
    el('return-live').hidden=live || !canEmbed;
    el('shot-live').hidden=!still || !canEmbed;
    el('fallback-live').hidden=checking || !canEmbed;
    el('fallback-screenshot').hidden=data.review.closed && !data.captures.some(shot=>shot.pageId===page.id);
    el('leave-feedback').hidden=picking || data.review.closed;
  }
  function render() {
    el('mast').hidden=true; el('loading').hidden=true; el('workspace').hidden=false;
    el('host').textContent=data.review.host; document.title=data.review.host+' · Site Review';
    el('round').textContent=data.review.title; el('owner-panel').hidden=!isOwner(); el('owner-link-panel').hidden=!isOwner();
    el('add-page').hidden=data.review.closed; el('close-round').textContent=data.review.closed?'Reopen review':'Close review';
    el('page-list').hidden=data.pages.length<2;
    setOptions(el('page-select'),data.pages,page.id,pageLabel);
    setOptions(el('shot-page-select'),data.pages,page.id,p=>new URL(p.url).pathname || '/');
    el('shot-add-page').hidden=data.review.closed;
    el('snippet').textContent='<script defer src="https://sitereview.fernandezgrowthsystems.com/live.js"></script>';
    el('auto-controls').hidden=data.review.closed; el('upload').hidden=data.review.closed;
    el('extension-capture-options').hidden=data.review.closed;
    const float=el('floating-notes');
    if(float)float.hidden=data.review.closed || !window.FGSReviewCompanion?.available();
    drawCapture(capture?.id); drawNotes(); renderView();
  }
  const policyChecks=new Map(), deniedPages=new Set(), autoAttempts=new Set();
  function completeShot(pageId=page.id) {
    return data.captures.filter(c=>c.pageId===pageId && (c.fullPage===true || c.tiles?.length || /^full page\b/i.test(c.label || ''))).at(-1);
  }
  function blockedPreview() {
    frameStop(); view='fallback';
    deniedPages.add(page.id);
    el('fallback-title').textContent='Review this page as a screenshot';
    el('fallback-detail').textContent='This website opens in its own tab. A full-page screenshot lets you scroll, pin a point, or draw here.';
    renderView();
    if(picking || isSending || document.querySelector('dialog[open]'))return;
    const shot=completeShot();
    if(shot){showCapture(shot.id);return;}
    if(!data.review.closed && !autoAttempts.has(page.id)){
      autoAttempts.add(page.id);
      openImages({automatic:true});
    }
  }
  function openWebsite(preferSaved=true) {
    closeDialogs(); setPicking(false); frameStop(); pendingShotMethod=null;
    const saved=preferSaved && completeShot();
    if(saved && showCapture(saved.id))return;
    if(new URL(page.url).protocol!=='https:') {
      view='fallback';
      el('fallback-title').textContent='Open this website in a new tab';
      el('fallback-detail').textContent='This site uses HTTP. Open the original to browse, then return here to leave a note or review a screenshot.';
      renderView();
    } else if(page.frameBlocked || page.frameMode==='blocked' || deniedPages.has(page.id))blockedPreview();
    else {
      view=preferSaved?'connecting':'website';
      if(preferSaved){
        el('fallback-title').textContent='Opening the live preview…';
        el('fallback-detail').textContent='You can also open the original website in a new tab.';
      }
      renderView(); frameStart(!preferSaved);
    }
  }
  function switchPage(id,open=true) {
    if(isSending) { el('page-select').value=page.id; return; }
    saveDraft(); frameStop(); setPicking(false); discardImage(); pendingShotMethod=null;
    page=data.pages.find(p=>p.id===id) || data.pages[0]; capture=null;
    restoreDraft(); render(); if(open)openWebsite();
  }
  el('page-select').onchange=()=>switchPage(el('page-select').value);
  el('return-live').onclick=()=>openWebsite(false);
  el('fallback-live').onclick=el('shot-live').onclick=()=>openWebsite(false);
  el('page-help-button').onclick=()=>modal('help-dialog');
  el('canvas-full').onclick=()=>openImages();
  el('shot-add-page').onclick=()=>{openImages();el('full-page-url').focus();el('full-page-url').select();};
  el('shot-page-select').onchange=()=>{
    if(isSending){el('shot-page-select').value=page.id;return;}
    switchPage(el('shot-page-select').value,false);
    if(capture)showCapture((completeShot() || capture).id);
    else {openWebsite();openImages();}
  };
  el('help-screenshot').onclick=()=>openImages();
  el('fallback-screenshot').onclick=()=>openImages();
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
    if(target?.annotation){
      context.annotation=target.annotation;
      if(target.captureId)body.captureId=target.captureId;
      if(target.annotation.kind==='point')[body.x,body.y]=target.annotation.point;
      if(target.viewport)Object.assign(context,{liveViewport:target.viewport,scrollX:target.scrollX,scrollY:target.scrollY});
    }
    isSending=true; saveDraft(); el('feedback').readOnly=true; el('reviewer-name').readOnly=true;
    try {
      await sendNote(body);
      storage('set','fgs-reviewer-name',name,true); storage('remove',draftKey());
      el('feedback').value=''; el('note-url').value=''; target=null; clientId=crypto.randomUUID();
      closeDialogs(); drawMarkers(); announce('Feedback saved. Open Notes at the top to see it.'); el('leave-feedback').focus({preventScroll:true});
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
    const sharedShot = first ? data.captures.find(item=>item.id===linkOptions.get('shot')) : null;
    page=data.pages.find(p=>p.id===(sharedShot?.pageId || page?.id)) || data.pages[0];
    if(!page)throw Error('This review has no pages.');
    if(data.review.closed && picking)setPicking(false);
    render();
    if(!first && el('image-dialog').open) {
      availableImage();
      if(extensionHandoff?.session===imageSession) {
        const targetPage=data.pages.find(p=>p.url===extensionHandoff.address);
        const received=targetPage && data.captures.findLast(shot=>shot.pageId===targetPage.id && !extensionHandoff.known.has(shot.id));
        if(received && !el('image-original').hidden && el('image-original').href===extensionHandoff.address) {
          extensionHandoff=null;
          openAvailableImage(received);
        }
      }
    }
    if(first) {
      rememberOwnerReview(data.review,owner);
      restoreDraft();
      if (!sharedShot || !showCapture(sharedShot.id)) openWebsite();
      if (linkOptions.get('panel') === 'notes') modal('notes-dialog');
      if (linkOptions.get('panel') === 'share') openShare();
    }
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
    frameTimer=null;
    clearTimeout(layoutTimer);
    frame?.remove();
    frame = null;
    frameOrigin = null;
    frameReady = false;
    supportsLayout = false;
    frameHelpAvailable = false;
    currentFrameUrl = null;
    navigatedWithoutBridge = false;
  }

  function frameStart(keepLiveVisible) {
    frameStop();
    const websiteUrl = new URL(page.url);
    frameOrigin = websiteUrl.origin;
    const nextFrame = document.createElement('iframe');
    frame = nextFrame;
    nextFrame.title = 'Website under review: ' + websiteUrl.host;
    nextFrame.referrerPolicy = 'no-referrer';
    nextFrame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    let loads = 0;
    const initialPageId=page.id;
    if(!policyChecks.has(initialPageId)){
      policyChecks.set(initialPageId,api(apiRoot+'/pages/'+encodeURIComponent(initialPageId)+'/frame-policy')
        .then(policy=>policy.blocked===true).catch(()=>false));
    }
    policyChecks.get(initialPageId).then(blocked=>{
      if(!blocked)return;
      deniedPages.add(initialPageId);
      if(page.id!==initialPageId)return;
      if(frame===nextFrame && !frameReady && (view==='connecting' || view==='website'))blockedPreview();
      else if(view==='fallback' || view==='screenshot')renderView();
    });
    // A cross-origin iframe's load event can also mean the browser displayed
    // its refusal page. Use the bridge handshake as the positive live signal.
    function offerHelp() {
      if (frame !== nextFrame || frameReady) return;
      clearTimeout(frameTimer); frameTimer=null;
      if(keepLiveVisible){
        frameHelpAvailable=true;
      }else{
        frameStop(); view='fallback';
        el('fallback-title').textContent='Choose how to review this page';
        el('fallback-detail').textContent='Open the original website to browse, or use a screenshot to pin a point or draw on this page.';
      }
      renderView();
    }
    function scheduleHelp() {
      if(!frameTimer)frameTimer = setTimeout(offerHelp, 3500);
    }
    nextFrame.addEventListener('load', () => {
      if (frame !== nextFrame) return;
      navigatedWithoutBridge = ++loads > 1;
      if (picking) setPicking(false);
      frameReady = false;
      supportsLayout = false;
      frameHelpAvailable = false;
      currentFrameUrl = null;
      if(!keepLiveVisible)view='connecting';
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
    if (!['connected','selected','visual-layout'].includes(msg.type) || typeof msg.url !== 'string') return;
    let liveUrl;
    try { liveUrl = new URL(msg.url); } catch { return; }
    if (liveUrl.origin !== frameOrigin || liveUrl.username || liveUrl.password) return;
    const exactPage = liveUrl.origin + liveUrl.pathname;
    if (msg.type === 'connected') {
      clearTimeout(frameTimer);
      frameTimer=null;
      if(picking && currentFrameUrl && currentFrameUrl!==exactPage)setPicking(false);
      frameReady = true;
      view='website';
      supportsLayout = msg.visualLayout===true;
      frameHelpAvailable = false;
      navigatedWithoutBridge = false;
      currentFrameUrl = exactPage;
      renderView();
      return;
    }
    if (!frameReady || !picking || view !== 'website' || data.review.closed || isSending)return;
    if(msg.type==='visual-layout'){
      if(!supportsLayout || liveGeometry || !['point','draw'].includes(activeMethod))return;
      const w=msg.viewport?.width,h=msg.viewport?.height;
      if(![w,h].every(n=>Number.isInteger(n) && n>0 && n<=32768))return;
      clearTimeout(layoutTimer);
      liveGeometry={width:w,height:h,url:exactPage,scrollX:Number(msg.scrollX)||0,scrollY:Number(msg.scrollY)||0};
      markEditor().begin(el('frame-slot'),activeMethod,{width:w,height:h},msg.keyboard===true);
      return;
    }
    if (activeMethod!=='element' || typeof msg.element?.label !== 'string' || !msg.element.label.trim()) return;
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
    // Keep lettering readable down the page. Re-encode locally so image metadata
    // stays out of the shared capture. Smaller canvases cover low-memory browsers.
    const max=10*1024*1024;
    let scale=Math.min(1, 16384/Math.max(w,h));
    while (scale>.025) {
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(w*scale)); canvas.height=Math.max(1,Math.round(h*scale));
      const ctx=canvas.getContext('2d'); if (!ctx) throw Error('This browser could not resize the image.');
      ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(img,0,0,canvas.width,canvas.height);
      if (file.type==='image/png' && file.size<=1250000 && canvas.width*canvas.height<=5000000) {
        const png=canvas.toDataURL('image/png');
        if (png.startsWith('data:image/png;') && png.length*.75<1250000) return {width:canvas.width,height:canvas.height,dataUrl:png};
      }
      const url=canvas.toDataURL('image/jpeg',.83);
      if (url.startsWith('data:image/jpeg;') && url.length*0.75<max) return {width:canvas.width,height:canvas.height,dataUrl:url};
      scale*=.75;
    }
    throw Error('Use a smaller screenshot or crop it before uploading.');
  }
  function showCapture(id) {
    const item = data.captures.find(shot => shot.pageId === page.id && (!id || shot.id === id));
    if (!item) return false;
    const method=pendingShotMethod; pendingShotMethod=null;
    setPicking(false);
    frameStop();
    view = 'screenshot';
    drawCapture(id || item.id);
    renderView();
    drawNotes();
    closeDialogs();
    if(method && !data.review.closed)beginVisual(method,false);
    return true;
  }
  function rememberCapture(item,show=true) {
    refreshSequence++;
    if (!data.captures.some(shot => shot.id === item.id)) data.captures.push(item);
    if (item.pageId !== page.id) return;
    if (show && el('image-dialog').open) {
      showCapture(item.id);
      if(!picking){el('leave-feedback').focus({preventScroll:true});announce('Screenshot ready. Scroll to a spot, then choose Leave feedback.');}
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
  let captureBusy = false, imageSession=0;
  async function captureCurrent() {
    if (captureBusy || !page || data.review.closed) return;
    const pageId = page.id;
    const session=imageSession;
    const button = el('auto-capture');
    const resultText = el('image-error');
    captureBusy = true;
    button.disabled = true;
    button.textContent = 'Capturing full page…';
    resultText.textContent = 'Preparing a scrollable screenshot.';
    try {
      const address=exactAddress(el('full-page-url').value || page.url);
      const result = await api(apiRoot + '/auto-captures', 'POST', {pageId,device:el('auto-device').value,fullPage:true,...(address!==page.url ? {url:address}:{})});
      if (page.id === pageId && imageSession===session) resultText.textContent = '';
      receiveCapture(result,pageId,session);
    } catch (error) {
      if (page.id === pageId && session===imageSession) resultText.textContent = error.message || 'The capture could not finish.';
    } finally {
      captureBusy = false;
      button.disabled = false;
      button.textContent = 'Capture full page';
    }
  }
  function openImages({automatic = false, method=null} = {}) {
    if (!page) return;
    imageSession++;
    pendingShotMethod=method;
    el('full-page-url').value=currentFrameUrl || page.url;
    const latest=availableImage();
    if (latest && ((automatic || method) && completeShot(latest.pageId) || data.review.closed) && openAvailableImage(latest))return;
    el('image-intent').textContent=method==='point' ? 'Capture the full page, then tap the spot you want to discuss.'
      : method==='draw' ? 'Capture the full page, scroll to the area, then draw your feedback.' : 'Capture the full page to scroll and mark it together.';
    el('auto-device').value=window.matchMedia('(max-width:700px)').matches ? 'mobile' : 'desktop';
    el('existing-shot').hidden = !latest;
    el('image-error').textContent = data.review.closed && !latest ? 'This round has no saved screenshot.' : '';
    modal('image-dialog');
    if (automatic && !data.review.closed) {
      captureCurrent();
    }
  }
  el('auto-capture').onclick = captureCurrent;
  let extensionHandoff=null;
  el('extension-capture').onclick = async () => {
    const button=el('extension-capture'), hint=el('extension-capture-hint'), install=el('extension-capture-install');
    const runtime=window.chrome?.runtime;
    const setupHint='Install or update FGS Site Review, reload this review, then try again.';
    button.disabled=true; install.hidden=true;
    try {
      const url=exactAddress(el('full-page-url').value || currentFrameUrl || page.url);
      if (!runtime?.sendMessage) throw Error(setupHint);
      extensionHandoff={session:imageSession,address:url,known:new Set(data.captures.map(shot=>shot.id))};
      const response=await new Promise(resolve => runtime.sendMessage('knbdankbggjcdbdjcdgacibgbjiaffhg',
        {type:'open-capture-page',url}, result => resolve(runtime.lastError ? null : result)));
      if (!response) throw Error(setupHint);
      if (!response.ok) throw Error(response.error || 'Reopen this review and try again.');
      hint.textContent='On the original website, open the FGS extension, choose Capture a screenshot, then Share & copy link. The screenshot will appear in this review.';
    } catch (error) {
      extensionHandoff=null;
      hint.textContent=error.message || 'The extension could not open this page.';
      install.hidden=hint.textContent!==setupHint;
    } finally { button.disabled=false; }
  };
  el('image-dialog').addEventListener('close',()=>{
    if(!el('image-dialog').open){pendingShotMethod=null;extensionHandoff=null;imageSession++;}
  });
  function availableImage() {
    let address;
    try {address=exactAddress(el('full-page-url').value);} catch { /* The address can be incomplete while typing. */ }
    const original=el('image-original');
    original.hidden=!address;
    if(address)original.href=address;else original.removeAttribute('href');
    const record=address && data.pages.find(p=>p.url===address);
    const latest=record && (completeShot(record.id) || data.captures.filter(shot=>shot.pageId===record.id).at(-1));
    el('existing-shot').hidden=!latest;
    return latest;
  }
  function openAvailableImage(shot) {
    if(!shot)return false;
    if(shot.pageId!==page.id){
      const method=pendingShotMethod;
      switchPage(shot.pageId,false);
      pendingShotMethod=method;
    }
    return showCapture(shot.id);
  }
  function receiveCapture(result,startingPage,session) {
    const show=page.id===startingPage && session===imageSession && el('image-dialog').open;
    if(result.page && !data.pages.some(p=>p.id===result.page.id))data.pages.push(result.page);
    if(show && result.page && result.page.id!==startingPage){
      const method=pendingShotMethod;
      switchPage(result.page.id,false);
      pendingShotMethod=method;
    }
    rememberCapture(result.capture,show);
  }
  el('full-page-url').addEventListener('input',availableImage);
  el('existing-shot').onclick=()=>openAvailableImage(availableImage());
  el('capture-select').onchange = event => {
    if (isSending) { event.target.value = capture?.id || ''; return; }
    setPicking(false);drawCapture(event.target.value);
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
    const pageId = page.id, session=imageSession;
    const name=form.elements.label.value.trim() || stagedFilename;
    const label=form.elements.fullPage.checked && !/^full page\b/i.test(name) ? ('Full page · '+name).slice(0,80) : name;
    const url=exactAddress(el('full-page-url').value || page.url);
    const result = await api(apiRoot + '/captures', 'POST', {pageId,label,...image,...(url!==page.url ? {url}:{})});
    if (page.id === pageId && image === stagedImage) discardImage();
    receiveCapture(result,pageId,session);
  });

  if(location.pathname==='/') {
    el('landing').hidden=false; el('loading').hidden=true;
    drawSavedReviews();
    window.addEventListener('pageshow', event => { if (event.persisted) drawSavedReviews(); });
    window.addEventListener('storage', event => {
      if (!event.key || event.key.startsWith(savedReviewPrefix)) drawSavedReviews();
    });
  }
  else if(invite)refresh().catch(error=>{
    el('loading').querySelector('h1').textContent='Could not open review';
    el('loading-message').textContent=error.message;el('reload').hidden=false;el('back-home').hidden=false;
  });
  else {el('loading').querySelector('h1').textContent='Review link unavailable';el('loading-message').textContent='Open the complete review link or start a new review.';el('back-home').hidden=false;}
})();
