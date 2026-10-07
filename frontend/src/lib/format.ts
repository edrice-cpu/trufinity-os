export const BUSINESS_TIMEZONE = "America/Vancouver";

export function formatReportDate(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: BUSINESS_TIMEZONE,
  }).format(date);
}

const moneyFormatter = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
const countFormatter = new Intl.NumberFormat("en-CA");

/** Formats a backend decimal string (e.g. "12345.67") for display. Intl formats the string exactly, no float parsing. */
export function formatMoney(value: string | null | undefined): string {
  if (value == null || value.trim() === "") return "—";
  return moneyFormatter.format(value as Intl.StringNumericLiteral);
}

export function formatCount(value: number | null | undefined): string {
  return value == null ? "—" : countFormatter.format(value);
}

const dateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: BUSINESS_TIMEZONE,
});
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: BUSINESS_TIMEZONE,
});

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTimeFormatter.format(new Date(iso)) : "—";
}

export function formatDate(iso: string | null | undefined): string {
  return iso ? dateFormatter.format(new Date(iso)) : "—";
}

/** "PARTIALLY_PAID" -> "Partially Paid" */
export function formatEnumLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .toLowerCase()
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const percentFormatter = new Intl.NumberFormat("en-CA", { style: "percent", maximumFractionDigits: 1 });
const numberFormatter = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 2 });

/** Formats a backend ratio string ("0.4200") as a percentage ("42%"), without float parsing. */
export function formatRatio(value: string | null | undefined): string {
  if (value == null || value.trim() === "") return "—";
  return percentFormatter.format(value as Intl.StringNumericLiteral);
}

export function formatDecimal(value: string | null | undefined): string {
  if (value == null || value.trim() === "") return "—";
  return numberFormatter.format(value as Intl.StringNumericLiteral);
}

/** "dropPoints" / "drop_points" -> "Drop Points" */
export function humanizeKey(key: string): string {
  return formatEnumLabel(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}
