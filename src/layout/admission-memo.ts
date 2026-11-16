/**
 * The memo of the fan and solid-block admission (`admitFanFamilies`, dense-16x9 ticket 21). A placement asks for the admission of the same
 * draft more than once: the replays of the `bars` and `bundles` rules rebuild the row paths of a draft whose fields the admission reads have
 * not changed (only the stage marker and the runtime record changed, which it does not read). Each such call costs a full member search.
 *
 * The key is the input the call read, derived from the call itself, not from a list: while the admission runs, every own field of the draft
 * is an accessor that records its name, so the key of an entry is the fields that call read (their content before the call, the document
 * too), the draft's own field names in order, the members (whole) and the search budget. The admission is deterministic and reads nothing
 * else: its arguments, the draft, and caches of the draft's own content. A later call whose draft agrees on those fields runs the same reads
 * and makes the same writes, so its writes are taken from the entry.
 *
 * An entry is stored only when the call's writes are ones the memo can make again exactly: the fields of member links (a kept value stays
 * the same object, a new value is a new object, as the admission makes it) and the diagnostics (kept entries stay the same objects, new
 * ones are new). A call that changed anything else (another field, another link, a value in place) is not stored. Under the cache check
 * (`LayoutOptions.checkCaches`) a hit runs the admission again on a copy and compares the writes. The memo is open while a command runs
 * (`openAdmissionMemo`, called by `layout`) and emptied when the last running command ends; outside a command the admission runs directly.
 * It holds at most `ADMISSION_MEMO_LIMIT` entries for each set of fields read and `ADMISSION_SIGNATURE_LIMIT` such sets, the least recently
 * used dropped first (R4). A key is the content of what was read, so no write to a draft can make an entry stale, and no mutation boundary
 * has to drop one.
 */
import type { Diagnostic, LayoutLink, LayoutModel } from '../model/layout.js';
import { readCache } from '../model/read-cache.js';

const ADMISSION_MEMO_LIMIT = 16;
const ADMISSION_SIGNATURE_LIMIT = 8;
const MARK = '\u0000pg';

/** JSON text that also tells undefined, -0, NaN, the infinities, maps and sets apart (plain JSON writes them as null, 0 or {}). */
function exact(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === undefined) return { [MARK]: 'u' };
    if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))) return { [MARK]: Object.is(item, -0) ? '-0' : String(item) };
    if (item instanceof Map) return { [MARK]: 'map', items: [...item] };
    if (item instanceof Set) return { [MARK]: 'set', items: [...item] };
    if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') return { [MARK]: 'opaque' };
    return item;
  });
}
/** The value `exact` wrote, as a new object. */
function decode(text: string): unknown {
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (item === null || typeof item !== 'object') return item;
    const record = item as Record<string, unknown>;
    const mark = record[MARK];
    if (typeof mark === 'string') {
      if (mark === 'u') return undefined;
      if (mark === 'map') return new Map((record.items as [unknown, unknown][]).map(([key, value]) => [walk(key), walk(value)]));
      if (mark === 'set') return new Set((record.items as unknown[]).map(walk));
      if (mark === 'opaque') throw new Error('The admission memo cannot make a function value again');
      return Number(mark);
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) out[key] = walk(value);
    return out;
  };
  return walk(JSON.parse(text));
}

/** What one call wrote, in a form a later call with the same reads applies to its own draft. */
interface Effect {
  /** Per member, in `members` order: the link's fields after the call, in order; `undefined` text = the value the link held before (the same object). */
  links: (readonly (readonly [string, string | undefined])[])[];
  /** The diagnostics after the call: an index into the list before it (the same entry) or the text of a new entry; absent when the call left them alone. */
  diagnostics?: { same: boolean; items: readonly (number | string)[] };
}
interface Signature { fields: readonly string[]; entries: Map<string, Effect> }

const admissionMemo = new Map<string, Signature>();
const admissionCache = readCache('fanAdmission');
let commands = 0;

/**
 * The memo lives while a command runs (`layout`): the first command to start opens it, and it is emptied when the last running command ends.
 * The keys are content, so two commands that run at once may share entries; none outlives them.
 */
export function openAdmissionMemo(): () => void {
  commands++;
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    if (--commands === 0) admissionMemo.clear();
  };
}

