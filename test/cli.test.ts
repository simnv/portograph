import { describe, expect, it } from 'vitest';
import { EXIT, VERBS, helpText, isVerb } from '../src/index.js';

describe('CLI contract', () => {
  it('help lists the four verbs in pipeline order and each one is a recognised verb', () => {
    const help = helpText();
    const names = VERBS.map((verb) => verb.name);
    expect(names).toEqual(['layout', 'render', 'score', 'migrate']);

    const positions = names.map((name) => help.indexOf(`  ${name} `));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    expect(names.every(isVerb)).toBe(true);
    expect(isVerb('parse')).toBe(false);
    expect(EXIT.notImplemented).toBe(2);
    expect(help).toContain(`${EXIT.inputError}  input error`);
  });
});
