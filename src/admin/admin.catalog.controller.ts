import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../common/auth/roles.decorator';
import { ZodBody, ZodParam } from '../common/http/zod.decorators';
import {
  adminCreateFeatureSchema,
  adminCreatePlanSchema,
  adminCreateProductSchema,
  adminCreateVersionSchema,
  adminPlanParamsSchema,
  adminProductParamsSchema,
  adminUpdatePlanSchema,
  adminUpdateProductSchema,
  adminUpdateVersionSchema,
  adminVersionParamsSchema,
  type AdminCreateFeatureInput,
  type AdminCreatePlanInput,
  type AdminCreateProductInput,
  type AdminCreateVersionInput,
  type AdminPlanParams,
  type AdminProductParams,
  type AdminUpdatePlanInput,
  type AdminUpdateProductInput,
  type AdminUpdateVersionInput,
  type AdminVersionParams,
} from './admin.schemas';
import type {
  AdminFeatureView,
  AdminPlanView,
  AdminProductView,
  AdminVersionView,
} from './admin.types';
import { CatalogAdminService } from './catalog-admin.service';

/**
 * Catalogue writes. Publishing is a state machine, so every route here is a
 * transition rather than an edit of something already sold.
 */
@ApiTags('admin')
@ApiBearerAuth('session')
@Roles('ADMIN')
@Controller('admin')
export class AdminCatalogController {
  constructor(private readonly catalog: CatalogAdminService) {}

  @Get('products')
  @ApiOperation({ summary: 'Every product, including drafts (admin)' })
  @ApiOkResponse({ description: 'Products with their plan version history' })
  listProducts(): Promise<AdminProductView[]> {
    return this.catalog.listProducts();
  }

  @Post('products')
  @ApiOperation({ summary: 'Create a product (admin)' })
  @ApiCreatedResponse({ description: 'The new product' })
  createProduct(
    @ZodBody(adminCreateProductSchema) body: AdminCreateProductInput,
  ): Promise<AdminProductView> {
    return this.catalog.createProduct(body);
  }

  @Patch('products/:id')
  @ApiOperation({ summary: 'Update product metadata or availability (admin)' })
  @ApiOkResponse({ description: 'The updated product' })
  updateProduct(
    @ZodParam(adminProductParamsSchema) params: AdminProductParams,
    @ZodBody(adminUpdateProductSchema) body: AdminUpdateProductInput,
  ): Promise<AdminProductView> {
    return this.catalog.updateProduct(params.id, body);
  }

  @Post('products/:id/plans')
  @ApiOperation({ summary: 'Add an edition to a product (admin)' })
  @ApiCreatedResponse({ description: 'The new plan' })
  createPlan(
    @ZodParam(adminProductParamsSchema) params: AdminProductParams,
    @ZodBody(adminCreatePlanSchema) body: AdminCreatePlanInput,
  ): Promise<AdminPlanView> {
    return this.catalog.createPlan(params.id, body);
  }

  @Patch('plans/:id')
  @ApiOperation({ summary: 'Rename an edition (identity only, admin)' })
  @ApiOkResponse({ description: 'The updated plan' })
  updatePlan(
    @ZodParam(adminPlanParamsSchema) params: AdminPlanParams,
    @ZodBody(adminUpdatePlanSchema) body: AdminUpdatePlanInput,
  ): Promise<AdminPlanView> {
    return this.catalog.updatePlan(params.id, body);
  }

  @Get('plans/:id/versions')
  @ApiOperation({ summary: 'Version history of one plan (admin)' })
  @ApiOkResponse({ description: 'Versions, newest first' })
  listVersions(
    @ZodParam(adminPlanParamsSchema) params: AdminPlanParams,
  ): Promise<AdminVersionView[]> {
    return this.catalog.listVersions(params.id);
  }

  @Post('plans/:id/versions')
  @ApiOperation({
    summary: 'Create a draft version, optionally copied from another',
  })
  @ApiCreatedResponse({ description: 'The draft version' })
  createVersion(
    @ZodParam(adminPlanParamsSchema) params: AdminPlanParams,
    @ZodBody(adminCreateVersionSchema) body: AdminCreateVersionInput,
  ): Promise<AdminVersionView> {
    return this.catalog.createVersion(params.id, body);
  }

  @Patch('versions/:id')
  @ApiOperation({ summary: 'Edit a draft version (admin)' })
  @ApiOkResponse({ description: 'The updated draft' })
  updateVersion(
    @ZodParam(adminVersionParamsSchema) params: AdminVersionParams,
    @ZodBody(adminUpdateVersionSchema) body: AdminUpdateVersionInput,
  ): Promise<AdminVersionView> {
    return this.catalog.updateVersion(params.id, body);
  }

  @Delete('versions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an unused draft version (admin)' })
  @ApiNoContentResponse({ description: 'The draft is gone' })
  deleteVersion(
    @ZodParam(adminVersionParamsSchema) params: AdminVersionParams,
  ): Promise<void> {
    return this.catalog.deleteVersion(params.id);
  }

  @Post('versions/:id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish a draft; the previous version is closed for sale',
  })
  @ApiOkResponse({ description: 'The published version' })
  publish(
    @ZodParam(adminVersionParamsSchema) params: AdminVersionParams,
  ): Promise<AdminVersionView> {
    return this.catalog.publishVersion(params.id);
  }

  @Post('versions/:id/close-for-sale')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop selling but keep renewing (admin)' })
  @ApiOkResponse({ description: 'The closed version' })
  closeForSale(
    @ZodParam(adminVersionParamsSchema) params: AdminVersionParams,
  ): Promise<AdminVersionView> {
    return this.catalog.closeForSale(params.id);
  }

  @Post('versions/:id/retire')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retire a closed version (admin)' })
  @ApiOkResponse({ description: 'The retired version' })
  retire(
    @ZodParam(adminVersionParamsSchema) params: AdminVersionParams,
  ): Promise<AdminVersionView> {
    return this.catalog.retireVersion(params.id);
  }

  @Get('features')
  @ApiOperation({ summary: 'The boolean feature catalogue (admin)' })
  @ApiOkResponse({ description: 'Features, sorted by code' })
  listFeatures(): Promise<AdminFeatureView[]> {
    return this.catalog.listFeatures();
  }

  @Post('features')
  @ApiOperation({ summary: 'Add a boolean feature (admin)' })
  @ApiCreatedResponse({ description: 'The new feature' })
  createFeature(
    @ZodBody(adminCreateFeatureSchema) body: AdminCreateFeatureInput,
  ): Promise<AdminFeatureView> {
    return this.catalog.createFeature(body);
  }
}
