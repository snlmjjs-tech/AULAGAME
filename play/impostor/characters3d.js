/* =====================================================================
   Personajes 3D del Impostor — astronautas procedurales con Three.js.
   Un único WebGLRenderer compartido; cada personaje visible se copia a un
   canvas 2D (drawImage). Si Three.js/WebGL no cargan, la página sigue usando
   el astronauta CSS (respaldo). Ver .claude/skills/impostor-character-design.
===================================================================== */
const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
const ASPECT = 403 / 300;             // proporción 64:86 (igual que .crewmate)
/* Gobernador de calidad: si el equipo es lento baja la resolución y los fps; si aun así no da, vuelve al diseño CSS. */
const LEVELS = [{ w: 300, fps: 30 }, { w: 220, fps: 24 }, { w: 160, fps: 15 }, { w: 120, fps: 8 }];
let level = 0, R_W = 300, R_H = 403, ema = 0, over = 0, good = 0, warm = 0;
const REDUCED = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

let T = null, renderer = null, scene = null, camera = null, rimLight = null, shadowTex = null;
let failed = false, ready = false, initPromise = null;
let palette = {};
const rigs = {};
const instances = new Map();            // canvas -> instance
const pausedGroups = new Set();
const targets = new Map();              // elemento observado -> instancia
let rafId = 0, lastDraw = 0, io = null, mo = null, scanQueued = false;

/* ---------------- Personalidades y accesorios (modulares) ---------------- */
export const CHAR_DEFS = {
  green:  { role: "Explorador",   acc: ["headlamp", "bedroll", "compass"],        idle: { bob: 1.0, speed: 1.0 } },
  red:    { role: "Enérgico",     acc: ["headband", "bolt", "jetfins"],           idle: { bob: 1.7, speed: 1.6 } },
  blue:   { role: "Técnico",      acc: ["antenna", "toolbelt", "toolpack"],       idle: { bob: 0.9, speed: 1.0 } },
  lime:   { role: "Científico",   acc: ["goggles", "flask", "tanks"],             idle: { bob: 1.1, speed: 1.2 } },
  white:  { role: "Médico",       acc: ["cross", "medpack", "headmirror"],        idle: { bob: 0.8, speed: 0.8 } },
  pink:   { role: "Investigador", acc: ["dish", "magnifier", "scanner"],          idle: { bob: 1.0, speed: 1.1 } },
  cyan:   { role: "Piloto",       acc: ["headset", "wings", "jetpack"],           idle: { bob: 1.2, speed: 1.3 } },
  orange: { role: "Ingeniero",    acc: ["hardhat", "gearpack", "wrench"],         idle: { bob: 1.0, speed: 0.9 } },
};
const loadouts = {};                      // key -> [ids] personalizados (opcional)

const mk = (g, m, x = 0, y = 0, z = 0) => { const o = new T.Mesh(g, m); o.position.set(x, y, z); return o; };
const cyl = (r1, r2, h, seg = 20) => new T.CylinderGeometry(r1, r2, h, seg);
const box = (w, h, d) => new T.BoxGeometry(w, h, d);
const sph = (r, ws = 24, hs = 16) => new T.SphereGeometry(r, ws, hs);
const tor = (r, t, rs = 10, ts = 28, arc) => new T.TorusGeometry(r, t, rs, ts, arc);

