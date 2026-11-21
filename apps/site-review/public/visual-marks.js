(() => {
  'use strict';
  const ns = 'http://www.w3.org/2000/svg';
  const svg = name => document.createElementNS(ns, name);
  const unit = value => Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
  function geometryLayer(annotation) {
    const result = svg('svg'), {width, height} = annotation;
    result.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    result.setAttribute('preserveAspectRatio', 'none');
    result.setAttribute('aria-hidden','true');
    result.classList.add('draw-lines');
    result.dataset.annotationKind = annotation.kind;
    for (const stroke of annotation.strokes || []) {
      if (!stroke.length) continue;
      if(stroke.length===1){
        const dot=svg('circle');
        dot.setAttribute('cx',stroke[0][0]*width);dot.setAttribute('cy',stroke[0][1]*height);
        dot.setAttribute('r','.1');dot.setAttribute('vector-effect','non-scaling-stroke');
        result.append(dot);continue;
      }
      const path = svg('polyline');
      const points = stroke.map(([x, y]) => (x * width) + ',' + (y * height));
      path.setAttribute('points', points.join(' '));
      path.setAttribute('vector-effect','non-scaling-stroke');
      result.append(path);
    }
    return result;
  }
  function sample(points, max) {
    if (points.length <= max) return points;
    return Array.from({length:max}, (_, i) => points[Math.round(i * (points.length - 1) / (max - 1))]);
  }
  function editor({point, changed, announce, finish}) {
    const surface = document.createElement('div');
    surface.id = 'mark-surface';
    surface.tabIndex = 0;
    const crosshair = document.createElement('span');
    crosshair.className = 'mark-cursor';
    crosshair.setAttribute('aria-hidden','true');
    let strokes = [], current, kind, size, pointerId, cursor, keyPen;
    function geometry() {
      const limit = Math.min(256, Math.floor(640 / Math.max(1, strokes.length)));
      return {kind:'draw', ...size, strokes:strokes.map(stroke => sample(stroke,limit))};
    }
    function render() {
      surface.replaceChildren(geometryLayer(geometry()));
      if (cursor) {
        crosshair.style.left = (cursor[0] * 100) + '%';
        crosshair.style.top = (cursor[1] * 100) + '%';
        surface.append(crosshair);
      }
      changed(strokes.length);
    }
    function startStroke(pos) {
      if (strokes.length >= 24) { announce('Drawing is full. Use Undo or add your note.'); return false; }
      current = [pos];
      strokes.push(current);
      return true;
    }
    function extend(pos) {
      const last = current[current.length - 1];
      if (last[0] === pos[0] && last[1] === pos[1]) return;
      current.push(pos);
      if (current.length > 512) current.splice(0,current.length,...sample(current,256));
    }
    function position(event) {
      const box = surface.getBoundingClientRect();
      return [unit((event.clientX - box.left) / box.width), unit((event.clientY - box.top) / box.height)];
    }
    function visibleCenter() {
      const box=surface.getBoundingClientRect(), port=surface.closest('#snapshot')?.getBoundingClientRect();
      if(!port || !box.height)return [.5,.5];
      const y=(Math.max(box.top,port.top)+Math.min(box.bottom,port.bottom))/2;
      return [.5,unit((y-box.top)/box.height)];
    }
    surface.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary || pointerId !== null) return;
      if (kind !== 'draw') return;
      keyPen = false; cursor = null;
      if (!startStroke(position(event))) return;
      pointerId = event.pointerId;
      surface.setPointerCapture(pointerId);
      render();
    });
    surface.addEventListener('pointermove', event => {
      if (event.pointerId !== pointerId || !current) return;
      extend(position(event)); render();
    });
    function end(event) {
      if (event.pointerId !== pointerId || !current) return;
      if (event.type === 'pointerup') extend(position(event));
      pointerId = null; current = null; render();
    }
    for (const type of ['pointerup','pointercancel','lostpointercapture']) surface.addEventListener(type,end);
    surface.addEventListener('click', event => {
      if (kind === 'point' && event.detail) point(...position(event));
    });
    surface.addEventListener('keydown', event => {
      const delta = {ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1]}[event.key];
      if (!delta && !['Enter',' '].includes(event.key)) return;
      event.preventDefault();
      cursor ||= visibleCenter();
      if (delta) {
        const step = event.shiftKey ? .05 : .01;
        cursor = cursor.map((value, i) => unit(value + delta[i] * step));
        if (keyPen && current) extend(cursor);
      } else if (kind === 'point') { point(...cursor); return; }
      else if (event.key === 'Enter') { if(strokes.length) finish(); return; }
      else if (keyPen) { keyPen = false; current = null; }
      else keyPen = startStroke(cursor);
      render();
      if(cursor)crosshair.scrollIntoView({block:'nearest',inline:'nearest'});
    });
    function remove() {
      surface.remove(); strokes=[]; current=null; pointerId=null; keyPen=false; cursor=null;
    }
    return {
      begin(parent, mode, dimensions, keyboard) {
        remove(); kind=mode; size=dimensions; surface.dataset.method=mode;
        surface.setAttribute('aria-label',mode==='draw'
          ? 'Draw on the page. With a keyboard, move with arrows, toggle the pen with Space, and press Enter to add a note.'
          : 'Place a point. With a keyboard, move with arrows and press Enter.');
        parent.append(surface);
        if(keyboard){cursor=visibleCenter();surface.focus({preventScroll:true});}
        render();
      },
      undo(){if(strokes.length){strokes.pop();current=null;pointerId=null;keyPen=false;render();}},
      remove, geometry,
      ready(){return surface.isConnected;},
    };
  }
  window.FGSVisualMarks = {editor, geometryLayer};
})();
