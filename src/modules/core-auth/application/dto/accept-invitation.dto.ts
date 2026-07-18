import { IsString, MinLength } from 'class-validator';

export class AcceptInvitationDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}
