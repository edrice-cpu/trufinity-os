import { qboApiClient } from '../api.client';
import type { QboCdcEntity, QboCdcResponse } from '../types';

export class QboCdcService {
  public getChanges(entities: QboCdcEntity[], changedSince: string): Promise<QboCdcResponse> {
    return qboApiClient.getCdc<QboCdcResponse>(entities, changedSince);
  }
}

export const qboCdcService = new QboCdcService();
