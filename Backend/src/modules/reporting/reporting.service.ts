import { KnexReportingRepository } from './reporting.repository';
import type { DateRangeFilter } from '../../utils/dashboard-filters';
import type { ReportingRepository, ReportingSnapshot } from './reporting.types';

export class ReportingService {
  public constructor(private readonly repository: ReportingRepository = new KnexReportingRepository()) {}

  public getInvoiceSummary(dateRange?: DateRangeFilter) { return this.repository.getInvoiceSummary(dateRange); }
  public getPaymentSummary(dateRange?: DateRangeFilter) { return this.repository.getPaymentSummary(dateRange); }
  public getQboCompleteness() { return this.repository.getQboCompleteness(); }
  public getCustomerIdentityQuality() { return this.repository.getCustomerIdentityQuality(); }
  public getPaymentApplicationIntegrity() { return this.repository.getPaymentApplicationIntegrity(); }

  public async getSnapshot(): Promise<ReportingSnapshot> {
    const [invoices, payments, qboCompleteness, customerIdentityQuality, paymentApplicationIntegrity] = await Promise.all([
      this.getInvoiceSummary(),
      this.getPaymentSummary(),
      this.getQboCompleteness(),
      this.getCustomerIdentityQuality(),
      this.getPaymentApplicationIntegrity(),
    ]);
    return { invoices, payments, qboCompleteness, customerIdentityQuality, paymentApplicationIntegrity };
  }
}

export const reportingService = new ReportingService();