/* slot: head | antenna | back | chest | hip   build(m) -> Object3D */
export const ACCESSORIES = {
  headlamp: { slot: "head", build(m) { const g = new T.Group(); g.add(mk(cyl(.13, .13, .12), m.metal, 0, .58, .6)); const l = mk(cyl(.09, .09, .02), m.em(0xfff2a8), 0, .58, .67); l.rotation.x = Math.PI / 2; g.children[0].rotation.x = Math.PI / 2; g.add(l); return g; } },
  bedroll:  { slot: "back", build(m) { const o = mk(cyl(.17, .17, .85), m.rust, 0, .55, -.1); o.rotation.z = Math.PI / 2; return o; } },
  compass:  { slot: "hip",  build(m) { const g = new T.Group(); const a = mk(cyl(.12, .12, .05), m.metal); a.rotation.x = Math.PI / 2; const b = mk(cyl(.09, .09, .02), m.em(0x66ffcc), 0, 0, .03); b.rotation.x = Math.PI / 2; g.add(a, b); g.position.z = .12; return g; } },
  headband: { slot: "head", build(m) { const g = new T.Group(); const t = mk(tor(.79, .06, 8, 40), m.white, 0, .3, 0); t.rotation.x = Math.PI / 2; t.scale.set(1, 1, 1); g.add(t); g.add(mk(box(.22, .08, .05), m.white, -.55, .3, -.62)); const tail = mk(box(.08, .32, .04), m.white, -.45, .1, -.7); tail.rotation.z = .3; g.add(tail); return g; } },
  bolt:     { slot: "chest", build(m) { const s = new T.Shape(); s.moveTo(.05, .16); s.lineTo(-.08, -.02); s.lineTo(-.01, -.02); s.lineTo(-.05, -.16); s.lineTo(.09, .03); s.lineTo(.02, .03); s.closePath(); const o = new T.Mesh(new T.ExtrudeGeometry(s, { depth: .03, bevelEnabled: false }), m.em(0xffd45a)); o.position.set(0, -.2, .02); o.scale.set(1.1, 1.1, 1); return o; } },
  jetfins:  { slot: "back", build(m) { const g = new T.Group(); [-1, 1].forEach(s => { const f = mk(new T.ConeGeometry(.12, .5, 4), m.suitDark, s * .52, -.1, -.1); f.rotation.z = s * -.4; g.add(f); }); return g; } },
  antenna:  { slot: "antenna", build(m) { const g = new T.Group(); g.add(mk(cyl(.025, .025, .6, 8), m.metal, 0, .3, 0)); const tip = mk(sph(.07), m.blink(0xff4455), 0, .62, 0); g.add(tip); return g; } },
  toolbelt: { slot: "hip",  build(m) { const g = new T.Group(); g.add(mk(box(.22, .26, .16), m.dark, .08, 0, .08)); const w = mk(cyl(.025, .025, .34, 8), m.metal, .08, .22, .08); w.rotation.z = .25; g.add(w); return g; } },
  toolpack: { slot: "back", build(m) { return mk(box(.5, .3, .22), m.metal, 0, -.45, -.05); } },
  goggles:  { slot: "head", build(m) { const g = new T.Group(); const st = mk(tor(.72, .045, 8, 40), m.dark, 0, .38, 0); st.rotation.x = Math.PI / 2; g.add(st); [-1, 1].forEach(s => { const l = mk(cyl(.17, .17, .09), m.glass, s * .24, .46, .62); l.rotation.x = Math.PI / 2 - .35; g.add(l); const r = mk(tor(.17, .03, 8, 20), m.metal, s * .24, .46, .63); r.rotation.x = -.35; g.add(r); }); return g; } },
  flask:    { slot: "hip",  build(m) { const g = new T.Group(); g.add(mk(cyl(.05, .05, .12), m.glass, 0, .1, 0)); g.add(mk(sph(.13), m.glass, 0, -.04, 0)); g.add(mk(sph(.1), m.em(0x66ff88), 0, -.05, 0)); g.position.set(.06, 0, .12); return g; } },
  tanks:    { slot: "back", build(m) { const g = new T.Group(); [-1, 1].forEach(s => { g.add(mk(cyl(.14, .14, .75), m.white, s * .22, .08, -.2)); g.add(mk(cyl(.09, .09, .1), m.metal, s * .22, .5, -.2)); }); return g; } },
  cross:    { slot: "chest", build(m) { const g = new T.Group(); const red = m.em(0xff3b4a); g.add(mk(box(.26, .08, .03), red, 0, 0, .02), mk(box(.08, .26, .03), red, 0, 0, .02)); g.position.set(-.18, -.2, .02); return g; } },
  medpack:  { slot: "back", build(m) { const g = new T.Group(); g.add(mk(box(.5, .4, .22), m.white, 0, -.4, -.12)); const red = m.em(0xff3b4a); g.add(mk(box(.2, .06, .02), red, 0, -.4, -.24), mk(box(.06, .2, .02), red, 0, -.4, -.24)); return g; } },
  headmirror:{ slot: "head", build(m) { const g = new T.Group(); const d = mk(cyl(.15, .15, .03), m.metal, 0, .6, .52); d.rotation.x = Math.PI / 2 - .6; g.add(d); const b = mk(tor(.77, .035, 8, 40), m.metal, 0, .32, 0); b.rotation.x = Math.PI / 2; g.add(b); return g; } },
  dish:     { slot: "antenna", build(m) { const g = new T.Group(); g.add(mk(cyl(.02, .02, .35, 8), m.metal, 0, .18, 0)); const d = mk(new T.SphereGeometry(.2, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), m.metal, 0, .38, 0); d.rotation.x = Math.PI - .5; d.material = m.metalDS; g.add(d); g.add(mk(sph(.04), m.blink(0x66ffcc), 0, .42, .06)); return g; } },
  magnifier:{ slot: "hip",  build(m) { const g = new T.Group(); g.add(mk(tor(.11, .025, 8, 20), m.metal, 0, .12, 0)); g.add(mk(cyl(.02, .02, .22, 8), m.dark, 0, -.04, 0)); const gl = mk(cyl(.1, .1, .01, 20), m.glass, 0, .12, 0); gl.rotation.x = Math.PI / 2; g.add(gl); g.position.set(.04, -.04, .14); g.rotation.z = -.2; return g; } },
  scanner:  { slot: "back", build(m) { const g = new T.Group(); g.add(mk(box(.44, .3, .16), m.dark, 0, -.45, -.1)); g.add(mk(box(.34, .2, .02), m.em(0x66e0ff), 0, -.45, -.2)); return g; } },
  headset:  { slot: "head", build(m) { const g = new T.Group(); [-1, 1].forEach(s => { const e = mk(cyl(.15, .15, .12), m.dark, s * .78, .08, 0); e.rotation.z = Math.PI / 2; g.add(e); }); const band = mk(tor(.78, .03, 8, 40, Math.PI), m.dark, 0, .08, 0); band.rotation.z = 0; g.add(band); const mic = mk(cyl(.015, .015, .45, 6), m.dark, .66, -.1, .3); mic.rotation.x = Math.PI / 2 - .3; mic.rotation.z = .5; g.add(mic); g.add(mk(sph(.05), m.em(0xff5566), .55, -.2, .55)); return g; } },
  wings:    { slot: "chest", build(m) { const g = new T.Group(); [-1, 1].forEach(s => { const w = mk(box(.2, .05, .02), m.metal, s * .17, -.2, .02); w.rotation.z = s * .35; g.add(w); const w2 = mk(box(.16, .05, .02), m.metal, s * .15, -.26, .02); w2.rotation.z = s * .25; g.add(w2); }); g.add(mk(sph(.05), m.em(0xffd45a), 0, -.22, .03)); return g; } },
  jetpack:  { slot: "back", build(m) { const g = new T.Group(); [-1, 1].forEach(s => { g.add(mk(cyl(.12, .12, .5), m.metal, s * .24, -.35, -.2)); g.add(mk(cyl(.09, .11, .08), m.em(0x66e8ff), s * .24, -.66, -.2)); }); return g; } },
  hardhat:  { slot: "head", build(m) { const g = new T.Group(); const dome = mk(new T.SphereGeometry(.84, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2.2), m.yellow, 0, .08, 0); g.add(dome); g.add(mk(cyl(.9, .9, .06, 36), m.yellow, 0, .16, .1)); g.add(mk(box(.12, .5, .6), m.yellow, 0, .52, 0)); return g; } },
  gearpack: { slot: "back", build(m) { const g = new T.Group(); const hub = mk(cyl(.2, .2, .08, 24), m.metal, 0, -.4, -.22); hub.rotation.x = Math.PI / 2; g.add(hub); for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; const t = mk(box(.08, .1, .08), m.metal, Math.cos(a) * .25, -.4 + Math.sin(a) * .25, -.22); t.rotation.z = a; g.add(t); } return g; } },
  wrench:   { slot: "hip",  build(m) { const g = new T.Group(); const h = mk(box(.05, .4, .03), m.metal, 0, -.05, 0); g.add(h); g.add(mk(tor(.07, .03, 8, 16), m.metal, 0, .18, 0)); g.position.set(.1, 0, .12); g.rotation.z = -.25; return g; } },
};

