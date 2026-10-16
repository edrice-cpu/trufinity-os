import {
  EMAIL_CLASSIFICATION_LABELS,
  EMAIL_CLASSIFICATION_MAX_REASON_LENGTH,
  deriveEmailDecision,
  parseEmailClassification,
} from '../../src/modules/google/email-classifier';
import { describe, expect, test } from '@jest/globals';

describe('email classifier domain contract', () => {
  const base = { confidence: 0.5, reason: 'Synthetic classification reason.' };

  test.each(EMAIL_CLASSIFICATION_LABELS)('accepts label %s', (label: (typeof EMAIL_CLASSIFICATION_LABELS)[number]) => {
    expect(parseEmailClassification({ label, ...base }).label).toBe(label);
  });

  test('rejects unsupported labels and generated fields', () => {
    expect(() => parseEmailClassification({ label: 'other', ...base })).toThrow();
    expect(() => parseEmailClassification({ label: 'none', ...base, customerId: 'x' })).toThrow();
  });

  test.each([0, 1])('accepts confidence boundary %s', (confidence: number) => {
    expect(parseEmailClassification({ label: 'none', confidence, reason: 'ok' }).confidence).toBe(confidence);
  });

  test.each([-0.01, 1.01, Number.NaN, '0.5'] as Array<number | string>)('rejects invalid confidence %p', (confidence: number | string) => {
    expect(() => parseEmailClassification({ label: 'none', confidence, reason: 'ok' })).toThrow();
  });

  test('rejects empty reason after normalization', () => {
    expect(() => parseEmailClassification({ label: 'none', ...base, reason: '' })).toThrow();
  });

  test('normalizes multiline reasons to a single line', () => {
    const result = parseEmailClassification({ label: 'none', ...base, reason: 'two\nlines' });
    expect(result.reason).toBe('two lines');
    expect(result.reason).not.toMatch(/[\r\n]/);
  });

  test('truncates over-length reasons to the maximum', () => {
    const long = 'x'.repeat(EMAIL_CLASSIFICATION_MAX_REASON_LENGTH + 10);
    const result = parseEmailClassification({ label: 'none', ...base, reason: long });
    expect(result.reason.length).toBe(EMAIL_CLASSIFICATION_MAX_REASON_LENGTH);
  });

  test('derives escalation, review, and none decisions', () => {
    expect(deriveEmailDecision({ label: 'complaint', ...base }, 0.5).state).toBe('ESCALATION');
    expect(deriveEmailDecision({ label: 'complaint', confidence: 0.49, reason: 'ok' }, 0.5).state).toBe('REVIEW_REQUIRED');
    expect(deriveEmailDecision({ label: 'none', confidence: 1, reason: 'ok' }, 0.5).state).toBe('NONE');
  });

  test('label none always produces NONE regardless of confidence', () => {
    expect(deriveEmailDecision({ label: 'none', confidence: 0, reason: 'ok' }, 0.85).state).toBe('NONE');
    expect(deriveEmailDecision({ label: 'none', confidence: 0.85, reason: 'ok' }, 0.85).state).toBe('NONE');
    expect(deriveEmailDecision({ label: 'none', confidence: 1, reason: 'ok' }, 0.85).state).toBe('NONE');
  });

  test('threshold boundary at 0.85', () => {
    const r = 'ok';
    expect(deriveEmailDecision({ label: 'complaint', confidence: 0.85, reason: r }, 0.85).state).toBe('ESCALATION');
    expect(deriveEmailDecision({ label: 'complaint', confidence: 0.8499, reason: r }, 0.85).state).toBe('REVIEW_REQUIRED');
    expect(deriveEmailDecision({ label: 'complaint', confidence: 0.8501, reason: r }, 0.85).state).toBe('ESCALATION');
  });

  test('confidence extremes with non-none labels', () => {
    expect(deriveEmailDecision({ label: 'complaint', confidence: 0, reason: 'ok' }, 0.85).state).toBe('REVIEW_REQUIRED');
    expect(deriveEmailDecision({ label: 'complaint', confidence: 1, reason: 'ok' }, 0.85).state).toBe('ESCALATION');
  });

  test('rejects invalid threshold values', () => {
    expect(() => deriveEmailDecision({ label: 'complaint', ...base }, -0.01)).toThrow('Confidence threshold');
    expect(() => deriveEmailDecision({ label: 'complaint', ...base }, 1.01)).toThrow('Confidence threshold');
    expect(() => deriveEmailDecision({ label: 'complaint', ...base }, NaN)).toThrow('Confidence threshold');
  });
});
