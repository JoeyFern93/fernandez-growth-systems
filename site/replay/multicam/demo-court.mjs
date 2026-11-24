// Both cameras observe one athlete on a sixteen-second loop around four markers.
const duration = 16;
const turn = 2 * Math.PI;
const fullFrame = { x: 0, y: 0, size: 1 };
const markers = [[3.3, 0], [0, 2.4], [-3.3, 0], [0, -2.4]];

export function renderMock(canvas, time, { angle = 'baseline' } = {}) {
  const t = Math.max(0, Math.min(duration, time));
  const phase = turn * t / duration;
  const runner = { x: 3.6 * Math.cos(phase), y: 2.7 * Math.sin(phase) };
  const heading = Math.atan2(2.7 * Math.cos(phase), -3.6 * Math.sin(phase));
  const yaw = angle === 'sideline' ? 1.24 : -.34;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const width = 960, height = 540;
  const ctx = canvas.getContext('2d');

  function depth(x, y) { return x * sin + y * cos; }
  function project(x, y, z = 0) {
    const d = depth(x, y);
    const scale = 1040 / (14 - d);
    return { x: 480 + (x * cos - y * sin) * scale, y: 324 + (d * .46 - z) * scale, scale };
  }
  function path(points, color, weight, fill = false) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
    if (fill) {
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = weight;
      ctx.stroke();
    }
  }
  function oval(p, rx, ry, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, rx, ry, 0, 0, turn);
    ctx.fill();
  }

  function drawMarker(x, y) {
    const base = project(x, y), top = project(x, y, .24);
    const size = base.scale;
    const proximity = 1 - Math.min(1, Math.hypot(runner.x - x, runner.y - y) / 1.25);
    if (proximity > 0) {
      oval(base, size * .31, size * .13, 'rgba(244,209,118,' + proximity * .8 + ')');
    }
    oval(base, size * .15, size * .055, '#523d2c');
    path([{ x: base.x - size * .105, y: base.y }, top,
      { x: base.x + size * .105, y: base.y }], '#f3a456', 0, true);
    path([{ x: base.x - size * .052, y: base.y - size * .11 },
      { x: base.x + size * .052, y: base.y - size * .11 }], '#ffefd0', size * .025);
  }
  function drawRunner() {
    const stride = Math.sin(turn * t * 1.125);
    const bob = Math.abs(stride) * .055;
    const forwardX = Math.cos(heading), forwardY = Math.sin(heading);
    function joint(forward, side, z) {
      return project(runner.x + forwardX * forward - forwardY * side,
        runner.y + forwardY * forward + forwardX * side, z);
    }
    const foot = project(runner.x, runner.y);
    oval(foot, foot.scale * .32, foot.scale * .09, '#365851');
    const scale = foot.scale;
    function limbs(side) {
      const step = side * stride, lift = Math.max(0, -step);
      const hip = joint(0, side * .095, .89 + bob);
      const knee = joint(.10 + .24 * step, side * .10, .46 + lift * .14);
      const heel = joint(-.03 + .37 * step, side * .105, .075 + lift * .19);
      const toe = joint(.065 + .37 * step, side * .105, .065 + lift * .19);
      path([hip, knee, heel], '#28444c', .11 * scale);
      path([heel, toe], '#f3e8cd', .085 * scale);
      const shoulder = joint(.065, side * .165, 1.39 + bob);
      const elbow = joint(-.035 - step * .19, side * .20, 1.13 + bob);
      const hand = joint(.16 - step * .21, side * .20, 1.13 + bob + Math.max(-step, 0) * .12);
      path([shoulder, elbow, hand], '#c48b68', .077 * scale);
    }
    const nearSide = depth(-forwardY, forwardX) > 0 ? 1 : -1;
    limbs(-nearSide);
    path([joint(0, 0, .91 + bob), joint(.075, 0, 1.40 + bob)], '#225c54', .32 * scale);
    path([joint(.015, 0, 1.01 + bob), joint(.075, 0, 1.39 + bob)], '#a6d9a3', .255 * scale);
    const head = joint(.10, 0, 1.66 + bob);
    oval(head, scale * .117, scale * .14, '#ca9370');
    oval({ x: head.x, y: head.y - scale * .075 }, scale * .12, scale * .073, '#293a36');
    limbs(nearSide);
  }

  ctx.save();
  ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const backdrop = ctx.createLinearGradient(0, 0, 0, height);
  backdrop.addColorStop(0, '#183335');
  backdrop.addColorStop(.29, '#335653');
  backdrop.addColorStop(.30, '#51736b');
  backdrop.addColorStop(1, '#84a397');
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, width, height);
  const mat = [[-4.45,-3.4],[4.45,-3.4],[4.45,3.4],[-4.45,3.4]]
    .map(([x,y]) => project(x,y));
  path(mat, '#587e73', 0, true);
  path([...mat, mat[0]], '#bdd1b9', 2);
  const route = Array.from({ length: 65 }, (_, i) => {
    const a = turn * i / 64;
    return project(3.6 * Math.cos(a), 2.7 * Math.sin(a));
  });
  ctx.setLineDash([8, 11]);
  path(route, '#9db5a4', 2);
  ctx.setLineDash([]);
  const objects = markers.map(([x, y]) => ({ depth: depth(x, y), draw: () => drawMarker(x, y) }));
  objects.push({ depth: depth(runner.x, runner.y), draw: drawRunner });
  objects.sort((a, b) => a.depth - b.depth).forEach(object => object.draw());
  ctx.restore();
  return { time: t, crop: fullFrame };
}
