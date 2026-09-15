/**
 * portograph libavoid worker (stage 8).
 *
 * `Router.processTransaction()` is synchronous WASM work, so it runs here in a real terminable
 * worker: the host can kill this thread when the route budget expires. One message routes one
 * batch with its own Router; the host owns batch order and every geometric decision. Nothing here
 * reads the layout model, the filesystem or the current working directory — the host passes the
 * module and WASM URLs it resolved.
 */

/** One initialization promise per module/WASM pair. `AvoidLib.load` only checks a finished instance. */
const runtimes = new Map();

/**
 * Load one libavoid runtime. Concurrent first calls share one promise, so the upstream loader
 * cannot instantiate two modules; a failed load is evicted so a corrected URL can be retried.
 */
export function loadAvoid(moduleUrl, wasmUrl, importModule = specifier => import(specifier)) {
  const key = JSON.stringify([moduleUrl, wasmUrl]);
  let pending = runtimes.get(key);
  if (pending === undefined) {
    pending = (async () => {
      const module = await importModule(moduleUrl);
      const lib = module && module.AvoidLib;
      if (!lib || typeof lib.load !== 'function' || typeof lib.getInstance !== 'function') {
        throw new Error(`libavoid module ${moduleUrl} does not export AvoidLib`);
      }
      await lib.load(wasmUrl);
      return lib.getInstance();
    })();
    pending.catch(() => { if (runtimes.get(key) === pending) runtimes.delete(key); });
    runtimes.set(key, pending);
  }
  return pending;
}

/** All directions; libavoid's ConnDirFlags are top 1, bottom 2, left 4, right 8. */
const ALL_DIRECTIONS = 15;

/**
 * Collision tolerance. This is `EPS` in `src/score/geometry.ts`, and it must stay that value: the
 * adapter has to reach the same answer as the host about a visited checkpoint, or it re-solves a
 * route the host would have taken.
 */
const EPS = 1e-7;

/**
 * Whether a segment touches a point, boundary contact included. This is `segmentRect` from
 * `src/score/geometry.ts` against a rectangle of zero size, written out here because the worker
 * loads as plain JavaScript and imports nothing from the library.
 */
function segmentTouches(from, to, point) {
  let low = 0, high = 1;
  for (const [origin, delta, at] of [[from.x, to.x - from.x, point.x], [from.y, to.y - from.y, point.y]]) {
    if (delta === 0) { if (origin < at - EPS || origin > at + EPS) return false; }
    else {
      const a = (at - EPS - origin) / delta, b = (at + EPS - origin) / delta;
      low = Math.max(low, Math.min(a, b));
      high = Math.min(high, Math.max(a, b));
    }
  }
  return low <= high;
}

/**
 * Whether a returned polyline really passes through every checkpoint, in the order they were asked
 * for. This is the host's own test — `polylineDistance` and `checkpointsHonoured` in
 * `src/route/paths.ts` — repeated here so the adapter can see a dropped checkpoint while it can
 * still ask again, and it must give the same answer the host will. Distance is measured along the
 * whole route, not along one segment, so two checkpoints on one straight run stay ordered.
 */
export function checkpointsVisited(points, checkpoints) {
  const at = (point, after) => {
    let travelled = 0;
    for (let index = 0; index + 1 < points.length; index++) {
      const from = points[index], to = points[index + 1];
      if (segmentTouches(from, to, point)) {
        const reached = travelled + Math.hypot(point.x - from.x, point.y - from.y);
        if (reached >= after - EPS) return reached;
      }
      travelled += Math.hypot(to.x - from.x, to.y - from.y);
    }
    return -1;
  };
  let cursor = -1;
  for (const checkpoint of checkpoints) {
    const reached = at(checkpoint, cursor);
    if (reached < 0) return false;
    cursor = reached;
  }
  return true;
}

