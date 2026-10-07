import { apiClient } from '../api.client';
import { Booking, PaginatedResponse } from '../types';
import { env } from '../../../config/env';

export class BookingService {
  public async getBookings(page = 1, pageSize = 50): Promise<PaginatedResponse<Booking>> {
    const endpoint = `/crm/v2/tenant/${env.SERVICETITAN_TENANT_ID}/bookings`;
    return apiClient.get<PaginatedResponse<Booking>>(endpoint, { page, pageSize });
  }
}

export const bookingService = new BookingService();
