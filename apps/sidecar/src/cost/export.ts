import type { CostBreakdownGroupBy, CostReportFormat } from '@taori/shared';

function csvEscape(value: unknown): string {
  if (value == null) return '';
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function safeCostExportFilename(args: {
  scope: 'session' | 'today' | 'week' | 'month';
  groupBy: CostBreakdownGroupBy;
  format: CostReportFormat;
}): string {
  return `taori-costs-${args.groupBy}-${args.scope}.${args.format}`;
}

export function renderCostReportCsv(
  rows: Array<Record<string, unknown>>,
): string {
  if (rows.length === 0) return 'key,label,sum_usd,count,success_count,billed_failure_count\n';
  const keys = Array.from(
    rows.reduce((set, row) => {
      for (const key of Object.keys(row)) {
        if (key !== 'trend') set.add(key);
      }
      return set;
    }, new Set<string>()),
  );
  return [
    keys.join(','),
    ...rows.map((row) => keys.map((key) => csvEscape(row[key])).join(',')),
  ].join('\n');
}
