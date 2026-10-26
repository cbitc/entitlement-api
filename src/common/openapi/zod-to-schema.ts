import type { ApiBodyOptions } from '@nestjs/swagger';
import { z } from 'zod';

type OpenApiSchema = Extract<ApiBodyOptions, { schema: unknown }>['schema'];

/**
 * Converts a zod schema into the JSON Schema that Swagger decorators accept, so
 * the validation rules and the published contract come from one definition.
 *
 * Example:
 *   @ApiBody({ schema: zodToOpenApiSchema(createOrderSchema) })
 */
export const zodToOpenApiSchema = (schema: z.ZodType): OpenApiSchema =>
  z.toJSONSchema(schema) as OpenApiSchema;
