import { NextResponse } from 'next/server';

// Only this IP can access /users and /api/users
const ALLOWED_IP = '24.49.252.230';

// Routes that are IP-restricted
const PROTECTED = ['/users', '/api/users'];

export const config = {
  matcher: ['/users', '/api/users'],
};

export default function middleware(req) {
  const url = req.nextUrl;

  const isProtected = PROTECTED.some(p =>
    url.pathname === p || url.pathname.startsWith(p + '/')
  );

  if (!isProtected) return NextResponse.next();

  // x-vercel-forwarded-for is injected by Vercel's edge infrastructure.
  // Unlike x-forwarded-for, clients cannot set or spoof this header.
  const vercelIp = req.headers.get('x-vercel-forwarded-for') || '';
  // Also check x-real-ip as a fallback for local dev
  const realIp = req.headers.get('x-real-ip') || '';
  // Take only the first IP in case it's a comma-separated list
  const clientIp = (vercelIp || realIp).split(',')[0].trim();

  if (clientIp !== ALLOWED_IP) {
    // Return a plain 403 — don't reveal what the restriction is
    return new NextResponse(null, { status: 403 });
  }

  return NextResponse.next();
}
