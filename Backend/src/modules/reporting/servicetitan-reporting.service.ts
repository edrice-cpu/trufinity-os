import { KnexServiceTitanReportingRepository } from './servicetitan-reporting.repository';
import { env } from '../../config/env';
import type { DateRangeFilter, ServiceTitanDepartment } from '../../utils/dashboard-filters';
import type { AgentMetricsItem, AbandonedCallsAggregate, CallRevenueAttribution, Paginated, AbandonedCallItem, StInvoiceListItem, StReportingSnapshot, VoicemailCallbackAlertItem, VoicemailCallbackAlertStatus } from './servicetitan-reporting.types';

const SOURCE_SYSTEM = `ServiceTitan:${env.SERVICETITAN_TENANT_ID}`;

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

  public listAbandonedCalls(
    from: Date, to: Date, page: number, pageSize: number, sortDir: 'asc' | 'desc',
  ): Promise<Paginated<AbandonedCallItem>> {
    return this.repository.listAbandonedCalls(from, to, page, pageSize, sortDir, SOURCE_SYSTEM);
  }

  public getAbandonedCallsAggregate(from: Date, to: Date): Promise<AbandonedCallsAggregate> {
    return this.repository.getAbandonedCallsAggregate(from, to, SOURCE_SYSTEM);
  }

  public listVoicemailCallbackAlerts(
    page: number,
    pageSize: number,
    status?: VoicemailCallbackAlertStatus,
    from?: Date,
    to?: Date,
  ): Promise<Paginated<VoicemailCallbackAlertItem>> {
    return this.repository.listVoicemailCallbackAlerts(page, pageSize, SOURCE_SYSTEM, status, from, to);
  }

  public getAgentMetrics(
    from: Date,
    to: Date,
    page: number,
    pageSize: number,
    agentId?: string,
  ): Promise<Paginated<AgentMetricsItem>> {
    return this.repository.getAgentMetrics(from, to, page, pageSize, SOURCE_SYSTEM, agentId);
  }

  public getCallRevenueAttribution(callId: string): Promise<CallRevenueAttribution> {
    return this.repository.getCallRevenueAttribution(callId, SOURCE_SYSTEM);
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
