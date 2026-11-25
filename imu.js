/* Recorded inertial measurements share the reconstruction player's clock. */
(() => {
  'use strict';
  const root = document.getElementById('demo-imu');
  if (!root) return;
  const status = document.getElementById('imu-status');
  const charts = ['accel', 'gyro'].map(key => ({
    key, canvas: document.getElementById(`imu-${key}`),
    value: document.getElementById(`imu-${key}-value`), limit: 1
  }));
  const colors = ['#efad9d', '#9ed9b6', '#8bbfe8'];
  let sceneId = '', currentTime = 0, duration = 20, data = null;
  let request = null, drawFrame = 0;

  function scheduleDraw() {
    if (drawFrame) return;
    drawFrame = requestAnimationFrame(() => { drawFrame = 0; charts.forEach(draw); });
  }
  function currentSample(time) {
    if (!data?.samples.length) return null;
    const samples = data.samples;
    let low = 0, high = samples.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (samples[middle].time <= time) low = middle + 1;
      else high = middle;
    }
    return samples[Math.max(0, low - 1)];
  }
  function draw(chart) {
    const { canvas, key } = chart;
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.round(box.width * ratio), height = Math.round(box.height * ratio);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const w = box.width, h = box.height, left = 40, right = 9, top = 8, bottom = 19;
    ctx.clearRect(0, 0, w, h);
    const pw = Math.max(1, w - left - right), ph = Math.max(1, h - top - bottom);
    ctx.strokeStyle = '#ffffff14'; ctx.lineWidth = 1;
    ctx.fillStyle = '#94adb5'; ctx.font = '10px system-ui'; ctx.textAlign = 'right';
    for (const sign of [-1, 0, 1]) {
      const y = top + ph * (1 - sign) / 2;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(w - right, y); ctx.stroke();
      ctx.fillText(data ? (sign * chart.limit).toFixed(chart.limit >= 10 ? 0 : 1) : '—', left - 7, y + 3);
    }
    const windowLength = Math.min(6, duration);
    const start = Math.max(0, Math.min(currentTime - windowLength * .82, duration - windowLength));
    const end = start + windowLength;
    const x = time => left + (time - start) / windowLength * pw;
    ctx.textAlign = 'left'; ctx.fillText(`${start.toFixed(1)} s`, left, h - 3);
    ctx.textAlign = 'right'; ctx.fillText(`${end.toFixed(1)} s`, w - right, h - 3);
    if (!data) { chart.value.textContent = '—'; return; }
    const sample = currentSample(currentTime);
    chart.value.textContent = sample ? sample[key].map(v => v.toFixed(2)).join(' / ') : '—';
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, pw, ph); ctx.clip();
    // Reveal only samples at or before the current replay time.
    for (let axis = 0; axis < 3; axis++) {
      ctx.strokeStyle = colors[axis]; ctx.lineWidth = 1.15; ctx.beginPath();
      let started = false;
      for (const s of data.samples) {
        if (s.time < start) continue;
        if (s.time > currentTime || s.time > end) break;
        const px = x(s.time), py = top + ph * (.5 - s[key][axis] / (chart.limit * 2));
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = '#edf7f4a0'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(currentTime), top); ctx.lineTo(x(currentTime), top + ph); ctx.stroke();
    ctx.restore();
  }
  async function selectScene(id) {
    sceneId = id; data = null;
    if (request) request.abort();
    request = new AbortController();
    const thisRequest = request;
    status.textContent = 'Loading recorded IMU…';
    scheduleDraw();
    try {
      const response = await fetch(new URL(`assets/demos/${encodeURIComponent(id)}/imu.json`, document.baseURI), { signal: thisRequest.signal });
      if (!response.ok) throw new Error('Missing IMU recording');
      const result = await response.json();
      if (request !== thisRequest) return;
      if (!Array.isArray(result.samples) || !result.samples.length || !result.samples.every(s =>
        Number.isFinite(s.time) && ['accel', 'gyro'].every(key => Array.isArray(s[key]) && s[key].length === 3 && s[key].every(Number.isFinite)))) {
        throw new Error('Invalid IMU recording');
      }
      data = result;
      for (const chart of charts) {
        const absolute = data.samples.flatMap(s => s[chart.key].map(Math.abs)).sort((a, b) => a - b);
        // Robust symmetric range keeps occasional isolated spikes readable.
        chart.limit = Math.max(chart.key === 'accel' ? 1 : .1, absolute[Math.floor((absolute.length - 1) * .995)] * 1.12);
      }
      status.textContent = 'Recorded accelerometer + gyroscope · synchronized';
    } catch (error) {
      if (error.name === 'AbortError' || request !== thisRequest) return;
      status.textContent = 'The IMU recording is unavailable for this sequence.';
    }
    scheduleDraw();
  }
  window.addEventListener('promano:frame', event => {
    const detail = event.detail || {};
    if (!detail.sceneId) return;
    currentTime = Number(detail.time) || 0;
    duration = Number(detail.duration) || 20;
    if (sceneId !== detail.sceneId) selectScene(detail.sceneId);
    scheduleDraw();
  });
  new ResizeObserver(scheduleDraw).observe(root);
  scheduleDraw();
})();
