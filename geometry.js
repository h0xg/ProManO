/* A synthetic, single-camera example of the transformation families in Sec. 3.
 * This is an explanatory construction, not a benchmark or an estimated output.
 * Coordinates are (depth, vertical offset); the unused image x-coordinate is zero.
 * The prediction is E_q applied to metric points with q_3 = +0.20.
 * The inverse correction has q_3 = -0.20 and a positive denominator throughout.
 */
(() => {
  'use strict';
  const slider = document.querySelector('#geometry-progress');
  if (!slider) return;
  const ns = 'http://www.w3.org/2000/svg';
  const camera = [54, 155], unit = 72, distortion = 0.20;
  const depths = [1, 1.9, 2.9], slopes = [-0.44, 0, 0.44];
  const metric = depths.flatMap(z => slopes.map(b => [z, b * z]));
  const predicted = metric.map(([z, y]) => [z / (1 + distortion * z), y / (1 + distortion * z)]);
  // Pose is already aligned in this illustration. Isolate the scale component
  // of Sim(3), fitting its one multiplier to every point without moving the camera.
  let numerator = 0, denominator = 0;
  predicted.forEach((p, i) => {
    for (let j = 0; j < 2; j++) {
      numerator += p[j] * metric[i][j];
      denominator += p[j] ** 2;
    }
  });
  const scale = numerator / denominator;
  const screen = p => [camera[0] + unit * p[0], camera[1] + unit * p[1]];
  const point = p => p.map(v => v.toFixed(2)).join(',');
  const add = (parent, tag, attrs) => {
    const el = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    parent.append(el);
    return el;
  };
  const panels = [...document.querySelectorAll('[data-geometry-model]')].map(svg => {
    const model = svg.dataset.geometryModel;
    const color = {sim3: '#79d8ff', sl4: '#ffc28c', ours: '#bca6ff'}[model];
    const references = svg.querySelector('.geometry-reference');
    const moving = svg.querySelector('.geometry-moving');
    // Reference rays, metric anchors and original prediction are identical in all panels.
    slopes.forEach(b => {
      const end = screen([3.13, b * 3.13]);
      add(references, 'line', {x1: camera[0], y1: camera[1], x2: end[0], y2: end[1], stroke: '#719cca', 'stroke-width': 1, opacity: '.42', 'stroke-dasharray': '3 5'});
    });
    metric.forEach(g => {
      const [x, y] = screen(g);
      add(references, 'path', {d: `M${x - 4},${y}h8M${x},${y - 4}v8`, stroke: '#b4c2db', 'stroke-width': 1.5, fill: 'none'});
    });
    predicted.forEach(p => {
      const [cx, cy] = screen(p);
      add(references, 'circle', {cx, cy, r: 4.2, fill: '#0c162b', stroke: '#f2ad79', 'stroke-width': 1.5});
    });
    const rays = slopes.map(() => add(moving, 'line', {stroke: color, 'stroke-width': 1, opacity: '.32'}));
    const links = predicted.map(() => add(moving, 'line', {stroke: color, 'stroke-width': 1.3, opacity: '.7', 'marker-end': `url(#geometry-arrow-${model})`}));
    const residuals = model === 'sim3' ? predicted.map(() => add(moving, 'line', {stroke: '#f2ad79', 'stroke-width': 1.6, 'stroke-dasharray': '2 2'})) : [];
    const dots = predicted.map(() => add(moving, 'circle', {r: 4.3, fill: color, stroke: '#0a1123', 'stroke-width': 1}));
    const cameraIcon = add(moving, 'g', {});
    add(cameraIcon, 'path', {d: 'M-17-8h12v16h-12zM-5-5L4-11V11L-5 5Z', fill: '#152644', stroke: color, 'stroke-width': 1.7, 'stroke-linejoin': 'round'});
    // A rectified image grid makes the calibration modes visible, separately
    // from the depth plot. General projective maps still preserve straight lines.
    const grid = svg.querySelector('.geometry-calibration');
    const gridPath = add(grid, 'path', {fill: 'none', stroke: color, 'stroke-width': 1.4});
    return {model, color, svg, rays, links, residuals, dots, cameraIcon, gridPath};
  });
  function render() {
    const amount = Number(slider.value) / 100;
    for (const panel of panels) {
      const center = [0, 0];
      const corrected = predicted.map(p => {
        if (panel.model === 'sim3') {
          return p.map(v => (1 + amount * (scale - 1)) * v);
        }
        const divisor = 1 - distortion * amount * p[0];
        const z = p[0] / divisor, y = p[1] / divisor;
        // One allowed, calibration-changing affine factor in the SL(4) family.
        // It is not claimed to be an optimum or an inevitable SL(4) result.
        return panel.model === 'sl4' ? [z, (1 + .04 * amount) * y - .08 * amount * z] : [z, y];
      });
      corrected.forEach((p, i) => {
        const [x1, y1] = screen(predicted[i]), [x2, y2] = screen(p);
        for (const [key, value] of Object.entries({x1, y1, x2, y2})) panel.links[i].setAttribute(key, value.toFixed(2));
        panel.links[i].setAttribute('visibility', Math.hypot(x2 - x1, y2 - y1) > 9 ? 'visible' : 'hidden');
        panel.dots[i].setAttribute('cx', x2.toFixed(2)); panel.dots[i].setAttribute('cy', y2.toFixed(2));
        if (panel.residuals[i]) {
          const [gx, gy] = screen(metric[i]);
          for (const [key, value] of Object.entries({x1: x2, y1: y2, x2: gx, y2: gy})) panel.residuals[i].setAttribute(key, value.toFixed(2));
        }
      });
      panel.cameraIcon.setAttribute('transform', `translate(${point(screen(center))})`);
      panel.rays.forEach((ray, i) => {
        const start = screen(center), far = corrected[6 + i];
        const end = screen(far.map((v, j) => center[j] + 1.07 * (v - center[j])));
        for (const [key, value] of Object.entries({x1: start[0], y1: start[1], x2: end[0], y2: end[1]})) ray.setAttribute(key, value.toFixed(2));
      });
      let d = '';
      // The camera changes contragrediently: P' = P H^-1, hence K' = K A^-1.
      const gridPoint = (x, y) => panel.model === 'sl4' ? [240 + x, 277 + (y + 6 * amount) / (1 + .04 * amount)] : [240 + x, 277 + y];
      for (const k of [-12, 0, 12]) {
        d += `M${point(gridPoint(k, -12))}L${point(gridPoint(k, 12))}`;
        d += `M${point(gridPoint(-12, k))}L${point(gridPoint(12, k))}`;
      }
      panel.gridPath.setAttribute('d', d);
    }
    document.querySelector('#geometry-value').textContent = amount === 0 ? 'Prediction' : amount === 1 ? 'Transformation applied' : `${slider.value}% applied`;
    for (const toggle of document.querySelectorAll('[data-geometry-toggle]')) toggle.textContent = amount > 0 ? 'Show prediction' : 'Apply transformation';
    slider.setAttribute('aria-valuetext', amount === 0 ? 'Original predicted geometry' : `${slider.value} percent of the illustrative transformations applied`);
  }
  slider.disabled = false;
  slider.addEventListener('input', render);
  for (const toggle of document.querySelectorAll('[data-geometry-toggle]')) {
    toggle.disabled = false;
    toggle.addEventListener('click', () => { slider.value = Number(slider.value) > 0 ? '0' : '100'; render(); });
  }
  render();
})();
