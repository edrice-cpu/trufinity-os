import { Router, Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';

import { customerService } from './services/customer.service';
import { locationService } from './services/location.service';
import { bookingService } from './services/booking.service';
import { leadService } from './services/lead.service';
import { jobService } from './services/job.service';
import { appointmentService } from './services/appointment.service';
import { invoiceService } from './services/invoice.service';
import { paymentService } from './services/payment.service';
import { serviceTitanBusinessUnitIngestionService } from './ingestion/business-unit.ingestion';

const router = Router();

// Middleware to restrict routes to development only
const devOnly = (_req: Request, res: Response, next: NextFunction) => {
  if (env.NODE_ENV !== 'development') {
    res.status(403).json({ error: 'Integration test endpoints are only available in development mode' });
    return;
  }
  next();
};

router.use(devOnly);

// Business Units are a small settings list (department names, e.g. "Company",
// "Service", "New Construction") used to resolve the dashboard Department
// filter - no scheduler runs ServiceTitan ingestion yet, so this is manual.
router.post('/sync/business-units', async (_req, res, next) => {
  try {
    const result = await serviceTitanBusinessUnitIngestionService.run();
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

const handlePagination = (req: Request) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || 10;
  return { page, pageSize };
};

router.get('/customers', async (req, res, next) => {
  try {
    const { page, pageSize } = handlePagination(req);
    const data = await customerService.getCustomers(page, pageSize);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/locations', async (req, res, next) => {
  try {
    const { page, pageSize } = handlePagination(req);
    const data = await locationService.getLocations(page, pageSize);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/bookings', async (req, res, next) => {
  try {
    const { page, pageSize } = handlePagination(req);
    const data = await bookingService.getBookings(page, pageSize);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/leads', async (req, res, next) => {
  try {
    const { page, pageSize } = handlePagination(req);
    const data = await leadService.getLeads(page, pageSize);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/jobs', async (req, res, next) => {
  try {
    const { page, pageSize } = handlePagination(req);
    const data = await jobService.getJobs(page, pageSize);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/appointments', async (req, res, next) => {
  try {
    const { page, pageSize } = handlePagination(req);
    const data = await appointmentService.getAppointments(page, pageSize);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/invoices', async (req, res, next) => {
  try {
    const { page, pageSize } = handlePagination(req);
    const data = await invoiceService.getInvoices(page, pageSize);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/payments', async (req, res, next) => {
  try {
    const { page, pageSize } = handlePagination(req);
    const data = await paymentService.getPayments(page, pageSize);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export const serviceTitanRouter = router;
