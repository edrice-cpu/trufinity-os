import { describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'stream';
import { S3LaceObjectStore } from '../../src/modules/lace/s3.client';

describe('S3LaceObjectStore', () => {
  it('listObjects maps S3 items, strips quotes from ETags, and follows pagination', async () => {
    const send = jest
      .fn<(command: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({
        Contents: [{ Key: 'a.csv', ETag: '"etag-a"', LastModified: new Date('2026-01-01T00:00:00Z'), Size: 10 }],
        IsTruncated: true,
        NextContinuationToken: 'token-2',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'b.csv', ETag: '"etag-b"', LastModified: new Date('2026-01-02T00:00:00Z'), Size: 20 }],
        IsTruncated: false,
      });
    const store = new S3LaceObjectStore('test-bucket', () => ({ send }) as never);

    const objects = await store.listObjects('prefix/');

    expect(send).toHaveBeenCalledTimes(2);
    expect(objects).toEqual([
      { key: 'a.csv', eTag: 'etag-a', lastModified: new Date('2026-01-01T00:00:00Z'), size: 10 },
      { key: 'b.csv', eTag: 'etag-b', lastModified: new Date('2026-01-02T00:00:00Z'), size: 20 },
    ]);
  });

  it('listObjects skips entries missing a Key or ETag rather than crashing', async () => {
    const send = jest.fn<(command: unknown) => Promise<unknown>>().mockResolvedValue({
      Contents: [{ Key: 'a.csv', ETag: '"etag-a"' }, { Key: undefined, ETag: '"etag-b"' }, { Key: 'c.csv', ETag: undefined }],
      IsTruncated: false,
    });
    const store = new S3LaceObjectStore('test-bucket', () => ({ send }) as never);

    const objects = await store.listObjects('');

    expect(objects.map((o) => o.key)).toEqual(['a.csv']);
  });

  it('listObjects returns an empty array when the bucket/prefix has no objects', async () => {
    const send = jest.fn<(command: unknown) => Promise<unknown>>().mockResolvedValue({ Contents: undefined, IsTruncated: false });
    const store = new S3LaceObjectStore('test-bucket', () => ({ send }) as never);

    expect(await store.listObjects('empty/')).toEqual([]);
  });

  it('getObjectText reads the object body stream into a string', async () => {
    const body = Readable.from(['line1\n', 'line2\n']);
    const send = jest.fn<(command: unknown) => Promise<unknown>>().mockResolvedValue({ Body: body });
    const store = new S3LaceObjectStore('test-bucket', () => ({ send }) as never);

    const text = await store.getObjectText('some-key.csv');

    expect(text).toBe('line1\nline2\n');
  });

  it('getObjectText throws when the object has no body', async () => {
    const send = jest.fn<(command: unknown) => Promise<unknown>>().mockResolvedValue({ Body: undefined });
    const store = new S3LaceObjectStore('test-bucket', () => ({ send }) as never);

    await expect(store.getObjectText('missing-body.csv')).rejects.toThrow('Lace S3 object has no body: missing-body.csv');
  });

  it('builds the S3 client lazily - only on first use, not at construction', () => {
    const clientFactory = jest.fn(() => ({ send: jest.fn() }) as never);

    // eslint-disable-next-line no-new
    new S3LaceObjectStore('test-bucket', clientFactory);

    expect(clientFactory).not.toHaveBeenCalled();
  });
});