/* ---------------- Materiales ---------------- */
function materials(hex) {
  const c = new T.Color(hex);
  const phys = (o) => new T.MeshPhysicalMaterial(o);
  const std = (o) => new T.MeshStandardMaterial(o);
  const blinkers = [];
  return {
    suit: phys({ color: c, roughness: .34, metalness: .08, clearcoat: .5, clearcoatRoughness: .35 }),
    suitDark: std({ color: c.clone().multiplyScalar(.55), roughness: .5, metalness: .1 }),
    white: phys({ color: 0xeaf0fa, roughness: .28, metalness: .05, clearcoat: .6 }),
    metal: std({ color: 0xaab6cc, roughness: .26, metalness: .95 }),
    metalDS: std({ color: 0xaab6cc, roughness: .26, metalness: .95, side: T.DoubleSide }),
    dark: std({ color: 0x1a2036, roughness: .55, metalness: .35 }),
    rust: std({ color: 0xb4691f, roughness: .7, metalness: .05 }),
    yellow: phys({ color: 0xffc928, roughness: .3, metalness: .1, clearcoat: .8 }),
    visor: phys({ color: 0x06122b, roughness: .03, metalness: .9, clearcoat: 1, clearcoatRoughness: .02, envMapIntensity: 2.2 }),
    glass: new T.MeshPhysicalMaterial({ color: 0xa8ecff, roughness: .05, metalness: 0, transparent: true, opacity: .5 }),
    em: (col) => std({ color: col, emissive: col, emissiveIntensity: 1.1, roughness: .4 }),
    blink: (col) => { const mt = std({ color: col, emissive: col, emissiveIntensity: 1, roughness: .4 }); blinkers.push(mt); return mt; },
    blinkers,
  };
}

