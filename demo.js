/* Real, offline SLAM replay. Frame-owned, corrected depth contributions are
   revealed in recorded keyframe order, alongside the recorded cameras and RGB. */
(() => {
  'use strict';
  const root = document.getElementById('slam-demo');
  if (!root) return;
  const get = (id) => document.getElementById(`demo-${id}`);
  const canvas = get('canvas');
  const overview = get('overview');
  const video = get('input');
  const poster = get('poster');
  const progress = get('progress');
  const playButton = get('play');
  const followButton = get('follow');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const defaultStatus = 'Offline depth-fusion replay · synchronized camera input';
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const assetURL = (path) => new URL(path, document.baseURI).href;
  const formatTime = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const subtract = (a, b) => a.map((v, i) => v - b[i]);
  const scale = (a, s) => a.map((v) => v * s);
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => scale(a, 1 / (Math.hypot(...a) || 1));
  let scenes = [];
  let entry = null;
  let controller = null;
  let generation = 0;
  let loaded = false;
  let loading = false;
  let playing = false;
  let visible = false;
  // Keep the playback choice separate from temporary offscreen/tab pauses.
  let playbackRequested = false;
  let inputHealthy = true;
  let frameIndex = 0;
  let time = 0;
  let speed = Number(get('speed').value) || 1;
  let following = false;
  let positions = null;
  let colors = null;
  let trajectory = null;
  let orbit = { yaw: 0.65, pitch: 0.69, distance: 3.7, target: [0, 0, 0] };
  let home = { ...orbit, target: [...orbit.target] };
  let viewAdjusted = false;
  let dirty = true;
  let animation = 0;
  let previousTick = 0;
  let overviewImage = null;
  let overviewBounds = null;
  let overviewPointCount = 0;
  let overviewStep = 1;
  let hasMapTimeline = false;
  let lastOverviewFrame = -1;
  const gl = canvas.getContext('webgl', { alpha: false, antialias: true, powerPreference: 'low-power' });
  let program;
  let attributes;
  let uniforms;
  let cloudPositionBuffer;
  let cloudColorBuffer;
  let pathPositionBuffer;
  let pathColorBuffer;
  let glyphPositionBuffer;
  let glyphColorBuffer;
  let pointCount = 0;
  let viewportWidth = 0;
  let viewportHeight = 0;

  function status(message = defaultStatus) { get('status').textContent = message; }
  function updateControls() {
    playButton.textContent = playing ? 'Pause' : 'Play';
    playButton.setAttribute('aria-label', playing ? 'Pause offline SLAM replay' : 'Play offline SLAM replay');
    progress.value = entry ? Math.round(time / entry.duration * 1000) : 0;
    progress.style.setProperty('--progress', `${Number(progress.value) / 10}%`);
    get('time').textContent = `${formatTime(time)} / ${formatTime(entry?.duration || 0)}`;
    progress.setAttribute('aria-valuetext', `${formatTime(time)} of ${formatTime(entry?.duration || 0)}`);
    if (entry) window.dispatchEvent(new CustomEvent('promano:frame', {
      detail: {
        sceneId: entry.id,
        time: loaded && inputHealthy ? video.currentTime : time,
        duration: entry.duration,
        sourceTime: entry.frames[frameIndex]?.sourceTime,
        playing: !video.paused
      }
    }));
  }
  function setControlsEnabled(enabled) {
    for (const id of ['play', 'progress', 'follow', 'reset', 'speed']) get(id).disabled = !enabled;
  }
  function stop() {
    playing = false;
    video.pause();
    updateControls();
  }
  function pause() {
    playbackRequested = false;
    stop();
  }
  function ensureAnimation() {
    if (!animation && visible && !document.hidden) animation = requestAnimationFrame(tick);
  }
  async function start() {
    playbackRequested = true;
    if (!loaded || !visible || document.hidden) return;
    if (time >= entry.duration - 0.05) seek(0);
    const request = generation;
    playing = true;
    previousTick = performance.now();
    updateControls();
    if (inputHealthy) {
      video.playbackRate = speed;
      try { await video.play(); }
      catch (error) {
        if (request !== generation || !playing) return;
        if (error.name === 'NotAllowedError') {
          pause();
          status('Press Play to start the synchronized offline replay.');
        } else if (error.name !== 'AbortError') {
          inputFailed();
        }
      }
    }
    if (request === generation && playing) ensureAnimation();
  }
  function inputFailed() {
    inputHealthy = false;
    video.pause();
    video.classList.add('is-unavailable');
    video.setAttribute('aria-label', 'Input camera video unavailable; recorded map and trajectory updates can still be replayed.');
    status('Input video unavailable · recorded map and trajectory replay remain available.');
    previousTick = performance.now();
    if (playing) ensureAnimation();
  }
  function setFrameFromTime() {
    const frames = entry.frames;
    let low = 0;
    let high = frames.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (frames[middle].time <= time) low = middle + 1;
      else high = middle;
    }
    const next = Math.max(0, low - 1);
    if (next !== frameIndex) dirty = true;
    frameIndex = next;
  }
  function seek(next) {
    if (!loaded) return;
    time = clamp(next, 0, entry.duration);
    if (inputHealthy && video.readyState >= 1) video.currentTime = Math.min(time, Math.max(0, video.duration - 0.01));
    setFrameFromTime();
    updateControls();
    dirty = true;
    ensureAnimation();
  }

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message || 'The 3D shader could not compile.');
    }
    return shader;
  }
  let rendererReady = false;
  if (gl) {
    try {
      const vertex = compileShader(gl.VERTEX_SHADER, `
        attribute vec3 position;
        attribute vec3 color;
        uniform mat4 matrix;
        uniform float pointSize;
        varying vec3 vColor;
        void main() {
          gl_Position = matrix * vec4(position, 1.0);
          gl_PointSize = clamp(pointSize / max(gl_Position.w, 0.2), 1.0, 6.0);
          vColor = color;
        }`);
      const fragment = compileShader(gl.FRAGMENT_SHADER, `
        precision mediump float;
        uniform bool roundPoints;
        varying vec3 vColor;
        void main() {
          if (roundPoints && distance(gl_PointCoord, vec2(0.5)) > 0.5) discard;
          gl_FragColor = vec4(vColor, 1.0);
        }`);
      program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('The 3D renderer could not initialize.');
      attributes = { position: gl.getAttribLocation(program, 'position'), color: gl.getAttribLocation(program, 'color') };
      uniforms = { matrix: gl.getUniformLocation(program, 'matrix'), pointSize: gl.getUniformLocation(program, 'pointSize'), roundPoints: gl.getUniformLocation(program, 'roundPoints') };
      gl.useProgram(program);
      gl.enableVertexAttribArray(attributes.position);
      gl.enableVertexAttribArray(attributes.color);
      gl.enable(gl.DEPTH_TEST);
      rendererReady = true;
    } catch (_) { status('Interactive 3D is unavailable in this browser. The recorded camera input is still available.'); }
  }
  if (!rendererReady) {
    canvas.hidden = true;
    poster.hidden = false;
    followButton.hidden = true;
    get('reset').hidden = true;
  }
  function deleteBuffers() {
    if (!gl) return;
    for (const buffer of [cloudPositionBuffer, cloudColorBuffer, pathPositionBuffer, pathColorBuffer, glyphPositionBuffer, glyphColorBuffer]) {
      if (buffer) gl.deleteBuffer(buffer);
    }
    cloudPositionBuffer = cloudColorBuffer = pathPositionBuffer = pathColorBuffer = glyphPositionBuffer = glyphColorBuffer = null;
  }
  function upload(data, usage = gl.STATIC_DRAW) {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    return buffer;
  }
  function buildBuffers() {
    deleteBuffers();
    cloudPositionBuffer = upload(positions);
    cloudColorBuffer = upload(colors);
    pathPositionBuffer = upload(trajectory);
    const pathColors = new Float32Array(entry.frames.length * 3);
    for (let i = 0; i < entry.frames.length; i++) pathColors.set([0.16 + i / entry.frames.length * 0.3, 0.67, 0.97], i * 3);
    pathColorBuffer = upload(pathColors);
    glyphPositionBuffer = upload(new Float32Array(48), gl.DYNAMIC_DRAW);
    glyphColorBuffer = upload(new Float32Array(48).fill(0).map((_, i) => [1, 0.72, 0.3][i % 3]));
  }
  function viewMatrix(eye, target, cameraUp) {
    const z = unit(subtract(eye, target));
    const x = unit(cross(cameraUp, z));
    const y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  }
  function multiply(a, b) {
    const out = new Float32Array(16);
    for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    }
    return out;
  }
  function cameraMatrix() {
    const ratio = viewportWidth / Math.max(1, viewportHeight);
    const f = 1 / Math.tan(45 * Math.PI / 360);
    const near = 0.005;
    const far = 100;
    const projection = [f / ratio, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0];
    let eye;
    let target;
    let up = [0, 1, 0];
    if (following) {
      const frame = entry.frames[frameIndex];
      eye = add(add(frame.position, scale(frame.forward, -0.32)), scale(frame.up, 0.14));
      target = add(frame.position, scale(frame.forward, 0.35));
      up = frame.up;
    } else {
      target = orbit.target;
      const horizontal = Math.cos(orbit.pitch) * orbit.distance;
      eye = add(target, [Math.sin(orbit.yaw) * horizontal, Math.sin(orbit.pitch) * orbit.distance, Math.cos(orbit.yaw) * horizontal]);
    }
    return multiply(projection, viewMatrix(eye, target, up));
  }
  function bindBuffers(positionBuffer, colorBuffer, byteColors) {
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(attributes.position, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.vertexAttribPointer(attributes.color, 3, byteColors ? gl.UNSIGNED_BYTE : gl.FLOAT, byteColors, 0, 0);
  }
  function frustum(frame) {
    const center = add(frame.position, scale(frame.forward, 0.065));
    const right = scale(frame.right, 0.046);
    const up = scale(frame.up, 0.029);
    const corners = [add(add(center, right), up), add(subtract(center, right), up), subtract(subtract(center, right), up), subtract(add(center, right), up)];
    const vertices = [];
    for (let i = 0; i < 4; i++) vertices.push(...frame.position, ...corners[i], ...corners[i], ...corners[(i + 1) % 4]);
    return new Float32Array(vertices);
  }
  function render() {
    if (!rendererReady || !loaded || !pointCount) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (width !== viewportWidth || height !== viewportHeight) {
      canvas.width = viewportWidth = width;
      canvas.height = viewportHeight = height;
      gl.viewport(0, 0, width, height);
    }
    gl.clearColor(0.035, 0.055, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.matrix, false, cameraMatrix());
    gl.uniform1f(uniforms.pointSize, Math.max(2.4, canvas.clientHeight / 210) * ratio);
    gl.uniform1i(uniforms.roundPoints, 1);
    bindBuffers(cloudPositionBuffer, cloudColorBuffer, true);
    const visiblePoints = hasMapTimeline ? entry.frames[frameIndex].pointCount : 0;
    if (visiblePoints) gl.drawArrays(gl.POINTS, 0, visiblePoints);
    gl.uniform1i(uniforms.roundPoints, 0);
    // The camera path is a visible overlay over the depth contributions so far.
    gl.disable(gl.DEPTH_TEST);
    bindBuffers(pathPositionBuffer, pathColorBuffer, false);
    gl.drawArrays(gl.LINE_STRIP, 0, frameIndex + 1);
    const glyph = frustum(entry.frames[frameIndex]);
    gl.bindBuffer(gl.ARRAY_BUFFER, glyphPositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, glyph, gl.DYNAMIC_DRAW);
    bindBuffers(glyphPositionBuffer, glyphColorBuffer, false);
    gl.drawArrays(gl.LINES, 0, glyph.length / 3);
    gl.enable(gl.DEPTH_TEST);
  }

  function buildOverview() {
    const width = Math.max(220, Math.round(overview.clientWidth * Math.min(window.devicePixelRatio || 1, 2)));
    const height = Math.max(140, Math.round(overview.clientHeight * Math.min(window.devicePixelRatio || 1, 2)));
    overview.width = width;
    overview.height = height;
    const cache = document.createElement('canvas');
    cache.width = width;
    cache.height = height;
    const ctx = cache.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#0b1420';
    ctx.fillRect(0, 0, width, height);
    const min = [Infinity, Infinity];
    const max = [-Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      min[0] = Math.min(min[0], positions[i]); max[0] = Math.max(max[0], positions[i]);
      min[1] = Math.min(min[1], positions[i + 2]); max[1] = Math.max(max[1], positions[i + 2]);
    }
    for (const frame of entry.frames) {
      min[0] = Math.min(min[0], frame.position[0]); max[0] = Math.max(max[0], frame.position[0]);
      min[1] = Math.min(min[1], frame.position[2]); max[1] = Math.max(max[1], frame.position[2]);
    }
    const factor = Math.min((width - 22) / Math.max(0.01, max[0] - min[0]), (height - 22) / Math.max(0.01, max[1] - min[1]));
    overviewBounds = { factor, center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2] };
    overviewStep = Math.max(1, Math.floor(pointCount / 13000));
    overviewPointCount = 0;
    overviewImage = cache;
    lastOverviewFrame = -1;
  }
  function overviewPoint(position) {
    return [overview.width / 2 + (position[0] - overviewBounds.center[0]) * overviewBounds.factor, overview.height / 2 + (position[2] - overviewBounds.center[1]) * overviewBounds.factor];
  }
  function renderOverview() {
    if (!loaded || !overviewImage || lastOverviewFrame === frameIndex) return;
    const ctx = overview.getContext('2d');
    if (!ctx) return;
    const cache = overviewImage.getContext('2d');
    const visiblePoints = hasMapTimeline ? entry.frames[frameIndex].pointCount : 0;
    if (visiblePoints < overviewPointCount) {
      cache.fillStyle = '#0b1420';
      cache.fillRect(0, 0, overview.width, overview.height);
      overviewPointCount = 0;
    }
    for (let i = Math.ceil(overviewPointCount / overviewStep) * overviewStep; i < visiblePoints; i += overviewStep) {
      const p = overviewPoint(positions.subarray(i * 3, i * 3 + 3));
      cache.fillStyle = `rgba(${colors[i * 3]},${colors[i * 3 + 1]},${colors[i * 3 + 2]},0.6)`;
      cache.fillRect(p[0], p[1], 1.4, 1.4);
    }
    overviewPointCount = visiblePoints;
    ctx.drawImage(overviewImage, 0, 0);
    ctx.beginPath();
    for (let i = 0; i <= frameIndex; i++) {
      const p = overviewPoint(entry.frames[i].position);
      if (i === 0) ctx.moveTo(...p); else ctx.lineTo(...p);
    }
    ctx.strokeStyle = '#6bc5ff'; ctx.lineWidth = 2; ctx.stroke();
    const frame = entry.frames[frameIndex];
    const point = overviewPoint(frame.position);
    const forward = unit([frame.forward[0], frame.forward[2]]);
    ctx.save(); ctx.translate(...point); ctx.rotate(Math.atan2(forward[1], forward[0]));
    ctx.beginPath(); ctx.moveTo(7, 0); ctx.lineTo(-5, -4); ctx.lineTo(-3, 0); ctx.lineTo(-5, 4); ctx.closePath();
    ctx.fillStyle = '#ffc66c'; ctx.fill(); ctx.restore();
    lastOverviewFrame = frameIndex;
  }
  function tick(now) {
    animation = 0;
    if (!visible || document.hidden) return;
    if (playing && loaded) {
      if (inputHealthy) time = clamp(video.currentTime, 0, entry.duration);
      else time = Math.min(entry.duration, time + Math.min((now - previousTick) / 1000, 0.2) * speed);
      setFrameFromTime();
      if (time >= entry.duration - 0.02 || (inputHealthy && video.ended)) restartReplay();
      updateControls();
    }
    previousTick = now;
    if (dirty) { render(); renderOverview(); dirty = false; }
    if (playing) ensureAnimation();
  }
  function restartReplay() {
    if (!loaded || !playing) return;
    // Restart the shared timeline, so camera, growing map and IMU loop together.
    seek(0);
    previousTick = performance.now();
    if (inputHealthy && video.paused) start();
  }

  function setFollowing(enabled) {
    following = Boolean(enabled);
    followButton.setAttribute('aria-pressed', String(following));
    followButton.classList.toggle('is-active', following);
    dirty = true;
    ensureAnimation();
  }
  function fitHome() {
    if (!positions?.length) return;
    const yaw = 0.65;
    const pitch = 0.69;
    const back = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
    const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const up = cross(back, right);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const arrays = [positions, trajectory];
    // Fit the actual projected geometry, avoiding empty world-AABB corners.
    // Recorded camera positions participate so the entire path remains in view.
    for (const data of arrays) for (let i = 0; i < data.length; i += 3) {
      const projected = [
        data[i] * right[0] + data[i + 1] * right[1] + data[i + 2] * right[2],
        data[i] * up[0] + data[i + 1] * up[1] + data[i + 2] * up[2],
        data[i] * back[0] + data[i + 1] * back[1] + data[i + 2] * back[2]
      ];
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], projected[axis]);
        max[axis] = Math.max(max[axis], projected[axis]);
      }
    }
    const center = min.map((value, i) => (value + max[i]) / 2);
    const box = canvas.parentElement.getBoundingClientRect();
    const aspect = Math.max(0.3, box.width / Math.max(1, box.height));
    const tanVertical = Math.tan(45 * Math.PI / 360);
    const tanHorizontal = tanVertical * aspect;
    let distance = 0.35;
    for (const data of arrays) for (let i = 0; i < data.length; i += 3) {
      const x = data[i] * right[0] + data[i + 1] * right[1] + data[i + 2] * right[2] - center[0];
      const y = data[i] * up[0] + data[i + 1] * up[1] + data[i + 2] * up[2] - center[1];
      const z = data[i] * back[0] + data[i + 1] * back[1] + data[i + 2] * back[2] - center[2];
      distance = Math.max(distance, z + 1.1 * Math.max(Math.abs(x) / tanHorizontal, Math.abs(y) / tanVertical));
    }
    home = {
      yaw, pitch, distance: distance + 0.015,
      target: add(add(scale(right, center[0]), scale(up, center[1])), scale(back, center[2]))
    };
  }
  function resetView() {
    setFollowing(false);
    fitHome();
    orbit = { ...home, target: [...home.target] };
    viewAdjusted = false;
    dirty = true;
    ensureAnimation();
  }
  function updateSceneURL(id) {
    const url = new URL(location.href);
    url.searchParams.set('scene', id);
    history.replaceState(null, '', url);
  }
  async function loadScene(next, updateURL = true) {
    const request = ++generation;
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    stop();
    loaded = false;
    loading = true;
    playbackRequested = !reducedMotion.matches;
    inputHealthy = true;
    entry = next;
    frameIndex = 0;
    time = 0;
    pointCount = 0;
    hasMapTimeline = false;
    overviewImage = null;
    canvas.hidden = true;
    if (rendererReady) { gl.clearColor(0.035, 0.055, 0.08, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); }
    const overviewContext = overview.getContext('2d');
    if (overviewContext) { overviewContext.fillStyle = '#0b1420'; overviewContext.fillRect(0, 0, overview.width, overview.height); }
    video.removeAttribute('src');
    video.load();
    video.classList.remove('is-unavailable', 'is-ready');
    video.setAttribute('aria-label', 'Camera input synchronized with the recorded camera trajectory');
    poster.src = assetURL(entry.poster);
    poster.hidden = false;
    video.poster = assetURL(entry.poster);
    video.src = assetURL(entry.inputVideo);
    video.playbackRate = speed;
    video.load();
    get('name').textContent = entry.title;
    get('dataset').textContent = entry.dataset;
    for (const button of get('scenes').children) button.setAttribute('aria-pressed', String(button.dataset.scene === entry.id));
    root.setAttribute('aria-busy', 'true');
    setControlsEnabled(false);
    status('Loading recorded SLAM results…');
    updateControls();
    if (updateURL) updateSceneURL(entry.id);
    try {
      const response = await fetch(assetURL(entry.cloud), { signal });
      if (!response.ok) throw new Error('The recorded point cloud could not be downloaded.');
      const bytes = await response.arrayBuffer();
      if (request !== generation) return;
      if (!Number.isSafeInteger(entry.count) || entry.count <= 0 || bytes.byteLength !== entry.count * 9 || !entry.frames?.length) throw new Error('The recorded scene data is incomplete.');
      positions = new Float32Array(entry.count * 3);
      colors = new Uint8Array(entry.count * 3);
      const view = new DataView(bytes);
      for (let i = 0; i < entry.count; i++) for (let axis = 0; axis < 3; axis++) {
        const value = view.getInt16(i * 9 + axis * 2, true) / 32767;
        positions[i * 3 + axis] = value;
        colors[i * 3 + axis] = view.getUint8(i * 9 + 6 + axis);
      }
      trajectory = new Float32Array(entry.frames.flatMap((frame) => frame.position));
      hasMapTimeline = entry.frames.every((frame, i) => Number.isSafeInteger(frame.pointCount) && frame.pointCount >= 0 && frame.pointCount <= entry.count && (i === 0 || frame.pointCount >= entry.frames[i - 1].pointCount));
      pointCount = entry.count;
      if (rendererReady) buildBuffers();
      loaded = true;
      loading = false;
      root.setAttribute('aria-busy', 'false');
      setControlsEnabled(true);
      resetView();
      buildOverview();
      canvas.hidden = !rendererReady;
      poster.hidden = rendererReady;
      if (!inputHealthy) status('Input video unavailable · recorded map and trajectory replay remain available.');
      else if (!hasMapTimeline) status('Map-update timing unavailable · recorded camera input and trajectory replay.');
      else status(rendererReady ? defaultStatus : 'Interactive 3D unavailable · static preview and recorded camera input.');
      dirty = true;
      ensureAnimation();
      if (playbackRequested && visible && !document.hidden) start();
    } catch (error) {
      if (signal.aborted || request !== generation) return;
      loading = false;
      playbackRequested = false;
      video.pause();
      root.setAttribute('aria-busy', 'false');
      status(`${error.message} Select a scene to retry.`);
    }
  }
  async function initialize() {
    if (scenes.length || loading) return;
    loading = true;
    try {
      const response = await fetch(assetURL('assets/demos/scenes.json'));
      if (!response.ok) throw new Error('The SLAM demo list could not be loaded.');
      const list = await response.json();
      if (!Array.isArray(list) || !list.length) throw new Error('No recorded SLAM demos are available.');
      scenes = list;
      for (const scene of scenes) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'demo-scene'; button.dataset.scene = scene.id;
        button.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-label', `Replay ${scene.title}, ${scene.dataset}`);
        const image = document.createElement('img'); image.src = assetURL(scene.poster); image.alt = ''; image.loading = 'lazy';
        const copy = document.createElement('span');
        const dataset = document.createElement('small'); dataset.textContent = scene.dataset;
        const title = document.createElement('strong'); title.textContent = scene.title;
        copy.append(dataset, title); button.append(image, copy);
        button.addEventListener('click', () => loadScene(scene));
        get('scenes').append(button);
      }
      const requested = new URL(location.href).searchParams.get('scene');
      await loadScene(scenes.find((scene) => scene.id === requested) || scenes[0], false);
    } catch (error) { loading = false; status(`${error.message} Reload the page to retry.`); }
  }

  playButton.addEventListener('click', () => { if (playing) pause(); else start(); });
  progress.addEventListener('input', () => seek(Number(progress.value) / 1000 * (entry?.duration || 0)));
  get('speed').addEventListener('change', () => { speed = Number(get('speed').value) || 1; video.playbackRate = speed; });
  followButton.addEventListener('click', () => { viewAdjusted = true; setFollowing(!following); });
  get('reset').addEventListener('click', resetView);
  get('prev').addEventListener('click', () => { if (scenes.length) loadScene(scenes[(scenes.indexOf(entry) - 1 + scenes.length) % scenes.length]); });
  get('next').addEventListener('click', () => { if (scenes.length) loadScene(scenes[(scenes.indexOf(entry) + 1) % scenes.length]); });
  get('fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (get('player')?.requestFullscreen) await get('player').requestFullscreen();
      else status('Fullscreen is unavailable in this browser.');
    } catch (_) { status('Fullscreen could not be opened.'); }
  });
  video.muted = true; video.defaultMuted = true; video.playsInline = true;
  video.addEventListener('error', () => { if (entry && video.getAttribute('src')) inputFailed(); });
  video.addEventListener('loadedmetadata', () => { if (loaded && time > 0) video.currentTime = Math.min(time, video.duration - 0.01); });
  video.addEventListener('loadeddata', () => video.classList.add('is-ready'));
  video.addEventListener('ended', () => { restartReplay(); });
  video.addEventListener('playing', () => {
    if (inputHealthy && loaded) status(!hasMapTimeline ? 'Map-update timing unavailable · recorded camera input and trajectory replay.' : rendererReady ? defaultStatus : 'Interactive 3D unavailable · static preview and recorded camera input.');
  });
  let pointer = null;
  canvas.addEventListener('pointerdown', (event) => {
    if (!loaded || event.button !== 0) return;
    viewAdjusted = true;
    setFollowing(false);
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    orbit.yaw -= (event.clientX - pointer.x) * 0.008;
    orbit.pitch = clamp(orbit.pitch + (event.clientY - pointer.y) * 0.008, -1.48, 1.48);
    pointer.x = event.clientX; pointer.y = event.clientY;
    dirty = true; ensureAnimation();
  });
  const releasePointer = () => { pointer = null; };
  canvas.addEventListener('pointerup', releasePointer); canvas.addEventListener('pointercancel', releasePointer); canvas.addEventListener('lostpointercapture', releasePointer);
  canvas.addEventListener('wheel', (event) => {
    if (!loaded) return;
    viewAdjusted = true;
    event.preventDefault(); setFollowing(false);
    orbit.distance = clamp(orbit.distance * Math.exp(event.deltaY * 0.001), 0.15, 18);
    dirty = true; ensureAnimation();
  }, { passive: false });
  canvas.addEventListener('keydown', (event) => {
    if (event.code === 'Space') { event.preventDefault(); if (playing) pause(); else start(); }
    if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.code)) {
      viewAdjusted = true;
      event.preventDefault(); setFollowing(false);
      if (event.code === 'ArrowRight') orbit.yaw += 0.12;
      if (event.code === 'ArrowLeft') orbit.yaw -= 0.12;
      if (event.code === 'ArrowUp') orbit.pitch = clamp(orbit.pitch + 0.12, -1.48, 1.48);
      if (event.code === 'ArrowDown') orbit.pitch = clamp(orbit.pitch - 0.12, -1.48, 1.48);
      dirty = true; ensureAnimation();
    }
    if (['Equal', 'NumpadAdd', 'Minus', 'NumpadSubtract'].includes(event.code)) {
      viewAdjusted = true;
      event.preventDefault(); setFollowing(false);
      orbit.distance = clamp(orbit.distance * (event.code === 'Minus' || event.code === 'NumpadSubtract' ? 1.12 : 1 / 1.12), 0.15, 18);
      dirty = true; ensureAnimation();
    }
    if (event.code === 'KeyR' || event.code === 'Home') { event.preventDefault(); resetView(); }
    if (event.code === 'KeyF') { viewAdjusted = true; setFollowing(!following); }
  });
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault(); pause(); rendererReady = false; canvas.hidden = true; poster.hidden = false;
    status('The 3D graphics context was interrupted. Reload to restore the interactive view.');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stop(); cancelAnimationFrame(animation); animation = 0; }
    else { dirty = true; ensureAnimation(); if (playbackRequested && loaded && visible) start(); }
  });
  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) pause(); });
  const resize = () => {
    if (loaded) {
      buildOverview();
      if (!viewAdjusted && !following) { fitHome(); orbit = { ...home, target: [...home.target] }; }
    }
    dirty = true; ensureAnimation();
  };
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
  else window.addEventListener('resize', resize);
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement === get('player')) visible = true;
    resize();
  });
  window.addEventListener('pagehide', (event) => {
    stop();
    if (!event.persisted) { controller?.abort(); deleteBuffers(); }
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && playbackRequested && loaded && visible && !document.hidden) start();
  });
  setControlsEnabled(false);
  updateControls();
  if ('IntersectionObserver' in window) {
    const lazyObserver = new IntersectionObserver(([event]) => {
      if (event.isIntersecting) { lazyObserver.disconnect(); initialize(); }
    }, { rootMargin: '500px 0px' });
    lazyObserver.observe(root);
    new IntersectionObserver(([event]) => {
      visible = event.isIntersecting;
      if (!visible) { stop(); cancelAnimationFrame(animation); animation = 0; }
      else { dirty = true; ensureAnimation(); if (playbackRequested && loaded && !document.hidden) start(); }
    }, { threshold: 0.01 }).observe(get('player') || root);
  } else { visible = true; initialize(); }
})();
