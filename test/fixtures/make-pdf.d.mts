export function makePdf(pages: { heading?: string; text: string }[]): Uint8Array;
export const TITLE: string;
export function sampleThesis(v2?: boolean): Uint8Array;
export function sampleAvance(v2?: boolean): {
  schema: 1;
  title: string;
  generated_at: string;
  total_words: number;
  chapters: { id: string; title: string; words: number; goal: number | null; status: string | null }[];
};
export function sampleProgress(v2?: boolean): {
  schema: 1;
  title: string;
  generated_at: string;
  total_words: number;
  sections: { id: string; title: string; words: number; goal: number | null; status: string | null }[];
};
export const REPORT_TITLE: string;
export function sampleReport(v2?: boolean): Uint8Array;
export function sampleReportProgress(v2?: boolean): ReturnType<typeof sampleProgress>;
