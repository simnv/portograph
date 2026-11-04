import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, render } from '../../src/index.js';
import type { NormalisedNode } from '../../src/model/document.js';
import type { Side } from '../../src/model/geometry.js';
import { measureNodeContent, placeNodeContent } from '../../src/layout/size.js';
import { DEFAULT_NODE_CONTENT, NODE_CONTENT_STYLES, resolveNodeContentStyle } from '../../src/profiles/network/content.js';
import { measurePortPill, measureText } from '../../src/text/index.js';
import { CARD_CONTENT_GEOMETRY as card } from '../../src/theme/content.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withoutJointOrder } from './joint-off.js';

/**
 * Snack-theme ticket 159: a card node. Line heights come from the text module (Verdana, `ceil(1.215 × size)`), never from a number written here.
 */
const title = (text: string) => measureText(text, { fontSize: card.titleFontSize, weight: card.titleFontWeight });
const subtitle = (text: string) => measureText(text, { fontSize: card.subtitleFontSize, weight: card.subtitleFontWeight });
const plain: Record<Side, number> = { top: 10, right: 10, bottom: 10, left: 10 };
/** The documents the tests measure in: `layout.nodeContent` is the card switch (ticket 159); a document without it is stacked. */
const cards = { groups: {}, layout: { nodeContent: 'card' as const } };
const plainDoc = { groups: {} };
const node = (extra: Partial<NormalisedNode> = {}): NormalisedNode => ({ group: 'g', label: 'Flex Mini', ports: [], ...extra });

describe('card content measurement', () => {
  it('takes its width from the text: inset + tile + gap + the wider of title and subtitle + inset', () => {
    const text = node({ class: 'router', label: 'Distribution switch of the east wing', description: 'Rack 14, row B' });
    const content = measureNodeContent(text, cards, plain);
    expect(content.style).toBe('card');
    const wide = Math.max(title(text.label).width, subtitle(text.description!).width);
    expect(wide).toBe(title(text.label).width);
    expect(content.width).toBe(10 + card.tileSize + card.tileGap + wide + 10);
  });

  it('takes its width from a long subtitle when it is wider than the title', () => {
    const text = node({ class: 'router', label: 'A', description: 'a description that is much wider than the title' });
    expect(measureNodeContent(text, cards, plain).width).toBe(10 + card.tileSize + card.tileGap + subtitle(text.description!).width + 10);
  });

  it('is as high as the text block when that is higher than the tile, with the 2 px gap between title and subtitle', () => {
    const text = node({ class: 'router', description: 'one line' });
    const block = title(text.label).height + card.subtitleGap + subtitle('one line').height;
    expect(block).toBeGreaterThan(card.tileSize);
    expect(measureNodeContent(text, cards, plain).height).toBe(10 + block + 10);
    // The line heights are the text module's: 14 at 11 px, 11 at 9 px.
    expect(title('X').lineHeight).toBe(Math.ceil(1.215 * card.titleFontSize));
    expect(subtitle('x').lineHeight).toBe(Math.ceil(1.215 * card.subtitleFontSize));
  });

  it('keeps the lines the author wrote and does not wrap them', () => {
    const text = node({ class: 'router', description: 'PoE-powered by p8\nspare on p9' });
    const content = measureNodeContent(text, cards, plain);
    const sub = content.blocks.find(block => block.kind === 'description')!;
    expect(sub.kind === 'description' && sub.lines).toEqual(['PoE-powered by p8', 'spare on p9']);
    expect(content.height).toBe(10 + title(text.label).height + card.subtitleGap + 2 * subtitle('x').lineHeight + 10);
  });

  it('has no 2 px gap and no subtitle line when there is no description', () => {
    const none = measureNodeContent(node({ class: 'router' }), cards, plain);
    expect(none.blocks.map(block => block.kind)).toEqual(['icon', 'node']);
    // The title (14) is shorter than the tile (24): the tile sets the height.
    expect(none.height).toBe(10 + Math.max(card.tileSize, title('Flex Mini').height) + 10);
    const empty = measureNodeContent(node({ class: 'router', description: '' }), cards, plain);
    expect(empty.height).toBe(none.height);
    // With no icon either, the title alone sets the height and nothing adds a gap to it.
    expect(measureNodeContent(node({ icon: '' }), cards, plain).height).toBe(10 + title('Flex Mini').height + 10);
  });

  it('has no tile and no gap when the card has no icon', () => {
    const bare = node({ class: 'router', icon: '', description: 'label only' });
    const content = measureNodeContent(bare, cards, plain);
    expect(content.blocks.map(block => block.kind)).toEqual(['node', 'description']);
    expect(content.width).toBe(10 + Math.max(title('Flex Mini').width, subtitle('label only').width) + 10);
  });

  it('sets the tile at 24 x 24 with radius 4 and glyph inset 3, and the text start-aligned', () => {
    const content = measureNodeContent(node({ class: 'router', description: 'x' }), cards, plain);
    expect(content.blocks[0]).toEqual({ kind: 'icon', icon: 'router', width: 24, height: 24, inset: 3, radius: 4 });
    for (const block of content.blocks.slice(1)) expect(block.kind !== 'icon' && block.textAlign).toBe('start');
  });

  it('uses the asymmetric insets of the faces: a left port moves the width by the left inset only', () => {
    const pill = measurePortPill('l1');
    const left = { ...plain, left: Math.max(10, pill.width / 2 + 4) };
    const text = node({ class: 'router' });
    const base = measureNodeContent(text, cards, plain), moved = measureNodeContent(text, cards, { ...plain, left: 30 });
    expect(moved.width - base.width).toBe(20);
    expect(moved.height).toBe(base.height);
    expect(measureNodeContent(text, cards, left).width).toBe(left.left + card.tileSize + card.tileGap + title(text.label).width + 10);
  });
});