type Admit = (draft: LayoutModel, members: readonly LayoutLink[], budget: number) => void;

/** The key of `fields` of the draft as it stands, with the draft's field names, the members and the budget. */
function keyOf(draft: LayoutModel, fields: readonly string[], members: readonly LayoutLink[], budget: number, texts: Map<string, string>): string {
  const record = draft as unknown as Record<string, unknown>;
  const text = (field: string): string => {
    let known = texts.get(field);
    if (known === undefined) texts.set(field, known = exact(record[field]));
    return known;
  };
  return `${exact(Object.keys(draft))}\n${fields.map(text).join('\n')}\n${text('\u0000members')}\n${budget}`;
}

/** Whether the memo can track the draft: plain writable data fields only, and members that are links of the draft. */
function trackable(draft: LayoutModel, members: readonly LayoutLink[]): boolean {
  if (Object.isFrozen(draft) || !Object.isExtensible(draft)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(draft), keys = Object.keys(draft);
  if (Reflect.ownKeys(draft).length !== keys.length) return false;
  if (keys.some(key => !('value' in descriptors[key]!) || descriptors[key]!.writable !== true || descriptors[key]!.configurable !== true)) return false;
  const links = new Set(draft.links);
  return members.every(link => links.has(link) && !Object.isFrozen(link));
}

/**
 * Runs the admission with every own field of the draft an accessor, and returns the fields it read or wrote and, when the memo can make
 * them again, its writes.
 */
function record(draft: LayoutModel, members: readonly LayoutLink[], budget: number, admit: Admit): { fields: string[]; effect: Effect | undefined } {
  const target = draft as unknown as Record<string, unknown>, keys = Object.keys(draft);
  const values = new Map(keys.map(key => [key, target[key]]));
  // The state before the call, to tell what it wrote: the text of every field, of every link, and of every member's field.
  const before = new Map(keys.filter(key => key !== 'links' && key !== 'diagnostics').map(key => [key, JSON.stringify(target[key])]));
  const links = draft.links, linkTexts = links.map(link => JSON.stringify(link));
  const memberFields = members.map(link => new Map(Object.entries(link).map(([key, value]) => [key, { value, text: JSON.stringify(value) }])));
  const diagnostics = draft.diagnostics, diagnosticTexts = diagnostics.map(item => JSON.stringify(item));
  const read = new Set<string>();
  for (const key of keys) {
    Object.defineProperty(draft, key, { configurable: true, enumerable: true,
      get: () => { read.add(key); return values.get(key); },
      set: (value: unknown) => { read.add(key); values.set(key, value); } });
  }
  try { admit(draft, members, budget); } finally {
    for (const key of keys) {
      if (Object.getOwnPropertyDescriptor(draft, key)?.get !== undefined) Object.defineProperty(draft, key, { configurable: true, enumerable: true, writable: true, value: values.get(key) });
    }
  }
  const fields = keys.filter(key => read.has(key));
  // What the memo cannot make again: a field added or dropped, a field other than the links and the diagnostics changed, the list of links
  // changed, a link that is no member changed, or a value changed in place.
  const after = Object.keys(draft);
  if (after.length !== keys.length || after.some((key, index) => key !== keys[index])) return { fields, effect: undefined };
  for (const [key, text] of before) if (target[key] !== values.get(key) || JSON.stringify(target[key]) !== text) return { fields, effect: undefined };
  if (draft.links !== links || links.length !== linkTexts.length) return { fields, effect: undefined };
  const own = new Set(members);
  if (links.some((link, index) => !own.has(link) && JSON.stringify(link) !== linkTexts[index])) return { fields, effect: undefined };
  const effect: Effect = { links: [] };
  for (const [index, link] of members.entries()) {
    const was = memberFields[index]!, fieldsAfter: [string, string | undefined][] = [];
    for (const [key, value] of Object.entries(link)) {
      const old = was.get(key);
      if (old !== undefined && old.value === value) {
        if (JSON.stringify(value) !== old.text) return { fields, effect: undefined };
        fieldsAfter.push([key, undefined]);
      } else fieldsAfter.push([key, exact(value)]);
    }
    effect.links.push(fieldsAfter);
  }
  const list = draft.diagnostics as Diagnostic[];
  if (list !== diagnostics || list.length !== diagnosticTexts.length || list.some((item, index) => JSON.stringify(item) !== diagnosticTexts[index])) {
    if (!read.has('diagnostics')) return { fields, effect: undefined };
    const items: (number | string)[] = [];
    for (const item of list) {
      const at = diagnostics.indexOf(item);
      if (at >= 0 && JSON.stringify(item) !== diagnosticTexts[at]) return { fields, effect: undefined };
      items.push(at >= 0 ? at : exact(item));
    }
    effect.diagnostics = { same: list === diagnostics, items };
  }
  return { fields, effect };
}

/** Makes the writes of `effect` on the draft; false (nothing written) when a kept field is missing. */
function apply(draft: LayoutModel, members: readonly LayoutLink[], effect: Effect): boolean {
  if (effect.links.some((fields, index) => fields.some(([key, text]) => text === undefined && !Object.hasOwn(members[index]!, key)))) return false;
  if (effect.diagnostics?.items.some(item => typeof item === 'number' && item >= draft.diagnostics.length)) return false;
  for (const [index, fields] of effect.links.entries()) {
    const link = members[index]! as unknown as Record<string, unknown>;
    const values = fields.map(([key, text]) => [key, text === undefined ? link[key] : decode(text)] as const);
    for (const key of Object.keys(link)) delete link[key];
    for (const [key, value] of values) link[key] = value;
  }
  if (effect.diagnostics !== undefined) {
    const before = draft.diagnostics;
    const list = effect.diagnostics.items.map(item => typeof item === 'number' ? before[item]! : decode(item) as Diagnostic);
    if (effect.diagnostics.same) before.splice(0, before.length, ...list); else draft.diagnostics = list;
  }
  return true;
}

/** A copy of the draft that shares only the document, with the members as links of the copy; for the cache check. */
function copyOf(draft: LayoutModel, members: readonly LayoutLink[]): { copy: LayoutModel; members: LayoutLink[] } {
  const copy = decode(exact({ ...draft, document: undefined })) as LayoutModel;
  copy.document = draft.document;
  return { copy, members: members.map(link => copy.links[draft.links.indexOf(link)]!) };
}

/** `admit`, through the memo. */
export function memoAdmission(draft: LayoutModel, members: readonly LayoutLink[], budget: number, admit: Admit): void {
  if (commands === 0 || !trackable(draft, members)) { admit(draft, members, budget); return; }
  const memo = admissionMemo;
  const texts = new Map<string, string>([['\u0000members', exact(members)]]);
  // The smaller sets of fields first: the calls that read little (a family with no reservation) find their entry before a full key is built.
  for (const [id, signature] of [...memo].sort((a, b) => a[1].fields.length - b[1].fields.length || (a[0] < b[0] ? -1 : 1))) {
    const key = keyOf(draft, signature.fields, members, budget, texts), effect = signature.entries.get(key);
    if (effect === undefined) continue;
    signature.entries.delete(key); signature.entries.set(key, effect);
    memo.delete(id); memo.set(id, signature);
    admissionCache.hit(draft, effect, () => { const fresh = copyOf(draft, members); return record(fresh.copy, fresh.members, budget, admit).effect; });
    if (apply(draft, members, effect)) return;
  }
  admissionCache.miss();
  const before = new Map<string, string>(), target = draft as unknown as Record<string, unknown>;
  // The key is the state before the call: the text of each field is taken now, and only the fields the call reads are kept.
  for (const key of Object.keys(draft)) before.set(key, exact(target[key]));
  before.set('\u0000members', texts.get('\u0000members')!);
  const { fields, effect } = record(draft, members, budget, admit);
  if (effect === undefined) return;
  const id = fields.join(',');
  let signature = memo.get(id);
  if (signature === undefined) {
    if (memo.size >= ADMISSION_SIGNATURE_LIMIT) {
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) memo.delete(oldest);
    }
    memo.set(id, signature = { fields, entries: new Map() });
  }
  const key = `${exact(Object.keys(draft))}\n${fields.map(field => before.get(field)!).join('\n')}\n${before.get('\u0000members')!}\n${budget}`;
  if (signature.entries.size >= ADMISSION_MEMO_LIMIT) {
    const oldest = signature.entries.keys().next().value;
    if (oldest !== undefined) signature.entries.delete(oldest);
  }
  signature.entries.set(key, effect);
}
