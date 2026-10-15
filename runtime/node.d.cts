import type { CreateElkAttempt, WarmElk } from './layout/elk-worker.js' with { 'resolution-mode': 'import' };
import type { CreateRouteAttempt } from './route/worker.js' with { 'resolution-mode': 'import' };
/** Create a real Node worker for each attempt. Pass this factory to skeleton(). */
export declare function createNodeElkFactory(): CreateElkAttempt;
/** Create a factory that keeps one real Node ELK worker for all its attempts, with `warm()` to start it early and `close()` to end it. A timed-out or failed attempt drops the worker; the next attempt starts a new one. */
export declare function createNodeWarmElk(): WarmElk;
/** Create a real terminable Node router worker. Pass this factory to route(). */
export declare function createNodeRouteFactory(): CreateRouteAttempt;
