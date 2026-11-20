export declare const SECTION_OF: Readonly<Record<string, string>>;
export declare const FREE_SECTIONS: readonly string[];
export interface AcceptedKey { key: string; section: string; where: string }
export declare function acceptedKeys(source: string, file?: string): { found: AcceptedKey[]; unmapped: string[] };
export declare function sections(doc: string): Map<string, string>;
export declare function schemaGaps(source: string, doc: string): { gaps: string[]; found: AcceptedKey[] };
