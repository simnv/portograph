/**
 * The deadline errors that end a whole command: the command's own budget (`CommandDeadlineError`) and the per-attempt timers of ELK and the
 * router. A trial round (the width-budget rows, the group lift) rethrows them, so the clock never chooses which geometry to publish (R4).
 */
import { CommandDeadlineError } from './budget.js';
import { ElkDeadlineError } from '../layout/elk-worker.js';
import { RouteDeadlineError } from '../route/index.js';

export function isDeadlineError(error: unknown): boolean {
  return error instanceof CommandDeadlineError || error instanceof ElkDeadlineError || error instanceof RouteDeadlineError;
}
