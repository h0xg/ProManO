(() => {
  "use strict";

  const vertexSource = `
    attribute vec3 aPosition;
    attribute vec3 aColor;
    uniform vec3 uCenter;
    uniform vec3 uRight;
    uniform vec3 uUp;
    uniform vec3 uTowardCamera;
    uniform vec3 uScale;
    uniform float uPointSize;
    varying vec3 vColor;
    void main() {
      vec3 point = aPosition - uCenter;
      vec3 view = vec3(dot(point, uRight), dot(point, uUp), -dot(point, uTowardCamera));
      gl_Position = vec4(view * uScale, 1.);
      gl_PointSize = uPointSize;
      vColor = aColor;
    }`;
  const fragmentSource = `
    precision mediump float;
    varying vec3 vColor;
    void main() {
      vec2 fromCenter = gl_PointCoord - .5;
      if (dot(fromCenter, fromCenter) > .25) discard;
      gl_FragColor = vec4(vColor, 1.);
    }`;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const initialView = { yaw: .23, elevation: .98, zoom: 1 };

  // Convert the portable, packed little-endian file into two aligned GPU arrays.
  function decodeCloud(bytes, count) {
    if (bytes.byteLength !== count * 9) throw Error("Incomplete point data.");
    const view = new DataView(bytes);
    const positions = new Int16Array(count * 3);
    const colors = new Uint8Array(count * 3);
    const low = [32767, 32767, 32767], high = [-32768, -32768, -32768];
    for (let i = 0; i < count; i++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = view.getInt16(i * 9 + axis * 2, true);
        positions[i * 3 + axis] = value;
        colors[i * 3 + axis] = view.getUint8(i * 9 + 6 + axis);
        low[axis] = Math.min(value, low[axis]);
        high[axis] = Math.max(value, high[axis]);
      }
    }
    const center = low.map((v, axis) => (high[axis] + v) / 65534);
    const half = low.map((v, axis) => (high[axis] - v) / 65534);
    return { positions, colors, count, center, half, radius: Math.max(.001, Math.hypot(...half)) };
  }

  function renderer(canvas) {
    const gl = canvas.getContext("webgl", { alpha: false, antialias: true, depth: true });
    if (!gl || gl.isContextLost()) throw Error("WebGL is unavailable.");
    const program = gl.createProgram();
    for (const [kind, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
      const shader = gl.createShader(kind);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error("Shader compilation failed.");
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error("Viewer initialization failed.");
    gl.useProgram(program);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(.965, .976, .970, 1);
    const maps = [gl.createBuffer(), gl.createBuffer()];
    const attr = ["aPosition", "aColor"].map(name => gl.getAttribLocation(program, name));
    const uniform = Object.fromEntries(["Center","Right","Up","TowardCamera","Scale","PointSize"]
      .map(name => [name, gl.getUniformLocation(program, "u" + name)]));
    const [minPoint, maxPoint] = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
    let bounds;
    return {
      set(cloud) {
        [cloud.positions, cloud.colors].forEach((array, idx) => {
          gl.bindBuffer(gl.ARRAY_BUFFER, maps[idx]);
          gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
          gl.enableVertexAttribArray(attr[idx]);
          gl.vertexAttribPointer(attr[idx], 3, idx === 0 ? gl.SHORT : gl.UNSIGNED_BYTE, true, 0, 0);
        });
        if (gl.getError() !== gl.NO_ERROR) throw Error("Could not upload points.");
        bounds = { center: cloud.center, radius: cloud.radius, half: cloud.half, count: cloud.count };
      },
      draw(camera) {
        if (!bounds || gl.isContextLost()) return;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(rect.width * pixelRatio));
        const h = Math.max(1, Math.round(rect.height * pixelRatio));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
          gl.viewport(0, 0, w, h);
        }
        const { yaw, elevation, zoom } = camera;
        const sy = Math.sin(yaw), cy = Math.cos(yaw), se = Math.sin(elevation), ce = Math.cos(elevation);
        const right = [cy, 0, -sy], up = [-sy * se, ce, -cy * se];
        // Fit the default view to its projected bounds. Keep its scale as the scene orbits.
        const [dx, dy, dz] = bounds.half;
        const { yaw: ey, elevation: ep } = initialView;
        const halfWidth = dx * Math.cos(ey) + dz * Math.sin(ey);
        const halfHeight = dx * Math.sin(ey) * Math.sin(ep) + dy * Math.cos(ep) + dz * Math.cos(ey) * Math.sin(ep);
        const base = Math.max(.001, halfHeight, halfWidth * h / w);
        const scale = .91 * zoom / base;
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.uniform3fv(uniform.Center, bounds.center);
        gl.uniform3fv(uniform.Right, right);
        gl.uniform3fv(uniform.Up, up);
        gl.uniform3f(uniform.TowardCamera, sy * ce, se, cy * ce);
        gl.uniform3f(uniform.Scale, scale * h / w, scale, .96 / bounds.radius);
        const pointSize = clamp(Math.sqrt(rect.width * rect.height / bounds.count) * .8, 1.25, 3.5);
        gl.uniform1f(uniform.PointSize, clamp(pointSize * pixelRatio * Math.sqrt(zoom), minPoint, maxPoint));
        gl.drawArrays(gl.POINTS, 0, bounds.count);
      }
    };
  }

  const defaultCamera = () => ({ ...initialView });
  function init() {
    const box = document.getElementById("cloud-box");
    if (!box) return;
    const canvas = box.querySelector("#cloud-canvas");
    const start = box.querySelector("#start-3d"), reset = box.querySelector("#reset-view");
    const title = box.querySelector("#cloud-name"), note = box.querySelector("#cloud-note");
    const screen = box.querySelector(".cloud-screen");
    const poster = document.createElement("img");
    poster.className = "cloud-poster";
    poster.alt = "";
    poster.hidden = true;
    poster.addEventListener("error", () => { poster.hidden = true; });
    screen.prepend(poster);
    canvas.hidden = true;
    box.hidden = false;
    let scenes = [], selected = 0, graphics, ready = false, request = 0;
    let camera = defaultCamera(), frame = 0, controller, manifestPromise, select;

    function draw() {
      if (!ready || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; if (ready) graphics.draw(camera); });
    }
    function resetCamera() { camera = defaultCamera(); draw(); }
    function orbit(dx, dy) {
      camera.yaw -= dx;
      camera.elevation = clamp(camera.elevation + dy, -1.54, 1.54);
      draw();
    }
    function zoomBy(factor) { camera.zoom = clamp(camera.zoom * factor, .3, 10); draw(); }
    function assetURL(value, suffix) {
      if (typeof value !== "string" || !value.trim()) return null;
      let url;
      try { url = new URL(value, document.baseURI); } catch { return null; }
      const assets = new URL("./assets/", document.baseURI);
      return url.origin === assets.origin && url.pathname.startsWith(assets.pathname)
        && url.pathname.toLowerCase().endsWith(suffix) ? url.href : null;
    }
    function galleryPoster(scene) {
      const key = value => value.toLowerCase().replace(/[^a-z0-9]/g, "");
      const identity = key(scene.name + " " + new URL(scene.file).pathname.split("/").pop());
      for (const anchor of document.querySelectorAll("#scene-gallery a.scene")) {
        const label = anchor.querySelector("span");
        if (!label) continue;
        const link = anchor.getAttribute("href") || "";
        const slug = key(link.split("/").pop().replace(/\.png$/i, ""));
        // Only match the actual sequence, not a dataset name in isolation.
        const sequence = key(label.textContent);
        if ((slug && identity.includes(slug)) || (sequence && identity.includes(sequence))) {
          return assetURL(link, ".png");
        }
      }
      return null;
    }
    function preview() {
      const scene = scenes[selected];
      const source = scene && (scene.preview || galleryPoster(scene));
      ready = false;
      canvas.hidden = true;
      reset.hidden = true;
      start.hidden = false;
      poster.hidden = !source;
      if (source) poster.src = source;
      title.textContent = scene ? "Interactive point cloud · " + scene.name : "Interactive point cloud";
    }
    function fallback(message) {
      preview();
      start.disabled = false;
      start.textContent = "Retry 3D view";
      note.replaceChildren(document.createTextNode(message + " "));
      const link = document.createElement("a");
      link.href = "#scene-gallery";
      link.textContent = "View the sequence gallery.";
      note.append(link);
    }
    async function loadManifest() {
      if (scenes.length) return;
      if (manifestPromise) return manifestPromise;
      manifestPromise = (async () => {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 18000);
        try {
          const response = await fetch("assets/scenes.json", { signal: abort.signal });
          if (!response.ok) throw Error("Scene list is unavailable.");
          const entries = await response.json();
          if (!Array.isArray(entries)) throw Error("Invalid scene list.");
          scenes = entries.filter(item => item && typeof item.name === "string" && item.name.trim()
              && Number.isSafeInteger(item.count) && item.count > 0 && item.count <= 6000000
              && assetURL(item.file, ".bin"))
            .map(item => ({ name: item.name.trim(), count: item.count, file: assetURL(item.file, ".bin"),
              preview: assetURL(item.preview, ".png") }));
          if (!scenes.length) throw Error("No preview scenes are available.");
          if (scenes.length > 1) {
            const label = document.createElement("label");
            label.className = "cloud-chooser";
            label.append("Scene ");
            select = document.createElement("select");
            scenes.forEach((scene, i) => select.add(new Option(scene.name, String(i))));
            label.append(select);
            reset.before(label);
            select.addEventListener("change", () => {
              const active = ready || start.disabled;
              selected = Number(select.value);
              if (active) loadScene();
              else { preview(); start.textContent = "Load 3D view"; note.textContent = "Open this scene to explore its reconstruction."; }
            });
          }
          preview();
        } finally {
          clearTimeout(timer);
        }
      })();
      try { await manifestPromise; } finally { manifestPromise = null; }
    }
    async function loadScene() {
      const token = ++request;
      if (controller) controller.abort();
      const abort = new AbortController();
      controller = abort;
      const timeout = setTimeout(() => abort.abort(), 45000);
      preview();
      start.disabled = true;
      start.textContent = "Loading…";
      note.textContent = "Loading the reconstruction.";
      try {
        await loadManifest();
        if (request !== token) return;
        const scene = scenes[selected];
        graphics ||= renderer(canvas);
        const response = await fetch(scene.file, { signal: abort.signal });
        if (!response.ok) throw Error("Scene download failed.");
        const bytes = await response.arrayBuffer();
        if (request !== token) return;
        graphics.set(decodeCloud(bytes, scene.count));
        ready = true;
        canvas.hidden = false;
        poster.hidden = true;
        start.hidden = true;
        reset.hidden = false;
        resetCamera();
        if (document.activeElement !== select) canvas.focus({ preventScroll: true });
        note.textContent = "Drag or use the arrow keys to orbit. Scroll, pinch or use + and − to zoom.";
      } catch {
        if (request === token) fallback("The 3D view could not be opened.");
      } finally {
        clearTimeout(timeout);
        if (request === token) { start.disabled = false; controller = null; }
      }
    }
    start.addEventListener("click", loadScene);
    reset.addEventListener("click", () => { resetCamera(); canvas.focus({ preventScroll: true }); });
    canvas.addEventListener("webglcontextlost", event => {
      event.preventDefault();
      ++request;
      if (controller) controller.abort();
      graphics = null;
      fallback("The graphics context was interrupted.");
    });
    canvas.addEventListener("webglcontextrestored", () => {
      note.textContent = "Graphics are available again. Reload the 3D view to continue.";
    });
    canvas.addEventListener("keydown", event => {
      if (!ready || event.altKey || event.ctrlKey || event.metaKey) return;
      const step = .12;
      switch (event.key) {
        case "ArrowLeft": orbit(-step, 0); break;
        case "ArrowRight": orbit(step, 0); break;
        case "ArrowUp": orbit(0, step); break;
        case "ArrowDown": orbit(0, -step); break;
        case "+": case "=": zoomBy(1.18); break;
        case "-": case "_": zoomBy(1 / 1.18); break;
        case "Home": case "0": resetCamera(); break;
        default: return;
      }
      event.preventDefault();
    });
    canvas.addEventListener("wheel", event => {
      if (!ready) return;
      event.preventDefault();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
      zoomBy(Math.exp(clamp(-pixels * .0015, -.55, .55)));
    }, { passive: false });
    const pointers = new Map();
    const separation = () => {
      const [a, b] = pointers.values();
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    canvas.addEventListener("pointerdown", event => {
      if (!ready || event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    });
    canvas.addEventListener("pointermove", event => {
      const old = pointers.get(event.pointerId);
      if (!old || !ready) return;
      const distance = pointers.size === 2 ? separation() : 0;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 1) orbit((event.clientX - old.x) * .008, (event.clientY - old.y) * .007);
      else if (pointers.size === 2 && distance > 1) zoomBy(separation() / distance);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      canvas.addEventListener(type, event => pointers.delete(event.pointerId));
    }
    if ("ResizeObserver" in window) new ResizeObserver(draw).observe(screen);
    else window.addEventListener("resize", draw);
    note.textContent = "Open a scene to explore its reconstruction.";
    const prepare = () => loadManifest().catch(() => {
      if (!start.disabled) fallback("The scene list could not be loaded.");
    });
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(items => {
        if (items.some(item => item.isIntersecting)) { observer.disconnect(); prepare(); }
      }, { rootMargin: "300px" });
      observer.observe(box);
    } else { prepare(); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
