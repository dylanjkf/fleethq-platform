import { IsString, MaxLength, MinLength } from 'class-validator';

export class RetryPaymentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  invoiceId!: string;
}
