import { parse } from 'csv-parse/sync';

// Lace exports include an occasional aggregate row (e.g. "TOTAL / TENANT") with
// blank id columns, and quoted fields containing commas - relax_column_count
// guards against any trailing-column drift the vendor note in SPEC-BI-001 (Sec 5)
// warns about between the live Call Center app and the scheduled export module.
export function parseLaceCsv(text: string): Record<string, string>[] {
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
}
