export interface ProjectLimits {
  default: { limit: number };
  heavy: { files: string[]; limit: number };
  slow: { files: string[]; limit: number };
}
export interface TestCall { line: number; title: string; pattern: RegExp; own: number | undefined; describe: number | undefined }
export function projectLimits(root: string): ProjectLimits;
export function projectOf(limits: ProjectLimits, file: string): 'default' | 'heavy' | 'slow';
export function specificity(pattern: RegExp): number;
export function testsIn(root: string, file: string): TestCall[];
export function limitOf(test: TestCall, projectLimit: number): number;
export function limitsBelowProject(root: string): { file: string; line: number; title: string; project: 'heavy' | 'slow'; limit: number; projectLimit: number }[];
