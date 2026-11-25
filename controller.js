// battle.training Armor controller - season 2 "Drafted" (s2.0.0)
// Pure JS. No network, no require, no filesystem. Runs in an isolated QuickJS VM.
// Reads every number from h.rules; never hard-codes rules values.

const FP = 65536;
const FULL = 4096;
const D8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

let R = null, M = null, SIDE = 0, W = 0, H = 0, NP = 0;
let PASS = null, OBJ = [], FIELDS = [], HOMEF = null;
let HOME = [0, 0], EHOME = [0, 0], HILL = -1, READY = false;
let LASTSMOKE = -1000;

const MEM = new Map();      // enemy id -> last seen state
const STUCK = new Map();    // our unit id -> backoff timer

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const iround = Math.round;

function distF(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy); }
function distT(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy) / FP; }
function angTo(ax, ay, bx, by) { return iround(Math.atan2(by - ay, bx - ax) * FULL / (2 * Math.PI)) & (FULL - 1); }
function angDiff(a, b) { let d = (b - a) & (FULL - 1); return d > FULL / 2 ? d - FULL : d; }
function cosA(a) { return Math.cos(a * 2 * Math.PI / FULL); }
function sinA(a) { return Math.sin(a * 2 * Math.PI / FULL); }
function cxOf(t) { return (t << 16) + 32768; }

