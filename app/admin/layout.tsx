import type { ReactNode } from 'react';
import { AdminIntegrityGuard } from '@/components/admin/admin-integrity-guard';
import { AdminThemeProvider } from '@/components/admin/admin-theme-provider';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <AdminIntegrityGuard>
      <AdminThemeProvider>
        {children}
      </AdminThemeProvider>
    </AdminIntegrityGuard>
  );
}
