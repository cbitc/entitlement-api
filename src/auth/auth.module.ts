import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AppConfig } from '../config/app-config.service';
import { UsersModule } from '../users/users.module';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { SessionTokenService } from './session-token.service';
import { LoginTicketService } from './sso/login-ticket.service';
import { OidcClient } from './sso/oidc.client';
import { SsoController } from './sso/sso.controller';
import { SsoService } from './sso/sso.service';
import { SsoStateService } from './sso/sso-state.service';

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
  ],
  controllers: [SsoController],
  providers: [
    SessionTokenService,
    OidcClient,
    SsoStateService,
    SsoService,
    LoginTicketService,
    // Registered here (not in AppModule) so the guards resolve against this
    // module's imports, which keeps users free of any auth dependency.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AuthModule {}
