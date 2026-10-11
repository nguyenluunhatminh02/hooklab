import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { WORKSPACE_NAME_MAX_LENGTH } from '../../common/constants/app.constants';

/** 02 §3 DTO sketch. */
export class CreateWorkspaceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(WORKSPACE_NAME_MAX_LENGTH)
  name!: string;
}
