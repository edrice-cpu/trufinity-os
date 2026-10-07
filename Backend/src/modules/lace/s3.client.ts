import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@aws-sdk/node-http-handler';
import { Agent as HttpsAgent } from 'https';
import type { Readable } from 'stream';
import { env } from '../../config/env';
import type { LaceS3Object } from './lace.types';

export interface LaceObjectStore {
  listObjects(prefix: string): Promise<LaceS3Object[]>;
  getObjectText(key: string): Promise<string>;
}

function buildClient(): S3Client {
  return new S3Client({
    region: env.LACE_S3_REGION,
    credentials: {
      accessKeyId: env.LACE_S3_ACCESS_KEY_ID,
      secretAccessKey: env.LACE_S3_SECRET_ACCESS_KEY,
    },
    // Some dev/prod hosts have a broken IPv6 path to AWS where Node's default
    // dual-stack "Happy Eyeballs" connection attempt hangs until it times out.
    // Forcing the underlying agent to IPv4 avoids that hang; plain curl (which
    // doesn't hit this) reaches the same endpoint instantly, confirming it's
    // Node-specific, not a real network/firewall block.
    requestHandler: new NodeHttpHandler({
      httpsAgent: new HttpsAgent({ family: 4 }),
    }),
  });
}

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Thin wrapper around the AWS SDK so ingestion logic can be tested against a
// fake store instead of real S3 credentials. The SDK client is built lazily
// (on first use, not at construction) because it validates its region eagerly
// and throws immediately if the Lace env vars aren't set yet - which must not
// crash module import in tests or in environments where Lace isn't configured.
export class S3LaceObjectStore implements LaceObjectStore {
  private client: S3Client | null = null;

  public constructor(
    private readonly bucket: string = env.LACE_S3_BUCKET,
    private readonly clientFactory: () => S3Client = buildClient,
  ) {}

  private getClient(): S3Client {
    this.client ??= this.clientFactory();
    return this.client;
  }

  public async listObjects(prefix: string): Promise<LaceS3Object[]> {
    const objects: LaceS3Object[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.getClient().send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const item of response.Contents ?? []) {
        if (!item.Key || !item.ETag) continue;
        objects.push({
          key: item.Key,
          eTag: item.ETag.replace(/"/g, ''),
          lastModified: item.LastModified ?? null,
          size: item.Size ?? 0,
        });
      }
      continuationToken = response.IsTruncated === true ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  }

  public async getObjectText(key: string): Promise<string> {
    const response = await this.getClient().send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body) throw new Error(`Lace S3 object has no body: ${key}`);
    return streamToString(response.Body as unknown as Readable);
  }
}

export const laceObjectStore = new S3LaceObjectStore();
