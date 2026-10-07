import { describe, expect, it } from '@jest/globals';
import { trailingWeekWindow } from '../../src/modules/detect/detect.types';

describe('trailingWeekWindow', () => {
  it('builds a 7-day current period and a preceding 4-week baseline of matching length', () => {
    const now = new Date('2026-09-16T13:00:00.000Z');
    const window = trailingWeekWindow(now);

    expect(window.periodEnd).toEqual(now);
    expect(window.periodStart).toEqual(new Date('2026-09-09T13:00:00.000Z'));
    expect(window.baselineEnd).toEqual(window.periodStart);
    expect(window.baselineStart).toEqual(new Date('2026-08-12T13:00:00.000Z'));

    const currentLengthMs = window.periodEnd.getTime() - window.periodStart.getTime();
    const baselineLengthMs = window.baselineEnd.getTime() - window.baselineStart.getTime();
    expect(baselineLengthMs).toBe(currentLengthMs * 4);
  });
});
