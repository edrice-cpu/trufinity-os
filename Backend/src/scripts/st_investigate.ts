import { env } from '../config/env';
import { apiClient } from '../modules/servicetitan/api.client';
import * as fs from 'fs';

async function investigate() {
  const tenant = env.SERVICETITAN_TENANT_ID;

  try {
    console.log('Fetching Invoices...');
    const invoices = await apiClient.get<any>('/accounting/v2/tenant/' + tenant + '/invoices?pageSize=5');
    fs.writeFileSync('st_invoices.json', JSON.stringify(invoices, null, 2));

    console.log('Fetching Payments...');
    const payments = await apiClient.get<any>('/accounting/v2/tenant/' + tenant + '/payments?pageSize=5');
    fs.writeFileSync('st_payments.json', JSON.stringify(payments, null, 2));

    console.log('Done!');
    process.exit(0);
  } catch (err) {
    console.error('Error during investigation:', err);
    process.exit(1);
  }
}

investigate();
