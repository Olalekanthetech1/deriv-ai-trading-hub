'use client';

import { type ReactNode } from 'react';

interface AdminIntegrityGuardProps {
  children: ReactNode;
}

export function AdminIntegrityGuard({ children }: AdminIntegrityGuardProps) {
  return <>{children}</>;
}

