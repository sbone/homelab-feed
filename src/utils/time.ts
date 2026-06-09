export function parseDate(value: unknown, fallback = new Date()): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "number") {
    const date = new Date(value > 10_000_000_000 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? fallback : date;
  }

  if (typeof value === "string" && value.length > 0) {
    if (/^\d+$/.test(value)) {
      return parseDate(Number(value), fallback);
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : date;
  }

  return fallback;
}
