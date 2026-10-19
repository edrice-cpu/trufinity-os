import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFileObjectStore, LOCAL_FILE_KEY_PREFIX } from '../../src/modules/lace/local-file.store';

describe('LocalFileObjectStore', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'lace-local-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('lists the one file under a manual-upload key with a content hash as its eTag', async () => {
    const path = join(dir, 'report_20261011.csv');
    writeFileSync(path, 'CSR,Period Start\nA,2026-09-01 04:00:00\n');
    const [object] = await new LocalFileObjectStore(path).listObjects();
    expect(object?.key).toBe(`${LOCAL_FILE_KEY_PREFIX}report_20261011.csv`);
    expect(object?.eTag).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives a different eTag when the content changes, so a corrected re-send is ingested', async () => {
    const path = join(dir, 'resend.csv');
    writeFileSync(path, 'CSR\nA\n');
    const first = (await new LocalFileObjectStore(path).listObjects())[0]?.eTag;
    writeFileSync(path, 'CSR\nB\n');
    const second = (await new LocalFileObjectStore(path).listObjects())[0]?.eTag;
    expect(first).not.toBe(second);
  });

  it('strips a UTF-8 byte-order mark so the first header parses as "CSR"', async () => {
    const path = join(dir, 'bom.csv');
    writeFileSync(path, '\uFEFFCSR,Period Start\n');
    const store = new LocalFileObjectStore(path);
    const [object] = await store.listObjects();
    expect((await store.getObjectText(object!.key)).startsWith('CSR,')).toBe(true);
  });

  it('refuses any key other than its own file', async () => {
    const path = join(dir, 'one.csv');
    writeFileSync(path, 'CSR\n');
    await expect(new LocalFileObjectStore(path).getObjectText('manual-upload/other.csv')).rejects.toThrow('Unknown local Lace file key');
  });
});
