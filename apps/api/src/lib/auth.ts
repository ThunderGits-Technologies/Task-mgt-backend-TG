import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Role } from "@agency/shared";
import { config } from "./config";

export interface AuthTokenPayload {
  userId: string;
  workspaceId: string;
  role: Role;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn as jwt.SignOptions["expiresIn"] });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  return jwt.verify(token, config.jwtSecret) as AuthTokenPayload;
}

export const AUTH_COOKIE_NAME = "agency_session";
