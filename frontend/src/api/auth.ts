import { apiRequest } from './httpClient';
import type { AuthResponse, User } from './types';

export interface CredentialsInput {
  email: string;
  password: string;
}

/** Register/login return `AuthResponse` bare — the only unwrapped routes (02 §1.2). */
export function register(input: CredentialsInput): Promise<AuthResponse> {
  return apiRequest<AuthResponse>('/auth/register', { method: 'POST', body: input, bare: true });
}

export function login(input: CredentialsInput): Promise<AuthResponse> {
  return apiRequest<AuthResponse>('/auth/login', { method: 'POST', body: input, bare: true });
}

export function fetchMe(): Promise<User> {
  return apiRequest<User>('/auth/me');
}
