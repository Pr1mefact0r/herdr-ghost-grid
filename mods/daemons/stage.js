// stage.js — the planner ("Drehbuch") for THE GRID. Pure: no Herdr, no GPUI, testable with node.
//
// Positions are read only from a COMMITTED layout. The field says what it would like (a DESIRED layout:
// an ordered list of elements with x); the planner turns the difference into ONE step at a time and does
// nothing else until that step is over:
//   - elements whose order relative to the others is unchanged SLIDE on the ground, all with the same
//     duration (an order-preserving slide never crosses);
//   - every element that changes its place in the order (the minimum set, via a longest increasing
//     subsequence), and every element that goes on or comes back from a visit, makes a TRIP over the
//     upper track: rise, travel at one constant speed (nobody overtakes), come down;
//   - trips that would meet head-on are timed to meet at a switch; around it both travel as packets.
// A new element can come from somewhere (its group) and a vanishing one can go somewhere (into its
// group): both are trips too.

export const CFG = {
  SHIFT_MS: 1000,   // a slide on the ground
  SPEED: 0.52,      // px per ms on the track
  RISE_UP_MS: 300,  // up onto / down off the track
  PKT_R: 110,       // packet radius around a meeting point
  MORPH_MS: 220,    // daemon <-> packet glitch
  HOLD_MAX: 6000,   // longest a trip waits up on the track for a switch
  STAGGER_MS: 400,  // gap between several leaving from the same place
  PASS_GAP: 60,     // closer than this on the track = they pass as packets
  GROUND_SPEED: 0.3, // px per ms at most when making room on the ground
};

export function newStage() {
  return { els: new Map(), order: [], tx: null, trips: new Map(), marks: [], seq: 0 };
}

// ---- trips ---------------------------------------------------------------------------------------
const xAt = (r, t) => t <= r.tGo ? r.x0 : t >= r.tArr ? r.x1 : r.x0 + (r.x1 - r.x0) * (t - r.tGo) / r.dur;
const dir = (r) => Math.sign(r.x1 - r.x0);

