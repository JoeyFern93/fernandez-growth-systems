(() => {
  'use strict';

  const svgNamespace = 'http://www.w3.org/2000/svg';
  const isSize = value => Number.isFinite(value) && value > 0;
  const isPoint = value => Array.isArray(value) && value.length === 2 &&
    value.every(n => Number.isFinite(n) && n >= 0 && n <= 1);

  function svgNode(name, attributes) {
    const element = document.createElementNS(svgNamespace, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  function annotationFor(note, shot) {
    const annotation = note.context?.annotation;
    if (annotation?.kind === 'draw' && Array.isArray(annotation.strokes) &&
        annotation.strokes.length > 0 && annotation.strokes.length <= 24 &&
        annotation.strokes.every(stroke => Array.isArray(stroke) && stroke.length && stroke.every(isPoint)) &&
        annotation.strokes.reduce((total, stroke) => total + stroke.length, 0) <= 640) return annotation;
    if (annotation?.kind === 'point' && isPoint(annotation.point)) return annotation;
    // Reviews created before drawn annotations use two top-level screenshot coordinates.
    if (shot && isPoint([note.x, note.y])) return {kind:'point', point:[note.x, note.y]};
    return null;
  }

  function drawingStroke(points, width, height, dotRadius) {
    if (points.length === 1) return svgNode('circle', {
      cx:points[0][0] * width, cy:points[0][1] * height, r:dotRadius, class:'drawing-dot'
    });
    const commands = points.map(([x,y], i) => (i ? 'L' : 'M') + (x * width) + ' ' + (y * height));
    return svgNode('path', {d:commands.join(' '), fill:'none', 'stroke-linecap':'round', 'stroke-linejoin':'round'});
  }

  function annotationPreview(note, shot) {
    const a = annotationFor(note, shot);
    if (!a) return null;
    const width = shot?.width ?? a.width, height = shot?.height ?? a.height;
    if (!isSize(width) || !isSize(height)) return null;
    const figure = document.createElement('figure');
    figure.className = 'annotation-preview';
    figure.dataset.kind = a.kind;
    const image = document.createElement('div');
    image.className = 'annotation-image';
    image.style.aspectRatio = width + '/' + height;
    const tall = !!shot && height > width * 1.6;
    image.style.width = tall ? '100%' : 'min(100%, 21rem, ' + (12 * width / height) + 'rem)';
    function backdrop(url) {
      const photo = document.createElement('img');
      photo.loading = 'lazy';
      photo.decoding = 'async';
      photo.alt = '';
      photo.src = url;
      return photo;
    }
    if (shot?.tiles?.length) {
      const stack = document.createElement('div');
      stack.className = 'annotation-tiles';
      for (const tile of shot.tiles) {
        const part = backdrop(tile.imageUrl);
        part.style.height = (100 * tile.height / height) + '%';
        stack.append(part);
      }
      image.append(stack);
    } else if (shot?.imageUrl) image.append(backdrop(shot.imageUrl));
    const svg = svgNode('svg', {viewBox:'0 0 ' + width + ' ' + height, 'aria-hidden':'true', focusable:'false'});
    const unit = tall ? width / 336 : Math.max(width / 336, height / 192);
    if (a.kind === 'point') {
      const [x, y] = a.point;
      svg.append(svgNode('circle', {cx:x * width, cy:y * height, r:6 * unit, class:'annotation-point'}));
    } else {
      for (const stroke of a.strokes) {
        const mark = drawingStroke(stroke, width, height, 2.2 * unit);
        if (stroke.length > 1) {
          const halo = mark.cloneNode(false);
          halo.setAttribute('class','drawing-halo');
          svg.append(halo);
        }
        svg.append(mark);
      }
    }
    image.append(svg);
    const caption = document.createElement('figcaption');
    const details = [a.kind === 'point' ? 'Pin' : 'Drawing', shot ? 'Screenshot' : 'Viewport outline'];
    if (a.kind === 'point') {
      details.push(Math.round(a.point[0] * 100) + '% across, ' + Math.round(a.point[1] * 100) + '% down');
    }
    if (!shot) {
      details.push(width + ' × ' + height);
      const {scrollX, scrollY} = note.context || {};
      if (Number.isFinite(scrollX) && scrollX > 0) details.push('scrolled ' + Math.round(scrollX) + ' px right');
      if (Number.isFinite(scrollY) && scrollY > 0) details.push('scrolled ' + Math.round(scrollY) + ' px down');
    }
    if (tall) details.push('Scroll to explore the full image');
    caption.textContent = details.join(' · ');
    if (tall) {
      const viewport = document.createElement('div');
      viewport.className = 'annotation-window';
      viewport.tabIndex = 0;
      viewport.setAttribute('role', 'region');
      viewport.setAttribute('aria-label', 'Scrollable screenshot with ' + (a.kind === 'point' ? 'pin' : 'drawing'));
      viewport.append(image);
      figure.append(viewport, caption);
      // Open the image where the feedback was left, even if Notes starts out hidden.
      if (typeof ResizeObserver !== 'undefined') {
        const y = a.kind === 'point' ? a.point[1] : a.strokes[0][0][1];
        const observer = new ResizeObserver(() => {
          if (!viewport.clientHeight) return;
          viewport.scrollTop = y * image.offsetHeight - viewport.clientHeight / 2;
          observer.disconnect();
        });
        observer.observe(viewport);
      }
    } else figure.append(image, caption);
    return figure;
  }

  window.fgsAnnotationPreview = annotationPreview;
})();
