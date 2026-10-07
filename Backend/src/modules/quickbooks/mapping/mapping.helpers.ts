import type {
  MappingIssue,
  QboMappingEntity,
  QboMappingSkipReason,
  RawQboRecord,
} from './mapping.types';

export type JsonRecord = Record<string, unknown>;

const MAX_NUMERIC_15_2_CENTS = 999_999_999_999_999n;

export const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const mappingIssue = (
  entity: QboMappingEntity,
  sourceId: string | null,
  reason: QboMappingSkipReason,
): MappingIssue => ({ entity, sourceId, reason });

export type ValidatedRawSource =
  | { kind: 'active'; sourceId: string; payload: JsonRecord }
  | { kind: 'deleted'; sourceId: string }
  | { kind: 'skipped'; issue: MappingIssue };

export const validateRawSource = (
  raw: RawQboRecord,
  entity: QboMappingEntity,
): ValidatedRawSource => {
  const sourceId = typeof raw.source_id === 'string' ? raw.source_id : null;
  if (!sourceId || sourceId.trim() === '') {
    return { kind: 'skipped', issue: mappingIssue(entity, null, 'INVALID_SOURCE_ID') };
  }
  if (typeof raw.is_deleted !== 'boolean' || !isJsonRecord(raw.payload)) {
    return { kind: 'skipped', issue: mappingIssue(entity, sourceId, 'INVALID_SOURCE_RECORD') };
  }
  const payloadId = raw.payload.Id;
  if (typeof payloadId !== 'string' || payloadId.trim() === '') {
    return { kind: 'skipped', issue: mappingIssue(entity, sourceId, 'INVALID_SOURCE_ID') };
  }
  if (payloadId !== sourceId) {
    return { kind: 'skipped', issue: mappingIssue(entity, sourceId, 'SOURCE_ID_MISMATCH') };
  }
  return raw.is_deleted
    ? { kind: 'deleted', sourceId }
    : { kind: 'active', sourceId, payload: raw.payload };
};

export const parseQboReferenceId = (value: unknown): string | null => {
  if (!isJsonRecord(value) || typeof value.value !== 'string' || value.value.trim() === '') return null;
  return value.value;
};

const expandExponent = (value: number): string | null => {
  if (!Number.isFinite(value)) return null;
  const text = value.toString().toLowerCase();
  const [coefficient, exponentText] = text.split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 30) return null;

  const negative = coefficient.startsWith('-');
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [whole = '', fraction = ''] = unsigned.split('.');
  const digits = whole + fraction;
  const decimalPosition = whole.length + exponent;
  let integerPart: string;
  let fractionalPart: string;
  if (decimalPosition <= 0) {
    integerPart = '0';
    fractionalPart = '0'.repeat(-decimalPosition) + digits;
  } else if (decimalPosition >= digits.length) {
    integerPart = digits + '0'.repeat(decimalPosition - digits.length);
    fractionalPart = '';
  } else {
    integerPart = digits.slice(0, decimalPosition);
    fractionalPart = digits.slice(decimalPosition);
  }
  integerPart = integerPart.replace(/^0+(?=\d)/, '') || '0';
  fractionalPart = fractionalPart.replace(/0+$/, '');
  return (negative ? '-' : '') + integerPart + (fractionalPart ? '.' + fractionalPart : '');
};

export const qboMoneyToCents = (value: unknown): bigint | null => {
  if (typeof value !== 'number') return null;
  const text = expandExponent(value);
  if (!text) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const [, sign, integerPart, fractionalPart = ''] = match;
  if (fractionalPart.length > 2 || integerPart.length > 13) return null;
  const cents = BigInt(integerPart) * 100n + BigInt(fractionalPart.padEnd(2, '0') || '0');
  if (cents > MAX_NUMERIC_15_2_CENTS) return null;
  return sign === '-' ? -cents : cents;
};

export const centsToQboMoney = (cents: bigint): string | null => {
  const absolute = cents < 0n ? -cents : cents;
  if (absolute > MAX_NUMERIC_15_2_CENTS) return null;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return (cents < 0n ? '-' : '') + whole.toString() + '.' + fraction;
};

export const qboMoney = (value: unknown): string | null => {
  const cents = qboMoneyToCents(value);
  return cents === null ? null : centsToQboMoney(cents);
};

export const sumQboMoney = (values: unknown[]): string | null => {
  let total = 0n;
  for (const value of values) {
    const cents = qboMoneyToCents(value);
    if (cents === null) return null;
    total += cents;
    if (centsToQboMoney(total) === null) return null;
  }
  return centsToQboMoney(total);
};

export const qboDate = (value: unknown, optional: boolean): string | null | undefined => {
  if (value === undefined || value === null) return optional ? null : undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : undefined;
};

export const compactQboNamespace = (
  payload: JsonRecord,
  fields: readonly string[],
): Record<string, unknown> => {
  const qbo: Record<string, unknown> = {};
  for (const field of fields) {
    if (payload[field] !== undefined) qbo[field] = payload[field];
  }
  return { quickbooks: qbo };
};
