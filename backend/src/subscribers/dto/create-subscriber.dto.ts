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

/** 02 §4 DTO sketch — `forbidNonWhitelisted` turns unknown fields into 400s. */
export class CreateSubscriberDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUBSCRIBER_NAME_MAX_LENGTH)
  name!: string;

  @Validate(IsDestinationUrlConstraint)
  destinationUrl!: string;

  @IsOptional()
  @IsIn(Object.values(DestinationMethod))
  destinationMethod?: DestinationMethod;

  @IsOptional()
  @Validate(IsDestinationHeadersConstraint)
  destinationHeaders?: Record<string, string>;

  @IsOptional()
  @Validate(IsDestinationAuthConstraint)
  destinationAuth?: DestinationAuthWire;

  @IsOptional()
  @Matches(SIGNATURE_HEADER_PATTERN)
  signatureHeader?: string;
}
