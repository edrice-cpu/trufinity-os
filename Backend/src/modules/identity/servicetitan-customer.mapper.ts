import {
  type CustomerIdentityAnalysis,
  type CustomerIdentityIssue,
  type CustomerIdentityPlan,
  type IdentityRawCustomerRecord,
} from './customer-identity.types';

const MAX_MERGE_DEPTH = 10;

type JsonRecord = Record<string, unknown>;

interface AddressFields {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

export const normalizeIdentityValue = (value: string | null): string | null => {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === '' ? null : normalized;
};

const readFirstString = (record: JsonRecord, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value !== null) return value;
  }
  return null;
};

const extractAddress = (payload: JsonRecord): AddressFields => {
  const address = isRecord(payload.address) ? payload.address : {};
  return {
    street: readFirstString(address, ['street', 'street1', 'line1', 'address1', 'addressLine1']),
    city: readFirstString(address, ['city']),
    state: readFirstString(address, ['state', 'stateCode', 'stateOrProvince']),
    zip: readFirstString(address, ['zip', 'zipCode', 'postalCode', 'postal']),
  };
};

const extractQboAddress = (payload: JsonRecord): AddressFields => {
  const address = isRecord(payload.BillAddr) ? payload.BillAddr : {};
  return {
    street: readFirstString(address, ['Line1']),
    city: readFirstString(address, ['City']),
    state: readFirstString(address, ['CountrySubDivisionCode']),
    zip: readFirstString(address, ['PostalCode']),
  };
};

const extractName = (payload: JsonRecord, qbo: boolean): string | null =>
  qbo ? asString(payload.DisplayName) : asString(payload.name);

const matchingKey = (name: string | null, zip: string | null): string | null => {
  const normalizedName = normalizeIdentityValue(name);
  const normalizedZip = normalizeIdentityValue(zip);
  return normalizedName === null || normalizedZip === null
    ? null
    : normalizedName + ':' + normalizedZip;
};

const sameRequiredAddress = (left: AddressFields, right: AddressFields): boolean =>
  left.street !== null && right.street !== null &&
  left.city !== null && right.city !== null &&
  left.state !== null && right.state !== null &&
  normalizeIdentityValue(left.street) === normalizeIdentityValue(right.street) &&
  normalizeIdentityValue(left.city) === normalizeIdentityValue(right.city) &&
  normalizeIdentityValue(left.state) === normalizeIdentityValue(right.state);

const parseMergedToId = (payload: JsonRecord): string | null => {
  const value = payload.mergedToId;
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim()) && value.trim() !== '0') return value.trim();
  throw new Error('INVALID_MERGED_TO_ID');
};

interface ParsedCustomer {
  payload: JsonRecord;
  sourceId: string;
  name: string | null;
  address: AddressFields;
  mergedToId: string | null;
};

const parseSourcePayload = (
  record: IdentityRawCustomerRecord,
  qbo: boolean,
): ParsedCustomer | null => {
  if (!isRecord(record.payload) || record.sourceId.trim() === '') return null;
  return {
    payload: record.payload,
    sourceId: record.sourceId,
    name: extractName(record.payload, qbo),
    address: qbo ? extractQboAddress(record.payload) : extractAddress(record.payload),
    mergedToId: qbo ? null : parseMergedToId(record.payload),
  };
};

