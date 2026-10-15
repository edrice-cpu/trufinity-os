import { describe, expect, it, jest } from '@jest/globals';
import type { LaceExportFreshness } from '../../src/modules/lace/lace-freshness';
import { LacePipelineAlerter, pipelineAlertRecipient, type AlertMailer } from '../../src/modules/lace/lace-pipeline-alert';
import { env } from '../../src/config/env';

const freshness = (status: LaceExportFreshness['status'], exportType: LaceExportFreshness['exportType'] = 'call_analysis'): LaceExportFreshness => ({
  exportType, status, lastRunStatus: status === 'FAILING' ? 'FAILED' : 'COMPLETED', lastRunStartedAt: null, lastRunCompletedAt: null,
  lastRunRecordsProcessed: null, lastSuccessfulSyncAt: '2026-10-13T02:00:00.000Z', consecutiveFailures: status === 'FAILING' ? 2 : 0,
  lastFileIngestedAt: '2026-10-12T02:00:00.000Z', latestDataAt: null, latestRawRecordCount: 0, maxFileAgeHours: 36,
});

function setup() {
  let now = 1_000_000;
  const send = jest.fn<AlertMailer['send']>(async () => undefined);
  const alerter = new LacePipelineAlerter({ send }, () => now);
  return { alerter, send, advance: (ms: number) => { now += ms; } };
}

describe('LacePipelineAlerter', () => {
  it('sends nothing for healthy feeds', async () => {
    const { alerter, send } = setup();
    expect(await alerter.check([freshness('OK'), freshness('OK', 'agent_performance')])).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('emails once per broken feed and status, not on every check', async () => {
    const { alerter, send, advance } = setup();
    await alerter.check([freshness('FAILING')]);
    advance(60 * 60 * 1000);
    await alerter.check([freshness('FAILING')]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe('[TruFinity] Lace AI call analysis feed is FAILING');
    expect(send.mock.calls[0]?.[1]).toContain('the last 2 sync run(s) failed');
  });

  it('reminds again after 24 hours, and on a change of status', async () => {
    const { alerter, send, advance } = setup();
    await alerter.check([freshness('FAILING')]);
    await alerter.check([freshness('STALE')]);
    advance(24 * 60 * 60 * 1000 + 1);
    await alerter.check([freshness('FAILING')]);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('alerts again right away after the feed recovered and broke again', async () => {
    const { alerter, send } = setup();
    await alerter.check([freshness('FAILING')]);
    await alerter.check([freshness('OK')]);
    await alerter.check([freshness('FAILING')]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not throw when the email fails', async () => {
    const alerter = new LacePipelineAlerter({ send: async () => { throw new Error('smtp down'); } });
    await expect(alerter.check([freshness('STALE')])).resolves.toHaveLength(1);
  });

  it('sends to PIPELINE_ALERT_RECIPIENT, else to the company Lace inbox - never a personal fallback', () => {
    const original = { recipient: env.PIPELINE_ALERT_RECIPIENT, mailbox: env.LACE_REPORT_MAILBOX };
    try {
      env.PIPELINE_ALERT_RECIPIENT = 'ops@trufinity.ca';
      env.LACE_REPORT_MAILBOX = 'lace-report@trufinity.ca';
      expect(pipelineAlertRecipient()).toBe('ops@trufinity.ca');
      env.PIPELINE_ALERT_RECIPIENT = undefined;
      expect(pipelineAlertRecipient()).toBe('lace-report@trufinity.ca');
      env.LACE_REPORT_MAILBOX = '';
      expect(pipelineAlertRecipient()).toBeUndefined();
    } finally {
      env.PIPELINE_ALERT_RECIPIENT = original.recipient;
      env.LACE_REPORT_MAILBOX = original.mailbox;
    }
  });
});
