import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { useAuth } from '@/hooks/useAuth';

interface NavItem {
  to: string;
  label: string;
  permission?: string;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', permission: 'analytics:view' },
  { to: '/organisations', label: 'Organisations', permission: 'organisations:view' },
  { to: '/announcements', label: 'Announcements', permission: 'support:view' },
  { to: '/feature-flags', label: 'Feature Flags', permission: 'feature_flags:view' },
  { to: '/fleet', label: 'Fleet', permission: 'fleet:view' },
  { to: '/system', label: 'System Health', permission: 'system:view' },
  { to: '/audit-log', label: 'Audit Log', permission: 'audit_log:view' },
];

const linkClasses = ({ isActive }: { isActive: boolean }) =>
  `block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    isActive ? 'bg-accent-500/15 text-accent-400' : 'text-(--text-secondary) hover:bg-(--surface-2) hover:text-(--text-primary)'
  }`;

export function AppShell({ children }: { children: ReactNode }) {
  const { admin, hasPermission, logout } = useAuth();
  const visibleItems = NAV_ITEMS.filter((item) => !item.permission || hasPermission(item.permission));

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-(--border-subtle) bg-(--surface-1) p-4">
        <div className="mb-6 px-2">
          <p className="text-sm font-bold tracking-tight">FleetHQ Admin</p>
          <p className="text-xs text-(--text-tertiary)">Internal platform ops</p>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {visibleItems.map((item) => (
            <NavLink key={item.to} to={item.to} className={linkClasses} end={item.to === '/'}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-4 border-t border-(--border-subtle) pt-4">
          <NavLink to="/settings" className={linkClasses}>
            Security settings
          </NavLink>
          <div className="mt-3 px-3">
            <p className="truncate text-sm font-medium">{admin?.fullName}</p>
            <p className="truncate text-xs text-(--text-tertiary)">{admin?.role.name}</p>
          </div>
          <button
            onClick={() => void logout()}
            className="mt-2 w-full rounded-lg px-3 py-2 text-left text-sm text-(--text-secondary) transition-colors hover:bg-(--surface-2) hover:text-(--text-primary)"
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl p-6">{children}</div>
      </main>
    </div>
  );
}
