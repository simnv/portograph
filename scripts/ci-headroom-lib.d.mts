export interface TestDuration { job: string | undefined; project: string | undefined; file: string; title: string; ms: number; failed: boolean }
export interface Headroom { job: string | undefined; file: string; line: number | undefined; title: string; ms: number; limit: number | undefined; share: number | undefined; failed: boolean }
export function testDurations(log: string): TestDuration[];
export function headroom(log: string, root: string, part?: number): Headroom[];
