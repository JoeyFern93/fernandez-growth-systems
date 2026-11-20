(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const parts = location.pathname.split('/').filter(Boolean);
  const invite = parts.length === 2 ? parts[1] : '';
  const owner = new URLSearchParams(location.hash.slice(1)).get('owner');
  const root = '/api/reviews';
  const apiRoot = root + '/' + encodeURIComponent(invite);
  const channel = 'fgs-site-review-v1';
  let data, page, capture, target, frame, frameOrigin, frameReady, currentFrameUrl, frameTimer, toastTimer;
  let clientId, isSending = false, statusBusy = false, refreshSequence = 0;
  let stagedImage, stagedFilename, imageSequence=0;

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
  function inviteUrl() {
    return location.origin + data.review.reviewerPath + (frameReady && !el('live-view').hidden ? '#live' : '');
  }
  function ownerUrl() { return location.origin + '/' + encodeURIComponent(data.review.host) + '/' + encodeURIComponent(data.review.id) + '#owner=' + encodeURIComponent(owner); }
  async function copy(value, caption) {
    try { await navigator.clipboard.writeText(value); announce(caption + ' copied.'); }
    catch {
      el('copy-title').textContent = caption; el('copy-value').value = value;
      el('copy-dialog').showModal(); el('copy-value').select();
    }
  }
  async function createReview(url,title,sample) {
    const result = await api(root, 'POST', {url,title}, false);
    const destination = new URL(result.ownerPath, location.origin);
    if (destination.origin !== location.origin || !destination.hash.startsWith('#owner='))
      throw Error('The owner link could not be opened. Please try again.');
    storage('set', sample ? 'fgs-sample' : 'fgs-first-owner', destination.pathname);
    location.assign(destination.href);
  }
  registerForm('create', async form => {
    await createReview(website(form.elements.url.value),form.elements.title.value.trim(),false);
  });
  el('start-demo').onclick=async () => {
    const btn=el('start-demo'); btn.disabled=true; btn.textContent='Opening sample…';
    el('demo-error').textContent='';
    try { await createReview(new URL('/demo/fgs/',location.origin).href,'FGS mobile preview',true); }
    catch(error) { el('demo-error').textContent=error.message; }
    finally { btn.disabled=false; btn.textContent='Try a sample review'; }
  };
  el('share').onclick = () => copy(inviteUrl(), 'Reviewer link');
  el('copy-owner').onclick = () => copy(ownerUrl(), 'Private owner link');
  el('copy-snippet').onclick = () => copy(el('snippet').textContent, 'Preview script');
  el('reload').onclick = () => location.reload();

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
  function draftKey() { return 'fgs-note:' + invite + ':' + page.id; }
  function saveDraft() {
    if (!page || !clientId) return;
    const draft = {text:el('feedback').value, name:el('reviewer-name').value, target, clientId};
    storage('set', draftKey(), JSON.stringify(draft));
  }
  function restoreDraft() {
    let draft;
    try { draft = JSON.parse(storage('get', draftKey())); } catch { /* Invalid local draft. */ }
    el('feedback').value = draft?.text || '';
    el('reviewer-name').value = draft?.name || storage('get','fgs-reviewer-name',null,true) || '';
    clientId = draft?.clientId || crypto.randomUUID();
    target = draft?.target || null;
    if (target?.mode === 'screenshot' && target.captureId !== capture?.id) {
      const original = data.captures.find(c => c.id === target.captureId && c.pageId === page.id);
      if (original) drawCapture(original.id);
      else target=null;
    }
    if (target?.mode === 'live') target = null;
    el('note-form').querySelector('.form-error').textContent = '';
  }
  el('feedback').addEventListener('input', saveDraft);
  el('reviewer-name').addEventListener('input', saveDraft);
  function drawTarget() {
    let text = 'Page note';
    if (target?.mode === 'screenshot') text = 'Screenshot pin · ' + target.label;
    if (target?.mode === 'live') text = 'Live element · ' + target.label;
    el('note-target').textContent = text;
    el('clear-target').hidden = !target;
    drawMarkers();
  }
  function setTarget(value, moveFocus = false) {
    if (isSending) return;
    target = value;
    drawTarget(); saveDraft();
    if (moveFocus) el(el('reviewer-name').value ? 'feedback' : 'reviewer-name').focus();
  }
  el('clear-target').onclick = () => setTarget(null);
  function pick(x, y) {
    if (!capture || data.review.closed || isSending) return;
    const clamp = n => Math.max(0, Math.min(1, n));
    setTarget({mode:'screenshot',captureId:capture.id,label:capture.label,x:clamp(x),y:clamp(y)}, true);
  }
  el('shot-stage').addEventListener('click', event => {
    if (event.target.closest('button') || !el('capture-image').naturalWidth) return;
    const bounds = el('capture-image').getBoundingClientRect();
    pick((event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
  });
  el('set-pin').onclick = () => {
    const x = el('pin-x'), y = el('pin-y');
    if (x.value !== '' && y.value !== '' && x.reportValidity() && y.reportValidity())
      pick(Number(x.value)/100, Number(y.value)/100);
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
        if (item) { item.focus(); item.scrollIntoView({block:'center'}); }
      };
      markers.append(place(pin,note.x,note.y));
    }
    if (target?.captureId === capture.id) {
      const marker = node('span','+','marker-pending'); marker.setAttribute('aria-hidden','true');
      markers.append(place(marker,target.x,target.y));
    }
  }
  function drawCapture(desiredId) {
    const items = data.captures.filter(c => c.pageId === page.id);
    capture = items.find(c => c.id === desiredId) || items[items.length-1] || null;
    el('has-capture').hidden = !capture;
    el('empty-capture').hidden = !!capture;
    el('keyboard-pin').hidden = data.review.closed;
    el('pin-help').hidden = data.review.closed;
    if (capture) {
      setOptions(el('capture-select'),items,capture.id,c => c.label + ' · ' + c.width + ' × ' + c.height);
      if (el('capture-image').getAttribute('src') !== capture.imageUrl) el('capture-image').src = capture.imageUrl;
      el('capture-image').alt = capture.label + ' screenshot of ' + page.url + ', ' + capture.width + ' by ' + capture.height + ' pixels.';
    } else el('capture-image').removeAttribute('src');
    drawMarkers();
  }
  function drawNotes() {
    el('scope-control').hidden = data.pages.length < 2;
    const list = el('note-list'); list.replaceChildren();
    const notes = data.notes.filter(n => el('scope').value === 'all' || n.pageId === page.id);
    el('note-count').textContent = '(' + notes.length + ')';
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
      const where = shot ? shot.label + ' (' + shot.width + ' × ' + shot.height + ')'
        : ctx.elementLabel || ctx.element?.label || 'Page note';
      const info = [where, original && pageLabel(original), new Date(note.createdAt).toLocaleString()];
      item.append(node('div', info.filter(Boolean).join(' · '),'notes-meta'));
      const width = ctx.viewport?.width || ctx.viewportWidth, height = ctx.viewport?.height || ctx.viewportHeight;
      const deviceInfo = [ctx.browser, ctx.device, width && height ? width + ' × ' + height : ''].filter(Boolean);
      if (deviceInfo.length) item.append(node('div','Reviewer: ' + deviceInfo.join(' · '),'notes-meta'));
      if (ctx.liveViewport?.width && ctx.liveViewport?.height && (ctx.liveViewport.width!==width || ctx.liveViewport.height!==height))
        item.append(node('div','Live preview: ' + ctx.liveViewport.width + ' × ' + ctx.liveViewport.height,'notes-meta'));
      if (ctx.pageUrl && ctx.pageUrl !== original?.url) item.append(node('div',ctx.pageUrl,'notes-meta'));
      if (shot && (shot.id !== capture?.id || !el('live-view').hidden)) {
        const look = node('button','View screenshot');
        look.onclick = () => {
          switchPage(note.pageId); showMode(false); drawCapture(shot.id); el('capture-select').focus();
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
  function render() {
    const r=data.review;
    el('workspace').hidden = false; el('loading').hidden = true;
    document.title = r.host + ' · Site Review';
    el('host').textContent = r.host; el('round').textContent = r.title;
    el('owner-panel').hidden = !isOwner(); el('capture-tools').hidden = r.closed;
    el('auto-controls').hidden = !isOwner() || r.closed || !page.autoCaptureAvailable;
    el('closed-message').hidden = !r.closed; el('closed-badge').hidden = !r.closed;
    el('note-form').hidden = r.closed; el('add-page').hidden = r.closed;
    el('close-round').textContent = r.closed ? 'Reopen review' : 'Close review';
    el('snippet').textContent = '<script defer src="' + location.origin + '/live.js"></script>';
    el('page-url').textContent = currentFrameUrl || page.url; el('open-page').href = currentFrameUrl || page.url;
    setOptions(el('page-select'),data.pages,page.id,pageLabel);
    drawCapture(capture?.id); drawTarget(); drawNotes();
    if (frameReady) el('live-controls').hidden = r.closed;
  }
  function switchPage(id) {
    if (isSending) { el('page-select').value = page.id; return; }
    saveDraft(); frameStop(); showMode(false); discardImage();
    page = data.pages.find(p => p.id === id) || data.pages[0];
    target = null; capture = null;
    render(); restoreDraft(); drawTarget(); drawNotes();
  }
  el('page-select').onchange = () => switchPage(el('page-select').value);
  el('capture-select').onchange = () => {
    if (isSending) { el('capture-select').value=capture.id; return; }
    setTarget(null); drawCapture(el('capture-select').value); drawNotes();
  };
  registerForm('add-page', async form => {
    const result = await api(apiRoot + '/pages','POST',{url:website(form.elements.url.value)});
    refreshSequence++;
    if (!data.pages.some(p => p.id === result.page.id)) data.pages.push(result.page);
    switchPage(result.page.id); form.reset(); announce('Page added.'); el('page-select').focus();
  });
  el('close-round').onclick = async () => {
    if (statusBusy || isSending) return;
    if (!data.review.closed && !window.confirm('Close this review? Guests will be able to read existing feedback. You can reopen it anytime.')) return;
    statusBusy = true; el('close-round').disabled = true;
    try {
      const res = await api(apiRoot,'PATCH',{closed:!data.review.closed});
      refreshSequence++;
      data.review = {...data.review, ...res.review}; render();
      announce(data.review.closed ? 'Review closed.' : 'Review reopened.');
    } catch(error) { announce(error.message); }
    finally { statusBusy=false; el('close-round').disabled=false; }
  };
  el('rotate-link').onclick=async () => {
    if (statusBusy || !window.confirm('Replace the reviewer link? The old reviewer link will stop opening this review. Your private owner link will still work.')) return;
    statusBusy=true; el('rotate-link').disabled=true;
    try {
      const res=await api(apiRoot+'/rotate-invite','POST',{});
      data.review={...data.review,...res.review,reviewerPath:res.reviewerPath};
      await refresh(true);
      await copy(inviteUrl(),'New reviewer link');
    } catch(error) { announce(error.message); }
    finally { statusBusy=false; el('rotate-link').disabled=false; }
  };
  registerForm('note-form', async () => {
    const name = el('reviewer-name').value.trim(), text = el('feedback').value.trim();
    if (!name || !text) throw Error('Enter your first name and feedback.');
    isSending = true; saveDraft();
    const context = {...reviewerContext(),mode:target?.mode || 'page',pageUrl:target?.pageUrl || currentFrameUrl || page.url};
    if (target?.mode === 'live') {
      context.elementLabel=target.label; context.selector=target.selector; context.liveViewport=target.viewport;
      context.scrollX=target.scrollX; context.scrollY=target.scrollY;
    }
    const body = {clientId,pageId:page.id,name,text,context};
    if (target?.mode === 'screenshot') Object.assign(body,{captureId:target.captureId,x:target.x,y:target.y});
    el('feedback').readOnly=true; el('reviewer-name').readOnly=true;
    try {
      const result = await api(apiRoot + '/notes','POST',body);
      refreshSequence++;
      if (!data.notes.some(n => n.id === result.note.id)) data.notes.push(result.note);
      storage('set','fgs-reviewer-name',name,true); storage('remove',draftKey());
      el('feedback').value=''; target=null; clientId=crypto.randomUUID();
      drawTarget(); drawNotes(); announce('Note saved to this review.'); el('feedback').focus();
    } finally { isSending=false; el('feedback').readOnly=false; el('reviewer-name').readOnly=false; }
  });
  async function refresh(silent) {
    const sequence = ++refreshSequence;
    const result = await api(apiRoot);
    if (sequence !== refreshSequence || isSending) return;
    if (decodeURIComponent(parts[0]).toLowerCase() !== result.review.host.toLowerCase())
      throw Error('This invite link does not match the website being reviewed. Open the original link.');
    data = result;
    const first = !page;
    page = data.pages.find(p => p.id === page?.id) || data.pages[0];
    if (!page) throw Error('No pages are available in this review.');
    render();
    if (first) {
      restoreDraft(); drawTarget();
      if (isOwner() && storage('get','fgs-first-owner')===location.pathname) {
        el('owner-tools').open = true; storage('remove','fgs-first-owner');
        announce('Review created. Save your private owner link, then share the reviewer link.');
      }
      const demo = new URL(page.url);
      if (location.hash==='#live' || (demo.origin===location.origin && demo.pathname.startsWith('/demo/')) || storage('get','fgs-sample')===location.pathname) {
        storage('remove','fgs-sample'); showMode(true);
      }
    } else if (!silent) announce('Feedback refreshed.');
  }
  el('refresh-notes').onclick = async () => {
    el('refresh-notes').disabled=true;
    try { await refresh(false); } catch(error) { announce(error.message); }
    finally { el('refresh-notes').disabled=false; }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState==='visible' && data && !isSending && !statusBusy) {
      refresh(true).catch(() => { /* Manual refresh displays any connection error. */ });
    }
  });

  function frameStop() {
    clearTimeout(frameTimer); frameReady=false; frameOrigin=null; currentFrameUrl=null; frame=null;
    if (page) { el('page-url').textContent=page.url; el('open-page').href=page.url; }
    el('frame-slot').replaceChildren(); el('live-controls').hidden=true;
    el('pick-element').hidden=false; el('browse-frame').hidden=true;
  }
  function postFrame(type, mode) {
    if (frame?.contentWindow && frameOrigin) frame.contentWindow.postMessage({channel,type,mode},frameOrigin);
  }
  function frameStart() {
    frameStop(); frameOrigin = new URL(page.url).origin;
    el('live-status').textContent = 'Connecting to the review script on this page…';
    frame = document.createElement('iframe');
    frame.title = 'Live preview of ' + data.review.host;
    frame.referrerPolicy='no-referrer'; frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms');
    frame.hidden=true;
    function startTimer() {
      clearTimeout(frameTimer);
      frameTimer = setTimeout(() => {
        if (frameReady) return;
        frameStop();
        el('live-status').textContent='Live commenting is unavailable on this page. Open the live page in a new tab, then leave a page note here or choose Screenshot.';
      }, 9000);
    }
    frame.addEventListener('load', () => {
      if (!frame) return;
      frameReady=false; frame.hidden=true; el('live-controls').hidden=true;
      el('pick-element').hidden=false; el('browse-frame').hidden=true;
      if (target?.mode === 'live') setTarget(null);
      el('live-status').textContent='Connecting to the review script on this page…';
      postFrame('connect'); startTimer();
    });
    frame.src=page.url; el('frame-slot').append(frame); startTimer();
  }
  function showMode(live) {
    if (isSending) return;
    if (target && (live !== (target.mode === 'live'))) setTarget(null);
    el('live-view').hidden=!live; el('captures-view').hidden=live;
    el('see-live').setAttribute('aria-pressed',String(live)); el('see-captures').setAttribute('aria-pressed',String(!live));
    if (live) frameStart(); else frameStop();
    if (data && page) drawNotes();
  }
  el('see-live').onclick=() => { if (el('live-view').hidden || !frame) showMode(true); };
  el('see-captures').onclick=() => showMode(false);
  function liveMode(pickMode) {
    postFrame('mode',pickMode ? 'pick' : 'browse');
    el('pick-element').hidden=pickMode; el('browse-frame').hidden=!pickMode;
    el('live-status').textContent=pickMode ? 'Tap an element in the preview to add feedback. Press Escape to cancel.' : 'Browse the preview, then select an element to comment on it.';
    if (pickMode) frame?.focus();
  }
  el('pick-element').onclick=()=>liveMode(true); el('browse-frame').onclick=()=>liveMode(false);
  el('pick-element').addEventListener('pointerdown', event => { event.preventDefault(); });
  window.addEventListener('message',event => {
    if (!frame || event.source!==frame.contentWindow || event.origin!==frameOrigin) return;
    const msg=event.data;
    if (!msg || msg.channel!==channel) return;
    if (msg.type==='ready') { postFrame('connect'); return; }
    if (msg.type==='cancelled') { liveMode(false); return; }
    if (msg.type==='connected') {
      clearTimeout(frameTimer); frameReady=true; frame.hidden=false;
      try {
        const current=new URL(msg.url);
        if (current.origin===frameOrigin) {
          current.hash=''; currentFrameUrl=current.href;
          el('page-url').textContent=currentFrameUrl; el('open-page').href=currentFrameUrl;
        }
      } catch { /* The requested page URL remains available. */ }
      el('live-controls').hidden=data.review.closed; liveMode(false); return;
    }
    if (msg.type!=='selected' || !frameReady || data.review.closed || isSending) return;
    let url;
    try { url=new URL(msg.url); } catch { return; }
    if (url.origin!==frameOrigin || typeof msg.element?.label!=='string') return;
    url.hash=''; liveMode(false);
    setTarget({mode:'live',pageUrl:url.href,label:msg.element.label.slice(0,160),selector:String(msg.element.selector||'').slice(0,250),
      scrollX:Number(msg.scrollX)||0,scrollY:Number(msg.scrollY)||0,
      viewport:{width:Number(msg.viewport?.width)||0,height:Number(msg.viewport?.height)||0}},true);
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
  function gotCapture(value) {
    refreshSequence++;
    if (!data.captures.some(c=>c.id===value.id)) data.captures.push(value);
    if (value.pageId===page.id) {
      setTarget(null); drawCapture(value.id); drawNotes(); el('capture-tools').open=false;
    }
    announce('Screenshot saved. Select a spot to leave feedback.');
  }
  function discardImage() {
    imageSequence++; stagedImage=null; stagedFilename='';
    el('upload').reset(); el('upload-preview').removeAttribute('src'); el('image-confirm').hidden=true;
    el('upload').querySelector('.form-error').textContent='';
  }
  async function previewFile(file) {
    const requestId=++imageSequence;
    stagedImage=null; el('image-confirm').hidden=true; el('upload').querySelector('.form-error').textContent='';
    if (!file) return;
    try {
      const image=await prepareImage(file);
      if (imageSequence!==requestId) return;
      stagedImage=image; stagedFilename=file.name.replace(/\.[^.]+$/,'').slice(0,75) || 'Screenshot';
      el('upload-preview').src=image.dataUrl; el('image-confirm').hidden=false;
      announce('Screenshot ready to preview.');
    } catch(error) {
      if (imageSequence===requestId) el('upload').querySelector('.form-error').textContent=error.message;
    }
  }
  el('upload').elements.file.onchange=event=>previewFile(event.target.files[0]);
  el('discard-image').onclick=discardImage;
  import('/tab-capture.js').then(module => {
    if (!module.canCaptureTab()) return;
    el('tab-controls').hidden=false;
    el('capture-tab').onclick=async () => {
      const originalPage=page.id;
      try {
        const file=await module.captureTabImage();
        if (page.id===originalPage) await previewFile(file);
      } catch(error) { el('upload').querySelector('.form-error').textContent=error.message; }
    };
  }).catch(() => { /* File upload remains available everywhere. */ });
  registerForm('upload',async form => {
    if (!stagedImage) throw Error('Choose a screenshot and preview it first.');
    const pageId=page.id, label=form.elements.label.value.trim() || stagedFilename;
    const image=stagedImage;
    const res=await api(apiRoot+'/captures','POST',{pageId,label,...image});
    gotCapture(res.capture);
    if (page.id===pageId && image===stagedImage) discardImage();
  });
  el('auto-capture').onclick=async () => {
    const btn=el('auto-capture'); btn.disabled=true; btn.textContent='Capturing…';
    try {
      const res=await api(apiRoot+'/auto-captures','POST',{pageId:page.id,device:el('auto-device').value});
      gotCapture(res.capture);
    } catch(error) { announce(error.message); }
    finally { btn.disabled=false; btn.textContent='Capture this page'; }
  };
  if (location.pathname==='/') {
    el('landing').hidden=false; el('loading').hidden=true;
  } else if (invite) {
    refresh(true).catch(error=>{
      el('loading').querySelector('h1').textContent='Could not open review';
      el('loading-message').textContent=error.message; el('reload').hidden=false; el('back-home').hidden=false;
    });
  } else {
    el('loading').querySelector('h1').textContent='Review link unavailable';
    el('loading-message').textContent='Open the full invite link or create a new review.';
    el('back-home').hidden=false;
  }
})();
