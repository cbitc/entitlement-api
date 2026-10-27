import { Module } from '@nestjs/common';
import { LicenseTokenService } from './license-token.service';
import {
  LicenseJwksController,
  LicensingController,
} from './licensing.controller';
import { LicensingService } from './licensing.service';

@Module({
  controllers: [LicensingController, LicenseJwksController],
  providers: [LicensingService, LicenseTokenService],
  exports: [LicensingService],
})
export class LicensingModule {}
