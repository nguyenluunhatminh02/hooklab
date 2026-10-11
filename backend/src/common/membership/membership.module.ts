import { Global, Module } from '@nestjs/common';
import { MembershipService } from './membership.service';

/**
 * Every workspace-scoped module (workspaces, subscribers, records, replay)
 * needs the matrix checks; root-anchored once here instead of re-providing
 * the service per module (conventions §3: register a service once).
 */
@Global()
@Module({
  providers: [MembershipService],
  exports: [MembershipService],
})
export class MembershipModule {}
