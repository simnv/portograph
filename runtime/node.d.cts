import type { CreateElkAttempt } from './layout/elk-worker.js' with { 'resolution-mode': 'import' };
import type { CreateRouteAttempt } from './route/worker.js' with { 'resolution-mode': 'import' };
/** Create a real Node worker for each attempt. Pass this factory to skeleton(). */
export declare function createNodeElkFactory(): CreateElkAttempt;
/** Internal to the CLI: one real ELK worker kept for the attempts of one command, one command at a time. */
export declare function createNodeWarmElk(): { attempt: CreateElkAttempt; warm(): void; close(): void };
/** Create a real terminable Node router worker. Pass this factory to route(). */
export declare function createNodeRouteFactory(): CreateRouteAttempt;