/* ---------------- Construcción del rig ---------------- */
const SLOT_POS = { head: [0, 0, 0], antenna: [.4, .66, 0], back: [0, 0, 0], chest: [0, .9, .5], hip: [.52, .5, 0] };

function buildRig(key) {
  const hex = palette[key] || "#999999";
  const m = materials(hex);
  const root = new T.Group(), body = new T.Group(); root.add(body);
  const shadow = new T.Mesh(new T.PlaneGeometry(2.6, 2.6), new T.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = -.54; root.add(shadow);

  const torso = mk(new T.CapsuleGeometry(.52, .5, 10, 28), m.suit, 0, .78, 0); torso.scale.set(1.08, 1, .92); body.add(torso);
  const plate = mk(new T.CapsuleGeometry(.3, .12, 6, 16), m.white, 0, .84, .42); plate.scale.set(1.1, 1, .35); body.add(plate);
  const panel = mk(box(.34, .16, .06), m.dark, 0, .86, .52); body.add(panel);
  body.add(mk(sph(.035, 10, 8), m.em(0xffd45a), -.08, .86, .56), mk(sph(.035, 10, 8), m.em(0x4ce6a0), .08, .86, .56));
  const belt = mk(tor(.5, .07, 10, 32), m.metal, 0, .5, 0); belt.rotation.x = Math.PI / 2; belt.scale.set(1.08, .92, 1); body.add(belt);
  body.add(mk(box(.16, .12, .06), m.metal, 0, .5, .46));
  const neck = mk(tor(.38, .1, 10, 28), m.metal, 0, 1.28, 0); neck.rotation.x = Math.PI / 2; body.add(neck);

  const head = new T.Group(); head.position.y = 1.62; body.add(head);
  head.add(mk(sph(.78, 40, 28), m.suit));
  const visor = mk(sph(.64, 36, 24), m.visor, 0, .04, .46); visor.scale.set(1, .74, .62); head.add(visor);
  const rim = mk(tor(.64, .04, 10, 48), m.metal, 0, .04, .47); rim.scale.set(1, .74, 1); head.add(rim);
  const hl = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .55, depthWrite: false });
  const h1 = mk(new T.CircleGeometry(.14, 20), hl, -.25, .22, .81); h1.scale.set(1.8, .7, 1); h1.rotation.set(-.2, -.4, .3); head.add(h1);
  const h2 = mk(new T.CircleGeometry(.05, 14), hl, .28, -.08, .84); h2.rotation.y = .45; head.add(h2);

  const back = new T.Group(); back.position.set(0, .9, -.62); body.add(back);
  const pack = mk(new T.CapsuleGeometry(.34, .45, 8, 20), m.white, 0, 0, 0); pack.scale.set(1.2, 1, .7); back.add(pack);
  back.add(mk(tor(.34, .03, 8, 24), m.metal, 0, .12, 0), mk(tor(.34, .03, 8, 24), m.metal, 0, -.12, 0));
  back.children.slice(1).forEach(r => { r.rotation.x = Math.PI / 2; r.scale.set(1.2, .7, 1); });

  const arm = (s) => {
    const g = new T.Group(); g.position.set(s * .66, 1.12, 0);
    g.add(mk(sph(.22), m.suitDark), mk(new T.CapsuleGeometry(.17, .42, 8, 16), m.suit, 0, -.34, 0));
    const cuff = mk(tor(.17, .05, 8, 20), m.metal, 0, -.68, 0); cuff.rotation.x = Math.PI / 2; g.add(cuff);
    g.add(mk(sph(.21, 20, 14), m.white, 0, -.82, 0));
    body.add(g); return g;
  };
  const leg = (s) => {
    const g = new T.Group(); g.position.set(s * .27, .32, 0);
    g.add(mk(new T.CapsuleGeometry(.21, .26, 8, 16), m.suit, 0, -.24, 0));
    const ring = mk(tor(.2, .05, 8, 20), m.metal, 0, -.5, 0); ring.rotation.x = Math.PI / 2; g.add(ring);
    const boot = mk(sph(.27, 20, 14), m.white, 0, -.66, .1); boot.scale.set(1, .72, 1.4); g.add(boot);
    body.add(g); return g;
  };
  const rig = { key, root, body, head, back, armL: arm(-1), armR: arm(1), legL: leg(-1), legR: leg(1), m, mounts: {}, rimColor: new T.Color(hex) };
  const mounts = { head: new T.Group(), antenna: new T.Group(), back, chest: new T.Group(), hip: new T.Group() };
  mounts.head.position.set(...SLOT_POS.head); head.add(mounts.head);
  mounts.antenna.position.set(...SLOT_POS.antenna); head.add(mounts.antenna);
  mounts.chest.position.set(...SLOT_POS.chest); body.add(mounts.chest);
  mounts.hip.position.set(...SLOT_POS.hip); body.add(mounts.hip);
  rig.mounts = mounts;
  equipAll(rig);
  root.visible = false; scene.add(root);
  return rig;
}

