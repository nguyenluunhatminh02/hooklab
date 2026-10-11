/** Claims we put in the JWT (02 §2: `{ sub: userId, email }`). */
export interface JwtPayload {
  sub: number;
  email: string;
}

/** Shape attached to `request.user` by JwtStrategy; consumed via @CurrentUser(). */
export interface AuthenticatedUser {
  userId: number;
  email: string;
}

/** Wire shape behind `GET /api/auth/me` and `AuthResponse.user` (02 §2). */
export interface AuthUser {
  id: number;
  email: string;
  createdAt: string;
}

/** register/login return this bare — the §1.2 envelope's sole exception (02 §2). */
export interface AuthResponse {
  accessToken: string;
  tokenType: 'Bearer';
  user: AuthUser;
}
