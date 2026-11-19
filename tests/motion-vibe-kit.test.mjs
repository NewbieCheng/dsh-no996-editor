import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const motionCode = readFileSync(join(ROOT, 'vendor', 'templates', '_kit', 'motion', 'motion.js'), 'utf8');
const vibeCanvasCode = readFileSync(join(ROOT, 'vendor', 'templates', '_kit', 'vibe', 'vibe-canvas.js'), 'utf8');
const vibeOverlayCode = readFileSync(join(ROOT, 'vendor', 'templates', '_kit', 'vibe', 'vibe-overlay.js'), 'utf8');

function makeMockCtx(w = 1080, h = 1920) {
  return {
    canvas: { width: w, height: h },
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'round',
    lineJoin: 'round',
    globalAlpha: 1,
    font: '400 24px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowColor: 'transparent',
    shadowBlur: 0,
    save() {},
    restore() {},
    setTransform() {},
    translate() {},
    scale() {},
    rotate() {},
    clip() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    bezierCurveTo() {},
    arc() {},
    roundRect() {},
    rect() {},
    fill() {},
    stroke() {},
    fillRect() {},
    drawImage() {},
    strokeText() {},
    fillText() {},
    setLineDash() {},
    measureText(s) { return { width: String(s || '').length * 24 }; },
    createRadialGradient() { return { addColorStop() {} }; },
    createLinearGradient() { return { addColorStop() {} }; },
  };
}

