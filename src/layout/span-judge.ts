import type { LayoutModel } from '../model/layout.js';
import { compare, routedBends } from './objective.js';
import { courseProfile, GROWTH_BOUND, routedReading } from './course-measure.js';
import { added as namesAdded, constraintFindings, gateFindings, separationWorse } from './trial-findings.js';
import { isRoutedChord } from './frame-paths.js';
import { PLACEMENT_EPS } from './tolerance.js';

/**
 * The span round's judge (architecture ticket 22, docs/design/routed-chords.md, Section 14.4). The trial that reserves the offered span corridors is kept only when
 * (1) no link the baseline's route keeps is removed, (2) every hinted link publishes its chord (the promise) and 7f named no blocked chord, (3) no gate finding and no
 * hard entry of the x constraint catalogue is new (as sets), nor a minimum separation deeper, (4) the canvas grows by 5 % at most, and (5) the unified order on the routed
 * result gains: fewer bent links, then fewer turns, then fewer crossings. A trial that one chord spoils is refused whole (the user's decision 5).
 */
export interface SpanVerdict { kept: boolean; reason: 'removed' | 'promise' | 'blocked' | 'gate' | 'constraint' | 'separation' | 'growth' | 'worse' | 'unscored' | undefined; detail: string }

export function judgeSpanTrial(routedBase: LayoutModel, routedTrial: LayoutModel, hinted: readonly string[]): SpanVerdict {
  const verdict = (kept: boolean, reason: SpanVerdict['reason'], detail: string): SpanVerdict => ({ kept, reason, detail });
  const base = routedBends(routedBase), trial = routedBends(routedTrial);
  const removed = [...base.keys()].filter(id => !trial.has(id));
  if (removed.length > 0) return verdict(false, 'removed', `the trial's route removes ${removed.join(', ')}, which the baseline's route keeps`);
  const lost = hinted.filter(id => {
    const link = routedTrial.links.find(item => item.id === id);
    return link === undefined || !isRoutedChord(routedTrial, link);
  });
  if (lost.length > 0) return verdict(false, 'promise', `a hinted link does not publish its chord (${lost.join(', ')})`);
  const blocked = routedTrial.diagnostics.filter(item => item.code === 'SPAN_CHORD_BLOCKED').flatMap(item => item.owners ?? []).map(owner => 'id' in owner ? owner.id : '');
  if (blocked.length > 0) return verdict(false, 'blocked', `a move that 7f could not refuse put a wall in a span corridor (${blocked.join(', ')})`);
  const gatesNow = gateFindings(routedTrial), gatesThen = gateFindings(routedBase);
  if (gatesNow === undefined) return verdict(false, 'unscored', 'the routed trial does not score');
  const gateNew = namesAdded(gatesNow.findings, gatesThen?.findings ?? new Set());
  if (gateNew.length > 0) return verdict(false, 'gate', `the routed trial has gate findings the baseline does not have (${gateNew.join('; ')})`);
  const constraintNew = namesAdded(constraintFindings(routedTrial), constraintFindings(routedBase));
  if (constraintNew.length > 0) return verdict(false, 'constraint', `the routed trial breaks a hard constraint the baseline holds (${constraintNew.join('; ')})`);
  const separationNew = separationWorse(routedTrial, routedBase);
  if (separationNew.length > 0) return verdict(false, 'separation', `the routed trial breaks or deepens a minimum separation (${separationNew.join('; ')})`);
  const cap = (was: number | undefined): number => (was ?? 0) * (1 + GROWTH_BOUND) + PLACEMENT_EPS;
  if ((routedTrial.canvas?.width ?? 0) > cap(routedBase.canvas?.width) || (routedTrial.canvas?.height ?? 0) > cap(routedBase.canvas?.height)) {
    return verdict(false, 'growth', `the routed trial grows the canvas past ${GROWTH_BOUND * 100} %`);
  }
  const now = routedReading(routedTrial), then = routedReading(routedBase);
  if (!(compare(now, then, courseProfile) < 0)) {
    return verdict(false, 'worse', `the routed trial gives no gain (${now.routed.bent + now.overlay.bent} bent links, ${now.routed.turns + now.overlay.turns} turns, ${now.crossings()} crossings, against ${then.routed.bent + then.overlay.bent}, ${then.routed.turns + then.overlay.turns} and ${then.crossings()})`);
  }
  return verdict(true, undefined, '');
}
