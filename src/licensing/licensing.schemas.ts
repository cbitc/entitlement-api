import { z } from 'zod';

const productCodeSchema = z.string().trim().min(1).max(64);
const machineIdSchema = z.string().trim().min(1).max(128);

/** Body of `POST /licensing/licenses/obtain` and `/offline`. */
export const licenseMachineSchema = z.object({
  product: productCodeSchema,
  machineId: machineIdSchema,
});

/** Body of `POST /licensing/licenses/deactivate`. */
export const deactivateLicenseSchema = licenseMachineSchema;

export type LicenseMachineInput = z.output<typeof licenseMachineSchema>;
