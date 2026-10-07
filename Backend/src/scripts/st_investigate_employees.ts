import { env } from '../config/env';
import { apiClient } from '../modules/servicetitan/api.client';
import * as fs from 'fs';

async function investigate() {
  const tenant = env.SERVICETITAN_TENANT_ID;

  try {
    console.log('Fetching Employees...');
    const employees = await apiClient.get<any>('/crm/v2/tenant/' + tenant + '/employees?pageSize=5');
    fs.writeFileSync('st_employees.json', JSON.stringify(employees, null, 2));

    console.log('Done!');
    process.exit(0);
  } catch (err) {
    console.error('Error during investigation:', err);
    process.exit(1);
  }
}

investigate();
