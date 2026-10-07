import {
  GMAIL_METADATA_SCOPE,
  GMAIL_READONLY_SCOPE,
  googleWorkspaceAuthService,
  type GmailAuthorizationContext,
} from '../modules/google/google-auth.service';

const GMAIL_SMOKE_TEST_TARGETS = [
  {
    mailboxAddress: 'careers@trufinity.ca',
    expectedContentMode: 'METADATA',
    expectedScope: GMAIL_METADATA_SCOPE,
  },
  {
    mailboxAddress: 'service@trufinity.ca',
    expectedContentMode: 'CONTENT',
    expectedScope: GMAIL_READONLY_SCOPE,
  },
  {
    mailboxAddress: 'support@trufinity.ca',
    expectedContentMode: 'CONTENT',
    expectedScope: GMAIL_READONLY_SCOPE,
  },
  {
    mailboxAddress: 'billing@trufinity.ca',
    expectedContentMode: 'CONTENT',
    expectedScope: GMAIL_READONLY_SCOPE,
  },
] as const;

type GmailAuthorizationService = Pick<typeof googleWorkspaceAuthService, 'getGmailAuthorization'>;

type GmailSmokeTestTarget = (typeof GMAIL_SMOKE_TEST_TARGETS)[number];

export interface GmailSmokeTestResult {
  mailboxAddress: string;
  expectedContentMode: 'METADATA' | 'CONTENT';
  expectedScope: typeof GMAIL_METADATA_SCOPE | typeof GMAIL_READONLY_SCOPE;
  passed: boolean;
}

function hasExpectedAuthorization(
  authorization: GmailAuthorizationContext,
  target: GmailSmokeTestTarget,
): boolean {
  return authorization.subject === target.mailboxAddress
    && authorization.mailbox.contentMode === target.expectedContentMode
    && authorization.scope === target.expectedScope;
}

async function verifyMailbox(
  target: GmailSmokeTestTarget,
  authService: GmailAuthorizationService,
): Promise<GmailSmokeTestResult> {
  try {
    const authorization = authService.getGmailAuthorization(target.mailboxAddress);
    if (!hasExpectedAuthorization(authorization, target)) throw new Error('Unexpected Gmail authorization mode.');

    const listed = await authorization.client.users.messages.list({
      userId: 'me',
      maxResults: 1,
      includeSpamTrash: false,
    });
    const messageId = listed.data.messages?.[0]?.id;
    if (typeof messageId === 'string') {
      await authorization.client.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'metadata',
      });
    }
    return {
      mailboxAddress: target.mailboxAddress,
      expectedContentMode: target.expectedContentMode,
      expectedScope: target.expectedScope,
      passed: true,
    };
  } catch {
    return {
      mailboxAddress: target.mailboxAddress,
      expectedContentMode: target.expectedContentMode,
      expectedScope: target.expectedScope,
      passed: false,
    };
  }
}

export async function runGoogleGmailSmokeTest(
  authService: GmailAuthorizationService = googleWorkspaceAuthService,
): Promise<GmailSmokeTestResult[]> {
  return Promise.all(GMAIL_SMOKE_TEST_TARGETS.map(async (target) => verifyMailbox(target, authService)));
}

export function formatGmailSmokeTestResult(result: GmailSmokeTestResult): string {
  return `${result.mailboxAddress} | ${result.expectedContentMode} | ${result.expectedScope} | ${result.passed ? 'PASS' : 'FAIL'}`;
}

async function main(): Promise<void> {
  const results = await runGoogleGmailSmokeTest();
  for (const result of results) console.log(formatGmailSmokeTestResult(result));
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}

if (require.main === module) void main();