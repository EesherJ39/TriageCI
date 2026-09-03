import { createHmac, timingSafeEqual } from "node:crypto";

function constantTimeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyApiToken(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  return constantTimeTextEqual(provided, expected);
}

export function githubSignature(body: Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyGithubSignature(
  body: Buffer,
  provided: string | undefined,
  secret: string,
): boolean {
  if (!provided || !provided.startsWith("sha256=") || !secret) return false;
  return constantTimeTextEqual(provided, githubSignature(body, secret));
}
