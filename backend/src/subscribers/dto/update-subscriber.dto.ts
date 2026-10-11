import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Validate,
} from 'class-validator';
import { DestinationMethod } from '../../generated/prisma/enums';
import {
  SIGNATURE_HEADER_PATTERN,
  SUBSCRIBER_NAME_MAX_LENGTH,
} from '../subscribers.constants';
import {
  IsDestinationAuthConstraint,
  IsDestinationHeadersConstraint,
  IsDestinationUrlConstraint,
} from '../subscribers.constraints';
import { DestinationAuthWire } from '../destination-auth';

/**
 * PATCH body (02 §4): every CreateSubscriberDto field, optional.
 *
 * Conventions §3 asks for `extends PartialType(CreateSubscriberDto)`, but
 * `@nestjs/mapped-types` is not installed in this workspace and dependencies
 * are frozen for this phase — the fields mirror Create one-for-one so the
 * eventual swap is mechanical (tracked in the P2 hand-off issues).
 */
export class UpdateSubscriberDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUBSCRIBER_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @Validate(IsDestinationUrlConstraint)
  destinationUrl?: string;

  @IsOptional()
  @IsIn(Object.values(DestinationMethod))
  destinationMethod?: DestinationMethod;

  @IsOptional()
  @Validate(IsDestinationHeadersConstraint)
  destinationHeaders?: Record<string, string>;

  /**
   * PATCH rule for credentials (02 §4): absent = keep the stored credential
   * (the client only ever holds a hint, so it cannot resend the real one);
   * `{ type: 'none' }` = clear it; any other type = replace it wholesale.
   */
  @IsOptional()
  @Validate(IsDestinationAuthConstraint)
  destinationAuth?: DestinationAuthWire;

  @IsOptional()
  @Matches(SIGNATURE_HEADER_PATTERN)
  signatureHeader?: string;
}