function equipAll(rig) {
  const ids = loadouts[rig.key] || (CHAR_DEFS[rig.key] && CHAR_DEFS[rig.key].acc) || [];
  Object.values(rig.mounts).forEach(g => { if (g !== rig.back) g.clear(); else for (let i = g.children.length - 1; i >= 1 + 2; i--) g.remove(g.children[i]); });
  ids.forEach(id => {
    const a = ACCESSORIES[id]; if (!a) return;
    try { rig.mounts[a.slot].add(a.build(rig.m)); } catch (e) { /* un accesorio defectuoso no rompe al personaje */ }
  });
}
/* Cambia los accesorios de un personaje sin reconstruirlo (futuras opciones de personalización). */
export function setLoadout(key, ids) {
  loadouts[key] = Array.isArray(ids) ? ids.filter(id => ACCESSORIES[id]) : undefined;
  if (rigs[key]) equipAll(rigs[key]);
  instances.forEach(i => { if (i.key === key) i.dirty = true; });
}

/* ---------------- Poses / animaciones ---------------- */
const S = Math.sin, PI = Math.PI;
function reset(r) {
  r.root.position.set(0, 0, 0); r.root.rotation.set(0, 0, 0); r.root.scale.setScalar(1);
  r.body.position.set(0, 0, 0); r.body.rotation.set(0, 0, 0); r.body.scale.set(1, 1, 1);
  r.head.rotation.set(0, 0, 0);
  [r.armL, r.armR, r.legL, r.legR].forEach(p => p.rotation.set(0, 0, 0));
}
const ease = (u) => u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;

