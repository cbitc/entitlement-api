import { Body, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';

/**
 * Route-boundary sugar: `@ZodBody(schema) body: z.infer<typeof schema>`.
 *
 * Kept next to the pipe so feature code never instantiates a pipe by hand.
 */
export const ZodBody = <TSchema extends z.ZodType>(schema: TSchema) =>
  Body(new ZodValidationPipe(schema));

export const ZodQuery = <TSchema extends z.ZodType>(schema: TSchema) =>
  Query(new ZodValidationPipe(schema));

export const ZodParam = <TSchema extends z.ZodType>(schema: TSchema) =>
  Param(new ZodValidationPipe(schema));
