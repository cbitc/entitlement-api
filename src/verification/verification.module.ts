import { Module } from '@nestjs/common';
import { MailModule } from '../infra/mail/mail.module';
import { VerificationService } from './verification.service';

@Module({
  imports: [MailModule],
  providers: [VerificationService],
  exports: [VerificationService],
})
export class VerificationModule {}
