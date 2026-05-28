/* ============================================================
   THE SCENE — HOLOGRAPHIC SHADER  (v6 — silver foil + rainbow shines)
   ────────────────────────────────────────────────────────────
   Architecture matches the Maximage Color Combinations reference:
   silver metal is the dominant aesthetic; rainbow appears only
   inside the specular "shine" zones (instead of those highlights
   being white as on regular chrome). Read the card as: polished
   silver foil where reflected light has been split by a prism.

   Public API:
     window.HoloShader.init()    — call once after DOM ready
     window.HoloShader.refresh() — call after a feed re-render
     window.HoloShader.destroy() — tear down (rare)

   Per-card canvas — one <canvas> child per holo card. Canvas
   scrolls naturally with the card; no scissor math, no chase.
   Silently no-ops if WebGL is unavailable.
   ============================================================ */

(function () {
  'use strict';

  const HOLO_SELECTOR = '.gig-card[data-curated="3"]';
  const ACTIVE_CLASS  = 'holo-shader-active';
  const CANVAS_CLASS  = 'holo-shader-card-canvas';

  /* ── Shader sources ───────────────────────────────────── */

  const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

  const FRAGMENT_SHADER = `
precision mediump float;

uniform vec2  u_resolution;
uniform float u_scroll;
uniform float u_time;

varying vec2 v_uv;

/* 2D simplex noise — Stefan Gustavson / Ashima, public domain */
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
  m = m*m;
  m = m*m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

/* HSV → RGB. Used to generate the rainbow palette inside shine zones. */
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec2 uv = v_uv;

  /* ── 1. GLOSSY SILVER BASE ──
     Pure smooth gloss — no brushed-metal anisotropy, no foil grain.
     Reads as polished glass-chrome rather than matte foil. */
  vec3 silver = mix(vec3(0.96, 0.96, 0.98),
                    vec3(0.78, 0.78, 0.85), uv.y);

  /* ── 2. RAINBOW PALETTE — COMPRESSED ──
     1.4× hue cycles across the card so the FULL red→violet spectrum
     is visible within each shine zone, not just half the wheel.
     Higher saturation (0.70 vs 0.60) + larger wobble (0.22 vs 0.08)
     so each bloom shows multiple bands of colour, not one dominant hue. */
  float hueAxis = (uv.x * 0.65 + uv.y * 0.55) * 1.4 + u_scroll * 0.50;
  float wobble  = snoise(uv * 4.0) * 0.22;
  vec3  rainbow = hsv2rgb(vec3(fract(hueAxis + wobble), 0.70, 1.0));

  /* ── 3. SHINE MAP — HIGHER ANIMATION BANDWIDTH ──
     Drift amplitude doubled (0.10 vs 0.045). Two-frequency motion
     (slow primary + faster secondary harmonic) so the bloom positions
     evolve in a non-linear, organic way as the card scrolls. */
  float scrollT = u_scroll * 6.28;
  vec2 driftA = (
    vec2(sin(scrollT + 0.5),       cos(scrollT + 0.5))       * 0.7 +
    vec2(sin(scrollT * 2.3 + 1.0), cos(scrollT * 2.3 + 1.0)) * 0.3
  ) * 0.10;
  vec2 driftB = (
    vec2(cos(scrollT + 2.5),       sin(scrollT + 2.5))       * 0.7 +
    vec2(cos(scrollT * 1.7 + 3.0), sin(scrollT * 1.7 + 3.0)) * 0.3
  ) * 0.10;

  float shine = 0.0;
  /* Upper-right primary bloom (dominant Maximage shine) */
  shine = max(shine, exp(-distance(uv, vec2(0.62, 0.25) + driftA) * 1.6));
  /* Lower-left secondary bloom */
  shine = max(shine, exp(-distance(uv, vec2(0.22, 0.78) + driftB) * 2.0) * 0.85);
  /* Lower-right tertiary bloom */
  shine = max(shine, exp(-distance(uv, vec2(0.82, 0.82) + driftA * vec2(-1.0, 1.0)) * 2.2) * 0.75);
  /* Upper-left minor bloom */
  shine = max(shine, exp(-distance(uv, vec2(0.18, 0.30) + driftB * vec2(1.0, -1.0)) * 2.6) * 0.55);

  /* ── 4. COMPOSITE ── */
  vec3 color = mix(silver, rainbow, shine * 0.80);

  /* ── 5. WIDE GLOSSY SPECULAR ──
     Wider (×5.5 vs ×7.0) and brighter (0.45 vs 0.35) for the wet-glass
     quality. Travels further with scroll. */
  vec2 specCenter = vec2(0.5 + cos(u_scroll * 6.28) * 0.35,
                         0.25 + u_scroll * 0.50);
  float spec = exp(-distance(uv, specCenter) * 5.5);
  color = mix(color, vec3(1.0), spec * 0.45);

  /* ── 6. GLOSSY EDGE RIM ──
     Bright outline catching reflected light — the liquid-glass edge. */
  float edgeX = smoothstep(0.93, 1.0, abs(uv.x - 0.5) * 2.0);
  float edgeY = smoothstep(0.93, 1.0, abs(uv.y - 0.5) * 2.0);
  float edge = max(edgeX, edgeY);
  color = mix(color, vec3(1.0), edge * 0.25);

  gl_FragColor = vec4(color, 1.0);
}`;

  /* ── Module state ─────────────────────────────────────── */
  const cards = new Map();
  const visible = new Set();
  let cardObserver = null;
  let rafId = 0;
  let initStartTime = 0;
  let initialised = false;

  /* ── WebGL helpers (per-context) ──────────────────────── */
  function compileShader(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[HoloShader] shader compile failed:', gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }

  function createProgram(gl) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('[HoloShader] program link failed:', gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  }

  function createCardState(el) {
    const canvas = document.createElement('canvas');
    canvas.className = CANVAS_CLASS;
    el.insertBefore(canvas, el.firstChild);

    let gl;
    try {
      gl = canvas.getContext('webgl', {
        antialias: false,
        alpha: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      }) || canvas.getContext('experimental-webgl');
    } catch (_e) {
      gl = null;
    }

    if (!gl) {
      canvas.remove();
      return null;
    }

    const program = createProgram(gl);
    if (!program) {
      canvas.remove();
      return null;
    }

    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
      -1,  1,  1, -1,   1, 1,
    ]), gl.STATIC_DRAW);

    const posLoc    = gl.getAttribLocation(program,  'a_position');
    const resLoc    = gl.getUniformLocation(program, 'u_resolution');
    const scrollLoc = gl.getUniformLocation(program, 'u_scroll');
    const timeLoc   = gl.getUniformLocation(program, 'u_time');

    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    el.classList.add(ACTIVE_CLASS);

    return { el, canvas, gl, program, resLoc, scrollLoc, timeLoc, lastSize: null };
  }

  function ensureSize(card) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = card.el.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width  * dpr));
    const h = Math.max(1, Math.floor(r.height * dpr));
    if (card.lastSize && card.lastSize.w === w && card.lastSize.h === h) return;
    card.lastSize = { w, h };
    card.canvas.width  = w;
    card.canvas.height = h;
    card.gl.viewport(0, 0, w, h);
    card.gl.uniform2f(card.resLoc, r.width, r.height);
  }

  function renderOne(card, time, vh) {
    ensureSize(card);
    const r = card.el.getBoundingClientRect();
    const progress = 1 - (r.top + r.height * 0.5) / vh;
    const scroll = progress < 0 ? 0 : progress > 1 ? 1 : progress;
    card.gl.uniform1f(card.scrollLoc, scroll);
    card.gl.uniform1f(card.timeLoc, time);
    card.gl.drawArrays(card.gl.TRIANGLES, 0, 6);
  }

  function render() {
    rafId = 0;
    if (visible.size === 0) return;
    const time = (performance.now() - initStartTime) / 1000;
    const vh = window.innerHeight || 1;
    for (const el of visible) {
      const card = cards.get(el);
      if (card) renderOne(card, time, vh);
    }
  }

  function scheduleRender() {
    if (rafId || visible.size === 0) return;
    rafId = requestAnimationFrame(render);
  }

  function setupObserver() {
    cardObserver = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target);
        else visible.delete(e.target);
      }
      scheduleRender();
    }, { rootMargin: '100px 0px' });
  }

  /* ── Public API ──────────────────────────────────────── */
  function init() {
    if (initialised) return true;
    if (!window.WebGLRenderingContext) {
      console.warn('[HoloShader] WebGL unavailable — CSS fallback will be used');
      return false;
    }
    initStartTime = performance.now();
    setupObserver();
    refresh();
    window.addEventListener('scroll', scheduleRender, { passive: true });
    window.addEventListener('resize', scheduleRender, { passive: true });
    initialised = true;
    console.log('[HoloShader v7] initialised — glossy silver + full-spectrum shines');
    return true;
  }

  function refresh() {
    if (!cardObserver) return;
    const els = document.querySelectorAll(HOLO_SELECTOR);
    const seen = new Set();
    let added = 0;

    for (const el of els) {
      seen.add(el);
      if (!cards.has(el)) {
        const card = createCardState(el);
        if (card) {
          cards.set(el, card);
          cardObserver.observe(el);
          added++;
        }
      }
    }

    for (const [el, card] of cards) {
      if (!seen.has(el)) {
        cardObserver.unobserve(el);
        visible.delete(el);
        card.canvas.remove();
        el.classList.remove(ACTIVE_CLASS);
        cards.delete(el);
      }
    }

    console.log('[HoloShader] refresh:', cards.size, 'card(s) total,', added, 'added');
  }

  /* Force one render frame for all known cards, ignoring intersection state.
     Used when cards are injected into fixed/modal containers where the
     IntersectionObserver may not fire (e.g. WKWebView fixed stacking context). */
  function forceRender() {
    if (cards.size === 0) return;
    const time = (performance.now() - initStartTime) / 1000;
    const vh = window.innerHeight || 1;
    for (const [, card] of cards) {
      visible.add(card.el);
      renderOne(card, time, vh);
    }
    scheduleRender();
  }

  function destroy() {
    if (cardObserver) cardObserver.disconnect();
    cardObserver = null;
    for (const [el, card] of cards) {
      card.canvas.remove();
      el.classList.remove(ACTIVE_CLASS);
    }
    cards.clear();
    visible.clear();
    initialised = false;
  }

  window.HoloShader = { init, refresh, forceRender, destroy };
})();