function pose(r, anim, t, inst) {
  reset(r);
  const P = (CHAR_DEFS[r.key] && CHAR_DEFS[r.key].idle) || { bob: 1, speed: 1 };
  r.root.visible = true;
  switch (anim) {
    case "walk": {
      const ph = t * 6;
      r.legL.rotation.x = .6 * S(ph); r.legR.rotation.x = -.6 * S(ph);
      r.armL.rotation.x = -.55 * S(ph); r.armR.rotation.x = .55 * S(ph);
      r.body.position.y = Math.abs(S(ph)) * .07; r.root.rotation.y = .55; r.head.rotation.y = -.2;
      break;
    }
    case "run": {
      const ph = t * 11;
      r.legL.rotation.x = 1.0 * S(ph); r.legR.rotation.x = -1.0 * S(ph);
      r.armL.rotation.x = -1.1 * S(ph); r.armR.rotation.x = 1.1 * S(ph);
      r.armL.rotation.z = -.15; r.armR.rotation.z = .15;
      r.body.position.y = Math.abs(S(ph)) * .14; r.body.rotation.x = .22; r.root.rotation.y = .7;
      break;
    }
    case "select": {
      const u = Math.min(1, t / .95);
      r.root.position.y = S(PI * u) * .5; r.root.rotation.y = ease(u) * PI * 2;
      r.armR.rotation.z = 2.5 + .25 * S(t * 18); r.armL.rotation.z = -.4;
      r.body.scale.y = 1 + .06 * S(PI * Math.min(1, t / .25));
      break;
    }
    case "vote": {
      const u = Math.min(1, t / .4);
      r.armR.rotation.x = -1.55 * ease(u); r.armR.rotation.z = .1;
      r.head.rotation.x = .12 * S(t * 6); r.body.rotation.x = .1 * ease(u); r.root.rotation.y = -.35 * ease(u);
      r.armL.rotation.z = -.12;
      break;
    }
    case "win": {
      const ph = t * 5;
      r.root.position.y = Math.abs(S(ph)) * .55; r.root.rotation.y = .35 * S(t * 3);
      r.armL.rotation.z = -(2.5 + .3 * S(ph * 2)); r.armR.rotation.z = 2.5 + .3 * S(ph * 2 + 1);
      r.legL.rotation.x = .25 * S(ph); r.legR.rotation.x = -.25 * S(ph);
      break;
    }
    case "lose": case "dead": {
      const u = anim === "dead" ? 1 : ease(Math.min(1, t / .7));
      r.body.rotation.x = .28 * u; r.head.rotation.x = .55 * u;
      r.armL.rotation.z = -.28 * u; r.armR.rotation.z = .28 * u; r.armL.rotation.x = .2 * u; r.armR.rotation.x = .2 * u;
      r.body.position.y = -.12 * u + (anim === "dead" ? 0 : .02 * S(t * 9) * u);
      r.root.rotation.y = .25 * u;
      break;
    }
    case "ejected": {
      const dur = (inst && inst.dur ? inst.dur : 3000) / 1000, u = Math.min(1, t / dur);
      const k = Math.pow(u, 1.15);
      r.root.position.set(-1.0 + 2.0 * k, .25 * S(PI * u) + .3 * k, -4.6 - 18 * k);
      r.root.rotation.set(u * 5, 0.4 + u * 2.5, u * 10);
      r.armL.rotation.z = -1.2 + .6 * S(t * 7); r.armR.rotation.z = 1.2 - .6 * S(t * 7 + 1);
      r.legL.rotation.x = .8 * S(t * 6); r.legR.rotation.x = -.8 * S(t * 6);
      if (u >= 1) r.root.visible = false;
      break;
    }
    case "reveal": {
      const u = Math.min(1, t / .9);
      const sc = u < .6 ? (u / .6) * 1.18 : 1.18 - .18 * ((u - .6) / .4);
      r.root.scale.setScalar(Math.max(.01, sc)); r.root.rotation.y = (1 - ease(u)) * PI * 2;
      r.armR.rotation.z = .5 * (1 - u); r.armL.rotation.z = -.5 * (1 - u);
      break;
    }
    default: { // idle: respiración y flotación suave, cada color con su ritmo
      const sp = P.speed, bb = P.bob;
      r.body.position.y = .06 * bb * S(t * 2 * sp);
      r.body.scale.y = 1 + .014 * bb * S(t * 2.2 * sp + 1);
      r.armL.rotation.z = -.07 - .05 * S(t * 2 * sp + .6); r.armR.rotation.z = .07 + .05 * S(t * 2 * sp + .2);
      r.head.rotation.y = .18 * S(t * .9 * sp); r.root.rotation.y = .3 * S(t * .7 * sp);
      r.legL.rotation.x = .03 * S(t * 2 * sp); r.legR.rotation.x = -.03 * S(t * 2 * sp);
    }
  }
  r.m.blinkers.forEach(b => { b.emissiveIntensity = .55 + .45 * S(t * 4.5 + 1); });
  const sh = r.root.children[1];
  if (sh) { const f = 1 - Math.min(.35, Math.max(0, r.body.position.y + r.root.position.y) * .5); sh.scale.set(f, f, f); sh.visible = anim !== "ejected"; }
}

/* ---------------- Instancias (canvas) ---------------- */
function isStatic(i) { return REDUCED || i.anim === "dead"; }

