import { z } from 'zod';

/**
 * Query contract shared by every paged list.
 *
 * Kept deliberately dumb: offset paging is enough at this size, and a stable
 * `(createdAt, id)` sort in each query keeps pages from shuffling.
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type Pagination = z.output<typeof paginationSchema>;

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
}

export const skipFor = (pagination: Pagination): number =>
  (pagination.page - 1) * pagination.limit;

export const pageOf = <T>(
  items: readonly T[],
  total: number,
  pagination: Pagination,
): Page<T> => ({
  items,
  total,
  page: pagination.page,
  limit: pagination.limit,
});

/** Maps the rows of a page while keeping its paging metadata intact. */
export const mapPage = <T, R>(page: Page<T>, map: (item: T) => R): Page<R> => ({
  ...page,
  items: page.items.map(map),
});
