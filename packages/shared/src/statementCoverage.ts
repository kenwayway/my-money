export interface StatementDateRange {
  start: string;
  end: string;
}

export interface MonthCoverage {
  coveredDays: number;
  totalDays: number;
  status: "none" | "partial" | "full";
}

export interface StatementCycleCoverage extends MonthCoverage {
  hasPrimaryStatement: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

function utcDay(date: string): number | null {
  if (!ISO_DATE.test(date)) return null;
  const [year, month, day] = date.split("-").map(Number);
  const value = Date.UTC(year!, month! - 1, day!);
  const parsed = new Date(value);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month! - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(value / 86_400_000);
}

export function monthDateBounds(month: string): {
  start: string;
  end: string;
  totalDays: number;
} {
  if (!ISO_MONTH.test(month)) throw new Error(`invalid month: ${month}`);
  const [year, monthNumber] = month.split("-").map(Number);
  if (monthNumber! < 1 || monthNumber! > 12) {
    throw new Error(`invalid month: ${month}`);
  }
  const totalDays = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
  return {
    start: `${month}-01`,
    end: `${month}-${String(totalDays).padStart(2, "0")}`,
    totalDays,
  };
}

/** Inclusive calendar-day coverage after clipping and merging overlaps. */
export function monthCoverage(
  month: string,
  ranges: StatementDateRange[]
): MonthCoverage {
  const bounds = monthDateBounds(month);
  const monthStart = utcDay(bounds.start)!;
  const monthEnd = utcDay(bounds.end)!;
  const clipped: Array<[number, number]> = [];

  for (const range of ranges) {
    const rawStart = utcDay(range.start);
    const rawEnd = utcDay(range.end);
    if (rawStart === null || rawEnd === null) continue;
    const start = Math.min(rawStart, rawEnd);
    const end = Math.max(rawStart, rawEnd);
    const clippedStart = Math.max(start, monthStart);
    const clippedEnd = Math.min(end, monthEnd);
    if (clippedStart <= clippedEnd) clipped.push([clippedStart, clippedEnd]);
  }

  clipped.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let coveredDays = 0;
  let mergedStart: number | null = null;
  let mergedEnd: number | null = null;
  for (const [start, end] of clipped) {
    if (mergedStart === null) {
      mergedStart = start;
      mergedEnd = end;
      continue;
    }
    if (start <= mergedEnd! + 1) {
      mergedEnd = Math.max(mergedEnd!, end);
      continue;
    }
    coveredDays += mergedEnd! - mergedStart + 1;
    mergedStart = start;
    mergedEnd = end;
  }
  if (mergedStart !== null) coveredDays += mergedEnd! - mergedStart + 1;

  return {
    coveredDays,
    totalDays: bounds.totalDays,
    status:
      coveredDays === 0
        ? "none"
        : coveredDays >= bounds.totalDays
          ? "full"
          : "partial",
  };
}

/**
 * Calendar overlap plus statement-cycle semantics: the month containing the
 * period end is the completed cycle, even when only part of that calendar month
 * belongs to it. Other overlapped months remain partial carry-over.
 */
export function statementCycleCoverage(
  month: string,
  ranges: StatementDateRange[]
): StatementCycleCoverage {
  const coverage = monthCoverage(month, ranges);
  const hasPrimaryStatement = ranges.some(
    (range) => range.end.slice(0, 7) === month
  );
  return {
    ...coverage,
    status:
      coverage.status === "none"
        ? "none"
        : hasPrimaryStatement || coverage.status === "full"
          ? "full"
          : "partial",
    hasPrimaryStatement,
  };
}
