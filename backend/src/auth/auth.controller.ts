import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Public } from '../common/guards/public.decorator';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthResponse, AuthUser, AuthenticatedUser } from './auth.types';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** 201 + AuthResponse bare (02 §2 — the §1.2 envelope's exception). */
  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto): Promise<AuthResponse> {
    return this.authService.register(dto);
  }

  /** 200 — POST defaults to 201, which would break the contract. */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<AuthResponse> {
    return this.authService.login(dto);
  }

  /** 200 `{ data: User }` — this one IS wrapped (02 §2). */
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser): Promise<{ data: AuthUser }> {
    return { data: await this.authService.getMe(user.userId) };
  }
}