function drawInstance(inst, now) {
  const rig = rigs[inst.key] || (palette[inst.key] ? (rigs[inst.key] = buildRig(inst.key)) : null);
  if (!rig) return;
  const loopAnim = inst.anim;
  let t = (now - inst.start) / 1000;
  if (inst.dur && now - inst.start >= inst.dur && inst.anim !== "ejected") {
    inst.anim = inst.next || "idle"; inst.dur = 0; inst.start = now; t = 0; inst.dirty = true;
  }
  if (REDUCED) t = inst.anim === "idle" ? 0 : 0.6;
  Object.keys(rigs).forEach(k => { rigs[k].root.visible = false; });
  pose(rig, inst.anim === loopAnim ? inst.anim : inst.anim, t, inst);
  rimLight.color.copy(rig.rimColor);
  renderer.render(scene, camera);
  const c = inst.canvas, ctx = inst.ctx;
  sizeCanvas(inst);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(renderer.domElement, 0, 0, R_W, R_H, 0, 0, c.width, c.height);
  inst.dirty = false;
  if (!inst.shown) { inst.shown = true; const p = c.closest(".crewmate"); if (p) p.classList.add("ready3d"); c.classList.add("ready3d"); }
}

function sizeCanvas(inst) {
  const c = inst.canvas, dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = Math.min(R_W, Math.round((c.clientWidth || c.parentElement && c.parentElement.clientWidth || 64) * dpr));
  const h = Math.round(w * R_H / R_W);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
}

function loop(now) {
  rafId = 0;
  if (!ready || document.hidden) { schedule(); return; }
  const live = [];
  instances.forEach((inst, c) => {
    if (!c.isConnected) { instances.delete(c); if (inst.target) { io && io.unobserve(inst.target); targets.delete(inst.target); } return; }
    if (!inst.visible || pausedGroups.has(inst.group)) return;
    live.push(inst);
  });
  const interval = Math.max(1000 / LEVELS[level].fps, live.length > 10 ? 50 : 0);
  if (now - lastDraw >= interval) {
    lastDraw = now;
    const t0 = performance.now(); let drawn = 0;
    for (const inst of live) {
      if (isStatic(inst) && inst.shown && !inst.dirty) continue;
      try { drawInstance(inst, now); drawn++; } catch (e) { inst.failed = true; instances.delete(inst.canvas); }
    }
    if (drawn && ++warm > 6) govern(performance.now() - t0, interval);
  }
  schedule();
}
const FORCE = /[?&]3d=force\b/.test(location.search);   // depuración: sin gobernador de calidad
function govern(cost, interval) {
  if (FORCE) return;
  ema = ema ? ema * .7 + cost * .3 : cost;
  if (ema > interval * .7) { good = 0; if (++over >= 3) { over = 0; ema = 0; warm = 3; setLevel(level + 1); } }
  else { over = 0; if (ema < interval * .12 && level > 0) { if (++good >= 120) { good = 0; setLevel(level - 1); } } else good = 0; }
}
function setLevel(n) {
  if (n >= LEVELS.length) { disable("equipo lento"); return; }
  level = n; R_W = LEVELS[n].w; R_H = Math.round(R_W * ASPECT);
  renderer.setSize(R_W, R_H, false);
  instances.forEach(i => { i.dirty = true; });
}
function disable(why) {
  failed = true; ready = false;
  document.querySelectorAll(".ready3d").forEach(e => e.classList.remove("ready3d"));
  instances.clear(); targets.clear(); if (mo) mo.disconnect();
  console.warn("Personajes 3D desactivados (" + why + "): se usa el diseño CSS.");
}
function schedule() { if (!rafId && !failed && instances.size) rafId = requestAnimationFrame(loop); }

export function attach(canvas, key) {
  if (failed || !canvas) return null;
  let inst = instances.get(canvas);
  if (inst) return inst;
  const g = canvas.closest("[data-cmgroup]");
  inst = { canvas, ctx: canvas.getContext("2d"), key: key || canvas.dataset.key, anim: canvas.dataset.anim || "idle", start: performance.now() - Math.random() * 3000,
           dur: 0, next: "idle", visible: true, group: g ? g.dataset.cmgroup : "main", dirty: true, shown: false };
  instances.set(canvas, inst);
  inst.target = canvas.parentElement || canvas; targets.set(inst.target, inst);
  if (io) io.observe(inst.target);
  schedule();
  return inst;
}
export function setKey(canvas, key) { const i = instances.get(canvas) || attach(canvas, key); if (i) { i.key = key; i.dirty = true; } }
/* Reproduce una animación (las de una sola vez vuelven a `next`, por defecto idle). */
export function play(canvas, anim, opts) {
  const i = instances.get(canvas) || attach(canvas); if (!i) return;
  opts = opts || {};
  i.anim = anim; i.start = performance.now(); i.dirty = true;
  i.dur = opts.dur != null ? opts.dur : ({ select: 950, vote: 1300, reveal: 900 })[anim] || 0;
  i.next = opts.next || "idle";
  schedule();
}
export function pauseGroup(g, on) { on ? pausedGroups.add(g) : pausedGroups.delete(g); if (!on) schedule(); }
export function scan(root) {
  if (failed || !ready) return;
  (root || document).querySelectorAll("canvas.cm3d").forEach(c => { if (!instances.has(c)) attach(c); });
}
export const ok = () => ready && !failed;

