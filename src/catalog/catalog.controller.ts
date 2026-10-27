import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth/public.decorator';
import { CatalogService } from './catalog.service';
import type { CatalogResponse } from './catalog.types';

@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /** Browsing the shop needs no account, so the route is public. */
  @Public()
  @Get()
  @ApiOperation({
    summary: 'Sellable products with their plans, terms and features',
  })
  @ApiOkResponse({
    description: 'Active products that still offer an active, priced plan',
  })
  list(): Promise<CatalogResponse> {
    return this.catalog.listCatalog();
  }
}
