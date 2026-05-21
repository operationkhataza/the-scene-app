/* ============================================================
   SCENE STUDIO — LIQUID GLASS SHADER (k8 — final reskin)
   ────────────────────────────────────────────────────────────
   Outside panels: TRANSPARENT — page bg (Cape Town photo + cream
   + pastel blooms) shows through cleanly, like the rice-terraces
   bg around the menu in the reference.

   Inside panels: each panel is a glass "bubble" with:
     - Per-panel pastel tint (Palette Perfect, rotates by position)
     - Achromatic lens warp across the whole panel (3D bulge)
     - 45% white frost
     - 8px chromatic-aberration RING at the edge
     - Subtle specular + rim

   Public API:
     window.GlassShader.refresh() — call after panel set changes
     window.GlassShader.destroy() — tear down
   Auto-inits on DOMContentLoaded.
   ============================================================ */

(function () {
  'use strict';

  const CANVAS_CLASS    = 'glass-canvas';
  const PANEL_SELECTOR  = '.auth-card, .sidebar, .topbar, .card, .stat';
  const MAX_PANELS      = 16;
  const PANEL_RADIUS_PX = 16;
  const BG_URL          = 'bg.jpg';

  const VS = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

  const FS = `
precision mediump float;

uniform sampler2D u_bg;
uniform vec2  u_resolution;
uniform vec2  u_bg_size;
uniform int   u_panel_count;
uniform vec4  u_panels[${MAX_PANELS}];
uniform float u_panel_radius;
uniform float u_time;

vec3 sampleBg(vec2 uv) {
  vec2 viewport = u_resolution;
  vec2 bg       = u_bg_size;
  float vp_a = viewport.x / viewport.y;
  float bg_a = bg.x / bg.y;
  vec2 sample_uv;
  if (vp_a > bg_a) {
    float scale = viewport.x / bg.x;
    float scaled_h = bg.y * scale;
    float offset_y = (scaled_h - viewport.y) * 0.5;
    sample_uv = vec2(uv.x, (uv.y * viewport.y + offset_y) / scaled_h);
  } else {
    float scale = viewport.y / bg.y;
    float scaled_w = bg.x * scale;
    float offset_x = (scaled_w - viewport.x) * 0.5;
    sample_uv = vec2((uv.x * viewport.x + offset_x) / scaled_w, uv.y);
  }
  return texture2D(u_bg, sample_uv).rgb;
}

float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

void main() {
  vec2 canvas_xy = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  vec2 viewport_uv = canvas_xy / u_resolution;

  bool inside = false;
  vec4 active_panel = vec4(0.0);
  float active_sdf = 1000.0;

  for (int i = 0; i < ${MAX_PANELS}; i++) {
    if (i >= u_panel_count) break;
    vec4 p = u_panels[i];
    vec2 panel_centre = p.xy + p.zw * 0.5;
    vec2 panel_local  = canvas_xy - panel_centre;
    float sdf = sdRoundedBox(panel_local, p.zw * 0.5, u_panel_radius);
    if (sdf < 0.0 && (!inside || sdf > active_sdf)) {
      inside = true;
      active_panel = p;
      active_sdf = sdf;
    }
  }

  if (!inside) {
    /* Outside panels — transparent. Page bg shows cleanly. */
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }

  /* Inside panel — glass bubble treatment */
  vec2 panel_centre = active_panel.xy + active_panel.zw * 0.5;
  vec2 panel_half   = active_panel.zw * 0.5;
  vec2 from_norm = (canvas_xy - panel_centre) / panel_half;
  float dist_norm = length(from_norm);
  vec2 dir = from_norm / max(dist_norm, 0.0001);

  /* Achromatic lens warp — convex bulge across the whole panel (3D feel) */
  float lens_strength = pow(min(dist_norm, 1.0), 1.6) * 0.025;
  vec2 warped_uv = viewport_uv + dir * lens_strength;

  vec3 warped_bg = sampleBg(warped_uv);

  /* Per-panel pastel tint — Palette Perfect rotation by panel screen pos.
     Each panel ends up with a different colour automatically. */
  vec2 panel_pos_norm = panel_centre / u_resolution;
  float hue = panel_pos_norm.x * 0.5 + panel_pos_norm.y * 0.6;
  vec3 panel_tint = vec3(0.62) + 0.38 * cos(6.28 * (vec3(0.0, 0.33, 0.67) + hue));

  /* Mix tint into bg sample */
  vec3 tinted = mix(warped_bg, panel_tint, 0.30);

  /* 45% white frost — light + legible for white text on top */
  vec3 frosted = mix(tinted, vec3(1.0), 0.45);

  /* 8px edge chromatic-aberration ring — RGB channels split radially
     ONLY in the 8px boundary zone */
  float edge_zone = 1.0 - smoothstep(0.0, 8.0, -active_sdf);
  if (edge_zone > 0.0) {
    float ca_amount = edge_zone * 0.008;
    float r = sampleBg(warped_uv + dir * ca_amount).r;
    float b = sampleBg(warped_uv - dir * ca_amount).b;
    vec3 ca_rgb = vec3(r, frosted.g, b);
    /* Apply same tint + frost to keep edge cohesive with interior */
    ca_rgb = mix(ca_rgb, panel_tint, 0.20);
    ca_rgb = mix(ca_rgb, vec3(1.0), 0.30);
    frosted = mix(frosted, ca_rgb, edge_zone * 0.65);
  }

  /* Subtle top-left specular highlight */
  vec2 corner_uv = (canvas_xy - active_panel.xy) / active_panel.zw;
  vec2 spec_centre = vec2(0.15 + sin(u_time * 0.0003) * 0.015,
                          0.18 + cos(u_time * 0.0004) * 0.015);
  float spec = exp(-distance(corner_uv, spec_centre) * 8.0) * 0.15;
  frosted += vec3(spec);

  /* Visible rim */
  float rim = (1.0 - smoothstep(0.0, 6.0, -active_sdf)) * 0.18;
  frosted += vec3(rim);

  gl_FragColor = vec4(frosted, 1.0);
}`;

  let canvas = null;
  let gl = null;
  let program = null;
  let posBuf = null;
  let bgTexture = null;
  let bgImage = null;
  let bgSize = [1, 1];
  let panelEls = [];
  let rafId = 0;
  let initialised = false;
  let initStartTime = 0;
  let observer = null;

  let uBg, uResolution, uBgSize, uPanelCount, uPanels, uPanelRadius, uTime, posLoc;

  function compileShader(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[GlassShader] compile failed:', gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }

  function createProgram() {
    const vs = compileShader(gl.VERTEX_SHADER, VS);
    const fs = compileShader(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('[GlassShader] link failed:', gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  }

  function setupGeometry() {
    posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
      -1,  1,  1, -1,   1, 1,
    ]), gl.STATIC_DRAW);
  }

  function loadBgTexture() {
    bgTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, bgTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE,
      new Uint8Array([240, 240, 250]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    bgImage = new Image();
    bgImage.onload = () => {
      bgSize = [bgImage.width, bgImage.height];
      gl.bindTexture(gl.TEXTURE_2D, bgTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, bgImage);
      console.log('[GlassShader] bg loaded', bgSize);
      scheduleRender();
    };
    bgImage.onerror = () => console.warn('[GlassShader] failed to load', BG_URL);
    bgImage.src = BG_URL;
  }

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      gl.viewport(0, 0, w, h);
    }
  }

  function readPanelRects() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rects = [];
    for (const el of panelEls) {
      if (rects.length >= MAX_PANELS) break;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      if (r.right < 0 || r.left > window.innerWidth) continue;
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      rects.push([r.left * dpr, r.top * dpr, r.width * dpr, r.height * dpr]);
    }
    return rects;
  }

  function render() {
    rafId = 0;
    if (!gl || !program) return;

    resizeCanvas();
    const rects = readPanelRects();
    const panelData = new Float32Array(MAX_PANELS * 4);
    for (let i = 0; i < rects.length; i++) {
      panelData[i * 4 + 0] = rects[i][0];
      panelData[i * 4 + 1] = rects[i][1];
      panelData[i * 4 + 2] = rects[i][2];
      panelData[i * 4 + 3] = rects[i][3];
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bgTexture);
    gl.uniform1i(uBg, 0);
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform2f(uBgSize, bgSize[0], bgSize[1]);
    gl.uniform1i(uPanelCount, rects.length);
    gl.uniform4fv(uPanels, panelData);
    gl.uniform1f(uPanelRadius, PANEL_RADIUS_PX * Math.min(window.devicePixelRatio || 1, 2));
    gl.uniform1f(uTime, performance.now() - initStartTime);

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(render);
  }

  function refresh() {
    if (!initialised) return;
    panelEls = Array.from(document.querySelectorAll(PANEL_SELECTOR));
    scheduleRender();
  }

  function init() {
    if (initialised) return true;
    if (!window.WebGLRenderingContext) {
      console.warn('[GlassShader] WebGL unavailable — CSS fallback');
      return false;
    }

    canvas = document.createElement('canvas');
    canvas.className = CANVAS_CLASS;
    document.body.insertBefore(canvas, document.body.firstChild);

    try {
      gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false })
        || canvas.getContext('experimental-webgl', { alpha: true, antialias: true });
    } catch (_e) { gl = null; }

    if (!gl) { canvas.remove(); canvas = null; return false; }

    program = createProgram();
    if (!program) { canvas.remove(); canvas = null; gl = null; return false; }

    gl.useProgram(program);

    uBg          = gl.getUniformLocation(program, 'u_bg');
    uResolution  = gl.getUniformLocation(program, 'u_resolution');
    uBgSize      = gl.getUniformLocation(program, 'u_bg_size');
    uPanelCount  = gl.getUniformLocation(program, 'u_panel_count');
    uPanels      = gl.getUniformLocation(program, 'u_panels[0]');
    uPanelRadius = gl.getUniformLocation(program, 'u_panel_radius');
    uTime        = gl.getUniformLocation(program, 'u_time');
    posLoc       = gl.getAttribLocation(program, 'a_position');

    setupGeometry();
    loadBgTexture();
    initStartTime = performance.now();
    refresh();

    window.addEventListener('scroll', scheduleRender, { passive: true });
    window.addEventListener('resize', scheduleRender, { passive: true });

    observer = new MutationObserver(() => scheduleRefresh());
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['style', 'class'],
    });

    initialised = true;
    console.log('[GlassShader k8] initialised — clean bg outside, glass bubbles inside');
    return true;
  }

  let refreshScheduled = false;
  function scheduleRefresh() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    requestAnimationFrame(() => {
      refreshScheduled = false;
      refresh();
    });
  }

  function destroy() {
    if (observer) observer.disconnect();
    if (canvas) canvas.remove();
    canvas = null;
    gl = null;
    program = null;
    initialised = false;
  }

  window.GlassShader = { init, refresh, destroy };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