function loadVibeSuite() {
  const sandbox = {
    window: {},
    document: { querySelector: () => null, createElement: () => ({ style: {}, classList: { add() {} } }) },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(motionCode, sandbox, { filename: 'motion.js' });
  vm.runInContext(vibeCanvasCode, sandbox, { filename: 'vibe-canvas.js' });
  vm.runInContext(vibeOverlayCode, sandbox, { filename: 'vibe-overlay.js' });
  return {
    Motion: sandbox.window.Motion,
    VibeKit: sandbox.window.VibeKit,
    VibeOverlay: sandbox.window.VibeOverlay,
    sandbox,
  };
}

test('vibe & motion runtime kits contain zero non-deterministic wall/random APIs', () => {
  for (const [name, code] of [['motion.js', motionCode], ['vibe-canvas.js', vibeCanvasCode], ['vibe-overlay.js', vibeOverlayCode]]) {
    assert.equal(code.includes('Math.random('), false, `${name} must not call Math.random()`);
    assert.equal(code.includes('Date.now('), false, `${name} must not call Date.now()`);
    assert.equal(code.includes('performance.now('), false, `${name} must not call performance.now()`);
  }
});

test('Motion extended primitives (shake, slam, steps, pulse, wipeBand, carryPose) are pure functions of t', () => {
  const { Motion } = loadVibeSuite();
  assert.equal(Motion.shake(0.9, 1.0, { amp: 12 }), 0);
  const s1 = Motion.shake(1.05, 1.0, { amp: 12 });
  assert.notEqual(s1, 0);
  assert.equal(s1, Motion.shake(1.05, 1.0, { amp: 12 }));

  const sl = Motion.slam(0.15, 0, { duration: 0.4, fromScale: 1.45 });
  assert.ok(sl.scale > 1 && sl.scale < 1.45);
  assert.equal(Motion.slam(-0.1, 0, { duration: 0.4, fromScale: 1.45 }).active, false);

  const midStep = Motion.steps(0.7, [[0, 0], [0.5, 4]], 0.4);
  assert.ok(midStep > 0 && midStep < 4);
  assert.equal(Motion.steps(0.95, [[0, 0], [0.5, 4]], 0.4), 4);
  assert.ok(Motion.pulse([1.0], 1.05, 0.2) > 0);
  const wb = Motion.wipeBand(1.9, 2.0, 0.46);
  assert.equal(wb.active, true);
  const cp = Motion.carryPose({ x: 0, y: 10, scale: 1 }, { x: 100, y: 20, scale: 1.5 }, 0.5);
  assert.ok(cp.x > 0 && cp.x < 100);
});

test('VibeKit metaphor primitives and VibeOverlay face avoidance work in both orientations', () => {
  const { VibeKit, VibeOverlay, sandbox } = loadVibeSuite();
  const vSafe = VibeKit.safeArea(1080, 1920);
  const hSafe = VibeKit.safeArea(1920, 1080);
  assert.ok(vSafe.span < 1080 && hSafe.span < 1920);

  const ctx = makeMockCtx(1080, 1920);
  VibeKit.drawBackdrop(ctx, 1.5, { width: 1080, height: 1920, beatPulse: 0.4 });
  VibeKit.drawChrome(ctx, 1.5, { width: 1080, height: 1920, chapter: '01', progress: 0.25, beatIndex: 2 });
  VibeKit.drawWipeBand(ctx, 4.9, 5.0, { width: 1080, height: 1920 });
  VibeKit.drawScale(ctx, { cost: 0.25 });
  VibeKit.drawDoors(ctx, { leftClosed: 1, rightClosed: 0 });
  VibeKit.drawSplitBar(ctx, { split: 0.8, fall: 0.4, pick: 0.7 });
  VibeKit.drawRunway(ctx, { burnRates: [0.8, 0.4], added: [1, 0.6] });
  VibeKit.drawSimGrid(ctx, { times: [0.1, 0.2], t: 0.3, collapse: 0.2 });
  VibeKit.drawChecklistRow(ctx, { title: 'Test', done: 0.8, ripple: 0.4 });

  // Measured rhythm fallback & override
  const synth = VibeKit.readRhythm(10, 120);
  assert.equal(synth.measured, false);
  assert.ok(synth.beats.length >= 18);

  sandbox.window.RHYTHM = { bpm: 128, beats: [500, 1000, 1500], onsets: [[500, 0.9]] };
  const measured = VibeKit.readRhythm(10, 120);
  assert.equal(measured.measured, true);
  assert.equal(measured.bpm, 128);
  assert.deepEqual(measured.beats, [0.5, 1, 1.5]);

  // VibeOverlay safeAnchor avoids a centered talking head face box
  const pos = VibeOverlay.safeAnchor(1080, 1920, { bottom: 0.42, right: 0.65 });
  assert.ok(pos.y >= 1920 * 0.42 + 20, `overlay anchor (${JSON.stringify(pos)}) should sit cleanly below avoidRect bottom`);
});

test('Motion v2 & VibeKit v2 camera, parallax, 6 growth transitions and continuous vibe-explainer stage are deterministic', () => {
  const { Motion, VibeKit, sandbox } = loadVibeSuite();
  const stageCode = readFileSync(join(ROOT, 'vendor', 'templates', 'vibe-explainer', 'stage.js'), 'utf8');
  assert.equal(/drawWipeBand\s*\(/.test(stageCode), false, 'vibe-explainer stage must not call drawWipeBand');
  assert.equal(stageCode.includes('Math.random('), false);
  assert.equal(stageCode.includes('Date.now('), false);

  const cam = Motion.cameraKeyframe(2.5, [{ t: 0, zoom: 1 }, { t: 5, zoom: 1.2, x: -40 }]);
  assert.ok(cam.zoom > 1.0 && cam.zoom < 1.25);
  assert.equal(Motion.anticipate(0.05, 0, 0.4) < 0, true, 'anticipate pulls back before advancing');
  const box = Motion.morphBox({ x: 0, y: 0, w: 100, h: 50, r: 8 }, { x: 100, y: 200, w: 300, h: 150, r: 24 }, 0.5);
  assert.equal(box.w, 200);
  assert.match(Motion.colorLerp('#000000', '#ffffff', 0.5), /^#[0-9a-f]{6}$/);

  const ctx = makeMockCtx(1080, 1920);
  VibeKit.withParallax(ctx, 1080, 1920, cam, 0.3, () => VibeKit.drawAuroraMesh(ctx, 1.5, { width: 1080, height: 1920 }));
  VibeKit.drawPerspectiveGrid(ctx, 1.5, { width: 1080, height: 1920 });
  VibeKit.drawGlassCard(ctx, 94, 400, 892, 200, 28, { sweep: 0.5, accentBar: true });
  VibeKit.drawCursorClick(ctx, 300, 420, 0.45);
  VibeKit.drawDialogueTheater(ctx, 2.5, [{ at: 0.5, speaker: 'A', line1: 'Hi' }, { at: 2.0, side: 'right', tone: 'bad', line1: 'No' }]);
  VibeKit.drawAudioSpectrum(ctx, 2.5, VibeKit.readRhythm(42, 112.3));
  VibeKit.drawImageAnchorStage(ctx, 2.0, [{ at: 0, label: 'Start' }, { at: 1.5, label: 'End' }]);
  VibeKit.drawFlowNodes(ctx, 1.2, [{ x: 200, y: 500, label: 'S1' }], { x: 800, y: 900, label: 'Out' });
  VibeKit.drawCompareSlider(ctx, 1.2, { beforeValue: '10s', afterValue: '1s' });
  VibeKit.drawRadialGauge(ctx, 1.2, { value: 0.85, displayValue: '85%' });
  VibeKit.grow.morphExpand(ctx, { x: 0, y: 0, w: 100, h: 100, r: 8 }, { x: 50, y: 50, w: 300, h: 300, r: 20 }, 0.5);
  VibeKit.grow.portalZoom(ctx, 540, 960, 40, 1200, 0.5, () => {});
  VibeKit.grow.lineCarry(ctx, [{ x: 10, y: 10 }, { x: 200, y: 10 }, { x: 200, y: 200 }], 0.6);
  VibeKit.grow.causalRipple(ctx, 540, 960, 1000, 0.5, () => {});
  VibeKit.grow.spatialSlide(ctx, 1080, 1920, 0.5, 'up', () => {}, () => {});
  VibeKit.grow.cardFlip3D(ctx, 540, 960, 800, 400, 0.6, () => {}, () => {});

  vm.runInContext(stageCode, sandbox, { filename: 'stage.js' });
  assert.equal(typeof sandbox.window.drawContinuousStage, 'function');
  const rhythm = VibeKit.readRhythm(42, 112.3);
  for (const globalT of [0, 4.9, 5.0, 10.0, 16.0, 21.5, 27.0, 32.5, 37.5, 41.9]) {
    assert.doesNotThrow(() => sandbox.window.drawContinuousStage({
      globalT,
      t: globalT,
      duration: 5,
      filmDuration: 42,
      ctx,
      w: 1080,
      h: 1920,
      safe: VibeKit.safeArea(1080, 1920),
      pal: VibeKit.DEFAULT_PALETTE,
      copy: {},
      vars: {},
      kit: VibeKit,
      motion: Motion,
      rhythm,
      beatPulse: 0.5,
      onsetPulse: 0.4,
      tonalPulse: 0.3,
    }));
  }
});