describe('card placement', () => {
  const text = node({ class: 'router', description: '.170 · 5p · PoE-powered by p8' });
  const content = measureNodeContent(text, cards, plain);

  it('stands the tile and the text block side by side, 8 px apart, on one centre line', () => {
    const box = { x: 100, y: 50, width: content.width, height: content.height };
    const [tile, name, description] = placeNodeContent(content, box, plain);
    expect(tile!.bounds).toEqual({ x: 110, y: 50 + (box.height - card.tileSize) / 2, width: 24, height: 24 });
    expect(name!.bounds.x).toBe(tile!.bounds.x + tile!.bounds.width + card.tileGap);
    expect(description!.bounds.x).toBe(name!.bounds.x);
    expect(description!.bounds.y).toBe(name!.bounds.y + name!.bounds.height + card.subtitleGap);
    const blockTop = name!.bounds.y, blockBottom = description!.bounds.y + description!.bounds.height;
    expect((blockTop + blockBottom) / 2).toBeCloseTo(50 + box.height / 2, 9);
  });

  it('centres the tile and the text block together in the inset interior of a wider box', () => {
    const insets = { top: 10, bottom: 10, left: 30, right: 12 };
    const inner = measureNodeContent(text, cards, insets);
    const box = { x: 0, y: 0, width: inner.width + 40, height: inner.height };
    const placed = placeNodeContent(inner, box, insets);
    const left = placed[0]!.bounds.x, last = placed[placed.length - 1]!.bounds;
    const right = Math.max(...placed.map(item => item.bounds.x + item.bounds.width));
    expect(left - insets.left).toBeCloseTo(box.width - insets.right - right, 9);
    expect(last.x).toBeGreaterThan(left);
  });
});

