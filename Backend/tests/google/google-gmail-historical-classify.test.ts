import { describe, expect, it, jest } from '@jest/globals';
import {
  parseArgs,
  runDryRun,
  runClassify,
  emptyProgress,
  type HistoricalClassifyArgs,
  type HistoricalClassifyDeps,
} from '../../src/scripts/google-gmail-historical-classify';

const validDryRunArgs = [
  '--mailbox', 'service@trufinity.ca',
  '--from', '2026-07-01', '--to', '2026-09-01',
  '--dry-run', '--batch-limit', '25', '--max-calls', '10', '--delay-ms', '100',
];

describe('historical classify CLI', () => {
  describe('parseArgs', () => {
    it('parses valid arguments', () => {
      const args = parseArgs(validDryRunArgs);
      expect(args.mailbox).toBe('service@trufinity.ca');
      expect(args.dryRun).toBe(true);
      expect(args.batchLimit).toBe(25);
      expect(args.maxCalls).toBe(10);
      expect(args.delayMs).toBe(100);
    });

    it('rejects non-approved mailbox', () => {
      expect(() => parseArgs(['--mailbox', 'aaron@trufinity.ca', '--from', '2026-07-01', '--to', '2026-09-01'])).toThrow('not an approved');
    });

    it('rejects arbitrary external mailbox', () => {
      expect(() => parseArgs(['--mailbox', 'attacker@evil.com', '--from', '2026-07-01', '--to', '2026-09-01'])).toThrow('not an approved');
    });

    it('rejects missing --mailbox', () => {
      expect(() => parseArgs(['--from', '2026-07-01', '--to', '2026-09-01'])).toThrow('--mailbox is required');
    });

    it('rejects missing --from', () => {
      expect(() => parseArgs(['--mailbox', 'service@trufinity.ca', '--to', '2026-09-01'])).toThrow('--from and --to');
    });

    it('rejects missing --to', () => {
      expect(() => parseArgs(['--mailbox', 'service@trufinity.ca', '--from', '2026-07-01'])).toThrow('--from and --to');
    });

    it('rejects invalid --from date', () => {
      expect(() => parseArgs(['--mailbox', 'service@trufinity.ca', '--from', 'bad', '--to', '2026-09-01'])).toThrow('Invalid --from');
    });

    it('rejects invalid --to date', () => {
      expect(() => parseArgs(['--mailbox', 'service@trufinity.ca', '--from', '2026-07-01', '--to', 'bad'])).toThrow('Invalid --to');
    });

    it('rejects from >= to', () => {
      expect(() => parseArgs(['--mailbox', 'service@trufinity.ca', '--from', '2026-09-01', '--to', '2026-07-01'])).toThrow('--from must be before');
    });

    it('rejects same from and to', () => {
      expect(() => parseArgs(['--mailbox', 'service@trufinity.ca', '--from', '2026-09-01', '--to', '2026-09-01'])).toThrow('--from must be before');
    });

    it('rejects range exceeding 90 days', () => {
      expect(() => parseArgs(['--mailbox', 'service@trufinity.ca', '--from', '2026-01-01', '--to', '2026-06-01'])).toThrow('exceeds 90 days');
    });

    it('rejects future --to', () => {
      const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      expect(() => parseArgs(['--mailbox', 'service@trufinity.ca', '--from', '2026-09-01', '--to', future])).toThrow('future');
    });

    it('rejects batch-limit exceeding hard cap', () => {
      expect(() => parseArgs(['--mailbox', 'service@trufinity.ca', '--from', '2026-07-01', '--to', '2026-09-01', '--batch-limit', '9999'])).toThrow('--batch-limit');
    });

    it('rejects batch-limit of zero', () => {
      expect(() => parseArgs(['--mailbox', 'service@trufinity.ca', '--from', '2026-07-01', '--to', '2026-09-01', '--batch-limit', '0'])).toThrow('--batch-limit');
    });

    it('rejects max-calls exceeding hard cap', () => {
      expect(() => parseArgs(['--mailbox', 'service@trufinity.ca', '--from', '2026-07-01', '--to', '2026-09-01', '--max-calls', '9999'])).toThrow('--max-calls');
    });

    it('rejects negative delay-ms', () => {
      expect(() => parseArgs(['--mailbox', 'service@trufinity.ca', '--from', '2026-07-01', '--to', '2026-09-01', '--delay-ms', '-1'])).toThrow('--delay-ms');
    });

    it('accepts all three approved mailboxes', () => {
      for (const mb of ['service@trufinity.ca', 'support@trufinity.ca', 'billing@trufinity.ca']) {
        expect(parseArgs(['--mailbox', mb, '--from', '2026-07-01', '--to', '2026-09-01']).mailbox).toBe(mb);
      }
    });

    it('defaults batch-limit and max-calls when not provided', () => {
      const args = parseArgs(['--mailbox', 'service@trufinity.ca', '--from', '2026-07-01', '--to', '2026-09-01']);
      expect(args.batchLimit).toBe(500);
      expect(args.maxCalls).toBe(500);
      expect(args.delayMs).toBe(200);
      expect(args.dryRun).toBe(false);
    });
  });

  describe('runDryRun', () => {
    it('returns eligible count with zero classifier calls and zero writes', async () => {
      const mockFirst = jest.fn(async () => ({ id: 'mbx-1' }));
      const mockWhere = jest.fn(() => ({ first: mockFirst }));
      const mockSelect = jest.fn(() => ({ where: mockWhere }));
      const mockTable = jest.fn((table: string) => {
        if (table === 'google_gmail_mailboxes') return { select: mockSelect };
        return {};
      });
      const fakeDb = Object.assign(mockTable, {
        raw: jest.fn(async () => ({ rows: [
          { provider_message_id: 'm1', mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-01') },
          { provider_message_id: 'm2', mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-02') },
        ] })),
      }) as any;

      const args: HistoricalClassifyArgs = {
        mailbox: 'service@trufinity.ca', from: new Date('2026-07-01'), to: new Date('2026-09-01'),
        dryRun: true, batchLimit: 25, maxCalls: 10, delayMs: 100,
      };

      const progress = await runDryRun(args, fakeDb);
      expect(progress.eligible).toBe(2);
      expect(progress.attempted).toBe(0);
      expect(progress.succeeded).toBe(0);
      expect(progress.failed).toBe(0);
      expect(progress.inputTokens).toBe(0);
      expect(progress.outputTokens).toBe(0);
      expect(progress.gmailFetchAttempts).toBe(0);
      expect(progress.notificationsSent).toBe(0);
    });
  });

  describe('runClassify', () => {
    function makeDeps(overrides: Partial<HistoricalClassifyDeps> = {}): HistoricalClassifyDeps {
      return {
        database: Object.assign(jest.fn((table: string) => {
          if (table === 'google_gmail_mailboxes') return {
            select: jest.fn(() => ({ where: jest.fn(() => ({ first: jest.fn(async () => ({ id: 'mbx-1' })) })) })),
          };
          return {};
        }), {
          raw: jest.fn(async () => ({ rows: [] as any[] })),
        }) as any,
        authService: {
          getGmailAuthorization: jest.fn(() => ({
            mailbox: { normalizedAddress: 'service@trufinity.ca', contentMode: 'CONTENT' },
            subject: 'service@trufinity.ca',
            scope: 'https://www.googleapis.com/auth/gmail.readonly',
            client: {
              users: {
                messages: {
                  get: jest.fn(async () => ({
                    data: {
                      id: 'm1', threadId: 't1', labelIds: ['INBOX'],
                      internalDate: String(new Date('2026-08-01').getTime()),
                      payload: {
                        mimeType: 'text/plain',
                        headers: [
                          { name: 'From', value: 'customer@example.com' },
                          { name: 'Subject', value: 'Test subject' },
                        ],
                        body: { data: Buffer.from('Test body').toString('base64url') },
                      },
                    },
                  })),
                },
              },
            },
          })) as any,
        },
        classifier: {
          classify: jest.fn(async () => ({ label: 'complaint' as const, confidence: 0.9, reason: 'Synthetic reason.' })),
        },
        repository: {
          persist: jest.fn(async () => ({ id: 'cls-1', workItemId: 'wi-1', duplicate: false })),
        } as any,
        notifier: {
          sendNotification: jest.fn(async () => true),
          hasNotificationBeenSent: jest.fn(async () => false),
        },
        waitFn: jest.fn(async () => {}),
        ...overrides,
      };
    }

    function makeArgs(overrides: Partial<HistoricalClassifyArgs> = {}): HistoricalClassifyArgs {
      return {
        mailbox: 'service@trufinity.ca', from: new Date('2026-07-01'), to: new Date('2026-09-01'),
        dryRun: false, batchLimit: 25, maxCalls: 10, delayMs: 0,
        ...overrides,
      };
    }

    function depsWithEligible(rows: any[], overrides: Partial<HistoricalClassifyDeps> = {}): HistoricalClassifyDeps {
      const deps = makeDeps(overrides);
      (deps.database as any).raw = jest.fn(async () => ({ rows }));
      return deps;
    }

    it('processes eligible messages with transient Gmail fetch', async () => {
      const eligible = [{ provider_message_id: 'm1', mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-01') }];
      const deps = depsWithEligible(eligible);
      const progress = await runClassify(makeArgs(), deps);
      expect(progress.eligible).toBe(1);
      expect(progress.gmailFetchAttempts).toBe(1);
      expect(progress.attempted).toBe(1);
      expect(progress.succeeded).toBe(1);
      expect(progress.escalation).toBe(1);
      expect(deps.classifier.classify).toHaveBeenCalledWith({ subject: 'Test subject', bodyText: 'Test body' });
    });

    it('does not persist subject or body', async () => {
      const eligible = [{ provider_message_id: 'm1', mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-01') }];
      const deps = depsWithEligible(eligible);
      await runClassify(makeArgs(), deps);
      const persistCall = (deps.repository.persist as jest.Mock).mock.calls[0][0] as any;
      expect(persistCall).not.toHaveProperty('subject');
      expect(persistCall).not.toHaveProperty('bodyText');
      expect(persistCall).not.toHaveProperty('body');
      expect(persistCall).not.toHaveProperty('html');
      expect(persistCall).not.toHaveProperty('snippet');
    });

    it('NONE creates no notification', async () => {
      const eligible = [{ provider_message_id: 'm1', mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-01') }];
      const deps = depsWithEligible(eligible, {
        classifier: { classify: jest.fn(async () => ({ label: 'none' as const, confidence: 0.7, reason: 'No issue.' })) },
        repository: { persist: jest.fn(async () => ({ id: 'cls-1', workItemId: null, duplicate: false })) } as any,
      });
      const progress = await runClassify(makeArgs(), deps);
      expect(progress.none).toBe(1);
      expect(progress.notificationsSent).toBe(0);
      expect(deps.notifier.sendNotification).not.toHaveBeenCalled();
    });

    it('ESCALATION sends exactly one notification', async () => {
      const eligible = [{ provider_message_id: 'm1', mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-01') }];
      const deps = depsWithEligible(eligible);
      const progress = await runClassify(makeArgs(), deps);
      expect(progress.escalation).toBe(1);
      expect(progress.notificationsSent).toBe(1);
      expect(deps.notifier.sendNotification).toHaveBeenCalledTimes(1);
    });

    it('REVIEW_REQUIRED sends exactly one notification', async () => {
      const eligible = [{ provider_message_id: 'm1', mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-01') }];
      const deps = depsWithEligible(eligible, {
        classifier: { classify: jest.fn(async () => ({ label: 'complaint' as const, confidence: 0.5, reason: 'Low confidence.' })) },
      });
      const progress = await runClassify(makeArgs(), deps);
      expect(progress.reviewRequired).toBe(1);
      expect(progress.notificationsSent).toBe(1);
    });

    it('notification failure does not roll back classification', async () => {
      const eligible = [{ provider_message_id: 'm1', mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-01') }];
      const deps = depsWithEligible(eligible, {
        notifier: {
          sendNotification: jest.fn(async () => { throw new Error('SMTP down'); }),
          hasNotificationBeenSent: jest.fn(async () => false),
        },
      });
      const progress = await runClassify(makeArgs(), deps);
      expect(progress.succeeded).toBe(1);
      expect(progress.notificationFailures).toBe(1);
      expect(deps.repository.persist).toHaveBeenCalledTimes(1);
    });

    it('max-calls enforced', async () => {
      const eligible = Array.from({ length: 5 }, (_, i) => ({
        provider_message_id: `m${i}`, mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-01'),
      }));
      const deps = depsWithEligible(eligible);
      const progress = await runClassify(makeArgs({ maxCalls: 2 }), deps);
      expect(progress.attempted).toBe(2);
      expect(progress.stoppedByCallCap).toBe(true);
    });

    it('batch-limit enforced', async () => {
      const eligible = Array.from({ length: 5 }, (_, i) => ({
        provider_message_id: `m${i}`, mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-01'),
      }));
      const deps = depsWithEligible(eligible);
      const progress = await runClassify(makeArgs({ batchLimit: 3 }), deps);
      expect(progress.succeeded + progress.failed).toBeLessThanOrEqual(3);
      expect(progress.stoppedByBatchLimit).toBe(true);
    });

    it('SIGINT stops processing safely', async () => {
      const eligible = Array.from({ length: 5 }, (_, i) => ({
        provider_message_id: `m${i}`, mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-01'),
      }));
      const signalRef = { stopped: false };
      let callCount = 0;
      const deps = depsWithEligible(eligible, {
        classifier: {
          classify: jest.fn(async () => {
            callCount += 1;
            if (callCount >= 2) signalRef.stopped = true;
            return { label: 'none' as const, confidence: 0.5, reason: 'ok' };
          }),
        },
        repository: { persist: jest.fn(async () => ({ id: 'cls-1', workItemId: null, duplicate: false })) } as any,
      });
      const progress = await runClassify(makeArgs(), deps, signalRef);
      expect(progress.stoppedBySignal).toBe(true);
      expect(progress.attempted).toBeLessThan(5);
    });

    it('already-classified duplicate is skipped without re-notification', async () => {
      const eligible = [{ provider_message_id: 'm1', mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-01') }];
      const deps = depsWithEligible(eligible, {
        repository: { persist: jest.fn(async () => ({ id: 'cls-1', workItemId: 'wi-1', duplicate: true })) } as any,
      });
      const progress = await runClassify(makeArgs(), deps);
      expect(progress.skippedAlreadyClassified).toBe(1);
      expect(progress.notificationsSent).toBe(0);
    });

    it('classifier failure is isolated and counted', async () => {
      const eligible = [
        { provider_message_id: 'm1', mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-01') },
        { provider_message_id: 'm2', mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-02') },
      ];
      let callNum = 0;
      const deps = depsWithEligible(eligible, {
        classifier: {
          classify: jest.fn(async () => {
            callNum += 1;
            if (callNum === 1) throw new Error('provider error');
            return { label: 'none' as const, confidence: 0.5, reason: 'ok' };
          }),
        },
        repository: { persist: jest.fn(async () => ({ id: 'cls-2', workItemId: null, duplicate: false })) } as any,
      });
      const progress = await runClassify(makeArgs(), deps);
      expect(progress.failed).toBe(1);
      expect(progress.succeeded).toBe(1);
    });

    it('Gmail fetch failure is isolated', async () => {
      const eligible = [{ provider_message_id: 'm1', mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-01') }];
      const deps = depsWithEligible(eligible, {
        authService: {
          getGmailAuthorization: jest.fn(() => ({
            mailbox: { normalizedAddress: 'service@trufinity.ca', contentMode: 'CONTENT' },
            subject: 'service@trufinity.ca',
            scope: 'scope',
            client: { users: { messages: { get: jest.fn(async () => ({ data: null })) } } },
          })) as any,
        },
      });
      const progress = await runClassify(makeArgs(), deps);
      expect(progress.gmailFetchFailures).toBe(1);
      expect(progress.attempted).toBe(0);
    });

    it('outbound message skipped after transient fetch', async () => {
      const eligible = [{ provider_message_id: 'm1', mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-01') }];
      const deps = depsWithEligible(eligible, {
        authService: {
          getGmailAuthorization: jest.fn(() => ({
            mailbox: { normalizedAddress: 'service@trufinity.ca', contentMode: 'CONTENT' },
            subject: 'service@trufinity.ca', scope: 'scope',
            client: {
              users: { messages: { get: jest.fn(async () => ({
                data: {
                  id: 'm1', threadId: 't1', labelIds: ['SENT'],
                  internalDate: String(new Date('2026-08-01').getTime()),
                  payload: { headers: [{ name: 'From', value: 'service@trufinity.ca' }], body: {} },
                },
              })) } },
            },
          })) as any,
        },
      });
      const progress = await runClassify(makeArgs(), deps);
      expect(progress.skippedOutbound).toBe(1);
      expect(progress.attempted).toBe(0);
    });

    it('notification contains no raw email content fields', async () => {
      const eligible = [{ provider_message_id: 'm1', mailbox_address: 'service@trufinity.ca', mailbox_id: 'mbx-1', internal_date: new Date('2026-08-01') }];
      const deps = depsWithEligible(eligible);
      await runClassify(makeArgs(), deps);
      const notifCall = (deps.notifier.sendNotification as jest.Mock).mock.calls[0][0] as any;
      // Raw content must never appear on the notification input
      expect(notifCall).not.toHaveProperty('body');
      expect(notifCall).not.toHaveProperty('bodyText');
      expect(notifCall).not.toHaveProperty('html');
      expect(notifCall).not.toHaveProperty('snippet');
      // Transient metadata fields are allowed and expected
      expect(notifCall).toHaveProperty('subject');
      expect(notifCall).toHaveProperty('classifierReason');
      expect(notifCall).toHaveProperty('senderEmail');
      expect(notifCall).toHaveProperty('workItemId');
      expect(notifCall).toHaveProperty('workType');
      expect(notifCall).toHaveProperty('mailboxAddress');
    });

    it('empty eligible list produces zero calls', async () => {
      const deps = depsWithEligible([]);
      const progress = await runClassify(makeArgs(), deps);
      expect(progress.eligible).toBe(0);
      expect(progress.gmailFetchAttempts).toBe(0);
      expect(progress.attempted).toBe(0);
    });
  });

  describe('emptyProgress', () => {
    it('initializes all counters to zero/false', () => {
      const p = emptyProgress();
      expect(p.scanned).toBe(0);
      expect(p.eligible).toBe(0);
      expect(p.attempted).toBe(0);
      expect(p.succeeded).toBe(0);
      expect(p.failed).toBe(0);
      expect(p.none).toBe(0);
      expect(p.escalation).toBe(0);
      expect(p.reviewRequired).toBe(0);
      expect(p.inputTokens).toBe(0);
      expect(p.outputTokens).toBe(0);
      expect(p.gmailFetchAttempts).toBe(0);
      expect(p.notificationsSent).toBe(0);
      expect(p.notificationFailures).toBe(0);
      expect(p.stoppedBySignal).toBe(false);
      expect(p.stoppedByBatchLimit).toBe(false);
      expect(p.stoppedByCallCap).toBe(false);
    });
  });
});
