export interface CorpusRow { cells?: Record<string, string>; error?: string }
export interface CorpusTsv { columns: string[]; rows: Map<string, CorpusRow> }
export interface Pair { file: string; flags: string[]; key: number[]; base: CorpusRow; head: CorpusRow }
export interface LeftOut { file: string; reason: 'only in head' | 'only in base' | 'fails in both' }
export function rankPairs(base: CorpusTsv, head: CorpusTsv): { worse: Pair[]; better: Pair[]; left: LeftOut[] };
export function selectPairs(basePath: string, headPath: string, top: number): { worse: Pair[]; better: Pair[]; counts: { worse: number; better: number }; left: LeftOut[] };
export function caption(pair: Pair): string;
export function pictureName(file: string): string;
