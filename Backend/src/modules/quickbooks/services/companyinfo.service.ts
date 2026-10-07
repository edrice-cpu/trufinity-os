import { qboApiClient } from '../api.client';
import { qboAuthService } from '../auth.service';
import { QboCompanyInfo } from '../types';

export class QboCompanyInfoService {
  public async getCompanyInfo(): Promise<QboCompanyInfo> {
    const { realmId } = await qboAuthService.getValidAccessToken();
    const response = await qboApiClient.get<{ CompanyInfo: QboCompanyInfo }>(
      `/v3/company/${realmId}/companyinfo/${realmId}`
    );
    return response.CompanyInfo;
  }
}

export const qboCompanyInfoService = new QboCompanyInfoService();
