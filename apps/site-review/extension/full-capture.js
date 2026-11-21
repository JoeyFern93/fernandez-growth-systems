/* global chrome, OffscreenCanvas, createImageBitmap */
'use strict';

// Chrome serializes this function into the extension's isolated world in the
// clicked tab. The current document owns its restore timer, even if the
// extension worker is suspended or the popup closes during capture.
async function scrollForScreenshot(action, token, left = 0, top = 0) {
  const key = Symbol.for('fgs.full.screenshot');
  const doc = document.scrollingElement || document.documentElement;
  const metrics = () => ({x: window.scrollX, y: window.scrollY, width: doc.scrollWidth,
    height: doc.scrollHeight, viewWidth: doc.clientWidth, viewHeight: doc.clientHeight,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight});
  let state = globalThis[key];
  if (action === 'restore') {
    if (state?.token === token) state.restore();
    return;
  }
  if (action === 'begin') {
    if (state) throw Error('A full-page capture is already running on this page.');
    if (window.visualViewport && window.visualViewport.scale !== 1) throw Error('Reset page zoom, then try a full-page capture.');
    const original = metrics();
    const styles = [];
    const fixed = [];
    const saveStyle = (element, name, value) => {
      styles.push([element, name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]);
      element.style.setProperty(name, value, 'important');
    };
    const restore = () => {
      clearTimeout(state.timer);
      for (const [element,name,old,priority] of styles.reverse()) {
        if (old) element.style.setProperty(name, old, priority);
        else element.style.removeProperty(name);
      }
      window.scrollTo({left: original.x, top: original.y, behavior:'instant'});
      delete globalThis[key];
    };
    state = {token, location: location.href, fixed, saveStyle, restore, timer: null, hiddenFixed:false};
    globalThis[key] = state;
    state.timer = setTimeout(restore, 12000);
    try {
      saveStyle(doc, 'scroll-snap-type', 'none');
      saveStyle(doc, 'overflow-anchor', 'none');
      let nested = false;
      for (const element of document.querySelectorAll('body *')) {
        const style = getComputedStyle(element);
        if (style.position === 'sticky') {
          saveStyle(element, 'position', 'relative');
          for (const edge of ['top','right','bottom','left']) saveStyle(element, edge, 'auto');
        } else if (style.position === 'fixed') fixed.push(element);
        if (original.height <= original.viewHeight + 1 && /auto|scroll/.test(style.overflowY) &&
            element.clientWidth >= original.viewWidth * 0.7 && element.clientHeight >= original.viewHeight * 0.5 &&
            element.scrollHeight - element.clientHeight > original.viewHeight / 2) nested = true;
      }
      if (nested) throw Error('This page scrolls inside a separate panel. Choose Visible area to capture that view.');
      return metrics();
    } catch (error) { restore(); throw error; }
  }
  if (state?.token !== token || state.location !== location.href) throw Error('The page changed. Capture the full page again.');
  clearTimeout(state.timer);
  state.timer = setTimeout(state.restore, 12000);
  if (action === 'inspect') return metrics();
  if (!state.hiddenFixed && (left || top)) {
    for (const element of state.fixed) state.saveStyle(element, 'visibility', 'hidden');
    state.hiddenFixed = true;
  }
  window.scrollTo({left, top, behavior:'instant'});
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return metrics();
}

