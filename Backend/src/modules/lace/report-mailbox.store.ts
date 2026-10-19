import type { GmailMessagePart, GmailReportInboxClient } from '../google/google-auth.service';
import type { LaceObjectStore } from './s3.client';
import type { LaceS3Object } from './lace.types';

// A LaceObjectStore over the CSV attachments in Lace's report inbox
// (LACE_REPORT_MAILBOX). Lace emails its Monthly Agent Performance Report
// there instead of dropping it in S3, so this lets the normal ingestion
// service pick it up: each matching attachment looks like one S3 object.
//
// Only CSV attachments of messages matching the Gmail search query are read.
// Fetching a message (format "full") is needed to find its attachment parts;
// the message body that comes with it is never stored, logged or returned.
//
// Object key = mailbox/<message id>/<filename>. A Gmail message never
// changes, so the key alone makes ingestion idempotent; the eTag is derived
// from the same stable values (attachment ids are NOT stable across fetches).
export const MAILBOX_KEY_PREFIX = 'mailbox/';
const MAX_MESSAGES = 100;
const PAGE_SIZE = 50;

interface AttachmentRef {
  messageId: string;
  attachmentId: string;
}

function csvAttachments(part: GmailMessagePart | null | undefined, found: { filename: string; attachmentId: string; size: number }[] = []) {
  if (!part) return found;
  const filename = part.filename?.trim();
  const attachmentId = part.body?.attachmentId;
  if (filename && attachmentId && filename.toLowerCase().endsWith('.csv')) {
    found.push({ filename, attachmentId, size: part.body?.size ?? 0 });
  }
  for (const child of part.parts ?? []) csvAttachments(child, found);
  return found;
}

export class LaceReportMailboxStore implements LaceObjectStore {
  private readonly attachments = new Map<string, AttachmentRef>();

  public constructor(
    private readonly client: GmailReportInboxClient,
    private readonly query: string,
  ) {}

  // The S3 prefix argument doesn't apply to a mailbox; the search query does that job.
  public async listObjects(): Promise<LaceS3Object[]> {
    this.attachments.clear();
    const objects: LaceS3Object[] = [];
    let pageToken: string | undefined;
    let seen = 0;
    do {
      const listed = await this.client.users.messages.list({
        userId: 'me', q: this.query, maxResults: PAGE_SIZE, includeSpamTrash: false, ...(pageToken ? { pageToken } : {}),
      });
      for (const ref of listed.data.messages ?? []) {
        if (!ref.id || seen >= MAX_MESSAGES) continue;
        seen += 1;
        const message = (await this.client.users.messages.get({ userId: 'me', id: ref.id, format: 'full' })).data;
        const receivedAt = message.internalDate ? new Date(Number(message.internalDate)) : null;
        for (const attachment of csvAttachments(message.payload)) {
          const key = `${MAILBOX_KEY_PREFIX}${ref.id}/${attachment.filename}`;
          this.attachments.set(key, { messageId: ref.id, attachmentId: attachment.attachmentId });
          objects.push({ key, eTag: `${ref.id}:${attachment.filename}:${attachment.size}`, lastModified: receivedAt, size: attachment.size });
        }
      }
      pageToken = listed.data.nextPageToken ?? undefined;
    } while (pageToken && seen < MAX_MESSAGES);
    return objects;
  }

  public async getObjectText(key: string): Promise<string> {
    const ref = this.attachments.get(key);
    if (!ref) throw new Error(`Unknown Lace report attachment key: ${key}`);
    const { data } = await this.client.users.messages.attachments.get({ userId: 'me', messageId: ref.messageId, id: ref.attachmentId });
    if (!data.data) throw new Error(`Lace report attachment ${key} is empty.`);
    // Gmail returns attachment bytes as base64url. Strip a UTF-8 BOM so the
    // first header parses as "CSR".
    return Buffer.from(data.data, 'base64url').toString('utf8').replace(/^\uFEFF/, '');
  }
}
