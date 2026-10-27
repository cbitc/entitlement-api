import { z } from 'zod';

const productCodeSchema = z.string().trim().min(1).max(64);
const planCodeSchema = z.string().trim().min(1).max(64);

export const createOrderSchema = z.object({
  productCode: productCodeSchema,
  planCode: planCodeSchema,
  interval: z.enum(['MONTH', 'YEAR']),
  currency: z.string().trim().length(3).toLowerCase().default('cny'),
});

export const refundOrderSchema = z.object({
  amountCents: z.number().int().positive().optional(),
  reason: z.string().trim().min(1).max(255),
});

export const orderParamsSchema = z.object({
  id: z.string().trim().min(1).max(191),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type RefundOrderInput = z.infer<typeof refundOrderSchema>;