/** Exact straight visibility against the already expanded obstacle set. */
function directRoute(batch, connector) {
  const endpoint = value => {
    if (value.kind === 'point') return { x: value.x, y: value.y, directions: ALL_DIRECTIONS };
    return batch.shapes.find(shape => shape.id === value.shape)?.pins?.find(pin => pin.classId === value.classId);
  };
  const a = endpoint(connector.from), b = endpoint(connector.to);
  if (!a || !b || (a.x !== b.x && a.y !== b.y) || (a.x === b.x && a.y === b.y)) return;
  const direction = a.x === b.x ? (b.y > a.y ? 2 : 1) : (b.x > a.x ? 8 : 4);
  const opposite = ({ 1: 2, 2: 1, 4: 8, 8: 4 })[direction];
  if (!(a.directions & direction) || !(b.directions & opposite)) return;
  const vertical = a.x === b.x, axis = vertical ? 'y' : 'x', cross = vertical ? 'x' : 'y';
  const sign = b[axis] > a[axis] ? 1 : -1;
  let cursor = 0;
  for (const checkpoint of connector.checkpoints || []) {
    const distance = (checkpoint[axis] - a[axis]) * sign;
    if (checkpoint[cross] !== a[cross] || distance < cursor || distance > (b[axis] - a[axis]) * sign
      || !((checkpoint.arrival ?? ALL_DIRECTIONS) & opposite)
      || !((checkpoint.departure ?? ALL_DIRECTIONS) & direction)) return;
    cursor = distance;
  }
  for (const shape of batch.shapes) {
    // A monotone outward segment can leave its source and enter its target, but no foreign shape.
    if (connector.from.kind === 'pin' && shape.id === connector.from.shape) continue;
    if (connector.to.kind === 'pin' && shape.id === connector.to.shape) continue;
    const box = shape.bounds;
    if (Math.max(a.x, b.x) >= box.x && Math.min(a.x, b.x) <= box.x + box.width
      && Math.max(a.y, b.y) >= box.y && Math.min(a.y, b.y) <= box.y + box.height) return;
  }
  return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
}

/**
 * Route one batch. Every shape, pin, endpoint and checkpoint is given by the host in absolute
 * coordinates; obstacles already carry their clearance, so the shape buffer stays at 0.
 *
 * The Router destructor deletes its shapes, pins and connectors, so only the temporary value
 * objects are released here.
 */
