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
  let offscreen, offCtx;     // CSS-pixel-sized buffer we render the sim into
  let trailMap;              // Float32Array, W×H (CSS pixels)
  let agentX, agentY, agentAngle;  // Float32Arrays
  let numAgents = 20000;
  let decayRate = 3;   // 1–6 → mapped to actual value
  let foodSources = []; // [{x, y}]
  let running = true;
  let hasInteracted = false;
  let frameCount = 0;
  let rafId;
  let editMode = true;       // when false, canvas ignores pointer/touch input
                             // and lets the page scroll past it.

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
    const cssW    = Math.max(1, wrapper.clientWidth);
    // Aspect: keep square-ish on mobile, wider on desktop
    const cssH    = Math.max(1, Math.min(cssW, Math.round(window.innerHeight * 0.55)));

    // Backing buffer matches the on-screen size so the sim fills the box exactly.
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width  = cssW + 'px';
    canvas.style.height = cssH + 'px';

    // We do NOT scale the main ctx here. We render the sim into an
    // offscreen buffer at simulation resolution (W×H), then drawImage it
    // stretched across the whole device-pixel canvas. This makes the visible
    // image exactly fill the canvas regardless of DPR — fixing the bug where
    // the sim only covered a fraction of the box and touches felt offset.
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    W = cssW;
    H = cssH;

    offscreen = document.createElement('canvas');
    offscreen.width  = W;
    offscreen.height = H;
    offCtx = offscreen.getContext('2d');

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
    // Build ImageData from trailMap into the OFFSCREEN buffer (W×H CSS pixels)
    const imageData = offCtx.createImageData(W, H);
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

    offCtx.putImageData(imageData, 0, 0);

    // Draw food sources into the offscreen buffer (in CSS-pixel coords,
    // matching the input coordinate space).
    for (const f of foodSources) {
      offCtx.save();
      offCtx.beginPath();
      offCtx.arc(f.x, f.y, 7, 0, Math.PI * 2);
      offCtx.fillStyle = 'rgba(255, 230, 80, 0.9)';
      offCtx.fill();
      offCtx.strokeStyle = 'rgba(255, 200, 20, 0.5)';
      offCtx.lineWidth = 2;
      offCtx.stroke();
      offCtx.restore();

      // Outer glow ring
      offCtx.save();
      offCtx.beginPath();
      offCtx.arc(f.x, f.y, 14, 0, Math.PI * 2);
      offCtx.strokeStyle = 'rgba(232, 160, 32, 0.25)';
      offCtx.lineWidth = 3;
      offCtx.stroke();
      offCtx.restore();
    }

    // Stretch the offscreen buffer over the entire visible canvas. Because
    // both source and dest fill their full extents, what the user sees lines
    // up perfectly with the input coordinate system used by canvasPos().
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(offscreen, 0, 0, W, H, 0, 0, canvas.width, canvas.height);
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
    // Clear scenario state so the UI reflects a blank slate.
    activeScenario = null;
    document.querySelectorAll('.btn-scenario').forEach(b => b.classList.remove('active'));
    const narration = document.getElementById('scenario-narration');
    if (narration) narration.classList.add('narration-hidden');
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

    // Edit-mode toggle — controls whether the canvas captures touch events
    // (so mobile users can scroll the page past the canvas).
    setupEditToggle();

    // Scenario presets + guided lessons
    setupScenarios();
  }

  // ─── Scenarios ────────────────────────────────────────────────────────────
  // Each scenario can: pre-place food (normalized coords 0..1),
  // set agent count and decay, and start a narration sequence.
  const SCENARIOS = {
    tokyo: {
      label: 'The Tokyo Experiment',
      agents: 30000,
      decay: 3,
      // Normalized approximations of 12 major Tokyo loop stations.
      // We don't need geographic precision — we want a recognizable ring
      // with a central hub so the slime's solution visibly echoes the
      // Yamanote line.
      food: [
        [0.50, 0.18], // Ikebukuro (north)
        [0.62, 0.22],
        [0.72, 0.30], // Ueno
        [0.78, 0.44],
        [0.80, 0.58], // Tokyo Station
        [0.74, 0.70],
        [0.60, 0.78], // Shinagawa (south)
        [0.44, 0.78],
        [0.30, 0.70], // Shibuya
        [0.22, 0.56], // Shinjuku
        [0.28, 0.40],
        [0.40, 0.26],
        [0.50, 0.50], // central hub — Tokyo city core
      ],
      narration: [
        {
          title: 'Tokyo · Step 1',
          body: '36 oat flakes. 12 of them shown here, placed at major rail stations around Tokyo. The slime mold starts from the center. What network will it grow?'
        },
        {
          title: 'Tokyo · Step 2',
          body: 'Food emits a chemical trail. Agents everywhere sense it, drift toward it, and leave their own pheromone behind — reinforcing paths that got there first.'
        },
        {
          title: 'Tokyo · Step 3',
          body: 'Watch the tendrils thin out. Weak branches fade, strong ones thicken. The emerging network is startlingly close to Tokyo\'s actual Yamanote loop + radial lines — engineered by a cell with no brain.'
        },
        {
          title: 'Tokyo · Done',
          body: 'Human engineers took ~100 years to plan this. The slime got there in a day. Now try moving or adding "stations" yourself — switch to Edit mode and tap the canvas.'
        },
      ],
    },
    lesson1: {
      label: 'Lesson 1 · Sense',
      agents: 800,      // few enough that you can almost see individuals
      decay: 5,         // fast fade so trails don't dominate
      food: [[0.75, 0.50]],
      narration: [
        {
          title: 'Sense · 1 of 3',
          body: 'One food source, on the right. The organism doesn\'t see it. No eyes. No brain. It only knows the concentration of a chemical in the space right in front of it.'
        },
        {
          title: 'Sense · 2 of 3',
          body: 'Each agent has three "nostrils" — left, center, right. Every frame, it samples the trail intensity at each one.'
        },
        {
          title: 'Sense · 3 of 3',
          body: 'That\'s the whole input. Three numbers. From that, it must decide which way to turn. Ready for the steering rule?'
        },
      ],
    },
    lesson2: {
      label: 'Lesson 2 · Steer',
      agents: 3000,
      decay: 4,
      food: [[0.25, 0.30], [0.75, 0.70]],
      narration: [
        {
          title: 'Steer · 1 of 3',
          body: 'Two food sources now. The steering rule is brutally simple: "turn toward the strongest smell."'
        },
        {
          title: 'Steer · 2 of 3',
          body: 'If center > left and right: keep going. If left > right: turn left a bit. If right > left: turn right a bit. That\'s it. No memory. No planning.'
        },
        {
          title: 'Steer · 3 of 3',
          body: 'But each agent also *leaves its own trail*. Now other agents will smell that trail too. This is the feedback loop that builds the network.'
        },
      ],
    },
    lesson3: {
      label: 'Lesson 3 · Swarm',
      agents: 40000,
      decay: 3,
      food: [
        [0.30, 0.30], [0.70, 0.30], [0.30, 0.70], [0.70, 0.70], [0.50, 0.50],
      ],
      narration: [
        {
          title: 'Swarm · 1 of 3',
          body: 'Five food sources. 40,000 agents, each running that same 3-sensor rule. No leader, no coordination, no message-passing.'
        },
        {
          title: 'Swarm · 2 of 3',
          body: 'Trails that connect food get reinforced by many agents. Trails that wander off decay. Over a few thousand frames, the strong paths win.'
        },
        {
          title: 'Swarm · 3 of 3',
          body: 'What you\'re watching is an optimization algorithm that nature invented before nervous systems. Biologists call it "self-organization." Computer scientists call it a Physarum solver — and use it for real network design.'
        },
      ],
    },
    sandbox: {
      label: 'Sandbox',
      agents: 20000,
      decay: 3,
      food: [],
      narration: null, // no narration — free play
    },
  };

  let activeScenario = null;
  let narrationStep = 0;

  function setupScenarios() {
    const buttons = document.querySelectorAll('.btn-scenario');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.scenario;
        activateScenario(key);
      });
    });

    document.getElementById('narration-close').addEventListener('click', hideNarration);
    document.getElementById('narration-next').addEventListener('click', advanceNarration);
  }

  function activateScenario(key) {
    const s = SCENARIOS[key];
    if (!s) return;
    activeScenario = key;

    // Mark active button
    document.querySelectorAll('.btn-scenario').forEach(b => {
      b.classList.toggle('active', b.dataset.scenario === key);
    });

    // Apply agent count via the slider (keeps UI in sync).
    const agentSlider = document.getElementById('agent-count');
    const agentDisplay = document.getElementById('agent-count-display');
    // Clamp to slider's allowed range.
    const agentsClamped = Math.max(
      parseInt(agentSlider.min, 10),
      Math.min(parseInt(agentSlider.max, 10), s.agents)
    );
    agentSlider.value = agentsClamped;
    numAgents = agentsClamped;
    agentDisplay.textContent = (numAgents / 1000).toFixed(0) + 'k';

    // Decay
    const decaySlider = document.getElementById('decay-rate');
    const decayDisplay = document.getElementById('decay-display');
    const decayLabels = ['glacial', 'slow', 'medium', 'fast', 'brisk', 'frantic'];
    decaySlider.value = s.decay;
    decayRate = s.decay;
    decayDisplay.textContent = decayLabels[decayRate - 1];

    // Reset sim state
    foodSources = [];
    trailMap = new Float32Array(W * H);
    setupAgents();

    // Place food (convert normalized → canvas coords)
    for (const [nx, ny] of s.food) {
      foodSources.push({ x: nx * W, y: ny * H });
    }

    // Pre-interaction hint: hide it for any non-sandbox scenario
    // (the scenario itself is now providing interaction).
    const pre = document.getElementById('pre-interaction');
    if (s.food.length > 0 || s.narration) {
      pre.classList.add('hidden');
      hasInteracted = true;
    } else {
      pre.classList.remove('hidden');
      hasInteracted = false;
    }

    // Narration
    if (s.narration && s.narration.length > 0) {
      narrationStep = 0;
      showNarration(s.narration[0], 1, s.narration.length);
    } else {
      hideNarration();
    }
  }

  function showNarration(entry, stepNum, total) {
    const box = document.getElementById('scenario-narration');
    box.classList.remove('narration-hidden');
    document.getElementById('narration-title').textContent = entry.title;
    document.getElementById('narration-body').textContent = entry.body;
    document.getElementById('narration-step-indicator').textContent =
      'Step ' + stepNum + ' / ' + total;
    const nextBtn = document.getElementById('narration-next');
    nextBtn.textContent = (stepNum >= total) ? 'Got it' : 'Next →';
  }

  function hideNarration() {
    document.getElementById('scenario-narration').classList.add('narration-hidden');
  }

  function advanceNarration() {
    if (!activeScenario) return;
    const s = SCENARIOS[activeScenario];
    if (!s || !s.narration) return;
    narrationStep++;
    if (narrationStep >= s.narration.length) {
      hideNarration();
      return;
    }
    showNarration(s.narration[narrationStep], narrationStep + 1, s.narration.length);
  }

  function setupCanvasInteraction() {
    let isDragging = false;
    let dragTarget = null; // index into foodSources if dragging existing

    function canvasPos(e) {
      // Use the live bounding rect so we always translate page pixels
      // (clientX/Y) into the canvas's CSS-pixel coordinate space — which is
      // also our simulation coordinate space (W×H). This is robust against
      // page scroll, zoom, and DPR.
      const rect = canvas.getBoundingClientRect();
      const src  = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
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
      if (!editMode) return; // Allow native behavior (scroll) when editing is off.
      // Only preventDefault for touch when actually editing — otherwise we
      // would block the user from scrolling past the canvas on mobile.
      if (e.cancelable) e.preventDefault();
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
      if (!editMode) return;
      if (!isDragging || dragTarget === null) return;
      if (e.cancelable) e.preventDefault();
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
      if (!editMode) return;
      const pos = canvasPos(e);
      const near = nearestFood(pos, 30);
      if (near >= 0) foodSources.splice(near, 1);
    });

    canvas.addEventListener('touchstart', (e) => {
      if (!editMode) return;            // Let the touch initiate a page scroll.
      const now = Date.now();
      if (now - lastTap < 300) {
        // Double-tap: remove
        if (e.cancelable) e.preventDefault();
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

  // ─── Edit-mode toggle ─────────────────────────────────────────────────────
  function setupEditToggle() {
    const btn      = document.getElementById('edit-toggle');
    const label    = document.getElementById('edit-toggle-label');
    const wrapper  = document.getElementById('canvas-wrapper');
    const badge    = document.getElementById('edit-badge');

    // Default to OFF on touch-primary devices so users can scroll the page
    // naturally on first load. Desktop users keep the immediate-interaction
    // experience.
    const isTouchPrimary = window.matchMedia &&
      window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    setEditMode(!isTouchPrimary);

    btn.addEventListener('click', () => setEditMode(!editMode));

    function setEditMode(on) {
      editMode = !!on;
      btn.setAttribute('aria-pressed', editMode ? 'true' : 'false');
      label.textContent = editMode ? 'Edit mode: ON' : 'Edit mode: OFF';
      wrapper.classList.toggle('edit-on', editMode);
      if (badge) {
        badge.textContent = editMode
          ? 'EDIT MODE: ON · tap to place food'
          : 'EDIT MODE: OFF · scroll freely';
      }
    }
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
