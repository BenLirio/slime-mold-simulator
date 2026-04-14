// Physarum polycephalum — Slime Mold Simulator
// Agents sense pheromone ahead (left/center/right), steer toward highest,
// deposit trail, trail diffuses and decays each frame.
// Food sources act as persistent pheromone emitters.

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────────
  const SENSOR_ANGLE   = Math.PI / 4;   // 45° from forward
  const SENSOR_DIST    = 9;             // pixels ahead to sample
  const TURN_SPEED     = Math.PI / 6;   // max steer per frame
  const MOVE_SPEED     = 1.2;           // pixels per frame
  const FOOD_STRENGTH  = 220;           // pheromone emitted per food per frame
  const FOOD_RADIUS    = 16;            // radius around food that receives pheromone
  const DEPOSIT_AMOUNT = 5;             // pheromone each agent deposits
  const DIFFUSE_K      = 0.18;          // 3×3 blur weight
  // decay is controlled by slider

  // ─── State ────────────────────────────────────────────────────────────────
  let canvas, ctx, W, H;
  let trailMap;        // Float32Array, W×H
  let agentX, agentY, agentAngle;  // Float32Arrays
  let numAgents = 20000;
  let decayRate = 3;   // 1–6 → mapped to actual value
  let foodSources = []; // [{x, y}]
  let running = true;
  let hasInteracted = false;
  let frameCount = 0;
  let rafId;

  // ─── Init ─────────────────────────────────────────────────────────────────
  function init() {
    canvas = document.getElementById('sim-canvas');
    ctx    = canvas.getContext('2d', { willReadFrequently: true });

    resizeCanvas();
    window.addEventListener('resize', () => { resizeCanvas(); resetSim(); });

    setupAgents();
    setupUI();
    loop();
  }

  function resizeCanvas() {
    const wrapper = document.getElementById('canvas-wrapper');
    const dpr     = Math.min(window.devicePixelRatio || 1, 2);
    const cssW    = wrapper.clientWidth;
    // Aspect: keep square-ish on mobile, wider on desktop
    const cssH    = Math.min(cssW, Math.round(window.innerHeight * 0.55));

    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width  = cssW + 'px';
    canvas.style.height = cssH + 'px';

    ctx.scale(dpr, dpr);
    W = cssW;
    H = cssH;

    trailMap = new Float32Array(W * H);
  }

  function setupAgents() {
    agentX     = new Float32Array(numAgents);
    agentY     = new Float32Array(numAgents);
    agentAngle = new Float32Array(numAgents);

    // Seed agents in a small central cluster
    const cx = W / 2, cy = H / 2;
    const spread = Math.min(W, H) * 0.06;
    for (let i = 0; i < numAgents; i++) {
      const r = Math.random() * spread;
      const a = Math.random() * Math.PI * 2;
      agentX[i]     = cx + Math.cos(a) * r;
      agentY[i]     = cy + Math.sin(a) * r;
      agentAngle[i] = Math.random() * Math.PI * 2;
    }
  }

  // ─── Simulation step ──────────────────────────────────────────────────────
  function stepSim() {
    // 1. Emit pheromone at food sources
    for (const f of foodSources) {
      const fx = Math.round(f.x), fy = Math.round(f.y);
      for (let dy = -FOOD_RADIUS; dy <= FOOD_RADIUS; dy++) {
        for (let dx = -FOOD_RADIUS; dx <= FOOD_RADIUS; dx++) {
          if (dx * dx + dy * dy > FOOD_RADIUS * FOOD_RADIUS) continue;
          const nx = fx + dx, ny = fy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const dist = Math.sqrt(dx * dx + dy * dy) + 1;
          trailMap[ny * W + nx] = Math.min(255, trailMap[ny * W + nx] + FOOD_STRENGTH / dist);
        }
      }
    }

    // 2. Update agents
    for (let i = 0; i < numAgents; i++) {
      const x = agentX[i], y = agentY[i], angle = agentAngle[i];

      // Sense: center, left, right
      const cVal = senseAt(x, y, angle, SENSOR_DIST);
      const lVal = senseAt(x, y, angle - SENSOR_ANGLE, SENSOR_DIST);
      const rVal = senseAt(x, y, angle + SENSOR_ANGLE, SENSOR_DIST);

      let newAngle = angle;
      if (cVal > lVal && cVal > rVal) {
        // Keep heading
      } else if (lVal > rVal) {
        newAngle -= TURN_SPEED;
      } else if (rVal > lVal) {
        newAngle += TURN_SPEED;
      } else {
        // Tie: random small jitter
        newAngle += (Math.random() - 0.5) * TURN_SPEED;
      }

      // Move
      let nx = x + Math.cos(newAngle) * MOVE_SPEED;
      let ny = y + Math.sin(newAngle) * MOVE_SPEED;

      // Bounce off walls
      if (nx < 0 || nx >= W) { newAngle = Math.PI - newAngle; nx = Math.max(0, Math.min(W - 1, nx)); }
      if (ny < 0 || ny >= H) { newAngle = -newAngle; ny = Math.max(0, Math.min(H - 1, ny)); }

      agentX[i]     = nx;
      agentY[i]     = ny;
      agentAngle[i] = newAngle;

      // Deposit
      const pi = Math.round(ny) * W + Math.round(nx);
      if (pi >= 0 && pi < trailMap.length) {
        trailMap[pi] = Math.min(255, trailMap[pi] + DEPOSIT_AMOUNT);
      }
    }

    // 3. Diffuse + decay
    diffuseDecay();
  }

  function senseAt(x, y, angle, dist) {
    const sx = Math.round(x + Math.cos(angle) * dist);
    const sy = Math.round(y + Math.sin(angle) * dist);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return 0;
    return trailMap[sy * W + sx];
  }

  function diffuseDecay() {
    // Map slider 1–6 → decay subtract per frame (higher = faster fade)
    const decaySubtract = [0.4, 0.8, 1.4, 2.2, 3.4, 5.0][decayRate - 1];
    const next = new Float32Array(trailMap.length);
    const k = DIFFUSE_K;
    const center_w = 1 - 8 * k;

    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const idx = y * W + x;
        const diffused =
          trailMap[idx] * center_w +
          (trailMap[(y-1)*W+(x-1)] + trailMap[(y-1)*W+x] + trailMap[(y-1)*W+(x+1)] +
           trailMap[y*W+(x-1)]                            + trailMap[y*W+(x+1)] +
           trailMap[(y+1)*W+(x-1)] + trailMap[(y+1)*W+x] + trailMap[(y+1)*W+(x+1)]) * k;
        next[idx] = Math.max(0, diffused - decaySubtract);
      }
    }
    trailMap = next;
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  function render() {
    // Build ImageData from trailMap
    const imageData = ctx.createImageData(W, H);
    const data = imageData.data;

    for (let i = 0; i < trailMap.length; i++) {
      const v = trailMap[i];
      if (v <= 0) {
        // Deep background: near-black with slight green tint
        data[i*4+0] = 2;
        data[i*4+1] = 4;
        data[i*4+2] = 2;
        data[i*4+3] = 255;
      } else {
        // Map trail intensity to amber→green color gradient
        const t = Math.min(1, v / 120);
        // Low: deep amber; high: bright yellow-green
        const r = Math.round(lerp(140, 240, t));
        const g = Math.round(lerp(60, 200, t));
        const b = Math.round(lerp(2, 20, t));
        data[i*4+0] = r;
        data[i*4+1] = g;
        data[i*4+2] = b;
        data[i*4+3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);

    // Draw food sources
    for (const f of foodSources) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(f.x, f.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 230, 80, 0.9)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 200, 20, 0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      // Outer glow ring
      ctx.save();
      ctx.beginPath();
      ctx.arc(f.x, f.y, 14, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(232, 160, 32, 0.25)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // ─── Main loop ────────────────────────────────────────────────────────────
  function loop() {
    if (!running) return;
    stepSim();
    render();
    frameCount++;
    rafId = requestAnimationFrame(loop);
  }

  // ─── Reset ────────────────────────────────────────────────────────────────
  function resetSim() {
    foodSources = [];
    trailMap = new Float32Array(W * H);
    setupAgents();
    hasInteracted = false;
    document.getElementById('pre-interaction').classList.remove('hidden');
  }

  // ─── UI ───────────────────────────────────────────────────────────────────
  function setupUI() {
    // Agent count slider
    const agentSlider = document.getElementById('agent-count');
    const agentDisplay = document.getElementById('agent-count-display');
    agentSlider.addEventListener('input', () => {
      numAgents = parseInt(agentSlider.value, 10);
      agentDisplay.textContent = (numAgents / 1000).toFixed(0) + 'k';
      // Rebuild agent arrays
      agentX     = new Float32Array(numAgents);
      agentY     = new Float32Array(numAgents);
      agentAngle = new Float32Array(numAgents);
      const cx = W / 2, cy = H / 2;
      const spread = Math.min(W, H) * 0.06;
      for (let i = 0; i < numAgents; i++) {
        const r = Math.random() * spread;
        const a = Math.random() * Math.PI * 2;
        agentX[i]     = cx + Math.cos(a) * r;
        agentY[i]     = cy + Math.sin(a) * r;
        agentAngle[i] = Math.random() * Math.PI * 2;
      }
    });

    // Decay slider
    const decaySlider = document.getElementById('decay-rate');
    const decayDisplay = document.getElementById('decay-display');
    const decayLabels = ['glacial', 'slow', 'medium', 'fast', 'brisk', 'frantic'];
    decaySlider.addEventListener('input', () => {
      decayRate = parseInt(decaySlider.value, 10);
      decayDisplay.textContent = decayLabels[decayRate - 1];
    });

    // Reset button
    document.getElementById('reset-btn').addEventListener('click', resetSim);

    // Save button
    document.getElementById('save-btn').addEventListener('click', saveOrganism);

    // Share button
    document.getElementById('share-btn').addEventListener('click', share);

    // Canvas interaction — add/drag food sources
    setupCanvasInteraction();
  }

  function setupCanvasInteraction() {
    let isDragging = false;
    let dragTarget = null; // index into foodSources if dragging existing

    function canvasPos(e) {
      const rect = canvas.getBoundingClientRect();
      const src  = e.touches ? e.touches[0] : e;
      return {
        x: (src.clientX - rect.left) * (W / rect.width),
        y: (src.clientY - rect.top)  * (H / rect.height),
      };
    }

    function nearestFood(pos, threshold = 22) {
      let best = -1, bestDist = threshold * threshold;
      for (let i = 0; i < foodSources.length; i++) {
        const dx = foodSources[i].x - pos.x;
        const dy = foodSources[i].y - pos.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist) { bestDist = d2; best = i; }
      }
      return best;
    }

    function onStart(e) {
      e.preventDefault();
      isDragging = true;
      const pos = canvasPos(e);
      const near = nearestFood(pos);
      if (near >= 0) {
        dragTarget = near;
      } else {
        // Place new food
        foodSources.push({ x: pos.x, y: pos.y });
        dragTarget = foodSources.length - 1;
        if (!hasInteracted) {
          hasInteracted = true;
          document.getElementById('pre-interaction').classList.add('hidden');
        }
      }
    }

    function onMove(e) {
      if (!isDragging || dragTarget === null) return;
      e.preventDefault();
      const pos = canvasPos(e);
      foodSources[dragTarget].x = pos.x;
      foodSources[dragTarget].y = pos.y;
    }

    function onEnd(e) {
      isDragging = false;
      dragTarget = null;
    }

    // Double-tap / double-click to remove food
    let lastTap = 0;
    canvas.addEventListener('dblclick', (e) => {
      const pos = canvasPos(e);
      const near = nearestFood(pos, 30);
      if (near >= 0) foodSources.splice(near, 1);
    });

    canvas.addEventListener('touchstart', (e) => {
      const now = Date.now();
      if (now - lastTap < 300) {
        // Double-tap: remove
        const pos = canvasPos(e);
        const near = nearestFood(pos, 30);
        if (near >= 0) { foodSources.splice(near, 1); return; }
      }
      lastTap = now;
      onStart(e);
    }, { passive: false });

    canvas.addEventListener('touchmove',  onMove,  { passive: false });
    canvas.addEventListener('touchend',   onEnd,   { passive: false });
    canvas.addEventListener('mousedown',  onStart);
    canvas.addEventListener('mousemove',  onMove);
    canvas.addEventListener('mouseup',    onEnd);
    canvas.addEventListener('mouseleave', onEnd);
  }

  // ─── Save organism ─────────────────────────────────────────────────────────
  function saveOrganism() {
    // Render one more frame without the cursor overlay, then export
    const link = document.createElement('a');
    link.download = 'physarum-' + Date.now() + '.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  // ─── Share ────────────────────────────────────────────────────────────────
  function share() {
    const url  = window.location.href;
    const text = 'Watch slime mold self-organize into optimal networks — a single-celled organism that once redesigned Tokyo\'s subway map.';
    if (navigator.share) {
      navigator.share({ title: 'Physarum — Slime Mold Simulator', text, url })
        .catch(() => {});
    } else {
      navigator.clipboard.writeText(url)
        .then(() => {
          const btn = document.getElementById('share-btn');
          const orig = btn.textContent;
          btn.textContent = 'Link copied!';
          setTimeout(() => { btn.textContent = orig; }, 2000);
        })
        .catch(() => {
          prompt('Copy this link:', url);
        });
    }
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
