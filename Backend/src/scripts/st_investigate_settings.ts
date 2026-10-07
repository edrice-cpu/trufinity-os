import { env } from '../config/env';
import { apiClient } from '../modules/servicetitan/api.client';
import * as fs from 'fs';

async function investigate() {
  const tenant = env.SERVICETITAN_TENANT_ID;

  try {
    console.log('Fetching Technicians (Settings)...');
    try {
      const techs = await apiClient.get<any>('/settings/v2/tenant/' + tenant + '/technicians?pageSize=5');
      fs.writeFileSync('st_technicians_settings.json', JSON.stringify(techs, null, 2));
      console.log('Technicians success!');
    } catch (e) {
      console.log('Technicians failed');
    }

    console.log('Fetching Employees (Settings)...');
    try {
      const emps = await apiClient.get<any>('/settings/v2/tenant/' + tenant + '/employees?pageSize=5');
      fs.writeFileSync('st_employees_settings.json', JSON.stringify(emps, null, 2));
      console.log('Employees success!');
    } catch (e) {
      console.log('Employees failed');
    }

    console.log('Done!');
    process.exit(0);
  } catch (err) {
    console.error('Error during investigation:', err);
    process.exit(1);
  }
}

investigate();
