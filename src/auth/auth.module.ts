import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AppConfig } from '../config/app-config.service';
import { UsersModule } from '../users/users.module';
import { VerificationModule } from '../verification/verification.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { SessionTokenService } from './session-token.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        secret: config.jwtSecret,
        signOptions: {
          expiresIn: config.jwtTtlSeconds,
          issuer: config.jwtIssuer,
          audience: config.jwtAudience,
        },
      }),
    }),
    UsersModule,
    VerificationModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionTokenService,
    // Registered here (not in AppModule) so the guards resolve against this
    // module's imports, which keeps users free of any auth dependency.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AuthModule {}