describe('the content style resolver', () => {
  const stacked = plainDoc, bars = { groups: { bus: { shape: 'bar' as const }, edge: { shape: 'ranked' as const } } };

  it('lists the two values, and a document without layout.nodeContent is stacked', () => {
    expect([...NODE_CONTENT_STYLES].sort()).toEqual(['card', 'stacked']);
    expect(DEFAULT_NODE_CONTENT).toBe('stacked');
    expect(resolveNodeContentStyle({ group: 'g' }, stacked)).toBe('stacked');
    expect(resolveNodeContentStyle({ group: 'g', class: 'router' }, stacked)).toBe('stacked');
    expect(resolveNodeContentStyle({ group: 'g', class: 'rr tbr' }, stacked)).toBe('stacked');
  });

  it('gives every node the document value, also one without a description or a class, and a sheet class', () => {
    expect(resolveNodeContentStyle({ group: 'g' }, cards)).toBe('card');
    expect(resolveNodeContentStyle({ group: 'g', class: 'router' }, cards)).toBe('card');
    expect(resolveNodeContentStyle({ group: 'g', class: 'rr tbr' }, cards)).toBe('card');
    expect(resolveNodeContentStyle({ group: 'g', class: 'my-sheet-class' }, cards)).toBe('card');
    expect(resolveNodeContentStyle({ group: 'g', class: 'router' }, { groups: {}, layout: { nodeContent: 'stacked' } })).toBe('stacked');
  });

  it('lets a profile class override the document value, and no other class follows it', () => {
    const toStacked = (token: string | undefined) => token === 'rr' ? { content: 'stacked' as const } : undefined;
    expect(resolveNodeContentStyle({ group: 'g', class: 'rr' }, cards, toStacked)).toBe('stacked');
    expect(resolveNodeContentStyle({ group: 'g', class: 'router' }, cards, toStacked)).toBe('card');
    expect(resolveNodeContentStyle({ group: 'g' }, cards, toStacked)).toBe('card');
    const toCard = (token: string | undefined) => token === 'rr' ? { content: 'card' as const } : undefined;
    expect(resolveNodeContentStyle({ group: 'g', class: 'rr' }, stacked, toCard)).toBe('card');
    expect(resolveNodeContentStyle({ group: 'g', class: 'router' }, stacked, toCard)).toBe('stacked');
  });

  it('gives a node of a bar group the stacked style, whatever its class and the document value: its own drops cross the bar body', () => {
    const toCard = (token: string | undefined) => token === 'rr' ? { content: 'card' as const } : undefined;
    const barCards = { ...bars, layout: { nodeContent: 'card' as const } };
    expect(resolveNodeContentStyle({ group: 'bus', class: 'router' }, barCards)).toBe('stacked');
    expect(resolveNodeContentStyle({ group: 'bus', class: 'rr' }, barCards, toCard)).toBe('stacked');
    expect(resolveNodeContentStyle({ group: 'edge', class: 'router' }, barCards)).toBe('card');
    expect(measureNodeContent(node({ group: 'bus', class: 'router', description: 'x' }), barCards, plain).style).toBe('stacked');
  });

  it('measures the stacked style exactly as before: one centred column, the same size for the same text', () => {
    const text = node({ class: 'router', label: 'Content', description: 'one\ntwo' });
    const stacked = measureNodeContent(text, plainDoc, plain, 'stacked');
    expect(stacked.style).toBe('stacked');
    expect(stacked.blocks.map(block => block.kind)).toEqual(['icon', 'node', 'description']);
    expect(stacked.blocks[0]).toEqual({ kind: 'icon', icon: 'router', width: 12, height: 12 });
    const placed = placeNodeContent(stacked, { x: 0, y: 0, width: stacked.width, height: stacked.height }, plain);
    const centres = placed.map(item => item.bounds.x + item.bounds.width / 2);
    expect(new Set(centres.map(x => Math.round(x * 1e6))).size).toBe(1);
    expect(stacked.blocks.every(block => block.kind === 'icon' || block.textAlign === undefined)).toBe(true);
  });
});

