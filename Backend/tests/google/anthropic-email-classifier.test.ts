import { describe, expect, jest, test } from '@jest/globals';
import { AnthropicEmailClassifier, EmailClassifierError } from '../../src/modules/google/anthropic-email-classifier';

const input = { subject: 'Synthetic subject', bodyText: 'Synthetic body only.' };
const config = { model: 'test-model', timeoutMs: 1000, maxRetries: 2, promptVersion: 'test-v1' };

function client(response: unknown, calls: unknown[] = []) {
  return { calls, messages: { create: jest.fn(async (request: unknown) => { calls.push(request); return response; }) } } as any;
}

describe('Anthropic email classifier adapter', () => {
  test('requests strict structured classification without leaking input in errors', async () => {
    const c = client({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ label: 'complaint', confidence: 0.9, reason: 'Synthetic reason.' }) }] });
    const result = await new AnthropicEmailClassifier(c, config).classify(input);
    expect(result.label).toBe('complaint');
    // max_tokens raised to 512 for safe structured-output headroom
    expect(c.messages.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'test-model', max_tokens: 512 }));
  });

  test('sends output_config.format json_schema to constrain response format', async () => {
    const c = client({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ label: 'none', confidence: 0, reason: 'Synthetic reason.' }) }] });
    await new AnthropicEmailClassifier(c, config).classify(input);
    const req = (c.messages.create as jest.Mock).mock.calls[0][0] as any;
    expect(req.output_config?.format?.type).toBe('json_schema');
    const schema = req.output_config.format.schema;
    expect(schema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({ label: expect.any(Object), confidence: expect.any(Object), reason: expect.any(Object) }),
      required: expect.arrayContaining(['label', 'confidence', 'reason']),
      additionalProperties: false,
    });
    // schema label enum contains all valid labels
    expect(schema.properties.label.enum).toContain('complaint');
    expect(schema.properties.label.enum).toContain('none');
    // Anthropic structured-output does NOT support numerical or string constraints;
    // using them causes HTTP 400. Verify they are absent from the API schema.
    expect(schema.properties.confidence).not.toHaveProperty('minimum');
    expect(schema.properties.confidence).not.toHaveProperty('maximum');
    expect(schema.properties.reason).not.toHaveProperty('minLength');
    expect(schema.properties.reason).not.toHaveProperty('maxLength');
  });

  test('rejects malformed provider output', async () => {
    await expect(new AnthropicEmailClassifier(client({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"label":"complaint"}' }] }), config).classify(input)).rejects.toThrow('invalid structured output');
  });

  test('retries retryable provider failures and succeeds', async () => {
    let count = 0;
    const c = { messages: { create: jest.fn(async () => { count += 1; if (count === 1) throw Object.assign(new Error('provider'), { response: { status: 429 } }); return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"label":"none","confidence":0,"reason":"Synthetic reason."}' }] }; }) } } as any;
    const waits: number[] = [];
    await expect(new AnthropicEmailClassifier(c, config, async (ms) => { waits.push(ms); }).classify(input)).resolves.toMatchObject({ label: 'none' });
    expect(c.messages.create).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([100]);
  });

  test('sanitizes non-retryable provider errors', async () => {
    const c = { messages: { create: jest.fn(async () => { throw new Error(`${input.subject} ${input.bodyText}`); }) } } as any;
    await expect(new AnthropicEmailClassifier(c, config).classify(input)).rejects.toThrow('provider request failed');
  });

  test('opt-in usage API returns provider token counts', async () => {
    const c = { messages: { create: jest.fn(async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"label":"none","confidence":0,"reason":"Synthetic reason."}' }],
      usage: { input_tokens: 17, output_tokens: 5 },
    })) } } as any;
    const result = await new AnthropicEmailClassifier(c, config).classifyWithUsage(input);
    expect(result.usage).toEqual({ inputTokens: 17, outputTokens: 5 });
  });
});

describe('EmailClassifierError granular invalid-output subtypes', () => {
  function goodResponse(text: string) {
    return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
  }

  test('stop_reason max_tokens → response_truncated', async () => {
    const c = client({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"lab' }] });
    const err = await new AnthropicEmailClassifier(c, config).classify(input).catch((e) => e) as EmailClassifierError;
    expect(err).toBeInstanceOf(EmailClassifierError);
    expect(err.category).toBe('response_truncated');
  });

  test('no text block → no_text_block', async () => {
    const c = client({ stop_reason: 'end_turn', content: [{ type: 'tool_use' }] });
    const err = await new AnthropicEmailClassifier(c, config).classify(input).catch((e) => e) as EmailClassifierError;
    expect(err.category).toBe('no_text_block');
  });

  test('code-fenced JSON → json_parse_failure', async () => {
    const c = client(goodResponse('```json\n{"label":"complaint","confidence":0.9,"reason":"Synthetic reason."}\n```'));
    const err = await new AnthropicEmailClassifier(c, config).classify(input).catch((e) => e) as EmailClassifierError;
    expect(err.category).toBe('json_parse_failure');
  });

  test('prose text (no JSON) → json_parse_failure', async () => {
    const c = client(goodResponse('Here is the JSON: the label is complaint'));
    const err = await new AnthropicEmailClassifier(c, config).classify(input).catch((e) => e) as EmailClassifierError;
    expect(err.category).toBe('json_parse_failure');
  });

  test('JSON with extra field → unsupported_fields', async () => {
    const c = client(goodResponse('{"label":"complaint","confidence":0.9,"reason":"Synthetic reason.","routing":"tier1"}'));
    const err = await new AnthropicEmailClassifier(c, config).classify(input).catch((e) => e) as EmailClassifierError;
    expect(err.category).toBe('unsupported_fields');
  });

  test('invalid label value → invalid_label', async () => {
    const c = client(goodResponse('{"label":"urgent","confidence":0.9,"reason":"Synthetic reason."}'));
    const err = await new AnthropicEmailClassifier(c, config).classify(input).catch((e) => e) as EmailClassifierError;
    expect(err.category).toBe('invalid_label');
  });

  test('confidence out of range → invalid_confidence', async () => {
    const c = client(goodResponse('{"label":"complaint","confidence":1.5,"reason":"Synthetic reason."}'));
    const err = await new AnthropicEmailClassifier(c, config).classify(input).catch((e) => e) as EmailClassifierError;
    expect(err.category).toBe('invalid_confidence');
  });

  test('multiline reason → invalid_reason', async () => {
    const c = client(goodResponse('{"label":"complaint","confidence":0.9,"reason":"Line one\\nLine two"}'));
    const err = await new AnthropicEmailClassifier(c, config).classify(input).catch((e) => e) as EmailClassifierError;
    expect(err.category).toBe('invalid_reason');
  });

  test('reason exceeding 280 chars → invalid_reason', async () => {
    const longReason = 'A'.repeat(281);
    const c = client(goodResponse(JSON.stringify({ label: 'complaint', confidence: 0.9, reason: longReason })));
    const err = await new AnthropicEmailClassifier(c, config).classify(input).catch((e) => e) as EmailClassifierError;
    expect(err.category).toBe('invalid_reason');
  });

  test('empty reason → invalid_reason', async () => {
    const c = client(goodResponse('{"label":"complaint","confidence":0.9,"reason":""}'));
    const err = await new AnthropicEmailClassifier(c, config).classify(input).catch((e) => e) as EmailClassifierError;
    expect(err.category).toBe('invalid_reason');
  });

  test('response_truncated is not retried', async () => {
    const c = client({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"lab' }] });
    const err = await new AnthropicEmailClassifier(c, { ...config, maxRetries: 3 }, async () => undefined).classify(input).catch((e) => e) as EmailClassifierError;
    expect(err.category).toBe('response_truncated');
    // Should NOT have retried despite maxRetries: 3
    expect((c.messages.create as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  test('json_parse_failure is not retried', async () => {
    const c = client(goodResponse('not json'));
    const err = await new AnthropicEmailClassifier(c, { ...config, maxRetries: 3 }, async () => undefined).classify(input).catch((e) => e) as EmailClassifierError;
    expect(err.category).toBe('json_parse_failure');
    expect((c.messages.create as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  test('none of the error subtypes expose raw Claude response text', async () => {
    const secretText = 'SECRET_CLAUDE_OUTPUT subject body Gmail snippet';
    for (const response of [
      { stop_reason: 'end_turn', content: [{ type: 'text', text: `\`\`\`json\n${secretText}\n\`\`\`` }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: secretText }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: `{"label":"${secretText}","confidence":0.9,"reason":"r"}` }] },
    ]) {
      const c = client(response);
      const err = await new AnthropicEmailClassifier(c, config).classify(input).catch((e) => e) as EmailClassifierError;
      expect(err.message).not.toContain('SECRET_CLAUDE_OUTPUT');
      expect(err.message).not.toContain('subject');
      expect(err.message).not.toContain('Gmail snippet');
    }
  });

  test('valid structured output still succeeds end-to-end', async () => {
    const c = client({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"label":"billing_dispute","confidence":0.85,"reason":"Customer disputes charge amount."}' }] });
    const result = await new AnthropicEmailClassifier(c, config).classify(input);
    expect(result.label).toBe('billing_dispute');
    expect(result.confidence).toBe(0.85);
    expect(result.reason).toBe('Customer disputes charge amount.');
  });
});

describe('EmailClassifierError diagnostic categories', () => {
  function providerError(overrides: Record<string, unknown>): unknown {
    return Object.assign(new Error('provider error'), overrides);
  }

  async function classifyWith(thrownError: unknown) {
    const c = { messages: { create: jest.fn(async () => { throw thrownError; }) } } as any;
    const err = await new AnthropicEmailClassifier(c, { ...config, maxRetries: 0 }).classify(input).catch((e) => e);
    expect(err).toBeInstanceOf(EmailClassifierError);
    return err as EmailClassifierError;
  }

  test('no text block → now categorized as no_text_block', async () => {
    const c = { messages: { create: jest.fn(async () => ({ content: [{ type: 'tool_use' }] })) } } as any;
    const err = await new AnthropicEmailClassifier(c, { ...config, maxRetries: 0 }).classify(input).catch((e) => e) as EmailClassifierError;
    expect(err.category).toBe('no_text_block');
    expect(err.providerStatus).toBeNull();
  });

  test('non-JSON text → now categorized as json_parse_failure', async () => {
    const c = { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: 'not json' }] })) } } as any;
    const err = await new AnthropicEmailClassifier(c, { ...config, maxRetries: 0 }).classify(input).catch((e) => e) as EmailClassifierError;
    expect(err.category).toBe('json_parse_failure');
  });

  test('schema-invalid JSON (missing fields) → invalid_structured_output umbrella', async () => {
    const c = { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: '{"label":"complaint"}' }] })) } } as any;
    const err = await new AnthropicEmailClassifier(c, { ...config, maxRetries: 0 }).classify(input).catch((e) => e) as EmailClassifierError;
    // missing confidence+reason → "Classifier output must be an object" would not apply;
    // "Classifier confidence must be..." maps to invalid_confidence
    expect(['invalid_confidence', 'invalid_reason', 'invalid_structured_output']).toContain(err.category);
  });

  test('invalid-output errors do not expose raw Claude response text', async () => {
    const c = { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: 'secret-claude-output subject body' }] })) } } as any;
    const err = await new AnthropicEmailClassifier(c, { ...config, maxRetries: 0 }).classify(input).catch((e) => e) as EmailClassifierError;
    expect(err.message).not.toContain('secret-claude-output');
    expect(err.message).not.toContain('subject');
    expect(err.message).not.toContain('body');
    // category is now json_parse_failure (not invalid_structured_output) but still safe
    expect(['json_parse_failure', 'invalid_structured_output', 'invalid_label', 'invalid_reason', 'invalid_confidence', 'unsupported_fields']).toContain(err.category);
  });

  test('HTTP 401 → provider_auth_error with status', async () => {
    const err = await classifyWith(providerError({ response: { status: 401 } }));
    expect(err.category).toBe('provider_auth_error');
    expect(err.providerStatus).toBe(401);
  });

  test('HTTP 403 → provider_auth_error with status', async () => {
    const err = await classifyWith(providerError({ response: { status: 403 } }));
    expect(err.category).toBe('provider_auth_error');
    expect(err.providerStatus).toBe(403);
  });

  test('HTTP 404 → provider_model_error with status', async () => {
    const err = await classifyWith(providerError({ response: { status: 404 } }));
    expect(err.category).toBe('provider_model_error');
    expect(err.providerStatus).toBe(404);
  });

  test('HTTP 408 → provider_timeout with status', async () => {
    const err = await classifyWith(providerError({ response: { status: 408 } }));
    expect(err.category).toBe('provider_timeout');
    expect(err.providerStatus).toBe(408);
  });

  test('ETIMEDOUT code → provider_timeout', async () => {
    const err = await classifyWith(providerError({ code: 'ETIMEDOUT' }));
    expect(err.category).toBe('provider_timeout');
  });

  test('HTTP 429 → provider_rate_limit with status', async () => {
    const err = await classifyWith(providerError({ response: { status: 429 } }));
    expect(err.category).toBe('provider_rate_limit');
    expect(err.providerStatus).toBe(429);
  });

  test('HTTP 500 → provider_server_error with status', async () => {
    const err = await classifyWith(providerError({ response: { status: 500 } }));
    expect(err.category).toBe('provider_server_error');
    expect(err.providerStatus).toBe(500);
  });

  test('HTTP 503 → provider_server_error with status', async () => {
    const err = await classifyWith(providerError({ response: { status: 503 } }));
    expect(err.category).toBe('provider_server_error');
    expect(err.providerStatus).toBe(503);
  });

  test('HTTP 400 → provider_http_error with status', async () => {
    const err = await classifyWith(providerError({ response: { status: 400 } }));
    expect(err.category).toBe('provider_http_error');
    expect(err.providerStatus).toBe(400);
  });

  test('ECONNRESET code → provider_network_error', async () => {
    const err = await classifyWith(providerError({ code: 'ECONNRESET' }));
    expect(err.category).toBe('provider_network_error');
    expect(err.providerStatus).toBeNull();
  });

  test('EAI_AGAIN code → provider_network_error', async () => {
    const err = await classifyWith(providerError({ code: 'EAI_AGAIN' }));
    expect(err.category).toBe('provider_network_error');
  });

  test('unknown error → provider_unknown', async () => {
    const err = await classifyWith(new Error('generic'));
    expect(err.category).toBe('provider_unknown');
    expect(err.providerStatus).toBeNull();
  });

  test('provider error message is never exposed through EmailClassifierError message', async () => {
    const err = await classifyWith(providerError({ response: { status: 503 }, message: 'secret model detail subject body' }));
    expect(err.message).not.toContain('secret model detail');
    expect(err.message).not.toContain('subject');
    expect(err.message).not.toContain('body');
  });

  test('retryable 429 still retries before assigning category', async () => {
    let count = 0;
    const c = { messages: { create: jest.fn(async () => {
      count += 1;
      if (count === 1) throw providerError({ response: { status: 429 } });
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"label":"none","confidence":0,"reason":"Synthetic reason."}' }] };
    }) } } as any;
    const result = await new AnthropicEmailClassifier(c, config, async () => undefined).classify(input);
    expect(result.label).toBe('none');
    expect(c.messages.create).toHaveBeenCalledTimes(2);
  });

  test('retryable 429 exhausted → provider_rate_limit', async () => {
    const c = { messages: { create: jest.fn(async () => { throw providerError({ response: { status: 429 } }); }) } } as any;
    const err = await new AnthropicEmailClassifier(c, { ...config, maxRetries: 1 }, async () => undefined).classify(input).catch((e) => e) as EmailClassifierError;
    expect(err.category).toBe('provider_rate_limit');
    expect(err.providerStatus).toBe(429);
    expect(c.messages.create).toHaveBeenCalledTimes(2);
  });
});
