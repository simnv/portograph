import type { CreateElkAttempt } from './layout/elk-worker.js' with { 'resolution-mode': 'import' };
/** Create a real Node worker for each attempt. Pass this factory to skeleton(). */
export declare function createNodeElkFactory(): CreateElkAttempt;
