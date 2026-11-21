import type { Point } from '../../src/model/geometry.js';
import type { CreateRouteAttempt, RouteWorker } from '../../src/route/worker.js';
import { avoidAssets, spawnAvoidWorker } from './fixture.js';

/**
 * A real router whose answers for the connectors of one link are rewritten before stage 8 reads them. A rewrite that the stitch
 * refuses makes stage 8 remove that link, which is the one way to build a sheet with a removed link from a generic fixture.
 */
export function forgingRouter(linkId: string, rewrite: (points: Point[]) => Point[]): CreateRouteAttempt {
  return () => {
    const worker = spawnAvoidWorker(avoidAssets.workerUrl);
    const wrapped: RouteWorker = {
      postMessage: message => worker.postMessage(message),
      terminate: () => worker.terminate(),
      addEventListener: (type, listener) => {
        if (type !== 'message') return worker.addEventListener(type, listener);
        worker.addEventListener(type, event => {
          const data = event.data as { routes?: { connector: string; points: Point[] }[] } | undefined;
          const routes = data?.routes?.map(item => item.connector.startsWith(`${linkId}#`) ? { ...item, points: rewrite(item.points) } : item);
          listener(routes ? { ...event, data: { ...data, routes } } : event);
        });
      },
      removeEventListener: (type, listener) => worker.removeEventListener(type, listener),
    };
    return { worker: wrapped, assets: avoidAssets };
  };
}

/** The answer of `forgingRouter` that walks back down the column it has drawn (A-B-A-C); the stitch rejects it as a retrace. */
export const retrace = (points: Point[]): Point[] => {
  const [start, tip, ...rest] = points;
  return [start!, tip!, { x: tip!.x, y: tip!.y + 40 }, { x: tip!.x + 30, y: tip!.y + 40 }, { x: tip!.x + 30, y: tip!.y + 20 },
    { x: tip!.x, y: tip!.y + 20 }, { x: tip!.x, y: tip!.y }, ...rest];
};
