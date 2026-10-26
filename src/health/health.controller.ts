import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../infra/prisma/prisma.service';

@ApiTags('health')
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liveness probe: the process is running' })
  @ApiOkResponse({ description: 'The process is alive' })
  liveness() {
    return {
      status: 'ok' as const,
      name: this.config.appName,
      version: this.config.appVersion,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness is the only probe that touches MySQL, so orchestrators can keep
   * the pod out of rotation while the database is unreachable.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe: MySQL is reachable' })
  @ApiOkResponse({ description: 'The database answered a trivial query' })
  async readiness() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException('Database is not reachable');
    }

    return {
      status: 'ok' as const,
      checks: { database: 'up' as const },
      timestamp: new Date().toISOString(),
    };
  }
}
