import { KnexServiceTitanReportingRepository } from './servicetitan-reporting.repository';
import type { DateRangeFilter, ServiceTitanDepartment } from '../../utils/dashboard-filters';
import type { StInvoiceListItem, StReportingSnapshot } from './servicetitan-reporting.types';

export class ServiceTitanReportingService {
  public constructor(private readonly repository: KnexServiceTitanReportingRepository = new KnexServiceTitanReportingRepository()) {}

  public getJobsSummary(dateRange?: DateRangeFilter, department?: ServiceTitanDepartment) {
    return this.repository.getJobsSummary(dateRange, department);
  }
  public getInvoicesSummary() { return this.repository.getInvoicesSummary(); }
  public getArAging() { return this.repository.getArAging(); }
  public getPaymentsSummary() { return this.repository.getPaymentsSummary(); }
  public getLeadsBookingsSummary() { return this.repository.getLeadsBookingsSummary(); }
  public getAppointmentsSummary() { return this.repository.getAppointmentsSummary(); }
  public getCustomersSummary() { return this.repository.getCustomersSummary(); }
  public getTechnicianSummary() { return this.repository.getTechnicianSummary(); }
  public getSyncStatus() { return this.repository.getSyncStatus(); }
  public listJobs(page: number, pageSize: number, status?: string) { return this.repository.listJobs(page, pageSize, status); }
  public listInvoices(page: number, pageSize: number, classification?: StInvoiceListItem['classification']) {
    return this.repository.listInvoices(page, pageSize, classification);
  }

  public async getSnapshot(): Promise<StReportingSnapshot> {
    const [jobs, invoices, arAging, payments, leadsBookings, appointments, customers, technicians, syncStatus] = await Promise.all([
      this.getJobsSummary(), this.getInvoicesSummary(), this.getArAging(), this.getPaymentsSummary(),
      this.getLeadsBookingsSummary(), this.getAppointmentsSummary(), this.getCustomersSummary(),
      this.getTechnicianSummary(), this.getSyncStatus(),
    ]);
    return { jobs, invoices, arAging, payments, leadsBookings, appointments, customers, technicians, syncStatus };
  }
}

export const serviceTitanReportingService = new ServiceTitanReportingService();
