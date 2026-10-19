import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { LaceObjectStore } from './s3.client';
import type { LaceS3Object } from './lace.types';

// A LaceObjectStore over one local CSV file, for Lace reports that don't
// arrive in S3 - today the Monthly Agent Performance Report, which Lace
// emails to lace-report@trufinity.ca. Plugging it into the normal ingestion
// service keeps everything the S3 path has: sync_runs, the advisory lock,
// sync_errors for bad rows, and per-file idempotency. The "eTag" is the
// file's SHA-256, so re-importing the same file is a no-op while a corrected
// re-send (different content) is ingested and supersedes the old rows.
export const LOCAL_FILE_KEY_PREFIX = 'manual-upload/';

export class LocalFileObjectStore implements LaceObjectStore {
  public constructor(private readonly filePath: string) {}

  private get key(): string {
    return `${LOCAL_FILE_KEY_PREFIX}${basename(this.filePath)}`;
  }

  public async listObjects(): Promise<LaceS3Object[]> {
    const [content, info] = await Promise.all([readFile(this.filePath), stat(this.filePath)]);
    return [{
      key: this.key,
      eTag: createHash('sha256').update(content).digest('hex'),
      lastModified: info.mtime,
      size: info.size,
    }];
  }

  public async getObjectText(key: string): Promise<string> {
    if (key !== this.key) throw new Error(`Unknown local Lace file key: ${key}`);
    // Lace's CSVs may carry a UTF-8 byte-order mark; strip it so the first
    // header is read as "CSR", not "\uFEFFCSR".
    return (await readFile(this.filePath, 'utf8')).replace(/^\uFEFF/, '');
  }
}
