import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { LIST_LIMIT_MAX, SEARCH_QUERY_MAX_LENGTH } from '../../common/constants/app.constants';

export class ListRecordsQueryDto {
  @IsOptional()
  @IsIn(['verified', 'rejected'])
  status?: 'verified' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_QUERY_MAX_LENGTH)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIST_LIMIT_MAX)
  limit?: number;

  /** Opaque cursor from a previous page's meta.nextCursor. */
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeReplays?: boolean;
}