async function fullScreenshot(tab, takePixels) {
  const token = crypto.randomUUID();
  async function step(action, x, y) {
    const [response] = await chrome.scripting.executeScript({target:{tabId:tab.id},func:scrollForScreenshot,args:[action,token,x || 0,y || 0]});
    if (!response || (action !== 'restore' && !response.result)) {
      throw Error(response?.error?.message || 'Chrome could not measure this page. Try capturing the visible area.');
    }
    return response.result;
  }
  function validate(size) {
    const {width,height,viewWidth,viewHeight} = size;
    if (!(width > 0 && height > 0 && viewWidth > 0 && viewHeight > 0)) throw Error('This page has no visible capture area.');
    if (width > 10000 || height > 100000 || width * height > 200000000 || Math.ceil(width/viewWidth)*Math.ceil(height/viewHeight)>150) {
      throw Error('This page is too large for one full-page screenshot. Choose Visible area to capture a section.');
    }
  }
  const shots = [];
  let size;
  try {
    size = await step('begin');
    validate(size);
    for (let top=0; top < size.height; top += size.viewHeight) {
      for (let left=0; left < size.width; left += size.viewWidth) {
        const pos = await step('move',left,top);
        validate(pos);
        if (pos.viewWidth !== size.viewWidth || pos.viewHeight !== size.viewHeight || pos.width !== size.width ||
            pos.height < size.height || pos.x > left+1 || pos.y > top+1) {
          throw Error('The page layout changed during capture. Let it finish loading, then try again.');
        }
        size = pos;
        const image = await takePixels(tab);
        const after = await step('inspect');
        if (after.x !== pos.x || after.y !== pos.y || after.viewWidth !== pos.viewWidth || after.viewHeight !== pos.viewHeight) {
          throw Error('The page moved during capture. Try again and leave this tab open.');
        }
        shots.push({image, left, top, pos});
        if (after.height > size.height) { validate(after); size = after; }
        if (shots.length > 150) throw Error('The page keeps growing. Choose Visible area to capture a section.');
      }
    }
  } finally { await step('restore').catch(() => {}); }
  const scale = Math.min(1, 2048 / size.width);
  const width = Math.max(1,Math.round(size.width * scale)), height = Math.max(1,Math.round(size.height * scale));
  // Keep each canvas below native texture limits. Source screenshots have
  // the browser's device scale, while the saved image uses normal CSS pixels.
  const single = height <= 8192 && width * height <= 14000000;
  const band = single ? height : Math.max(1,Math.min(6000, Math.floor(8000000/width)));
  const n = Math.ceil(height / band);
  if (n > 24) throw Error('This page is too large for one full-page screenshot. Choose Visible area to capture a section.');
  const tiles = [];
  let total = 0;
  for (let i=0; i<n; i++) {
    const offset = i*band, tileHeight = Math.min(band,height-offset);
    const canvas = new OffscreenCanvas(width,tileHeight);
    const ctx = canvas.getContext('2d',{alpha:false});
    for (const {image,left,top,pos} of shots) {
      const right = Math.min(size.width, left + size.viewWidth), bottom = Math.min(size.height, top + size.viewHeight);
      const y = Math.round(top*scale), yEnd = Math.round(bottom*scale);
      if (yEnd <= offset || y >= offset + tileHeight) continue;
      const bmp = await createImageBitmap(await (await fetch(image)).blob());
      try {
        const sx = bmp.width/pos.innerWidth, sy = bmp.height/pos.innerHeight;
        const x = Math.round(left*scale), xEnd = Math.round(right*scale);
        ctx.drawImage(bmp, (left-pos.x)*sx, (top-pos.y)*sy, (right-left)*sx, (bottom-top)*sy, x, y-offset, xEnd-x, yEnd-y);
      } finally { bmp.close(); }
    }
    const budget = Math.min(single ? 10*1024*1024 : 1310720, Math.floor((10*1024*1024-total)/(n-i)));
    let blob;
    for (const quality of [.88,.77,.65,.54,.4,.28]) {
      blob = await canvas.convertToBlob({type:'image/jpeg',quality});
      if (blob.size <= budget) break;
    }
    if (blob.size > budget) throw Error('This full page exceeds the review image limit. Choose Visible area to capture a section.');
    total += blob.size;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const parts = [];
    for (let j=0; j<bytes.length; j+=8192) parts.push(String.fromCharCode(...bytes.subarray(j,j+8192)));
    tiles.push({width,height:tileHeight,dataUrl:'data:image/jpeg;base64,' + btoa(parts.join(''))});
    canvas.width = canvas.height = 1;
  }
  return single ? {width,height,dataUrl:tiles[0].dataUrl} : {width,height,tiles};
}
