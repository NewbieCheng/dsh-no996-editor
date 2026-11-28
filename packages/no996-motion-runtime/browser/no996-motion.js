'use strict';/* Generated from packages/no996-motion-runtime/browser.mjs. No996 Motion runtime; GPL-3.0-or-later. */
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // packages/no996-motion-runtime/src/index.mjs
  var src_exports = {};
  __export(src_exports, {
    anticipate: () => anticipate,
    backOut: () => backOut,
    between: () => between,
    bezierPoint: () => bezierPoint,
    camera: () => camera,
    cameraKeyframe: () => cameraKeyframe,
    carryPose: () => carryPose,
    clamp: () => clamp,
    clamp01: () => clamp01,
    colorLerp: () => colorLerp,
    count: () => count,
    cubicOut: () => cubicOut,
    default: () => motion_default,
    det: () => det,
    detBetween: () => detBetween,
    drop: () => drop,
    enter: () => enter,
    exit: () => exit,
    expoOut: () => expoOut,
    grain: () => grain,
    halton: () => halton,
    hash32: () => hash32,
    inOutCubic: () => inOutCubic,
    inversePose: () => inversePose,
    jitter: () => jitter,
    lerp: () => lerp,
    morphBox: () => morphBox,
    overshootLerp: () => overshootLerp,
    pathProgress: () => pathProgress,
    pose: () => pose,
    pulse: () => pulse,
    quintOut: () => quintOut,
    reveal: () => reveal,
    seg: () => seg,
    shake: () => shake,
    slam: () => slam,
    split: () => split,
    spring: () => spring,
    stagger: () => stagger,
    steps: () => steps,
    surface: () => surface,
    text: () => text,
    unitsIn: () => unitsIn,
    wallScale: () => wallScale,
    wipeBand: () => wipeBand
  });

  // packages/no996-motion-runtime/src/motion.mjs
  var clamp01 = (value) => value < 0 ? 0 : value > 1 ? 1 : value;
  var clamp = (value, min, max) => value < min ? min : value > max ? max : value;
  var seg = (t, start, duration = 0.5) => clamp01((t - start) / (duration || 1e-3));
  var lerp = (from, to, p) => from + (to - from) * p;
  var stagger = (index, step = 0.04) => index * step;
  var cubicOut = (p) => 1 - Math.pow(1 - clamp01(p), 3);
  var quintOut = (p) => 1 - Math.pow(1 - clamp01(p), 5);
  var expoOut = (p) => p >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp01(p));
  var inOutCubic = (p) => {
    const t = clamp01(p);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  };
  var backOut = (p, overshoot = 1.70158) => {
    const t = clamp01(p) - 1;
    return 1 + (overshoot + 1) * t * t * t + overshoot * t * t;
  };
  function spring(t, duration = 0.6, zeta = 0.61) {
    if (t <= 0) return 0;
    const damping = Math.min(Math.max(zeta, 0.05), 0.98);
    const wn = 10 / Math.max(duration, 0.01);
    const wd = wn * Math.sqrt(1 - damping * damping);
    return 1 - Math.exp(-damping * wn * t) * (Math.cos(wd * t) + damping * wn / wd * Math.sin(wd * t));
  }
  function drop(t, duration = 0.3) {
    if (t <= 0) return { y: 1, sy: 1, landed: false };
    if (t < duration) {
      const x = clamp01(t / duration);
      return { y: 1 - x * x, sy: 1, landed: false };
    }
    const tau = t - duration;
    return { y: 0, sy: 1 - 0.3 * Math.exp(-tau / 0.05) * Math.cos(40 * tau), landed: true };
  }
  function wallScale(t, base = 0.1, duration = 0.6) {
    if (t <= 0) return 0;
    return base + (1 - base) * spring(t, duration);
  }
  function hash32(seed) {
    let x = seed | 0;
    x = x ^ 61 ^ x >>> 16;
    x = x + (x << 3);
    x = x ^ x >>> 4;
    x = Math.imul(x, 668265261);
    x = x ^ x >>> 15;
    return (x >>> 0) / 4294967296;
  }
  var det = (frame, salt = 0, index = 0) => hash32(Math.imul(frame + 1, 73856093) ^ Math.imul(salt + 1, 19349663) ^ Math.imul(index + 1, 83492791));
  var detBetween = (frame, salt, index, min, max) => min + (max - min) * det(frame, salt, index);
  function halton(index, base) {
    if (!Number.isSafeInteger(base) || base < 2 || !Number.isFinite(index) || index < 0) {
      throw new TypeError("Halton needs a non-negative index and an integer base of at least 2");
    }
    let result = 0;
    let fraction = 1 / base;
    let i = index + 1;
    while (i > 0) {
      result += i % base * fraction;
      i = Math.floor(i / base);
      fraction /= base;
    }
    return result;
  }
  var jitter = (sample, index) => [halton(index, 2) - 0.5, halton(index, 3) - 0.5];
  var resolve = (target) => typeof target === "string" ? document.querySelector(target) : target;
  function pose(target, options) {
    const node = resolve(target);
    if (!node) return;
    const opts = options || {};
    const x = opts.x || 0;
    const y = opts.y || 0;
    const z = opts.z || 0;
    const scale = opts.scale === void 0 ? 1 : opts.scale;
    const rotate = opts.rotate || 0;
    const rotateX = opts.rotateX || 0;
    const rotateY = opts.rotateY || 0;
    const opacity = opts.opacity === void 0 ? 1 : opts.opacity;
    const blur = opts.blur || 0;
    const parts = ["translate3d(" + x.toFixed(3) + "px," + y.toFixed(3) + "px," + z.toFixed(3) + "px)"];
    if (rotate) parts.push("rotate(" + rotate.toFixed(3) + "deg)");
    if (rotateX) parts.push("rotateX(" + rotateX.toFixed(3) + "deg)");
    if (rotateY) parts.push("rotateY(" + rotateY.toFixed(3) + "deg)");
    if (scale !== 1) parts.push("scale(" + scale.toFixed(4) + ")");
    node.style.transform = parts.join(" ");
    node.style.opacity = String(clamp01(opacity).toFixed(4));
    if ("filter" in node.style) node.style.filter = blur > 0.01 ? "blur(" + blur.toFixed(2) + "px)" : "";
    if (opts.origin) node.style.transformOrigin = opts.origin;
  }
  function enter(target, t, start, options) {
    const opts = options || {};
    const duration = opts.duration === void 0 ? 0.5 : opts.duration;
    const p = seg(t, start, duration);
    const useSpring = Boolean(opts.spring);
    const zeta = typeof opts.spring === "object" && opts.spring ? opts.spring.zeta || 0.61 : 0.61;
    const u = useSpring ? spring(Math.max(0, t - start), duration, zeta) : (opts.easing || cubicOut)(p);
    const from = {
      x: opts.x === void 0 ? 0 : opts.x,
      y: opts.y === void 0 ? 36 : opts.y,
      scale: opts.scale === void 0 ? 0.93 : opts.scale,
      rotate: opts.rotate === void 0 ? 0 : opts.rotate,
      blur: opts.blur === void 0 ? 0 : opts.blur
    };
    pose(target, {
      x: from.x * (1 - u),
      y: from.y * (1 - u),
      scale: lerp(from.scale, 1, u),
      rotate: from.rotate * (1 - u),
      blur: from.blur * (1 - u),
      opacity: p * 2,
      origin: opts.origin
    });
  }
  function exit(target, t, start, options) {
    const opts = options || {};
    const duration = opts.duration === void 0 ? 0.3 : opts.duration;
    const p = seg(t, start, duration);
    const e = inOutCubic(p);
    pose(target, {
      x: (opts.x || 0) * e,
      y: (opts.y === void 0 ? -24 : opts.y) * e,
      scale: lerp(1, opts.scale === void 0 ? 0.96 : opts.scale, e),
      rotate: (opts.rotate || 0) * e,
      blur: (opts.blur === void 0 ? 6 : opts.blur) * e,
      opacity: 1 - e
    });
  }
  function reveal(target, p, options) {
    const node = resolve(target);
    if (!node) return;
    const opts = options || {};
    const q = clamp01(p) * 100;
    const hidden = 100 - q;
    const from = opts.from || "left";
    const inset = from === "right" ? "0 0 0 " + hidden + "%" : from === "top" ? hidden + "% 0 0 0" : from === "bottom" ? "0 0 " + hidden + "% 0" : "0 " + hidden + "% 0 0";
    node.style.clipPath = "inset(" + inset + ")";
  }
  function camera(target, options) {
    const node = resolve(target);
    if (!node) return;
    const opts = options || {};
    const zoom = opts.zoom === void 0 ? 1 : opts.zoom;
    const rotate = opts.rotate || 0;
    node.style.transformOrigin = opts.origin || "50% 50%";
    node.style.transform = "translate3d(" + (opts.x || 0).toFixed(3) + "px," + (opts.y || 0).toFixed(3) + "px,0) rotate(" + rotate.toFixed(3) + "deg) scale(" + zoom.toFixed(5) + ")";
  }
  function inversePose(options) {
    const opts = options || {};
    const s = opts.scale === void 0 ? 1 : opts.scale;
    const z = opts.z || 0;
    return {
      zoom: 1 / (s || 1),
      rotate: -(opts.rotate || 0),
      x: -(opts.x || 0),
      y: -(opts.y || 0),
      z: -z
    };
  }
  function split(target, mode) {
    const node = resolve(target);
    if (!node || node.getAttribute("data-split") === (mode || "chars")) return node;
    const unit = mode === "words" ? /(\s+)/ : /()/;
    const parts = String(node.textContent || "").split(unit).filter((part) => part !== "");
    node.textContent = "";
    for (const part of parts) {
      if (/^\s+$/.test(part)) {
        node.appendChild(document.createTextNode(part));
        continue;
      }
      const span = document.createElement("span");
      span.className = "m-unit";
      span.style.display = "inline-block";
      span.textContent = part;
      node.appendChild(span);
    }
    node.setAttribute("data-split", mode || "chars");
    return node;
  }
  function unitsIn(target, t, start, options) {
    const node = resolve(target);
    if (!node) return;
    const opts = options || {};
    const step = opts.step === void 0 ? 0.03 : opts.step;
    const duration = opts.duration === void 0 ? 0.42 : opts.duration;
    const rise = opts.y === void 0 ? 22 : opts.y;
    [...node.querySelectorAll(".m-unit")].forEach((span, index) => {
      const p = seg(t, start + stagger(index, step), duration);
      const u = backOut(p, opts.overshoot === void 0 ? 1.2 : opts.overshoot);
      span.style.transform = "translate3d(0," + (rise * (1 - u)).toFixed(2) + "px,0)";
      span.style.opacity = String(clamp01(p * 1.6).toFixed(3));
    });
  }
  function count(target, t, options) {
    const node = resolve(target);
    if (!node) return;
    const opts = options || {};
    const from = opts.from === void 0 ? 0 : opts.from;
    const to = opts.to === void 0 ? 100 : opts.to;
    const start = opts.start === void 0 ? 0 : opts.start;
    const duration = opts.duration === void 0 ? 1.2 : opts.duration;
    const e = cubicOut(seg(t, start, duration));
    const value = lerp(from, to, e);
    const decimals = opts.decimals || 0;
    const fixed = value.toFixed(decimals);
    const grouped = opts.group === false ? fixed : fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const next = (opts.prefix || "") + grouped + (opts.suffix || "");
    if (node.textContent !== next) node.textContent = next;
  }
  function surface(canvas, options) {
    const opts = options || {};
    const scale = opts.scale || 2;
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 0, height: 0 };
    const width = Math.max(1, Math.round(rect.width || canvas.clientWidth || canvas.width || 1));
    const height = Math.max(1, Math.round(rect.height || canvas.clientHeight || canvas.height || 1));
    const pixelWidth = Math.round(width * scale);
    const pixelHeight = Math.round(height * scale);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.setTransform(scale, 0, 0, scale, 0, 0);
    return { ctx, width, height, scale };
  }
  function grain(ctx, t, options) {
    const opts = options || {};
    const width = opts.width || 1080;
    const height = opts.height || 1920;
    const frame = Math.floor(t * (opts.fps || 30));
    const density = opts.density === void 0 ? 12e-5 : opts.density;
    const total = Math.max(1, Math.round(width * height * density));
    ctx.save();
    ctx.globalAlpha = opts.alpha === void 0 ? 0.05 : opts.alpha;
    ctx.fillStyle = opts.color || "#ffffff";
    for (let i = 0; i < total; i += 1) {
      const x = det(frame, 11, i) * width;
      const y = det(frame, 12, i) * height;
      const s = 0.6 + det(frame, 13, i) * 1.4;
      ctx.fillRect(x, y, s, s);
    }
    ctx.restore();
  }
  function text(target, value) {
    const node = resolve(target);
    if (node && node.textContent !== String(value)) node.textContent = String(value);
  }
  var between = (p, from, to) => lerp(from, to, clamp01(p));
  function shake(t, t0, options) {
    if (t <= t0) return 0;
    const opts = options || {};
    const amp = opts.amp === void 0 ? 9 : opts.amp;
    const freq = opts.freq === void 0 ? 95 : opts.freq;
    const decay = opts.decay === void 0 ? 16 : opts.decay;
    const dt = t - t0;
    return Math.sin(dt * freq) * amp * Math.exp(-dt * decay);
  }
  function slam(t, t0, options) {
    const opts = options || {};
    const dur = opts.duration === void 0 ? 0.34 : opts.duration;
    const fromScale = opts.fromScale === void 0 ? 1.45 : opts.fromScale;
    const p = seg(t, t0, dur);
    if (p <= 0) return { active: false, p: 0, scale: fromScale, shakeX: 0, opacity: 0 };
    const e = cubicOut(p);
    return {
      active: true,
      p,
      scale: lerp(fromScale, 1, e),
      shakeX: t > t0 + 0.05 ? shake(t, t0, opts) : 0,
      opacity: clamp01(p * 3)
    };
  }
  function steps(t, list, duration, easing) {
    if (!Array.isArray(list) || list.length === 0) return 0;
    const dur = duration === void 0 ? 0.4 : duration;
    const ease = easing || cubicOut;
    let k = 0;
    for (let i = 1; i < list.length; i += 1) {
      if (t >= list[i][0]) k = i;
    }
    if (k === 0) return list[0][1];
    return lerp(list[k - 1][1], list[k][1], ease(seg(t, list[k][0], dur)));
  }
  function lastIndexAt(arr, t) {
    if (!Array.isArray(arr) || arr.length === 0) return -1;
    let lo = 0;
    let hi = arr.length - 1;
    let res = -1;
    while (lo <= hi) {
      const mid = lo + hi >> 1;
      if (arr[mid] <= t) {
        res = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return res;
  }
  function pulse(times, t, decay, strengths) {
    const idx = lastIndexAt(times, t);
    if (idx < 0) return 0;
    const dec = decay === void 0 ? 0.18 : decay;
    const amp = Array.isArray(strengths) && strengths[idx] !== void 0 ? 0.4 + 0.6 * strengths[idx] : 1;
    return Math.exp(-(t - times[idx]) / Math.max(dec, 0.01)) * amp;
  }
  function wipeBand(t, t0, duration) {
    const dur = duration === void 0 ? 0.46 : duration;
    const start = t0 - 0.16;
    const u = (t - start) / Math.max(dur, 0.01);
    if (u < 0 || u > 1) return { active: false, u: clamp01(u), eased: clamp01(u) };
    return { active: true, u, eased: inOutCubic(u) };
  }
  function carryPose(from, to, p, easing) {
    const a = from || {};
    const b = to || {};
    const u = (easing || inOutCubic)(clamp01(p));
    return {
      x: lerp(a.x || 0, b.x || 0, u),
      y: lerp(a.y || 0, b.y || 0, u),
      scale: lerp(a.scale === void 0 ? 1 : a.scale, b.scale === void 0 ? 1 : b.scale, u),
      rotate: lerp(a.rotate || 0, b.rotate || 0, u),
      opacity: lerp(a.opacity === void 0 ? 1 : a.opacity, b.opacity === void 0 ? 1 : b.opacity, u)
    };
  }
  function anticipate(t, t0, duration = 0.42, backAmp = 0.22) {
    const p = seg(t, t0, duration);
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    if (p < 0.28) {
      const k = p / 0.28;
      return -backAmp * Math.sin(k * Math.PI * 0.5);
    }
    const q = (p - 0.28) / 0.72;
    return lerp(-backAmp, 1, backOut(q, 1.35));
  }
  function overshootLerp(from, to, t, duration = 0.55, zeta = 0.58) {
    return lerp(from, to, spring(Math.max(0, t), duration, zeta));
  }
  function bezierPoint(p0, p1, p2, p3, u) {
    const t = clamp01(u);
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;
    const a = mt2 * mt;
    const b = 3 * mt2 * t;
    const c = 3 * mt * t2;
    const d = t2 * t;
    return {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
    };
  }
  function pathProgress(points, u) {
    if (!Array.isArray(points) || points.length === 0) return { x: 0, y: 0, angle: 0, partial: [] };
    if (points.length === 1) return { x: points[0].x, y: points[0].y, angle: 0, partial: [points[0]] };
    const p = clamp01(u);
    const segLens = [];
    let total = 0;
    for (let i = 1; i < points.length; i += 1) {
      const len = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      segLens.push(len);
      total += len;
    }
    if (total <= 1e-4) return { x: points[0].x, y: points[0].y, angle: 0, partial: [points[0]] };
    const targetDist = p * total;
    let acc = 0;
    const partial = [points[0]];
    for (let i = 0; i < segLens.length; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const len = segLens[i];
      if (acc + len >= targetDist || i === segLens.length - 1) {
        const local = len > 0 ? clamp01((targetDist - acc) / len) : 1;
        const x = lerp(a.x, b.x, local);
        const y = lerp(a.y, b.y, local);
        partial.push({ x, y });
        return { x, y, angle: Math.atan2(b.y - a.y, b.x - a.x), partial };
      }
      partial.push(b);
      acc += len;
    }
    return { x: points[points.length - 1].x, y: points[points.length - 1].y, angle: 0, partial };
  }
  function cameraKeyframe(t, keys, options) {
    const opts = options || {};
    const breath = opts.breath === void 0 ? 8e-3 : opts.breath;
    if (!Array.isArray(keys) || keys.length === 0) {
      return { x: 0, y: 0, zoom: 1 + breath * Math.sin(t * 1.4), rotate: 0 };
    }
    const sorted = [...keys].sort((a, b) => a.t - b.t);
    let cur = {
      x: sorted[0].x || 0,
      y: sorted[0].y || 0,
      zoom: sorted[0].zoom === void 0 ? 1 : sorted[0].zoom,
      rotate: sorted[0].rotate || 0
    };
    if (t > sorted[0].t) {
      let idx = 0;
      for (let i = 1; i < sorted.length; i += 1) {
        if (t >= sorted[i].t) idx = i;
      }
      if (idx >= sorted.length - 1) {
        const last = sorted[sorted.length - 1];
        cur = {
          x: last.x || 0,
          y: last.y || 0,
          zoom: last.zoom === void 0 ? 1 : last.zoom,
          rotate: last.rotate || 0
        };
      } else {
        const a = sorted[idx];
        const b = sorted[idx + 1];
        const ease = typeof b.ease === "function" ? b.ease : inOutCubic;
        const u = ease(seg(t, a.t, Math.max(1e-3, b.t - a.t)));
        cur = {
          x: lerp(a.x || 0, b.x || 0, u),
          y: lerp(a.y || 0, b.y || 0, u),
          zoom: lerp(a.zoom === void 0 ? 1 : a.zoom, b.zoom === void 0 ? 1 : b.zoom, u),
          rotate: lerp(a.rotate || 0, b.rotate || 0, u)
        };
      }
    }
    if (breath > 0) {
      cur.zoom += breath * Math.sin(t * 1.35);
      cur.x += breath * 140 * Math.sin(t * 0.9);
      cur.y += breath * 110 * Math.cos(t * 0.75);
    }
    return cur;
  }
  function morphBox(fromRect, toRect, p, easing) {
    const a = fromRect || {};
    const b = toRect || {};
    const u = (easing || inOutCubic)(clamp01(p));
    return {
      x: lerp(a.x || 0, b.x || 0, u),
      y: lerp(a.y || 0, b.y || 0, u),
      w: lerp(a.w || 0, b.w || 0, u),
      h: lerp(a.h || 0, b.h || 0, u),
      r: lerp(a.r || 0, b.r || 0, u),
      rotate: lerp(a.rotate || 0, b.rotate || 0, u),
      opacity: lerp(a.opacity === void 0 ? 1 : a.opacity, b.opacity === void 0 ? 1 : b.opacity, u)
    };
  }
  function colorLerp(hexA, hexB, p) {
    const parse = (hex) => {
      const clean = String(hex || "#000000").replace("#", "");
      const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean.padEnd(6, "0");
      return [
        parseInt(full.slice(0, 2), 16) || 0,
        parseInt(full.slice(2, 4), 16) || 0,
        parseInt(full.slice(4, 6), 16) || 0
      ];
    };
    const [r1, g1, b1] = parse(hexA);
    const [r2, g2, b2] = parse(hexB);
    const u = clamp01(p);
    const toHex = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
    return "#" + toHex(lerp(r1, r2, u)) + toHex(lerp(g1, g2, u)) + toHex(lerp(b1, b2, u));
  }
  var Motion = {
    clamp,
    clamp01,
    seg,
    lerp,
    between,
    stagger,
    cubicOut,
    quintOut,
    expoOut,
    inOutCubic,
    backOut,
    spring,
    drop,
    wallScale,
    slam,
    steps,
    pulse,
    shake,
    wipeBand,
    carryPose,
    anticipate,
    overshootLerp,
    bezierPoint,
    pathProgress,
    cameraKeyframe,
    morphBox,
    colorLerp,
    hash32,
    det,
    detBetween,
    halton,
    jitter,
    pose,
    enter,
    exit,
    reveal,
    camera,
    inversePose,
    split,
    unitsIn,
    count,
    surface,
    grain,
    text
  };
  var motion_default = Motion;

  // packages/no996-motion-runtime/browser.mjs
  var { default: _default, ...api } = src_exports;
  var root = globalThis;
  root.Motion = api;
  root.No996Motion = api;
  if (typeof window !== "undefined" && window !== root) {
    window.Motion = api;
    window.No996Motion = api;
  }
})();