/* ---------------- Inicio (carga progresiva) ---------------- */
function makeEnv() {
  const c = document.createElement("canvas"); c.width = 512; c.height = 256;
  const g = c.getContext("2d");
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, "#0b1030"); grd.addColorStop(.45, "#3a5fb8"); grd.addColorStop(.52, "#9fe6ff"); grd.addColorStop(.6, "#2a2f66"); grd.addColorStop(1, "#080a1c");
  g.fillStyle = grd; g.fillRect(0, 0, 512, 256);
  g.fillStyle = "#ffffff";
  [[70, 40, 90, 14], [250, 60, 140, 10], [400, 30, 70, 18], [160, 100, 60, 8]].forEach(r => g.fillRect(r[0], r[1], r[2], r[3]));
  g.fillStyle = "#ff6b8a"; g.fillRect(330, 90, 80, 10);
  return c;
}
function makeShadowTex() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), r = g.createRadialGradient(64, 64, 4, 64, 64, 60);
  r.addColorStop(0, "rgba(0,0,0,.55)"); r.addColorStop(.6, "rgba(0,0,0,.22)"); r.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return new T.CanvasTexture(c);
}

export function init(colors) {
  if (/[?&]3d=0\b/.test(location.search)) { failed = true; return Promise.resolve(false); }
  (colors || []).forEach(c => { palette[c.key] = c.hex; });
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      T = await import(/* webpackIgnore: true */ THREE_URL);
      renderer = new T.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "low-power" });
      if (!renderer.getContext()) throw new Error("sin WebGL");
      renderer.setPixelRatio(1); renderer.setSize(R_W, R_H, false);
      renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
      scene = new T.Scene();
      const envTex = new T.CanvasTexture(makeEnv()); envTex.mapping = T.EquirectangularReflectionMapping; envTex.colorSpace = T.SRGBColorSpace;
      const pm = new T.PMREMGenerator(renderer); scene.environment = pm.fromEquirectangular(envTex).texture; pm.dispose(); envTex.dispose();
      scene.add(new T.HemisphereLight(0x9fc0ff, 0x1a1030, .55));
      const key = new T.DirectionalLight(0xffffff, 2.1); key.position.set(3, 5, 6); scene.add(key);
      rimLight = new T.DirectionalLight(0xffffff, 1.7); rimLight.position.set(-4, 3, -4); scene.add(rimLight);
      camera = new T.PerspectiveCamera(30, 300 / 403, .1, 80); camera.position.set(0, .95, 6.6); camera.lookAt(0, .9, 0);
      shadowTex = makeShadowTex();
      if ("IntersectionObserver" in window) io = new IntersectionObserver(es => es.forEach(e => { const i = targets.get(e.target); if (i) { i.visible = e.isIntersecting; if (e.isIntersecting) i.dirty = true; } }));
      renderer.domElement.addEventListener("webglcontextlost", e => { e.preventDefault(); failed = true; ready = false; document.querySelectorAll(".crewmate.ready3d").forEach(p => p.classList.remove("ready3d")); });
      ready = true;
      mo = new MutationObserver(() => { if (scanQueued) return; scanQueued = true; requestAnimationFrame(() => { scanQueued = false; scan(document); }); });
      mo.observe(document.body, { childList: true, subtree: true });
      scan(document);
      return true;
    } catch (e) {
      failed = true; ready = false; console.warn("Personajes 3D no disponibles, se usa el diseño CSS:", e && e.message);
      return false;
    }
  })();
  return initPromise;
}

export const cm3d = { init, attach, setKey, play, pauseGroup, scan, ok, setLoadout, ACCESSORIES, CHAR_DEFS };
