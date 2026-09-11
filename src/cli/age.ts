const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "3 minutes ago", "2 hours ago", "5 days ago". */
export function describeAge(when: Date, now: Date = new Date()): string {
  const elapsed = now.getTime() - when.getTime();
  if (elapsed < 0) return "just now"; // clock skew; not worth a stranger phrasing
  if (elapsed < MINUTE) return "just now";

  if (elapsed < HOUR) return ago(Math.floor(elapsed / MINUTE), "minute");
  if (elapsed < DAY) return ago(Math.floor(elapsed / HOUR), "hour");
  return ago(Math.floor(elapsed / DAY), "day");
}

function ago(count: number, unit: string): string {
  return `${count} ${count === 1 ? unit : `${unit}s`} ago`;
}
