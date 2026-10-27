import { z } from 'zod';

const productCodeSchema = z.string().trim().min(1).max(64);
const machineIdSchema = z.string().trim().min(1).max(128);
const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** Body of `POST /licensing/licenses/obtain` and `/offline`. */
export const licenseMachineSchema = z.object({
  product: productCodeSchema,
  machineId: machineIdSchema,
});

/** Body of `POST /licensing/licenses/deactivate`. */
export const deactivateLicenseSchema = licenseMachineSchema;

/** Query of `GET /licensing/admin/licenses`. */
export const adminLicenseQuerySchema = z.object({
  email: emailSchema,
});

export type LicenseMachineInput = z.output<typeof licenseMachineSchema>;
export type AdminLicenseQuery = z.output<typeof adminLicenseQuerySchema>;
