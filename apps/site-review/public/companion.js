(() => {
  'use strict';
  let active;
  const drafts = new Map();

  function available() {
    return window.isSecureContext && window.top === window &&
      typeof window.documentPictureInPicture?.requestWindow === 'function';
  }

  // Guest notes are attached to the review's selected page. A reviewer can
  // provide a more precise path without granting access to the website tab.
  function noteUrl(value, original) {
    if (!value.trim()) return original.href;
    let address;
    const entered = value.trim();
    try {
      address = entered.startsWith('/')
        ? new URL(entered, original.origin)
        : new URL(/^[a-z][a-z\d+.-]*:/i.test(entered) ? entered : 'https://' + entered);
    } catch {
      throw Error('Enter a page link or a path beginning with /.');
    }
    if (address.hostname !== original.hostname || !['http:', 'https:'].includes(address.protocol) ||
        address.port || address.username || address.password) {
      throw Error('Enter a page on ' + original.hostname + '.');
    }
    address.search = '';
    address.hash = '';
    return address.href;
  }

  function draw(popup, {pageUrl, pageId, reviewerName, saveNote}) {
    const doc = popup.document;
    const original = new URL(pageUrl);
    const key = pageId + '\n' + original.href;
    const draft = drafts.get(key) || {
      clientId:crypto.randomUUID(), name:reviewerName || '', text:'', url:'', sending:false
    };
    drafts.set(key, draft);
    doc.title = 'Feedback for ' + original.hostname;
    doc.documentElement.lang = document.documentElement.lang || 'en';
    function item(tag, text) {
      const element = doc.createElement(tag);
      if (text !== undefined) element.textContent = text;
      return element;
    }
    const styles = item('style', `
      :root{font:16px/1.4 system-ui,sans-serif;color:#172b20;background:#f6f8f4;color-scheme:light}
      *{box-sizing:border-box}body{margin:0}main{padding:12px 14px}h1{font-size:1.05rem;margin:0;overflow-wrap:anywhere}
      header{display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid #ccd8cf;padding-bottom:8px}
      a,summary{color:#20573b;font-weight:650}a{display:inline-flex;align-items:center;min-height:40px;white-space:nowrap}
      form{display:grid;gap:9px;margin-top:10px}label{display:grid;gap:4px;font-weight:650}
      input,textarea,button{font:inherit;border-radius:6px}input,textarea{background:white;color:#172b20;border:1px solid #789182;padding:6px 8px;width:100%}
      input{min-height:40px}textarea{resize:vertical;min-height:68px}summary{cursor:pointer;min-height:36px;padding-top:5px}
      small,.source{font-size:.79rem;line-height:1.3;color:#415a4b;font-weight:450}
      .source{margin:6px 0 0;overflow-wrap:anywhere}button{min-height:44px;cursor:pointer;background:#20573b;border:0;color:white;font-weight:700;padding:6px 14px}
      button:disabled{cursor:wait;opacity:.75}*:focus-visible{outline:3px solid #316f9c;outline-offset:2px}
      [role=status], [role=alert]{margin:0;font-size:.9rem;line-height:1.35;font-weight:600}
      [role=alert]{color:#8a2a22}[role=status]:empty,[role=alert]:empty{display:none}
    `);
    doc.head.append(styles);
    const main = item('main');
    const header = item('header');
    const openSite = item('a', 'Open website ↗');
    openSite.href = original.href;
    openSite.target = '_blank';
    openSite.rel = 'noopener noreferrer';
    openSite.setAttribute('aria-label', 'Open ' + original.hostname + ' in a new tab');
    header.append(item('h1', 'Website feedback'), openSite);
    const source = item('p', 'Page: ' + original.hostname + original.pathname);
    source.className = 'source';
    const form = item('form');
    const labelName = item('label','Your name (optional)');
    const name = item('input');
    name.autocomplete = 'given-name';
    name.maxLength = 60;
    name.value = draft.name;
    labelName.append(name);
    const labelNote = item('label', 'Feedback');
    const note = item('textarea');
    note.rows = 3;
    note.maxLength = 2000;
    note.required = true;
    note.value = draft.text;
    labelNote.append(note);
    const details = item('details');
    const labelUrl = item('label','Page link or path');
    const url = item('input');
    url.placeholder = '/about';
    url.autocomplete = 'off';
    url.maxLength = 2048;
    url.value = draft.url;
    labelUrl.append(url,item('small', 'Only the page path is used when you paste a link.'));
    details.append(item('summary','Comment on a different page'),labelUrl);
    details.open = Boolean(draft.url);
    const save = item('button','Save note');
    save.type = 'submit';
    const status = item('p');
    status.setAttribute('role','status');
    const error = item('p');
    error.setAttribute('role','alert');
    form.append(labelName,labelNote,details,save,status,error);
    main.append(header,source,form);
    doc.body.replaceChildren(main);

    function remember() {
      draft.name = name.value; draft.text = note.value; draft.url = url.value;
      error.textContent = ''; status.textContent = '';
    }
    form.addEventListener('input', remember);
    function busy(sending) {
      draft.sending = sending;
      save.disabled = sending;
      save.textContent = sending ? 'Saving…' : 'Save note';
      name.readOnly = note.readOnly = url.readOnly = sending;
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (draft.sending) return;
      remember();
      if (!draft.text.trim()) {
        error.textContent = 'Enter your feedback.';
        note.focus();
        return;
      }
      let pageAddress;
      try { pageAddress = noteUrl(draft.url,original); }
      catch (issue) {
        error.textContent = issue.message; details.open = true; url.focus(); return;
      }
      busy(true);
      try {
        await saveNote({clientId:draft.clientId,pageId,name:draft.name.trim() || 'Guest',text:draft.text.trim(),pageUrl:pageAddress});
        draft.clientId = crypto.randomUUID();
        draft.text = ''; note.value = '';
        status.textContent = 'Note saved to this review.';
      } catch (issue) {
        error.textContent = issue.message || 'Could not save. Try again.';
      } finally {
        busy(false);
        if (!popup.closed) note.focus();
      }
    });
    note.focus();
  }

  async function open(options) {
    const {pageId, pageUrl, saveNote} = options;
    if (!available()) throw Error('Floating notes are unavailable in this browser.');
    const original = new URL(pageUrl);
    if (!pageId || typeof saveNote !== 'function' || !['https:', 'http:'].includes(original.protocol) ||
        original.username || original.password) throw Error('Open a review page first.');
    const key = pageId + '\n' + original.href;
    if (active?.key === key && !active.popup.closed) { active.popup.focus(); return; }
    if (drafts.get(key)?.sending) throw Error('The previous note is being saved. Try again in a moment.');
    if (active && !active.popup.closed) active.popup.close();
    let popup;
    try {
      // Stay in the click's transient activation. Open website is its own
      // separate, explicit anchor so normal popup blocking does not interfere.
      popup = await window.documentPictureInPicture.requestWindow({width:370,height:410});
    } catch {
      throw Error('The floating window could not open. You can still use the review tab to leave a note.');
    }
    draw(popup,options);
    active = {key,popup};
    popup.addEventListener('pagehide', () => {
      if (active?.popup === popup) active = undefined;
    }, {once:true});
  }
  window.FGSReviewCompanion = Object.freeze({available,open});
})();
