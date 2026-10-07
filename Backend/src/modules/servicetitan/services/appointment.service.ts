import { apiClient } from '../api.client';
import { Appointment, PaginatedResponse } from '../types';
import { env } from '../../../config/env';

export class AppointmentService {
  public async getAppointments(page = 1, pageSize = 50): Promise<PaginatedResponse<Appointment>> {
    const endpoint = `/jpm/v2/tenant/${env.SERVICETITAN_TENANT_ID}/appointments`;
    return apiClient.get<PaginatedResponse<Appointment>>(endpoint, { page, pageSize });
  }
}

export const appointmentService = new AppointmentService();