export function makeTrip(stage, key, x0, x1, tUp, switches, cfg = CFG, goAt = 0, lane = 0) {
  const dur = Math.max(400, Math.abs(x1 - x0) / cfg.SPEED);
  const tr = { key, x0, x1, tUp, tGo: Math.max(tUp + cfg.RISE_UP_MS, goAt), dur, packets: [], lane };
  // on different lanes (a meeting stack going home: each one at its own height) nobody touches anybody
  const apart = (o) => (o.lane ?? 0) !== lane;
  tr.tArr = tr.tGo + dur; tr.tDown = tr.tArr + cfg.RISE_UP_MS;
  for (let guard = 0; guard < 6; guard++) {
    let moved = false;
    for (const o of stage.trips.values()) {
      if (dir(o) === 0 || dir(tr) === 0 || dir(o) === dir(tr)) continue;
      const a0 = Math.max(o.tGo, tr.tGo), a1 = Math.min(o.tArr, tr.tArr);
      if (a1 <= a0) continue;
      const d0 = xAt(o, a0) - xAt(tr, a0), d1 = xAt(o, a1) - xAt(tr, a1);
      if (Math.sign(d0) === Math.sign(d1) && Math.abs(d0) > 40 && Math.abs(d1) > 40) continue;
      if (tr.packets.some((p) => p.with === o.key)) continue;
      const lo = Math.max(Math.min(o.x0, o.x1), Math.min(tr.x0, tr.x1));
      const hi = Math.min(Math.max(o.x0, o.x1), Math.max(tr.x0, tr.x1));
      let best = null;
      for (const S of switches) {
        if (S < lo || S > hi) continue;
        const tO = o.tGo + (S - o.x0) / (o.x1 - o.x0) * o.dur;
        const tT = tr.tGo + (S - tr.x0) / (tr.x1 - tr.x0) * tr.dur;
        const d = tO - tT;
        if (d >= 0 && d < cfg.HOLD_MAX && (!best || d < best.d)) best = { S, d, tO };
      }
      if (best && best.d > 30) { tr.tGo += best.d; tr.tArr += best.d; tr.tDown += best.d; moved = true; }
      const tm = best ? best.tO : (a0 + a1) / 2, xm = best ? best.S : xAt(tr, tm);
      const win = (r) => { const tc = r.tGo + (xm - r.x0) / (r.x1 - r.x0) * r.dur, h = cfg.PKT_R / cfg.SPEED; return [tc - h, tc + h]; };
      const wo = win(o), wt = win(tr);
      o.packets.push({ a: wo[0], b: wo[1], with: tr.key }); tr.packets.push({ a: wt[0], b: wt[1], with: o.key });
      stage.marks.push(wo[0] - cfg.MORPH_MS, wo[0], wo[1], wo[1] + cfg.MORPH_MS);
      if (moved) break;
    }
    if (!moved) break;
  }
  // Same direction: never pass each other — this one simply sets off later (it waits up on the track), until it stays a gap behind
  // the whole way (same speed keeps it). Only real crossings (opposite directions) become packets.
  for (let guard = 0; guard < 40; guard++) {
    let late = 0;
    for (const o of stage.trips.values()) {
      if (dir(o) !== dir(tr) || dir(tr) === 0 || apart(o)) continue;
      const t0 = Math.max(tr.tUp, o.tUp), t1 = Math.min(tr.tArr, o.tArr);
      // only when it would catch up while moving; being passed while it still waits can't be fixed by
      // waiting longer — that one becomes a packet pass below
      for (let t = Math.max(t0, tr.tGo); t <= t1; t += 40) if (Math.abs(xAt(tr, t) - xAt(o, t)) < cfg.PASS_GAP) { late = 120; break; }
      if (late) break;
    }
    if (!late) break;
    tr.tGo += late; tr.tArr += late; tr.tDown += late;   // rises as planned (off the ground), waits up there
  }
  // Anybody this trip still meets up on the track (going the other way, or passing one that waits there)
  // passes it as a data packet: both are packets for the whole time they are close (plus a margin).
  for (const o of stage.trips.values()) {
    if (apart(o)) continue;
    const t0 = Math.max(tr.tUp, o.tUp), t1 = Math.min(tr.tArr, o.tArr);
    let a = null;
    const close = (t) => Math.abs(xAt(tr, t) - xAt(o, t)) < cfg.PASS_GAP;
    for (let t = t0; t <= t1 + 40; t += 40) {
      const c = t <= t1 && close(t);
      if (c && a == null) a = t;
      if (!c && a != null) {
        const m = cfg.MORPH_MS + 80;
        if (!tr.packets.some((p) => p.with === o.key && p.a <= a && p.b >= t)) {
          tr.packets.push({ a: a - m, b: t + m, with: o.key }); o.packets.push({ a: a - m, b: t + m, with: tr.key });
          stage.marks.push(a - m - cfg.MORPH_MS, a - m, t + m, t + m + cfg.MORPH_MS);
        }
        a = null;
      }
    }
  }
  stage.trips.set(key, tr);
  stage.marks.push(tr.tUp, tr.tGo, tr.tArr - 450, tr.tArr, tr.tDown,
    ...tr.packets.flatMap((p) => [p.a - cfg.MORPH_MS, p.a, p.b, p.b + cfg.MORPH_MS]));
  return tr;
}

// where a trip puts its element at `now`
export function tripState(tr, now, cfg = CFG) {
  if (!tr) return null;
  let form = "daemon";
  for (const p of tr.packets) {
    if (now >= p.a && now < p.b) form = "packet";
    else if (form !== "packet" && ((now >= p.a - cfg.MORPH_MS && now < p.a) || (now >= p.b && now < p.b + cfg.MORPH_MS))) form = "morph";
  }
  return {
    x: now < tr.tGo ? tr.x0 : tr.x1,                      // the target the native transition glides to
    xNow: xAt(tr, now),                                   // where it actually is (for tests)
    up: now >= tr.tUp && now < tr.tArr,
    // one duration for the whole trip: GPUI may animate a change with the transition attached before it,
    // so the travel duration is attached from the moment it rises, not only once it sets off
    glide: tr.dur,
    linear: now < tr.tArr,
    form, dir: dir(tr), moving: now < tr.tDown, landed: now >= tr.tDown,
  };
}

// ---- planning --------------------------------------------------------------------------------------
// indices kept in place: longest increasing subsequence of the old positions, in new order
function keepSet(oldIdx) {
  const n = oldIdx.length, tails = [], prev = new Array(n).fill(-1), at = [];
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (oldIdx[tails[m]] < oldIdx[i]) lo = m + 1; else hi = m; }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i; at[lo] = i;
  }
  const keep = new Set();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

