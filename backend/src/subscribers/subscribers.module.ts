import { Module } from '@nestjs/common';
import { SecretService } from './secret.service';
import { SubscribersController } from './subscribers.controller';
import { SubscribersService } from './subscribers.service';

/**
 * PrismaModule and MembershipModule are @Global() at the root, so this module
 * only wires its own controller/providers. SecretService stays internal —
 * rotate is reached through SubscribersService, never alongside it.
 */
@Module({
  controllers: [SubscribersController],
  providers: [SubscribersService, SecretService],
  exports: [SubscribersService],
})
export class SubscribersModule {}