export const analyzeCustomerIdentity = (
  stRecords: IdentityRawCustomerRecord[],
  qboRecords: IdentityRawCustomerRecord[],
): CustomerIdentityAnalysis => {
  const issues: CustomerIdentityIssue[] = [];
  const stParsed = new Map<string, ParsedCustomer>();
  const qboGroups = new Map<string, string[]>();
  const stGroups = new Map<string, string[]>();

  for (const record of stRecords) {
    if (record.isDeleted) continue;
    try {
      const parsed = parseSourcePayload(record, false);
      if (parsed === null) {
        issues.push({ sourceId: record.sourceId || null, reason: 'INVALID_SOURCE_PAYLOAD' });
        continue;
      }
      stParsed.set(parsed.sourceId, parsed);
      if (parsed.mergedToId === null) {
        const key = matchingKey(parsed.name, parsed.address.zip);
        if (key !== null) stGroups.set(key, [...(stGroups.get(key) ?? []), parsed.sourceId]);
      }
    } catch (error) {
      const reason = error instanceof Error && error.message === 'INVALID_MERGED_TO_ID'
        ? 'INVALID_MERGED_TO_ID'
        : 'INVALID_SOURCE_PAYLOAD';
      if (reason === 'INVALID_MERGED_TO_ID') throw new Error(reason, { cause: error });
      issues.push({ sourceId: record.sourceId || null, reason });
    }
  }

  const qboParsed = new Map<string, ParsedCustomer>();
  for (const record of qboRecords) {
    if (record.isDeleted) continue;
    const parsed = parseSourcePayload(record, true);
    if (parsed === null) {
      issues.push({ sourceId: record.sourceId || null, reason: 'INVALID_SOURCE_PAYLOAD' });
      continue;
    }
    qboParsed.set(parsed.sourceId, parsed);
    const key = matchingKey(parsed.name, parsed.address.zip);
    if (key !== null) qboGroups.set(key, [...(qboGroups.get(key) ?? []), parsed.sourceId]);
  }

  const resolveTerminal = (sourceId: string): string => {
    const visited = new Set<string>();
    let current = sourceId;
    for (let depth = 0; depth <= MAX_MERGE_DEPTH; depth += 1) {
      if (visited.has(current)) throw new Error('MERGE_CYCLE');
      visited.add(current);
      const currentRecord = stParsed.get(current);
      if (!currentRecord) throw new Error('MERGE_TARGET_NOT_FOUND');
      if (currentRecord.mergedToId === null) return current;
      if (depth === MAX_MERGE_DEPTH) throw new Error('MERGE_DEPTH_EXCEEDED');
      current = currentRecord.mergedToId;
    }
    throw new Error('MERGE_DEPTH_EXCEEDED');
  };

  const terminals = new Map<string, string>();
  for (const parsed of stParsed.values()) {
    if (parsed.mergedToId !== null) {
      try {
        terminals.set(parsed.sourceId, resolveTerminal(parsed.sourceId));
      } catch (error) {
        const reason = error instanceof Error && (
          error.message === 'MERGE_CYCLE' ||
          error.message === 'MERGE_DEPTH_EXCEEDED' ||
          error.message === 'MERGE_TARGET_NOT_FOUND'
        ) ? error.message as CustomerIdentityIssue['reason'] : 'MERGE_TARGET_NOT_FOUND';
        throw new Error(reason, { cause: error });
      }
    }
  }

  const plans: CustomerIdentityPlan[] = [];
  let tierAVerifiedMatches = 0;
  let stOnlyUnresolved = 0;
  let mergedResolved = 0;

  for (const parsed of stParsed.values()) {
    const terminalSourceId = terminals.get(parsed.sourceId) ?? parsed.sourceId;
    if (parsed.mergedToId !== null) {
      plans.push({
        sourceId: parsed.sourceId,
        payload: parsed.payload,
        name: parsed.name,
        kind: 'MERGED',
        qboSourceId: null,
        terminalSourceId,
      });
      mergedResolved += 1;
      continue;
    }

    const key = matchingKey(parsed.name, parsed.address.zip);
    const stIds = key === null ? [] : stGroups.get(key) ?? [];
    const qboIds = key === null ? [] : qboGroups.get(key) ?? [];
    const qboCandidate = stIds.length === 1 && qboIds.length === 1 ? qboParsed.get(qboIds[0]) : undefined;
    const isTierA = qboCandidate !== undefined && sameRequiredAddress(parsed.address, qboCandidate.address);
    if (isTierA) {
      plans.push({
        sourceId: parsed.sourceId,
        payload: parsed.payload,
        name: parsed.name,
        kind: 'TIER_A',
        qboSourceId: qboCandidate.sourceId,
        terminalSourceId,
      });
      tierAVerifiedMatches += 1;
    } else {
      plans.push({
        sourceId: parsed.sourceId,
        payload: parsed.payload,
        name: parsed.name,
        kind: 'ST_ONLY',
        qboSourceId: null,
        terminalSourceId,
      });
      stOnlyUnresolved += 1;
    }
  }

  return {
    evaluated: stParsed.size,
    tierAVerifiedMatches,
    stOnlyUnresolved,
    mergedResolved,
    plans,
    issues,
  };
};
