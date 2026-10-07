import { describe, expect, it, jest } from '@jest/globals';
import { printFailure, printResult, runControlledClassifierTest } from '../../src/scripts/google-gmail-classifier-test';
import { EmailClassifierError } from '../../src/modules/google/anthropic-email-classifier';
import { ClassificationPersistenceError } from '../../src/modules/google/classification.repository';

const authorization = (message: Record<string, unknown>) => ({
  subject: 'service@trufinity.ca',
  scope: 'https://www.googleapis.com/auth/gmail.readonly',
  mailbox: { normalizedAddress: 'service@trufinity.ca', contentMode: 'CONTENT' },
  client: { users: { messages: {
    list: jest.fn(async () => ({ data: { messages: [{ id: 'm1' }] } })),
    get: jest.fn(async () => ({ data: message })),
  } } },
} as any);

const inboundMessage = (labels = ['INBOX']) => ({
  id: 'm1', threadId: 't1', labelIds: labels, internalDate: '123456789', historyId: 'h1',
  payload: { headers: [{ name: 'From', value: 'external@example.com' }, { name: 'Subject', value: 'Synthetic subject' }], mimeType: 'text/plain', body: { data: Buffer.from('Synthetic body').toString('base64url') } },
});

describe('controlled Gmail classifier runner', () => {
  it('fetches and classifies at most one message without checkpoint/raw repository access', async () => {
    const auth = authorization(inboundMessage());
    const classifier = { classify: jest.fn(async () => ({ label: 'complaint' as const, confidence: 0.9, reason: 'Synthetic reason.' })) };
    const repository = { hasClassification: jest.fn(async () => false), persist: jest.fn(async () => ({ id: 'c1', workItemId: 'w1', duplicate: false })) };
    const result = await runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => auth }, classifier as any, repository);
    expect(result).toMatchObject({ messageId: 'm1', label: 'complaint', decisionStatus: 'ESCALATION', newlyPersisted: true, workItemExists: true });
    expect(auth.client.users.messages.list).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 25, includeSpamTrash: false }));
    expect((auth.client.users.messages.get as jest.Mock).mock.calls.filter(([options]) => (options as any).format === 'full')).toHaveLength(1);
    expect(classifier.classify).toHaveBeenCalledTimes(1);
    expect(repository.persist).toHaveBeenCalledTimes(1);
  });

  it.each(['careers@trufinity.ca', 'other@trufinity.ca'])('rejects non-approved CONTENT mailbox %s', async (mailbox) => {
    await expect(runControlledClassifierTest(mailbox, { getGmailAuthorization: jest.fn() } as any, {} as any, {} as any)).rejects.toThrow('approved Gmail CONTENT');
  });

  it('rejects metadata access even if the mailbox is otherwise known', async () => {
    await expect(runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => { throw new Error('should not authorize'); } }, {} as any, {} as any)).rejects.toThrow();
  });

  it.each([['service@trufinity.ca'], ['support@trufinity.ca'], ['billing@trufinity.ca']])('accepts approved mailbox %s', async (mailbox) => {
    const auth = authorization(inboundMessage());
    auth.subject = mailbox;
    auth.mailbox.normalizedAddress = mailbox;
    const repository = { hasClassification: jest.fn(async () => false), persist: jest.fn(async () => ({ id: 'c1', workItemId: null, duplicate: true })) };
    const result = await runControlledClassifierTest(mailbox, { getGmailAuthorization: () => auth }, { classify: jest.fn(async () => ({ label: 'none' as const, confidence: 0.2, reason: 'Synthetic reason.' })) } as any, repository);
    expect(result.newlyPersisted).toBe(false);
    expect(result.workItemExists).toBe(false);
  });

  it('does not classify outbound, draft, spam, or trash candidates', async () => {
    for (const [labels, from] of [[['INBOX'], 'service@trufinity.ca'], [['DRAFT'], 'external@example.com'], [['SPAM'], 'external@example.com'], [['TRASH'], 'external@example.com']] as const) {
      const auth = authorization({ ...inboundMessage([...labels]), payload: { headers: [{ name: 'From', value: from }], mimeType: 'text/plain', body: { data: Buffer.from('Synthetic body').toString('base64url') } } });
      const classifier = { classify: jest.fn() };
      const repository = { hasClassification: jest.fn(async () => false), persist: jest.fn() };
      const result = await runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => auth }, classifier as any, repository as any);
      expect(result.label).toBeNull();
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(repository.persist).not.toHaveBeenCalled();
    }
  });

  it('supports REVIEW_REQUIRED and idempotent reruns', async () => {
    const auth = authorization(inboundMessage());
    const classifier = { classify: jest.fn(async () => ({ label: 'billing_dispute' as const, confidence: 0.2, reason: 'Synthetic reason.' })) };
    const repository = { hasClassification: jest.fn(async () => false), persist: jest.fn(async () => ({ id: 'c1', workItemId: 'w1', duplicate: true })) };
    const result = await runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => auth }, classifier as any, repository);
    expect(result.decisionStatus).toBe('REVIEW_REQUIRED');
    expect(result.newlyPersisted).toBe(false);
    expect(result.workItemExists).toBe(true);
  });


  it('skips the already-classified newest message and selects the next eligible message', async () => {
    const auth = authorization(inboundMessage());
    const list = auth.client.users.messages.list as jest.Mock;
    const get = auth.client.users.messages.get as jest.Mock;
    list.mockImplementation(async ({ pageToken }: any) => pageToken ? ({ data: { messages: [{ id: 'm2' }] } }) : ({ data: { messages: [{ id: 'm1' }], nextPageToken: 'next' } }));
    get.mockImplementation(async ({ id }: any) => ({ data: { ...inboundMessage(), id } }));
    const classifier = { classify: jest.fn(async () => ({ label: 'complaint' as const, confidence: 0.9, reason: 'Synthetic reason.' })) };
    const repository = { hasClassification: jest.fn(async ({ providerMessageId }: { providerMessageId: string }) => providerMessageId === 'm1'), persist: jest.fn(async () => ({ id: 'c2', workItemId: null, duplicate: false })) };
    const result = await runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => auth }, classifier as any, repository);
    expect(result.messageId).toBe('m2');
    expect(repository.hasClassification).toHaveBeenCalledWith(expect.objectContaining({ providerMessageId: 'm1' }));
    expect(classifier.classify).toHaveBeenCalledTimes(1);
    expect((get as jest.Mock).mock.calls.filter(([options]) => (options as any).format === 'full')).toHaveLength(1);
  });

  it('makes zero classifier calls when all eligible messages are already classified', async () => {
    const auth = authorization(inboundMessage());
    (auth.client.users.messages.list as any).mockResolvedValue({ data: { messages: [{ id: 'm1' }, { id: 'm2' }] } });
    (auth.client.users.messages.get as any).mockImplementation(async ({ id }: { id: string }) => ({ data: { ...inboundMessage(), id } }));
    const classifier = { classify: jest.fn() };
    const repository = { hasClassification: jest.fn(async () => true), persist: jest.fn(async () => ({ id: 'unused', workItemId: null, duplicate: true })) };
    const result = await runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => auth }, classifier as any, repository);
    expect(result.messageId).toBeNull();
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(repository.persist).not.toHaveBeenCalled();
    expect((auth.client.users.messages.get as jest.Mock).mock.calls.every(([options]) => (options as any).format === 'metadata')).toBe(true);
  });



  it('bounds metadata candidate scanning at twenty messages', async () => {
    const auth = authorization(inboundMessage());
    (auth.client.users.messages.list as any).mockResolvedValue({ data: { messages: Array.from({ length: 25 }, (_, index) => ({ id: `m${index}` })) } });
    (auth.client.users.messages.get as any).mockImplementation(async ({ id }: any) => ({ data: { ...inboundMessage(), id } }));
    const classifier = { classify: jest.fn() };
    const repository = { hasClassification: jest.fn(async () => true), persist: jest.fn(async () => ({ id: 'unused', workItemId: null, duplicate: true })) };
    const result = await runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => auth }, classifier as any, repository);
    expect(result.skippedAlreadyClassified).toBe(20);
    expect((auth.client.users.messages.get as any).mock.calls).toHaveLength(20);
    expect(classifier.classify).not.toHaveBeenCalled();
  });



  it('skips deleted candidates and classifies only a later valid candidate', async () => {
    const auth = authorization(inboundMessage());
    (auth.client.users.messages.list as any).mockImplementation(async ({ pageToken }: any) => pageToken ? ({ data: { messages: [{ id: 'valid' }] } }) : ({ data: { messages: [{ id: 'deleted' }], nextPageToken: 'next' } }));
    (auth.client.users.messages.get as any).mockImplementation(async ({ id }: any) => ({ data: { ...inboundMessage(id === 'deleted' ? ['INBOX', 'DELETED'] : ['INBOX']), id } }));
    const classifier = { classify: jest.fn(async () => ({ label: 'complaint' as const, confidence: 0.9, reason: 'Synthetic reason.' })) };
    const repository = { hasClassification: jest.fn(async () => false), persist: jest.fn(async () => ({ id: 'valid-result', workItemId: 'valid-work', duplicate: false })) };
    const result = await runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => auth }, classifier as any, repository);
    expect(result.messageId).toBe('valid');
    expect(classifier.classify).toHaveBeenCalledTimes(1);
    expect(repository.persist).toHaveBeenCalledTimes(1);
  });

  it('keeps CLI output free of email content and classifier reason', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    printResult({ mailbox: 'service@trufinity.ca', messageId: 'safe-id', model: 'test-model', label: 'complaint', confidence: 0.9, decisionStatus: 'ESCALATION', newlyPersisted: true, workItemExists: true, skippedAlreadyClassified: 2 });
    const output = log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).not.toContain('Synthetic subject');
    expect(output).not.toContain('Synthetic body');
    expect(output).not.toContain('Synthetic snippet');
    expect(output).not.toContain('<html>');
    expect(output).not.toContain('raw MIME content');
    expect(output).not.toContain('Synthetic reason');
    expect(output).toContain('MAILBOX:');
    expect(output).toContain('MESSAGE ID:');
    log.mockRestore();
  });



  it('reports safe stage diagnostics for every controlled runner boundary', async () => {
    const runAndReport = async (run: () => Promise<unknown>): Promise<string> => {
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      await expect(run()).rejects.toBeDefined();
      try { await run(); } catch (error) { printFailure(error); }
      const output = errorLog.mock.calls.map(([line]) => String(line)).join('\n');
      errorLog.mockRestore();
      return output;
    };
    const baseRepository = { hasClassification: jest.fn(async () => false), persist: jest.fn(async () => ({ id: 'result', workItemId: null, duplicate: false })) };

    await expect(runAndReport(async () => runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => { throw new Error('Synthetic subject Synthetic body'); } } as any, {} as any, baseRepository))).resolves.toContain('FAILED_STAGE=authorization_gmail_list');

    const metadataFailureAuth = authorization(inboundMessage());
    (metadataFailureAuth.client.users.messages.get as any).mockRejectedValue(new Error('Synthetic body'));
    await expect(runAndReport(async () => runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => metadataFailureAuth }, {} as any, baseRepository))).resolves.toContain('FAILED_STAGE=candidate_metadata_fetch');

    const lookupFailureAuth = authorization(inboundMessage());
    const lookupFailureRepository = { hasClassification: jest.fn(async () => { throw new Error('lookup'); }), persist: jest.fn() };
    await expect(runAndReport(async () => runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => lookupFailureAuth }, {} as any, lookupFailureRepository as any))).resolves.toContain('FAILED_STAGE=existing_classification_lookup');

    const fullFailureAuth = authorization(inboundMessage());
    (fullFailureAuth.client.users.messages.get as any).mockImplementation(async ({ format }: any) => format === 'full' ? Promise.reject(new Error('full')) : ({ data: inboundMessage() }));
    await expect(runAndReport(async () => runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => fullFailureAuth }, {} as any, baseRepository))).resolves.toContain('FAILED_STAGE=selected_message_full_fetch');

    const classifierFailureAuth = authorization(inboundMessage());
    await expect(runAndReport(async () => runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => classifierFailureAuth }, { classify: async () => { throw new EmailClassifierError('provider'); } }, baseRepository))).resolves.toContain('FAILED_STAGE=anthropic_classification');

    const decisionFailureAuth = authorization(inboundMessage());
    await expect(runAndReport(async () => runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => decisionFailureAuth }, { classify: async () => ({ label: 'invalid', confidence: 0.9, reason: 'Synthetic reason.' }) } as any, baseRepository))).resolves.toContain('FAILED_STAGE=decision_payload_construction');

    const persistenceFailureAuth = authorization(inboundMessage());
    const persistenceFailureRepository = { hasClassification: jest.fn(async () => false), persist: jest.fn(async () => { throw new Error('persist'); }) };
    await expect(runAndReport(async () => runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => persistenceFailureAuth }, { classify: async () => ({ label: 'none' as const, confidence: 0.9, reason: 'Synthetic reason.' }) }, persistenceFailureRepository))).resolves.toContain('FAILED_STAGE=classification_persistence');

    const workFailureAuth = authorization(inboundMessage());
    const workFailureRepository = { hasClassification: jest.fn(async () => false), persist: jest.fn(async () => { throw new ClassificationPersistenceError('work_item_persistence', { code: '23505', constraint: 'safe_constraint' }); }) };
    const workOutput = await runAndReport(async () => runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => workFailureAuth }, { classify: async () => ({ label: 'complaint' as const, confidence: 0.9, reason: 'Synthetic reason.' }) }, workFailureRepository));
    expect(workOutput).toContain('FAILED_STAGE=work_item_persistence');
    expect(workOutput).toContain('POSTGRES_CODE=23505');
    expect(workOutput).toContain('POSTGRES_CONSTRAINT=safe_constraint');
  });

  it('prints ANTHROPIC_FAILURE=invalid_structured_output for invalid structured output', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = authorization(inboundMessage());
    const badClassifier = { classify: jest.fn(async () => { throw new EmailClassifierError('Email classifier returned invalid structured output.', 'invalid_structured_output'); }) };
    try { await runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => auth }, badClassifier as any, { hasClassification: jest.fn(async () => false), persist: jest.fn() } as any); } catch (error) { printFailure(error); }
    const output = errorLog.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('FAILED_STAGE=anthropic_classification');
    expect(output).toContain('ERROR_CLASS=EmailClassifierError');
    expect(output).toContain('ANTHROPIC_FAILURE=invalid_structured_output');
    expect(output).not.toContain('ANTHROPIC_STATUS');
    errorLog.mockRestore();
  });

  it('prints ANTHROPIC_FAILURE=provider_rate_limit and ANTHROPIC_STATUS=429 for rate limit', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = authorization(inboundMessage());
    const rateLimitClassifier = { classify: jest.fn(async () => { throw new EmailClassifierError('Email classifier provider request failed.', 'provider_rate_limit', 429); }) };
    try { await runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => auth }, rateLimitClassifier as any, { hasClassification: jest.fn(async () => false), persist: jest.fn() } as any); } catch (error) { printFailure(error); }
    const output = errorLog.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('ANTHROPIC_FAILURE=provider_rate_limit');
    expect(output).toContain('ANTHROPIC_STATUS=429');
    errorLog.mockRestore();
  });

  it('prints ANTHROPIC_FAILURE=provider_auth_error and ANTHROPIC_STATUS for 401', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = authorization(inboundMessage());
    const authErrClassifier = { classify: jest.fn(async () => { throw new EmailClassifierError('Email classifier provider request failed.', 'provider_auth_error', 401); }) };
    try { await runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => auth }, authErrClassifier as any, { hasClassification: jest.fn(async () => false), persist: jest.fn() } as any); } catch (error) { printFailure(error); }
    const output = errorLog.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('ANTHROPIC_FAILURE=provider_auth_error');
    expect(output).toContain('ANTHROPIC_STATUS=401');
    errorLog.mockRestore();
  });

  it('prints ANTHROPIC_FAILURE=provider_unknown with no ANTHROPIC_STATUS for unknown error', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = authorization(inboundMessage());
    const unknownClassifier = { classify: jest.fn(async () => { throw new EmailClassifierError('Email classifier provider request failed.', 'provider_unknown', null); }) };
    try { await runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => auth }, unknownClassifier as any, { hasClassification: jest.fn(async () => false), persist: jest.fn() } as any); } catch (error) { printFailure(error); }
    const output = errorLog.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('ANTHROPIC_FAILURE=provider_unknown');
    expect(output).not.toContain('ANTHROPIC_STATUS');
    errorLog.mockRestore();
  });

  it('ANTHROPIC_FAILURE output never contains raw error message, Claude response, or Gmail content', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = authorization(inboundMessage());
    // Simulate a classifier that internally sees content but only leaks category
    const leakyClassifier = { classify: jest.fn(async () => {
      const raw = new EmailClassifierError('Email classifier returned invalid structured output.', 'invalid_structured_output');
      Object.defineProperty(raw, 'rawResponse', { value: 'SECRET CLAUDE TEXT Synthetic subject' });
      throw raw;
    }) };
    try { await runControlledClassifierTest('service@trufinity.ca', { getGmailAuthorization: () => auth }, leakyClassifier as any, { hasClassification: jest.fn(async () => false), persist: jest.fn() } as any); } catch (error) { printFailure(error); }
    const output = errorLog.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).not.toContain('SECRET CLAUDE TEXT');
    expect(output).not.toContain('Synthetic subject');
    expect(output).toContain('ANTHROPIC_FAILURE=invalid_structured_output');
    errorLog.mockRestore();
  });

  it('does not leak email content or classifier reason through failure output', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = { getGmailAuthorization: () => { throw new Error('Synthetic subject Synthetic body Synthetic snippet <html> raw MIME content Synthetic reason.'); } };
    try { await runControlledClassifierTest('service@trufinity.ca', auth as any, {} as any, {} as any); } catch (error) { printFailure(error); }
    const output = errorLog.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).not.toContain('Synthetic subject');
    expect(output).not.toContain('Synthetic body');
    expect(output).not.toContain('Synthetic snippet');
    expect(output).not.toContain('<html>');
    expect(output).not.toContain('raw MIME content');
    expect(output).not.toContain('Synthetic reason');
    expect(output).toContain('FAILED_STAGE=authorization_gmail_list');
    errorLog.mockRestore();
  });

});
