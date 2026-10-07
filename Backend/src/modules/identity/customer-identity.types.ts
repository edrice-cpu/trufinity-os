export interface IdentityRawCustomerRecord {
  sourceId: string;
  payload: unknown;
  isDeleted: boolean;
}

export type CustomerIdentityIssueReason =
  | 'INVALID_SOURCE_PAYLOAD'
  | 'INVALID_MERGED_TO_ID'
  | 'MERGE_TARGET_NOT_FOUND'
  | 'MERGE_CYCLE'
  | 'MERGE_DEPTH_EXCEEDED'
  | 'QBO_IDENTITY_NOT_FOUND'
  | 'EXISTING_VERIFIED_MAPPING_CONFLICT'
  | 'IDENTITY_REMAP_UNSAFE';

export interface CustomerIdentityIssue {
  sourceId: string | null;
  reason: CustomerIdentityIssueReason;
}

export interface CustomerIdentityPlan {
  sourceId: string;
  payload: Record<string, unknown>;
  name: string | null;
  kind: 'TIER_A' | 'ST_ONLY' | 'MERGED';
  qboSourceId: string | null;
  terminalSourceId: string;
}

export interface CustomerIdentityAnalysis {
  evaluated: number;
  tierAVerifiedMatches: number;
  stOnlyUnresolved: number;
  mergedResolved: number;
  plans: CustomerIdentityPlan[];
  issues: CustomerIdentityIssue[];
}

export interface CustomerIdentityRunResult {
  evaluated: number;
  tierAVerifiedMatches: number;
  stOnlyUnresolved: number;
  mergedResolved: number;
  skipped: number;
  conflicts: number;
  issues: CustomerIdentityIssue[];
}

export interface CustomerIdentityRepository {
  acquireLocks(): Promise<(() => Promise<void>) | null>;
  recoverStaleRuns(): Promise<void>;
  createRun(): Promise<string>;
  loadLatestCustomers(sourceSystem: 'ServiceTitan' | 'QuickBooks'): Promise<IdentityRawCustomerRecord[]>;
  persist(runId: string, analysis: CustomerIdentityAnalysis): Promise<CustomerIdentityRunResult>;
  completeRun(runId: string, recordsProcessed: number): Promise<void>;
  failRun(runId: string, safeMessage: string, recordsProcessed: number): Promise<void>;
}

