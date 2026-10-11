import { IsObject } from 'class-validator';

export class ReplayDto {
  /** 02 §6/§14: v1 accepts a JSON object body only — top-level arrays are validation_error. */
  @IsObject()
  body!: Record<string, unknown>;
}
