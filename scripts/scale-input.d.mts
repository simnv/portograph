/** Deterministic full-pipeline scale inputs; see `scale-input.mjs`. */
export declare function generateScaleYaml(options: {
  nodes: number;
  degree?: number;
  transits?: number;
  multiplicity?: number;
  shape?: 'hub' | 'chain';
}): { yaml: string; nodes: number; links: number; tiers: number; shape: string };