// desired: [{ id, x, item, travel?, origin? }]   (in field order, left to right)
// ctx: { now, switches: [x], destOf: (id) => x | null, slot }  (slot: moves over 1.5 slots go over the track)
export function plan(stage, desired, ctx, cfg = CFG) {
  const now = ctx.now;
  if (stage.tx && now < stage.tx.until) {
    // a step is running: nothing moves differently, only element data (status, text) is refreshed
    for (const d of desired) { const el = stage.els.get(d.id); if (el && !el.leaving) el.item = d.item; }
    return stage;
  }
  // the previous step is over: drop what has gone, forget finished trips
  for (const [id, el] of stage.els) if (el.leaving) stage.els.delete(id);
  for (const [k, r] of stage.trips) if (now > r.tDown + 1000) stage.trips.delete(k);
  stage.marks = stage.marks.filter((m) => m > now - 1000);
  stage.tx = null;
  for (const el of stage.els.values()) { el.trip = null; if (el.returning) { el.returning = false; el.meta = null; } }   // home again

  const oldOrder = stage.order.filter((id) => stage.els.has(id));
  const oldPos = new Map(oldOrder.map((id, k) => [id, k]));
  const same = desired.length === oldOrder.length && desired.every((d, k) => d.id === oldOrder[k]
    && Math.abs(stage.els.get(d.id).x - d.x) < 1 && !!stage.els.get(d.id).away === !!d.travel);
  if (same) { for (const d of desired) stage.els.get(d.id).item = d.item; return stage; }

  const common = desired.filter((d) => oldPos.has(d.id));
  // travellers (to a visit, or back from one) always go over the track; the order of everybody else is
  // kept with as few movers as possible — so a bystander never becomes a mover because a traveller passes
  const movers = new Set();
  for (const d of common) {
    const el = stage.els.get(d.id), dx = Math.abs(el.x - d.x);
    // setting off or going home: over the track. One already standing at its visit that only has to shift
    // a little (others arrive, the field gets denser) just slides with everybody else.
    const settling = el.away && d.travel && dx < 0.6 * (ctx.slot || 1e9);
    if (dx > 1 && (d.travel || el.away) && !settling) movers.add(d.id);
  }
  // only messages use the track: everybody else makes room on the ground. Should a bystander have to
  // change its place in the order (a status change), it doesn't slide through the others: it fades out
  // and fades in at its new place once room is made.
  const rest = common.filter((d) => !movers.has(d.id));
  const keep = keepSet(rest.map((d) => oldPos.get(d.id)));
  const reorder = new Set(rest.filter((_, k) => !keep.has(k)).map((d) => d.id));
  const born = desired.filter((d) => !oldPos.has(d.id));
  const gone = oldOrder.filter((id) => !desired.some((d) => d.id === id));

  const slides = common.some((d) => !movers.has(d.id) && Math.abs(stage.els.get(d.id).x - d.x) > 1);
  // all slides of a step share one duration (that keeps them from crossing), long enough for the longest
  const far = Math.max(0, ...common.filter((d) => !movers.has(d.id) && !reorder.has(d.id)).map((d) => Math.abs(stage.els.get(d.id).x - d.x)));
  const shift = Math.min(3000, Math.max(cfg.SHIFT_MS, far / cfg.GROUND_SPEED));
  stage.shift = shift;
  // movers rise at once (off the ground, out of the way of the slide), wait up there until room is made
  // Order of a step: those going home (back from a visit) rise and leave FIRST, then the field closes the
  // gap on the ground, then those setting off to a visit go (they need the room made). Only travellers use
  // the track, so nobody on the ground ever passes under a traveller still standing there.
  const homeGoers = common.filter((d) => movers.has(d.id) && stage.els.get(d.id).away && !d.travel).length
    + oldOrder.filter((id) => !desired.some((d) => d.id === id) && stage.els.get(id)?.away).length;
  const slideAt = now + (homeGoers ? cfg.RISE_UP_MS + (homeGoers - 1) * cfg.STAGGER_MS * 2 + 200 : 0);
  const goAt = slides ? slideAt + shift : now;
  let until = slides ? slideAt + shift : now;
  const tag = ++stage.seq;
  // several leaving from the same place (out of one group) go one after another, so they never travel
  // exactly on top of each other (same speed keeps the gap all the way)
  const pending = [];
  const travel = (id, x0, x1, born = false) => {
    if (Math.abs(x1 - x0) < 1) return null;
    const key = `${id}#${tag}`;
    pending.push({ key, id, x0, x1, born, toVisit: !!desired.find((d) => d.id === id)?.travel });
    return key;
  };
  const flushTrips = () => {
    // farthest first; those leaving from the same place go one after another
    pending.sort((p, q) => Math.abs(q.x1 - q.x0) - Math.abs(p.x1 - p.x0));
    const fromHere = new Map();
    let hn = 0, lastHomeGo = -Infinity;
    for (const p of pending) {
      const k = Math.round(p.x0 / 8), n = fromHere.get(k) ?? 0; fromHere.set(k, n + 1);
      const el0 = stage.els.get(p.id), home = !!(el0 && (el0.returning || el0.leaving) && !p.toVisit);
      // home-goers rise one after another right away (off the ground, so the field can move under them),
      // and set off once the field has settled; visitors set off once room is made
      const dur = Math.max(400, Math.abs(p.x1 - p.x0) / cfg.SPEED);
      const up = home ? now + hn++ * cfg.STAGGER_MS * 2 : (n === 0 ? now : Math.max(now, goAt + n * cfg.STAGGER_MS * 2 - cfg.RISE_UP_MS));
      // home-goers keep their stagger also when setting off (one after another, never as a bunch)
      let go = home ? Math.max(up + cfg.RISE_UP_MS, (slides ? slideAt + shift : 0) - dur) : goAt + n * cfg.STAGGER_MS * 2;
      if (home) { go = Math.max(go, lastHomeGo + cfg.STAGGER_MS * 2); lastHomeGo = go; }
      const tr = makeTrip(stage, p.key, p.x0, p.x1, up, ctx.switches, cfg, go, el0?.meta?.meeting ? (el0.meta.stack ?? 0) : 0);
      until = Math.max(until, tr.tDown);
      if (p.born) { const el = stage.els.get(p.id); if (el) el.appearAt = tr.tUp; }   // comes out of its group as it rises
    }
  };

  const oldX = new Map([...stage.els].map(([id, el]) => [id, el.x]));   // where things are before this step
  for (const d of desired) {
    const el = stage.els.get(d.id);
    if (el) {
      el.trip = movers.has(d.id) ? travel(d.id, el.x, d.x) : null;
      if (!el.trip && reorder.has(d.id)) {           // gone for a moment, back at its new place
        el.slideFrom = d.x; el.slideT0 = slideAt; el.appearAt = Math.max(goAt, now + 400); el.fadeFrom = el.x;
        until = Math.max(until, el.appearAt);
      }
      else if (!el.trip) { el.slideFrom = el.x; el.slideT0 = slideAt; el.appearAt = 0; if (slideAt > now) stage.marks.push(slideAt); }
      // one going home keeps how it looked (e.g. small in a meeting stack) until it rises
      el.returning = !!(el.trip && el.away && !d.travel);
      if (!el.returning) el.meta = d.meta ?? null;
      el.x = d.x; el.item = d.item; el.away = !!d.travel;
    } else {
      // comes out of something (its group, where that group is *now*), or appears once room is made
      const from = d.originId != null && oldX.has(d.originId) ? oldX.get(d.originId) : d.origin;
      const trip = d.travel && from != null ? travel(d.id, from, d.x, true) : null;
      stage.els.set(d.id, { id: d.id, x: d.x, item: d.item, away: !!d.travel, meta: d.meta ?? null, trip, born: now, slideFrom: d.x, slideT0: now,
        appearAt: trip || !slides ? now : goAt });
    }
  }
  for (const id of gone) {
    const el = stage.els.get(id), to = ctx.destOf?.(id);
    if (el.away && to != null && Math.abs(to - el.x) > 1) { el.trip = travel(id, el.x, to); el.x = to; el.leaving = true; }
    else stage.els.delete(id);
  }
  flushTrips();
  stage.order = desired.map((d) => d.id).concat(gone.filter((id) => stage.els.has(id)));
  stage.tx = until > now ? { until, tag } : null;
  if (stage.tx) stage.marks.push(until + 20);
  return stage;
}

// for tests: where an element really is at `now` and whether it is on the ground
export function actual(stage, el, now, cfg = CFG) {
  if (el.appearAt && now < el.appearAt) return { x: el.x, ground: false };   // not there yet
  const tr = el.trip ? stage.trips.get(el.trip) : null;
  if (tr) { const st = tripState(tr, now, cfg); return { x: st.xNow, ground: !st.up && !(now >= tr.tUp && now < tr.tDown) }; }
  const f = Math.min(1, Math.max(0, (now - (el.slideT0 ?? 0)) / (stage.shift ?? cfg.SHIFT_MS)));
  return { x: (el.slideFrom ?? el.x) + (el.x - (el.slideFrom ?? el.x)) * f, ground: true };
}

// where an element is at `now` and how it looks (for rendering and for tests)
export function view(stage, el, now, cfg = CFG) {
  const tr = el.trip ? stage.trips.get(el.trip) : null;
  const st = tripState(tr, now, cfg);
  const waitSlide = !tr && el.slideT0 > now;
  return { x: st ? st.x : waitSlide ? el.slideFrom : el.x, st, tr, hidden: !!(el.appearAt && now < el.appearAt) };
}
