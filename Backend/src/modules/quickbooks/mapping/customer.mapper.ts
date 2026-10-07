import type { ParsedSource, QboCustomerProjection, RawQboRecord } from './mapping.types';
import { compactQboNamespace, mappingIssue, validateRawSource } from './mapping.helpers';

const CUSTOMER_QBO_FIELDS = [
  'CompanyName',
  'FullyQualifiedName',
  'PrintOnCheckName',
  'Active',
  'Taxable',
  'CurrencyRef',
  'PreferredDeliveryMethod',
  'PrimaryPhone',
  'PrimaryEmailAddr',
  'BillAddr',
  'ShipAddr',
  'Balance',
  'BalanceWithJobs',
  'Job',
  'BillWithParent',
] as const;

export const mapQboCustomer = (
  raw: RawQboRecord,
): ParsedSource<QboCustomerProjection> => {
  const source = validateRawSource(raw, 'Customer');
  if (source.kind === 'deleted') return { kind: 'deleted', sourceId: source.sourceId };
  if (source.kind === 'skipped') return source;

  const displayName = source.payload.DisplayName;
  if (displayName !== undefined && displayName !== null && typeof displayName !== 'string') {
    return {
      kind: 'skipped',
      issue: mappingIssue('Customer', source.sourceId, 'INVALID_DISPLAY_NAME'),
    };
  }
  return {
    kind: 'mapped',
    value: {
      sourceId: source.sourceId,
      name: typeof displayName === 'string' ? displayName : null,
      sourceSpecificData: compactQboNamespace(source.payload, CUSTOMER_QBO_FIELDS),
    },
  };
};
