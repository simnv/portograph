import type { CreateElkAttempt } from './layout/elk-worker.js' with { 'resolution-mode': 'import' };
import type { CreateRouteAttempt } from './route/worker.js' with { 'resolution-mode': 'import' };
/** Create a real Node worker for each attempt. Pass this factory to skeleton(). */
export declare function createNodeElkFactory(): CreateElkAttempt;
/** Create a real terminable Node router worker. Pass this factory to route(). */
export declare function createNodeRouteFactory(): CreateRouteAttempt;
