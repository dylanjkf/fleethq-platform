import type { ReactNode } from 'react';
import { Navigate, Outlet } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { PageSpinner } from '@/components/ui/Spinner';
import { AppShell } from '@/app/AppShell';

export function ProtectedRoute() {
  const { status } = useAuth();

  if (status === 'loading') return <PageSpinner />;
  if (status === 'unauthenticated') return <Navigate to="/login" replace />;

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

/** Wraps a route element that further requires one specific granted permission — renders a plain "not permitted" message rather than hiding the route entirely (a staff member with the wrong role should understand why, not see a blank screen). */
export function RequirePermission({ permission, children }: { permission: string; children: ReactNode }) {
  const { hasPermission } = useAuth();
  if (!hasPermission(permission)) {
    return (
      <div className="p-6 text-sm text-(--text-secondary)">
        You don't have the <code className="rounded bg-(--surface-2) px-1 py-0.5">{permission}</code> permission needed to view this page.
      </div>
    );
  }
  return <>{children}</>;
}
