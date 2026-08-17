import { IsString, IsStrongPassword, MinLength } from 'class-validator';

export class AcceptInvitationDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @IsStrongPassword({
    minLength: 8,
    minLowercase: 1,
    minUppercase: 1,
    minNumbers: 1,
    minSymbols: 1,
  })
  password!: string;
}