describe('a card holds its ports on every face (fixture)', () => {
  const source = withoutJointOrder(readFileSync(new URL('../../goldens/synthetic/a-card-node-holds-its-ports-on-every-face.yaml', import.meta.url), 'utf8'));

  it('measures at stage 3, keeps the size through stage 5 and places the text beside the tile on every node', async () => {
    const model = await layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    for (const [id, placed] of Object.entries(model.nodes)) {
      const box = placed.bounds!, authored = model.document.nodes[id]!;
      // One decision: the stored content size is what the resolver's style measures with the stored insets.
      const again = measureNodeContent(authored, model.document, placed.contentInsets!);
      expect(again.style, id).toBe('card');
      expect({ width: again.width, height: again.height }, id).toEqual(placed.contentSize);
      expect(box.width, id).toBeGreaterThanOrEqual(placed.contentSize!.width - 1e-6);
      const labels = model.labels.filter(label => label.owner.kind === 'node' && label.owner.id === id && (label.role === 'node' || label.role === 'description'));
      for (const label of labels) expect(label.textAlign, id).toBe('start');
      if (placed.icon !== undefined) {
        expect(placed.icon.bounds.width).toBe(24);
        expect(placed.icon.bounds.height).toBe(24);
        for (const label of labels) expect(label.bounds!.x, id).toBe(placed.icon.bounds.x + 24 + card.tileGap);
      }
      // Ports stay centred on their faces, whatever the text does.
      for (const side of ['top', 'bottom', 'left', 'right'] as const) {
        const ports = placed.ports.filter(port => port.side === side);
        if (!ports.length) continue;
        const horizontal = side === 'top' || side === 'bottom';
        const along = ports.map(port => horizontal ? port.anchor!.x - box.x : port.anchor!.y - box.y);
        const length = horizontal ? box.width : box.height;
        expect((Math.min(...along) + Math.max(...along)) / 2, `${id}.${side}`).toBeCloseTo(length / 2, 6);
      }
    }
  });

  it('takes the width from the text for `wide` and from 5 bottom ports for `hub`, and is lower with no subtitle', async () => {
    const model = await layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const wide = model.nodes.wide!, hub = model.nodes.hub!, plainNode = model.nodes.plain!, twoline = model.nodes.twoline!;
    expect(wide.contentSize!.width).toBeGreaterThan(wide.sidePitch!.bottom! + 20);
    expect(wide.bounds!.width).toBeGreaterThanOrEqual(wide.contentSize!.width - 1e-6);
    expect(hub.bounds!.width).toBeGreaterThan(hub.contentSize!.width);
    expect(hub.bounds!.width).toBeGreaterThanOrEqual(5 * hub.sidePitch!.bottom! + 20);
    // `plain` has no description: no subtitle line and no gap. `lateral` has the same top and bottom insets and one subtitle line, so the difference is
    // the text block of `lateral` (title, 2 px, subtitle) less the taller of the tile and the one title line of `plain`. `twoline` has two subtitle lines.
    const lateralBlock = title('Lateral').height + card.subtitleGap + subtitle('.170 · 4l').height, plainBlock = Math.max(card.tileSize, title('Flex Mini').height);
    expect(lateralBlock, 'the premise: the text block of lateral is taller than the tile').toBeGreaterThan(card.tileSize);
    expect(model.nodes.lateral!.contentSize!.height - plainNode.contentSize!.height).toBeCloseTo(lateralBlock - plainBlock, 9);
    expect(twoline.contentSize!.height).toBeGreaterThan(model.nodes.hub!.contentSize!.height);
    // Four left ports: the left inset is the pill's inward half-extent + 4, the other faces keep 10.
    const lateral = model.nodes.lateral!;
    expect(lateral.contentInsets!.left).toBe(Math.max(10, measurePortPill('l1').width / 2 + 4));
    expect(lateral.contentInsets!.right).toBe(10);
    // Long pills on all four faces grow all four insets.
    const crowd = model.nodes.crowd!;
    for (const side of ['top', 'bottom', 'left', 'right'] as const) expect(crowd.contentInsets![side], side).toBeGreaterThan(40);
    // No icon: no tile, and the text block alone is centred in the inset interior of the box.
    const bare = model.nodes.bare!, box = bare.bounds!, insets = bare.contentInsets!;
    expect(bare.icon).toBeUndefined();
    const texts = model.labels.filter(label => label.owner.kind === 'node' && label.owner.id === 'bare' && (label.role === 'node' || label.role === 'description')).map(label => label.bounds!);
    expect(texts).toHaveLength(2);
    const left = Math.min(...texts.map(item => item.x)), right = Math.max(...texts.map(item => item.x + item.width));
    expect(left - (box.x + insets.left)).toBeCloseTo(box.x + box.width - insets.right - right, 6);
    expect(left - (box.x + insets.left)).toBeGreaterThanOrEqual(-1e-6);
  });

  it('is drawn start-aligned: text-anchor start at the left edge of the title, and a 24 px tile with radius 4', async () => {
    const model = await layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const svg = render(model);
    const title = model.labels.find(label => label.role === 'node' && label.owner.kind === 'node' && label.owner.id === 'hub')!;
    expect(svg).toMatch(/<text class="[^"]*node-label[^"]*"[^>]*text-anchor="start"/);
    expect(svg).toContain(`<tspan x="${title.bounds!.x}"`);
    expect(svg).toMatch(/<rect class="icon-tile[^"]*"[^>]*width="24" height="24" rx="4" ry="4"/);
  });
});