export function routeBatch(Avoid, batch) {
  const router = new Avoid.Router(Avoid.RouterFlag.OrthogonalRouting.value);
  const temporaries = [];
  const track = value => { temporaries.push(value); return value; };
  const point = (x, y) => track(new Avoid.Point(x, y));
  try {
    router.setRoutingParameter(Avoid.RoutingParameter.shapeBufferDistance, batch.shapeBufferDistance);
    for (const [name, value] of Object.entries(batch.parameters || {})) {
      const parameter = Avoid.RoutingParameter[name];
      if (parameter === undefined) throw new Error(`Unknown libavoid routing parameter ${name}`);
      router.setRoutingParameter(parameter, value);
    }
    const shapes = new Map();
    for (const shape of batch.shapes) {
      const box = shape.bounds;
      if (shapes.has(shape.id)) throw new Error(`Duplicate obstacle id ${shape.id}`);
      const rectangle = track(new Avoid.Rectangle(point(box.x, box.y), point(box.x + box.width, box.y + box.height)));
      const ref = new Avoid.ShapeRef(router, rectangle);
      shapes.set(shape.id, ref);
      for (const pin of shape.pins || []) {
        // Offsets are measured from the obstacle's top-left corner, so a pin stays on the drawn
        // node boundary inside its expanded routing rectangle.
        const created = new Avoid.ShapeConnectionPin(ref, pin.classId, pin.x - box.x, pin.y - box.y, false, 0, pin.directions);
        created.setExclusive(pin.exclusive === true);
      }
    }
    const endpoint = value => {
      if (value.kind === 'point') return track(new Avoid.ConnEnd(point(value.x, value.y)));
      const shape = shapes.get(value.shape);
      if (shape === undefined) throw new Error(`Connector endpoint references unknown obstacle ${value.shape}`);
      return track(new Avoid.ConnEnd(shape, value.classId));
    };
    const setCheckpoints = (ref, checkpoints) => {
      const vector = track(new Avoid.CheckpointVector());
      for (const checkpoint of checkpoints) {
        vector.push_back(track(new Avoid.Checkpoint(point(checkpoint.x, checkpoint.y),
          checkpoint.arrival === undefined ? ALL_DIRECTIONS : checkpoint.arrival,
          checkpoint.departure === undefined ? ALL_DIRECTIONS : checkpoint.departure)));
      }
      ref.setRoutingCheckpoints(vector);
    };
    const connectors = batch.connectors.map(connector => {
      const direct = directRoute(batch, connector);
      const ref = new Avoid.ConnRef(router, endpoint(connector.from), endpoint(connector.to));
      // Collinear checkpoints are already on a clear direct route. Passing them to libavoid
      // 0.5.0-beta.5 can truncate its result at the final checkpoint. Keep this connector in
      // the transaction, but omit redundant hints; the host still checks every requested one.
      const checkpoints = direct ? [] : connector.checkpoints || [];
      if (checkpoints.length) setCheckpoints(ref, checkpoints);
      // `asked` is what this connector currently holds; a retry below narrows it.
      return { id: connector.id, ref, connector, checkpoints, asked: checkpoints };
    });
    router.processTransaction();
    // `displayRoute()` and `at()` hand back independent native copies in this binding, so each one
    // is released here; only the copied coordinates leave the worker.
    const extract = ({ id, ref }) => {
      const route = ref.displayRoute(), size = route.size(), points = [];
      try {
        for (let index = 0; index < size; index++) {
          const at = route.at(index);
          try { points.push({ x: at.x, y: at.y }); } finally { at.delete(); }
        }
      } finally { route.delete(); }
      return { connector: id, points };
    };
    let routes = connectors.map(extract), retry = false;
    for (const [index, item] of connectors.entries()) {
      const points = routes[index].points, last = points.at(-1);
      const checkpoint = item.checkpoints.at(-1);
      if (!last || points.length < 2 || !checkpoint || last.x !== checkpoint.x || last.y !== checkpoint.y) continue;
      // The same upstream defect can truncate a route at its final checkpoint, whether the missing
      // leg continues the last segment straight or follows a bend. That leg is the destination's
      // own stem — the checkpoint lies on the perpendicular from its anchor — so it is straight and
      // clear by construction, and the hint is redundant. Re-solve once without it; never append a
      // guessed endpoint to returned geometry. The host still checks every requested checkpoint.
      const continuation = directRoute(batch, { from: { kind: 'point', ...checkpoint }, to: item.connector.to, checkpoints: [] });
      if (!continuation) continue;
      item.asked = item.checkpoints.slice(0, -1);
      setCheckpoints(item.ref, item.asked);
      retry = true;
    }
    if (retry) { router.processTransaction(); routes = connectors.map(extract); }
    // A checkpoint carries two things: the point, which is a reservation the host verifies, and a
    // direction mask, which is only a hint — `checkpointsHonoured` never reads it. This build drops
    // the whole checkpoint, silently, when it cannot meet the mask, and the host then has to reject
    // a route that missed a reservation. So when a checkpoint is missing from the answer, ask once
    // more for the same points with no mask. Nothing here invents geometry: the host still checks
    // every point it asked for, and still rejects the route when one is absent.
    let relaxed = false;
    for (const [index, item] of connectors.entries()) {
      if (!item.asked.length || checkpointsVisited(routes[index].points, item.asked)) continue;
      item.asked = item.asked.map(checkpoint => ({ ...checkpoint, arrival: ALL_DIRECTIONS, departure: ALL_DIRECTIONS }));
      setCheckpoints(item.ref, item.asked);
      relaxed = true;
    }
    if (relaxed) { router.processTransaction(); routes = connectors.map(extract); }
    return routes;
  } finally {
    // Release every temporary even if one of them is already gone, so the Router itself is always
    // deleted: it owns the shapes, pins and connectors and frees them in turn.
    for (const value of temporaries.reverse()) {
      try { value.delete(); } catch { /* already released */ }
    }
    router.delete();
  }
}

export const ROUTE_REQUEST = 'portograph-route';
export const ROUTE_RESPONSE = 'portograph-routed';

/** Answer one host request. Failures reply; they never leave the host waiting for its deadline. */
export async function handleRouteMessage(message, reply) {
  try {
    const Avoid = await loadAvoid(message.moduleUrl, message.wasmUrl);
    reply({ kind: ROUTE_RESPONSE, id: message.id, ok: true, routes: routeBatch(Avoid, message.batch) });
  } catch (error) {
    reply({ kind: ROUTE_RESPONSE, id: message.id, ok: false, error: String(error && error.message ? error.message : error) });
  }
}

// Registered only inside a real worker scope; importing this module elsewhere stays side-effect free.
if (typeof globalThis.addEventListener === 'function' && typeof globalThis.postMessage === 'function') {
  globalThis.addEventListener('message', event => {
    const message = event && event.data;
    if (!message || message.kind !== ROUTE_REQUEST) return;
    void handleRouteMessage(message, response => { globalThis.postMessage(response); });
  });
}
