/**
 * Navigation.js
 * -------------
 * GPS for the open world: a graph whose nodes are junctions, crossings and
 * route ends, and whose edges run along the road centre-lines (towns get
 * short "street" links between their entry points). Dijkstra finds the
 * shortest drive from the player to a waypoint; the result is a polyline for
 * the minimap / world map plus the remaining distance.
 */

const MERGE = 32; // metres: junction points closer than this are one node

export class RoadGraph {
  constructor(env) {
    this.env = env;
    this.nodes = [];
    this.routeNodes = new Map(); // route → [{ node, idx }] sorted by idx
    this._build();
  }

  _node(x, z) {
    for (const n of this.nodes) if (Math.abs(n.x - x) < MERGE && Math.abs(n.z - z) < MERGE) return n;
    const n = { id: this.nodes.length, x, z, links: [] };
    this.nodes.push(n);
    return n;
  }

  _link(a, b, cost, route, ia, ib, forward) {
    a.links.push({ to: b, cost, route, ia, ib, forward });
  }

  _build() {
    const roads = this.env.roads;
    const routes = roads.all.filter((r) => r.render || r.flat);
    const pts = roads.junctions().map(([x, z]) => [x, z]);
    // extra nodes around loops and at open-route ends so partial trips work
    for (const r of routes) {
      if (r.closed) for (let k = 0; k < 6; k++) { const i = Math.floor((k * r.count) / 6); pts.push([r.xs[i], r.zs[i]]); }
      else pts.push([r.xs[0], r.zs[0]], [r.xs[r.count - 1], r.zs[r.count - 1]]);
    }
    for (const r of routes) {
      const list = [];
      const reach = r.width / 2 + 26;
      for (const [x, z] of pts) {
        const i = r.nearestIndex(x, z);
        if (r.lastDistanceSq > reach * reach) continue;
        const node = this._node(x, z);
        if (!list.some((e) => e.node === node)) list.push({ node, idx: i });
      }
      list.sort((a, b) => a.idx - b.idx);
      this.routeNodes.set(r, list);
      for (let k = 0; k < list.length - 1; k++) this._connect(r, list[k], list[k + 1]);
      if (r.closed && list.length > 1) this._connect(r, list[list.length - 1], list[0]);
    }
    // towns: entry points are joined by street links
    for (const city of this.env.cities || []) {
      const R = city.rect;
      const inTown = this.nodes.filter((n) => n.x > R.minX - 160 && n.x < R.maxX + 160 && n.z > R.minZ - 160 && n.z < R.maxZ + 160);
      for (const a of inTown) for (const b of inTown) {
        if (a === b) continue;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d < 900) this._link(a, b, d * 1.25, null, 0, 0, true);
      }
    }
  }

  _connect(r, A, B) {
    // forward along the route from A.idx to B.idx (wrapping on loops)
    const n = r.count;
    let steps = B.idx - A.idx;
    if (steps < 0) steps += n;
    const cost = steps * r.spacing;
    if (cost <= 0) return;
    this._link(A.node, B.node, cost, r, A.idx, B.idx, true);
    this._link(B.node, A.node, cost, r, B.idx, A.idx, false);
  }

  /** Where x,z joins the network: nearest route sample and its neighbouring nodes. */
  _attach(x, z) {
    const n = this.env.roads.nearest(x, z, (r) => this.routeNodes.has(r));
    if (!n) return null;
    const r = n.route, i = n.index;
    const list = this.routeNodes.get(r);
    const p = { x: r.xs[i], z: r.zs[i], route: r, idx: i, links: [] };
    if (!list || !list.length) return p;
    const cnt = r.count;
    // previous and next node along the route
    let next = null, prev = null, nd = Infinity, pd = Infinity;
    for (const e of list) {
      let f = e.idx - i, b = i - e.idx;
      if (r.closed) { f = (f + cnt) % cnt; b = (b + cnt) % cnt; }
      if (f >= 0 && f < nd) { nd = f; next = e; }
      if (b >= 0 && b < pd) { pd = b; prev = e; }
    }
    if (next) p.links.push({ to: next.node, cost: nd * r.spacing, route: r, ia: i, ib: next.idx, forward: true });
    if (prev) p.links.push({ to: prev.node, cost: pd * r.spacing, route: r, ia: i, ib: prev.idx, forward: false });
    return p;
  }

  /**
   * Shortest path by road. Returns { points: Float32Array [x,z,...], length } or null.
   */
  path(fx, fz, tx, tz) {
    const S = this._attach(fx, fz), T = this._attach(tx, tz);
    if (!S || !T) return null;
    // same road stretch? drive straight along it
    if (S.route === T.route) {
      const direct = this._segment(S.route, S.idx, T.idx);
      if (direct.cost < 1500) return this._finish([direct], fx, fz, tx, tz);
    }
    const dist = new Map(), prev = new Map();
    const open = [];
    const push = (node, d, via) => {
      if (d < (dist.get(node) ?? Infinity)) { dist.set(node, d); prev.set(node, via); open.push([d, node]); }
    };
    for (const l of S.links) push(l.to, l.cost, { from: null, link: l });
    // target: reaching one of T's neighbours then riding the route to T
    const targetLinks = new Map();
    for (const l of T.links) targetLinks.set(l.to, l);
    let best = null, bestD = Infinity;
    while (open.length) {
      open.sort((a, b) => a[0] - b[0]);
      const [d, node] = open.shift();
      if (d > (dist.get(node) ?? Infinity)) continue;
      if (d >= bestD) break;
      const tl = targetLinks.get(node);
      if (tl && d + tl.cost < bestD) { bestD = d + tl.cost; best = node; }
      for (const l of node.links) push(l.to, d + l.cost, { from: node, link: l });
    }
    if (!best) return null;
    // walk back
    const legs = [];
    const tl = targetLinks.get(best);
    legs.push(this._segment(T.route, tl.ib, T.idx, !tl.forward));
    let node = best;
    while (node) {
      const v = prev.get(node);
      if (!v) break;
      legs.push(v.link.route ? this._segment(v.link.route, v.link.ia, v.link.ib, v.link.forward) : { pts: [v.from ? v.from.x : S.x, v.from ? v.from.z : S.z, node.x, node.z], cost: v.link.cost });
      node = v.from;
    }
    legs.reverse();
    return this._finish(legs, fx, fz, tx, tz);
  }

  /** Points along a route from index a to b (forward = increasing index, wrapping on loops). */
  _segment(r, a, b, forward) {
    const n = r.count;
    if (forward === undefined) {
      if (r.closed) { const f = (b - a + n) % n; forward = f <= n / 2; }
      else forward = b >= a;
    }
    const pts = [];
    let steps = forward ? b - a : a - b;
    if (r.closed) steps = (steps + n) % n;
    steps = Math.max(0, steps);
    const stride = 2;
    for (let s = 0; s <= steps; s += stride) {
      const i = r._wrap(forward ? a + s : a - s);
      pts.push(r.xs[i], r.zs[i]);
    }
    const ib = r._wrap(b);
    pts.push(r.xs[ib], r.zs[ib]);
    return { pts, cost: steps * r.spacing };
  }

  _finish(legs, fx, fz, tx, tz) {
    const out = [fx, fz];
    let length = 0;
    for (const l of legs) { for (let i = 0; i < l.pts.length; i++) out.push(l.pts[i]); length += l.cost; }
    out.push(tx, tz);
    return { points: new Float32Array(out), length };
  }
}