// ---------------------------------------------------------------- navigation
function bfs(gx, gy) {
  const d = new Int32Array(NP).fill(-1);
  if (gx < 0 || gy < 0 || gx >= W || gy >= H) return d;
  const gi = gy * W + gx;
  if (!PASS[gi]) return d;
  const q = new Int32Array(NP);
  let head = 0, tail = 0;
  d[gi] = 0; q[tail++] = gi;
  while (head < tail) {
    const i = q[head++], x = i % W, y = (i - x) / W, nd = d[i] + 1;
    for (let k = 0; k < 8; k++) {
      const nx = x + D8[k][0], ny = y + D8[k][1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (d[j] !== -1 || !PASS[j]) continue;
      if (k & 1 && (!PASS[y * W + nx] || !PASS[ny * W + x])) continue;
      d[j] = nd; q[tail++] = j;
    }
  }
  return d;
}

// walk a distance field up to n tiles ahead; returns a world point
function fieldLook(f, x, y, n) {
  let tx = x >> 16, ty = y >> 16;
  if (tx < 0 || ty < 0 || tx >= W || ty >= H) return null;
  for (let step = 0; step < n; step++) {
    let i = ty * W + tx, bd = f[i], bx = -1, by = -1;
    if (bd < 0) {
      let found = false;
      for (let r = 1; r <= 5 && !found; r++) {
        for (let dy = -r; dy <= r && !found; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const nx = tx + dx, ny = ty + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const j = ny * W + nx;
            if (f[j] >= 0) { bx = nx; by = ny; bd = f[j]; found = true; break; }
          }
        }
      }
      if (!found) return null;
      tx = bx; ty = by; continue;
    }
    for (let k = 0; k < 8; k++) {
      const nx = tx + D8[k][0], ny = ty + D8[k][1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (f[j] < 0) continue;
      if (k & 1 && (!PASS[ty * W + nx] || !PASS[ny * W + tx])) continue;
      if (f[j] < bd) { bd = f[j]; bx = nx; by = ny; }
    }
    if (bx < 0) break;
    tx = bx; ty = by;
  }
  return [cxOf(tx), cxOf(ty)];
}

function clearAhead(u, ang, air) {
  for (const a of [0.7, 1.45]) {
    const px = u.x + cosA(ang) * a * FP, py = u.y + sinA(ang) * a * FP;
    const tx = px >> 16, ty = py >> 16;
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
    if (!air && !PASS[ty * W + tx]) return false;
  }
  return true;
}

function drive(u, spec, want, o, air, slow) {
  if (!o.canMove) return null;
  if (!clearAhead(u, want, air)) {
    for (const off of [256, -256, 512, -512, 768, -768, 1024, -1024, 1365, -1365]) {
      if (clearAhead(u, (want + off) & (FULL - 1), air)) { want = (want + off) & (FULL - 1); break; }
    }
  }
  const d = angDiff(u.heading, want), ad = Math.abs(d);
  let th = FP;
  if (ad > 1300) th = FP * 0.2; else if (ad > 700) th = FP * 0.55;
  if (slow) th = Math.min(th, FP * 0.6);
  const st = clamp(iround(d * FP / Math.max(1, spec.turnRate)), -FP, FP);
  return { steer: st, throttle: iround(th) };
}

function applyStuck(u, o, order) {
  let s = STUCK.get(u.id);
  if (u.blocked && (!s || o.tick >= s.until + 6)) {
    s = { until: o.tick + 12, steer: ((u.id + (o.tick >> 3)) & 1) ? FP : -FP };
    STUCK.set(u.id, s);
  }
  if (s && o.tick < s.until) {
    order.throttle = -Math.round(FP * 0.65);
    order.steer = s.steer;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- sensing
function estHp(c) {
  const sp = R.units[c.kind];
  if (!sp) return 40;
  return Math.max(1, iround(((c.hpFrac | 0) / FP) * sp.hp));
}

const THREAT = { artillery: 7, missile: 6, mbt: 5, apc: 3, engineer: 2.5, scout: 2, drone: 2 };
function tscore(c) {
  return (THREAT[c.kind] || 2) * 10 + (1 - (c.hpFrac | 0) / FP) * 14;
}

function canEngage(u, c, gun) {
  if (!c || c.x === undefined) return false;
  const seen = c.seenBy;
  if (!seen || seen.indexOf(u.id) < 0) return false;
  const d = distF(u.x, u.y, c.x, c.y);
  if (d > gun.maxRange) return false;
  if (gun.minRange && d < gun.minRange) return false;
  return true;
}

function leadPoint(u, c, gun) {
  const dx = c.x - u.x, dy = c.y - u.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const fl = d / Math.max(1, gun.shellSpeed);
  const sp = c.speed || 0, hd = c.heading || 0;
  return [iround(c.x + cosA(hd) * sp * fl), iround(c.y + sinA(hd) * sp * fl), d];
}

function assignTargets(alive, contacts) {
  const out = {}, assigned = {};
  const shooters = [];
  for (const u of alive) {
    const sp = R.units[u.kind];
    if (sp && sp.gun.mode === 'direct' && !sp.gun.lockTicks) shooters.push(u);
  }
  const list = contacts.slice().sort((a, b) => tscore(b) - tscore(a));
  for (const u of shooters) {
    const gun = R.units[u.kind].gun;
    const weak = gun.damage <= 12;
    let pick = null, bs = -1e9;
    for (const c of list) {
      if (!canEngage(u, c, gun)) continue;
      if ((assigned[c.id] || 0) >= estHp(c)) continue;
      const s = shooterScore(u, c, weak);
      if (s > bs) { bs = s; pick = c; }
    }
    if (!pick) for (const c of list) {
      if (!canEngage(u, c, gun)) continue;
      const s = shooterScore(u, c, weak);
      if (s > bs) { bs = s; pick = c; }
    }
    if (pick) {
      out[u.id] = pick.id;
      assigned[pick.id] = (assigned[pick.id] || 0) + Math.max(1, gun.damage - 8);
    }
  }
  return out;
}

// weak guns cannot scratch an MBT's front; they should farm soft targets.
function shooterScore(u, c, weak) {
  let s = tscore(c) - distT(u.x, u.y, c.x, c.y) * 0.7;
  if (weak && c.kind === 'mbt') s -= 70;
  if (!weak && c.kind === 'drone') s += 12;
  return s;
}

function nearestKind(contacts, kind, u) {
  let best = null, bd = Infinity;
  for (const c of contacts) {
    if (kind && c.kind !== kind) continue;
    const d = distF(u.x, u.y, c.x, c.y);
    if (d < bd) { bd = d; best = c; }
  }
  return best ? { c: best, d: bd } : null;
}

function awayPoint(u, from, tiles) {
  const ang = angTo(from.x, from.y, u.x, u.y);
  return [iround(u.x + cosA(ang) * tiles * FP), iround(u.y + sinA(ang) * tiles * FP)];
}

// ---------------------------------------------------------------- hello / draft
function hello(h) {
  try {
    R = h.rules; M = h.map; SIDE = (h.side | 0) === 1 ? 1 : 0;
    W = M.width | 0; H = M.height | 0; NP = W * H;
    const ts = R.terrainSpeed || {};
    PASS = new Uint8Array(NP);
    for (let i = 0; i < NP; i++) PASS[i] = (ts[M.terrain[i]] | 0) > 0 ? 1 : 0;

    OBJ = [];
    const src = h.objectives || [];
    for (let i = 0; i < src.length; i++) {
      const o = src[i];
      OBJ.push({
        i, x: o.x | 0, y: o.y | 0,
        r: (o.radius | 0) || 327680,
        w: (o.weight | 0) || 1, hill: false
      });
    }
    const cxf = (W >> 1) << 16, cyf = (H >> 1) << 16;
    HILL = -1;
    for (const o of OBJ) if (Math.abs(o.x - cxf) < FP && Math.abs(o.y - cyf) < FP) { o.hill = true; HILL = o.i; }

    const sp = (M.spawns && M.spawns[SIDE]) || [2, H >> 1];
    const ep = (M.spawns && M.spawns[1 - SIDE]) || [W - 3, H >> 1];
    HOME = [cxOf(sp[0]), cxOf(sp[1])];
    EHOME = [cxOf(ep[0]), cxOf(ep[1])];
    FIELDS = OBJ.map(o => bfs(o.x >> 16, o.y >> 16));
    HOMEF = bfs(sp[0], sp[1]);
    MEM.clear(); STUCK.clear();
    LASTSMOKE = -1000;
    READY = true;
  } catch (e) { READY = false; }
}

const DRAFT_PREFS = [
  ['mbt', 'mbt', 'drone', 'drone'],
  ['mbt', 'mbt', 'scout', 'scout'],
  ['mbt', 'mbt', 'apc'],
  ['apc', 'drone', 'mbt', 'scout'],
  ['mbt', 'artillery', 'drone', 'scout'],
];

function chooseDraft(h) {
  const d = h && h.draft;
  if (!d || !d.roster || !d.costs) return undefined;
  const budget = d.budget | 0, min = d.min | 0, max = d.max | 0;
  for (const pick of DRAFT_PREFS) {
    if (pick.length < min || pick.length > max) continue;
    let cost = 0, ok = true;
    for (const k of pick) {
      if (d.roster.indexOf(k) < 0 || typeof d.costs[k] !== 'number') { ok = false; break; }
      cost += d.costs[k];
    }
    if (ok && cost <= budget) return pick.slice();
  }
  return undefined;
}

// ---------------------------------------------------------------- squad plan
function pickPoint(from, skipHill) {
  let best = null, bs = -1e9;
  for (const o of OBJ) {
    if (skipHill && o.hill) continue;
    const s = o.w / (1 + distT(from[0], from[1], o.x, o.y) / 12);
    if (s > bs) { bs = s; best = o; }
  }
  return best || OBJ[0] || null;
}

function slotFor(obj, u, radT, tx, ty) {
  if (!obj) return [HOME[0], HOME[1]];
  const base = angTo(obj.x, obj.y, tx, ty);
  const spread = ((u.id * 2.399) % 1) - 0.5;
  const ang = (base + iround(spread * 900)) & (FULL - 1);
  const rad = radT * FP;
  return [obj.x + iround(cosA(ang) * rad), obj.y + iround(sinA(ang) * rad)];
}

function nearestObjField(gx, gy) {
  let fi = 0, bd = Infinity;
  for (let i = 0; i < OBJ.length; i++) {
    const q = OBJ[i];
    const dd = (q.x - gx) * (q.x - gx) + (q.y - gy) * (q.y - gy);
    if (dd < bd) { bd = dd; fi = i; }
  }
  return FIELDS[fi];
}

function moveTo(u, spec, gx, gy, stopT, o, air, slow) {
  const d = distF(u.x, u.y, gx, gy);
  if (d <= stopT * FP) return null;
  let want;
  if (d > 7 * FP) {
    const look = fieldLook(nearestObjField(gx, gy), u.x, u.y, 4);
    want = look ? angTo(u.x, u.y, look[0], look[1]) : angTo(u.x, u.y, gx, gy);
  } else {
    want = angTo(u.x, u.y, gx, gy);
  }
  return drive(u, spec, want, o, air, slow);
}

function makePlan(o, units, contacts) {
  const t = o.tick | 0;
  const alive = [];
  for (const u of units) if (u.alive) alive.push(u);

  const known = [];
  for (const m of MEM.values()) if (t - m.t <= 120) known.push(m);
  const ref = contacts.length ? contacts : known;
  let cxs = 0, cys = 0;
  for (const c of ref) { cxs += c.x; cys += c.y; }
  const centroid = ref.length ? [cxs / ref.length, cys / ref.length] : [EHOME[0], EHOME[1]];

  const homeObj = pickPoint(HOME, true) || OBJ[0] || null;
  const awayObj = pickPoint(EHOME, true) || homeObj;
  const lead = (o.score ? o.score[SIDE] : 0) - (o.score ? o.score[1 - SIDE] : 0);
  const maxT = R.maxTicks || 4800;
  const aggressive = lead <= 0 || t < maxT * 0.5;

  // the APC commits to a point and holds it for the double capture
  let apcObj = null;
  const apc = alive.find(u => u.kind === 'apc');
  if (apc) {
    for (const obj of OBJ) if (distF(apc.x, apc.y, obj.x, obj.y) <= obj.r) { apcObj = obj; break; }
    if (!apcObj) {
      let bs = -1e9;
      for (const obj of OBJ) {
        if (obj.owner === 1 - SIDE) continue;
        let s = obj.w * 10 - distT(apc.x, apc.y, obj.x, obj.y) * 0.35;
        if (obj === homeObj) s += 6;
        if (s > bs) { bs = s; apcObj = obj; }
      }
    }
  }

  // an enemy standing in one of our points pulls the squad back
  let defendObj = null;
  for (const obj of OBJ) {
    if (!(obj.owner === SIDE || obj === apcObj)) continue;
    for (const c of contacts) {
      if (distF(c.x, c.y, obj.x, obj.y) <= obj.r + 2 * FP) { defendObj = obj; break; }
    }
    if (defendObj) break;
  }

  let mainObj = defendObj;
  if (!mainObj) {
    if (homeObj && homeObj.owner !== SIDE) mainObj = homeObj;
    else if (HILL >= 0 && OBJ[HILL] && OBJ[HILL].owner !== SIDE && (aggressive || t > 900)) mainObj = OBJ[HILL];
    else if (aggressive) mainObj = awayObj;
    else mainObj = homeObj;
  }
  if (!mainObj) mainObj = OBJ[0] || null;

  let scoutObj = awayObj;
  if (!scoutObj || scoutObj.owner === SIDE) scoutObj = mainObj;

  return {
    t, alive, contacts, centroid, homeObj, awayObj, apcObj, defendObj, mainObj, scoutObj,
    aggressive, lead, assign: assignTargets(alive, contacts), apc,
    mbtCount: alive.filter(u => u.kind === 'mbt').length,
  };
}

function friendlyNear(x, y, r, alive, exceptId) {
  for (const u of alive) {
    if (u.id === exceptId) continue;
    if (distF(u.x, u.y, x, y) < r) return true;
  }
  return false;
}

function artyTarget(u, sp, o) {
  const gun = sp.gun, contacts = o.contacts || [];
  let best = null, bs = -1e9;
  for (const c of contacts) {
    const d = distF(u.x, u.y, c.x, c.y);
    if (d < gun.minRange || d > gun.maxRange) continue;
    let cl = 0;
    for (const c2 of contacts) if (distF(c.x, c.y, c2.x, c2.y) <= gun.splash) cl++;
    const s = cl * 50 + (1 - (c.hpFrac | 0) / FP) * 40 + (THREAT[c.kind] || 1) * 5 - d / FP * 0.4;
    if (s > bs) { bs = s; best = c; }
  }
  if (best) {
    const dx = best.x - u.x, dy = best.y - u.y;
    const fl = 2 * (R.tickHz || 20) + Math.sqrt(dx * dx + dy * dy) / FP;
    return { x: best.x + cosA(best.heading || 0) * (best.speed || 0) * fl, y: best.y + sinA(best.heading || 0) * (best.speed || 0) * fl };
  }
  // no spotter: blind-fire an enemy-held point (they must have a unit inside)
  for (const obj of OBJ) {
    if (obj.owner !== 1 - SIDE) continue;
    const d = distF(u.x, u.y, obj.x, obj.y);
    if (d < gun.minRange || d > gun.maxRange) continue;
    return { x: obj.x, y: obj.y };
  }
  return null;
}

// ---------------------------------------------------------------- per-unit orders
function unitOrders(u, o, plan) {
  const sp = R.units[u.kind];
  if (!sp) return { id: u.id };
  const order = { id: u.id };
  const t = o.tick | 0;
  const air = !!sp.air;
  const contacts = o.contacts || [];

  let dodge = null;
  for (const inc of o.incoming || []) {
    if ((inc.ticks | 0) > 26) continue;
    if (distF(u.x, u.y, inc.x, inc.y) < 4.2 * FP) { dodge = inc; break; }
  }

  const tid = plan.assign[u.id];
  let tgt = null;
  if (tid !== undefined) for (const c of contacts) if (c.id === tid) { tgt = c; break; }
  let faceC = tgt;
  if (u.kind === 'mbt' || u.kind === 'apc') {
    const hard0 = nearestKind(contacts, 'mbt', u);
    if (hard0 && (!tgt || hard0.d < 30 * FP)) faceC = hard0.c;
  }

  let goal = null, stopT = 1, slow = false;

  if (dodge) {
    goal = awayPoint(u, dodge, 6);
    stopT = 0.3;
  } else if (u.kind === 'mbt') {
    const obj = plan.mainObj;
    if (obj) {
      const hard = nearestKind(contacts, 'mbt', u);
      const closeToObj = distT(u.x, u.y, obj.x, obj.y) < 14;
      if (hard && hard.d < 26 * FP && closeToObj) {
        goal = null; // stand and fight with the front armour on the threat
      } else {
        goal = slotFor(obj, u, 2.6, plan.centroid[0], plan.centroid[1]);
        stopT = 0.9;
        if (obj.owner !== SIDE && tgt && distF(u.x, u.y, tgt.x, tgt.y) > 22 * FP) slow = true;
      }
    }
  } else if (u.kind === 'apc') {
    const obj = plan.apcObj || plan.homeObj || plan.mainObj;
    if (obj) {
      const mb = nearestKind(contacts, 'mbt', u);
      let flee = false;
      if (mb && mb.d < 10 * FP) {
        let hd = Infinity;
        for (const f of plan.alive) {
          if (f.id === u.id || (f.kind !== 'mbt' && f.kind !== 'apc')) continue;
          const d = distF(u.x, u.y, f.x, f.y);
          if (d < hd) hd = d;
        }
        if (hd > 12 * FP) flee = true;
      }
      if (flee) { goal = [HOME[0], HOME[1]]; stopT = 1; }
      else { goal = [obj.x, obj.y]; stopT = 0.6; }
    }
  } else if (u.kind === 'scout') {
    let hunt = null, hd = Infinity;
    for (const c of contacts) {
      if (c.kind === 'mbt') continue;
      const d = distF(u.x, u.y, c.x, c.y);
      if (d < 40 * FP && d < hd) { hd = d; hunt = c; }
    }
    const hard = nearestKind(contacts, 'mbt', u);
    if (hard && hard.d < 18 * FP) {
      goal = awayPoint(u, hard.c, 13);
      stopT = 0.5;
    } else if (hunt && hd < 17 * FP) {
      goal = [hunt.x, hunt.y];
      stopT = 9;
    } else {
      const obj = plan.scoutObj || plan.mainObj;
      if (obj) {
        goal = slotFor(obj, u, 7.5, plan.centroid[0], plan.centroid[1]);
        stopT = 1.5;
      }
    }
  } else if (u.kind === 'drone') {
    const drones = plan.alive.filter(x => x.kind === 'drone');
    const idx = drones.findIndex(x => x.id === u.id);
    const spotter = drones.length < 2 || idx === 0;
    let near = null, nd = Infinity;
    for (const c of contacts) {
      const d = distF(u.x, u.y, c.x, c.y);
      if (d < nd) { nd = d; near = c; }
    }
    if (spotter) {
      if (near) {
        if (nd < 27 * FP || nd > 34 * FP) {
          const ang = angTo(near.x, near.y, u.x, u.y);
          goal = [near.x + iround(cosA(ang) * 30 * FP), near.y + iround(sinA(ang) * 30 * FP)];
          stopT = 1.5;
        }
      } else {
        goal = [EHOME[0], EHOME[1]];
        stopT = 12;
      }
    } else {
      const obj = (plan.awayObj && plan.awayObj.owner !== SIDE) ? plan.awayObj
        : (HILL >= 0 && OBJ[HILL] && OBJ[HILL].owner !== SIDE ? OBJ[HILL] : plan.mainObj);
      if (near && nd < 10 * FP) {
        goal = awayPoint(u, near, 13);
        stopT = 0.5;
      } else if (obj) {
        goal = [obj.x, obj.y];
        stopT = 0.8;
      }
    }
  } else if (u.kind === 'artillery' || u.kind === 'missile') {
    if (u.ammo === 0 && (R.maxTicks - t) > 800) {
      goal = [HOME[0], HOME[1]];
      stopT = 1;
    } else {
      const obj = plan.mainObj || plan.homeObj;
      const closeT = u.kind === 'artillery' ? 9 : 11;
      const near = nearestKind(contacts, null, u);
      if (near && near.d < closeT * FP) {
        const look = fieldLook(HOMEF, u.x, u.y, 4);
        if (look) { goal = look; stopT = 0.8; }
      } else if (obj) {
        const f = FIELDS[obj.i];
        const ft = f[(u.y >> 16) * W + (u.x >> 16)];
        const lo = u.kind === 'artillery' ? 19 : 15;
        const hi = u.kind === 'artillery' ? 31 : 27;
        if (ft < 0 || ft > hi) {
          const look = fieldLook(f, u.x, u.y, 5);
          if (look) { goal = look; stopT = 0.8; }
        } else if (ft < lo && near && near.d < 36 * FP) {
          const look = fieldLook(HOMEF, u.x, u.y, 4);
          if (look) { goal = look; stopT = 0.8; }
        }
      }
    }
  } else if (u.kind === 'engineer') {
    const obj = plan.mainObj;
    if (obj) {
      goal = slotFor(obj, u, 3.8, plan.centroid[0], plan.centroid[1]);
      stopT = 1.2;
    }
  }

  if (goal) {
    const mv = moveTo(u, sp, goal[0], goal[1], stopT, o, air, slow);
    if (mv) { order.steer = mv.steer; order.throttle = mv.throttle; }
  }

  // when stopped, keep the front armour (and fixed guns) on the threat
  if (order.throttle === undefined && o.canMove) {
    let fx = null, fy = null;
    if (faceC) {
      let g = sp.gun;
      if (g.mode === 'indirect') g = sp.secondary || g;
      if (g && g.shellSpeed > 0) {
        const lp = leadPoint(u, faceC, g);
        fx = lp[0]; fy = lp[1];
      } else { fx = faceC.x; fy = faceC.y; }
    } else if (plan.centroid) {
      fx = plan.centroid[0]; fy = plan.centroid[1];
    }
    if (fx !== null) {
      const want = angTo(u.x, u.y, fx, fy);
      const d = angDiff(u.heading, want);
      if (Math.abs(d) > 50) {
        order.steer = clamp(iround(d * FP / Math.max(1, sp.turnRate)), -FP, FP);
        order.throttle = 0;
      } else order.throttle = 0;
    }
  }

  applyStuck(u, o, order);

  // ------------------------------------------------------------ weapons
  const gun = sp.gun;
  if (gun && gun.lockTicks) {
    let pick = null, bs = -1e9;
    for (const c of contacts) {
      const d = distF(u.x, u.y, c.x, c.y);
      if (d < gun.minRange || d > gun.maxRange) continue;
      if (!c.seenBy || !c.seenBy.length) continue;
      const s = tscore(c) - d / FP * 0.5;
      if (s > bs) { bs = s; pick = c; }
    }
    if (pick) {
      order.target = pick.id;
      order.aimAt = [pick.x, pick.y];
      if (u.reload === 0 && u.ammo > 0 && (u.lockTicks | 0) >= gun.lockTicks) order.fire = true;
    }
  } else if (gun && gun.mode === 'direct') {
    if (tgt) {
      const lp = leadPoint(u, tgt, gun);
      order.aimAt = [lp[0], lp[1]];
      const fixed = sp.fixedGun || u.kind === 'scout';
      const rate = fixed ? sp.turnRate : sp.turretRate;
      const aimAng = angTo(u.x, u.y, lp[0], lp[1]);
      if (u.reload === 0 && Math.abs(angDiff(u.turret, aimAng)) <= gun.aimTolerance + rate) order.fire = true;
    }
  } else if (gun && gun.mode === 'indirect') {
    if (u.reload === 0 && u.ammo !== 0) {
      const at = artyTarget(u, sp, o);
      if (at && !friendlyNear(at.x, at.y, gun.splash + 1.2 * FP, plan.alive, u.id)) {
        order.fire = [iround(at.x), iround(at.y)];
      }
    }
    if (order.fire === undefined && sp.secondary && tgt && u.reload2 === 0) {
      const d = distF(u.x, u.y, tgt.x, tgt.y);
      if (d <= sp.secondary.maxRange) {
        const ang = angTo(u.x, u.y, tgt.x, tgt.y);
        if (Math.abs(angDiff(u.turret, ang)) <= sp.secondary.aimTolerance + sp.turnRate) order.fire = true;
      }
    }
  } else if (gun && gun.mode === 'none' && sp.secondary && tgt && u.reload2 === 0) {
    const d = distF(u.x, u.y, tgt.x, tgt.y);
    if (d <= sp.secondary.maxRange) {
      const ang = angTo(u.x, u.y, tgt.x, tgt.y);
      if (Math.abs(angDiff(u.turret, ang)) <= sp.secondary.aimTolerance + sp.turnRate) order.fire = true;
    }
  }

  // ------------------------------------------------------------ engineer abilities
  if (sp.abilities && u.charges) {
    if (order.ability === undefined && u.charges.smoke > 0 && t - LASTSMOKE > 170) {
      const near = nearestKind(contacts, null, u);
      if (near && near.d < 20 * FP) { order.ability = 'smoke'; LASTSMOKE = t; }
    }
    if (order.ability === undefined && u.charges.mine > 0 && (t % 137) < 2) {
      for (const obj of OBJ) {
        if (obj.owner === SIDE && distF(u.x, u.y, obj.x, obj.y) <= obj.r * 0.85) { order.ability = 'mine'; break; }
      }
    }
  }

  return order;
}

// ---------------------------------------------------------------- tick
function tick(o) {
  if (!READY) return { units: [] };
  const orders = [];
  try {
    const units = o.units || [];
    const contacts = o.contacts || [];
    const t = o.tick | 0;
    for (const c of contacts) {
      MEM.set(c.id, { x: c.x | 0, y: c.y | 0, t, kind: c.kind, hpFrac: c.hpFrac | 0, heading: c.heading | 0, speed: c.speed | 0 });
    }
    if ((t & 31) === 0) for (const [id, m] of MEM) if (t - m.t > 300) MEM.delete(id);
    const plan = makePlan(o, units, contacts);
    for (const u of units) {
      if (!u.alive) continue;
      try { orders.push(unitOrders(u, o, plan)); } catch (e) { orders.push({ id: u.id }); }
    }
  } catch (e) { /* never throw: empty orders are better than a dead tick */ }
  return { units: orders };
}

globalThis.controller = { draft: chooseDraft, hello, tick };
