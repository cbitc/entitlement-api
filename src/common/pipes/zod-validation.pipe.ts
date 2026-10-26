import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppException } from '../errors/app.exception';
import { formatZodError } from '../zod/format-zod-error';

/**
 * Validates and transforms a handler argument with a zod schema.
 *
 * The parsed value is what the handler receives, so coercions and unknown-key
 * stripping happen exactly once, at the boundary.
 */
@Injectable()
export class ZodValidationPipe<
  TSchema extends z.ZodType,
> implements PipeTransform<unknown, z.output<TSchema>> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.output<TSchema> {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }

    throw AppException.validation(formatZodError(result.error));
  }
}
