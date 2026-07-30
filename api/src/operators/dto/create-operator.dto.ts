import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateOperatorDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;
}
