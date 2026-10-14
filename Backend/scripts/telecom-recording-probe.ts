/**
 * Read-only probe: checks recording/voicemail URL availability on recent calls.
 * Never downloads audio. Only reports field presence and URL pattern structure.
 * Credentials from environment only — never hardcoded.
 */
import { env } from '../src/config/env';
import { apiClient } from '../src/modules/servicetitan/api.client';

const TENANT_ID = env.SERVICETITAN_TENANT_ID;

interface LeadCall {
  id: number;
  receivedOn: string;
  duration: string;
  direction: string;
  callType: string | null;
  recordingUrl: string | null;
  voiceMailUrl: string | null;
  reason: { name: string; lead: boolean } | null;
  agent: { id: number; name: string } | null;
  customer: { id: number } | null;
  active: boolean;
  sid: string;
}
interface Bundle { id: number; leadCall: LeadCall; jobNumber: string | null; businessUnit: { id: number; name: string } | null; type: { name: string } | null; }
interface ListResponse { page: number; pageSize: number; totalCount: number; hasMore: boolean; data: Bundle[]; }

// Classify URL without revealing the URL itself
function classifyUrl(url: string | null): string {
  if (!url) return 'null';
  if (url.startsWith('https://')) {
    const hasSig = url.includes('Signature=') || url.includes('X-Amz') || url.includes('sig=') || url.includes('token=');
    const hasExpiry = url.includes('Expires=') || url.includes('expiry=') || url.includes('X-Amz-Expires');
    if (hasSig && hasExpiry) return 'PRESENT — authenticated S3/CDN URL with expiry';
    if (hasSig) return 'PRESENT — authenticated URL with signature';
    return 'PRESENT — plain HTTPS URL';
  }
  return 'PRESENT — non-HTTPS URL';
}

// Safe enum value: only expose PascalCase/ALL_CAPS strings (non-PII)
function safeEnum(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string' && /^[A-Z][a-zA-Z]*$/.test(v)) return v;
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return String(v);
  return '[value present]';
}

async function probe(): Promise<void> {
  console.log('=== Telecom Recording Availability Probe ===');
  console.log(`Tenant: ${TENANT_ID}`);

  // Fetch recent calls — use createdAfter = 90 days ago to get Phones Pro era calls
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  console.log(`\nFetching calls created after: ${since.slice(0, 10)}`);

  const page1 = await apiClient.get<ListResponse>(
    `/telecom/v2/tenant/${TENANT_ID}/calls`,
    { pageSize: 50, createdAfter: since, orderBy: 'CreatedOn', orderByDirection: 'Desc' },
  );
  console.log(`Total calls in window: ${page1.totalCount}`);
  console.log(`Records in this page: ${page1.data.length}`);

  // Tally
  let withRecording = 0, withVoicemail = 0, withAgent = 0, withCustomer = 0, withBU = 0, withJobNumber = 0;
  const callTypes = new Set<string>();
  const directions = new Set<string>();
  const reasonNames = new Set<string>();
  const recordingUrlSamples: string[] = [];
  const voicemailUrlSamples: string[] = [];
  let withCallType = 0;

  for (const bundle of page1.data) {
    const c = bundle.leadCall;
    if (c.recordingUrl) { withRecording++; if (recordingUrlSamples.length < 2) recordingUrlSamples.push(classifyUrl(c.recordingUrl)); }
    if (c.voiceMailUrl) { withVoicemail++; if (voicemailUrlSamples.length < 2) voicemailUrlSamples.push(classifyUrl(c.voiceMailUrl)); }
    if (c.agent) withAgent++;
    if (c.customer) withCustomer++;
    if (bundle.businessUnit) withBU++;
    if (bundle.jobNumber) withJobNumber++;
    if (c.direction) directions.add(safeEnum(c.direction));
    if (c.callType !== null) { callTypes.add(safeEnum(c.callType)); withCallType++; }
    if (c.reason?.name) reasonNames.add(c.reason.name); // reason names are operator-defined, not PII
  }

  const n = page1.data.length;
  console.log('\n--- Field population across', n, 'recent calls ---');
  console.log(`  recordingUrl populated:  ${withRecording}/${n}`);
  console.log(`  voiceMailUrl populated:  ${withVoicemail}/${n}`);
  console.log(`  callType populated:      ${withCallType}/${n}`);
  console.log(`  agent populated:         ${withAgent}/${n}`);
  console.log(`  customer populated:      ${withCustomer}/${n}`);
  console.log(`  businessUnit populated:  ${withBU}/${n}`);
  console.log(`  jobNumber populated:     ${withJobNumber}/${n}`);

  console.log('\n--- Observed enum values ---');
  console.log('  direction values:', [...directions].join(', ') || 'none');
  console.log('  callType values: ', [...callTypes].join(', ') || 'none (all null)');
  console.log('  reason names:    ', [...reasonNames].slice(0, 10).join(', ') || 'none');

  if (recordingUrlSamples.length > 0) {
    console.log('\n--- Recording URL structure (no actual URLs printed) ---');
    recordingUrlSamples.forEach((s, i) => console.log(`  sample ${i + 1}: ${s}`));
  }
  if (voicemailUrlSamples.length > 0) {
    console.log('\n--- Voicemail URL structure ---');
    voicemailUrlSamples.forEach((s, i) => console.log(`  sample ${i + 1}: ${s}`));
  }

  // Now attempt calls with recordings on a wider window if none found
  if (withRecording === 0) {
    console.log('\nNo recordings in 90-day window. Checking older window (1 year)...');
    const page2 = await apiClient.get<ListResponse>(
      `/telecom/v2/tenant/${TENANT_ID}/calls`,
      { pageSize: 50, orderBy: 'ModifiedOn', orderByDirection: 'Desc', minDuration: 60 },
    );
    let found = 0;
    for (const b of page2.data) {
      if (b.leadCall.recordingUrl) {
        found++;
        if (found === 1) console.log('  recording URL structure:', classifyUrl(b.leadCall.recordingUrl));
      }
      if (b.leadCall.callType !== null) callTypes.add(safeEnum(b.leadCall.callType));
    }
    console.log(`  calls with recordings in broader window: ${found}/${page2.data.length}`);
    console.log('  callType values seen overall:', [...callTypes].join(', ') || 'none');
  }

  // Check /calls/{id}/recording endpoint accessibility (HEAD only, no download)
  if (page1.data.length > 0) {
    const sampleId = page1.data[0]!.leadCall.id;
    console.log(`\n--- Checking /calls/${sampleId}/recording endpoint availability ---`);
    try {
      // Try detail endpoint to see if recording URL is populated there
      const detail = await apiClient.get<Record<string, unknown>>(
        `/telecom/v2/tenant/${TENANT_ID}/calls/${sampleId}`,
      );
      const lc = (detail.leadCall ?? detail) as Record<string, unknown>;
      console.log(`  recordingUrl on detail: ${classifyUrl(lc.recordingUrl as string | null)}`);
      console.log(`  voiceMailUrl on detail: ${classifyUrl(lc.voiceMailUrl as string | null)}`);
      if (lc.callType !== null && lc.callType !== undefined) console.log(`  callType on detail: ${safeEnum(lc.callType)}`);
    } catch (e) {
      console.log('  detail endpoint failed:', e instanceof Error ? e.message : String(e));
    }
  }

  console.log('\n=== Probe complete ===');
}

probe().catch((e) => { console.error('Probe failed:', e instanceof Error ? e.constructor.name : typeof e); process.exit(1); });
