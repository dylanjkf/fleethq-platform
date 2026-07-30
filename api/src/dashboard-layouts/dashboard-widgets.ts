/**
 * The closed set of dashboard widget keys FleetHQ can render. A saved layout /
 * preset is an ordered list of these with a `visible` flag; the frontend has a
 * matching registry (features/dashboard/widget-registry.ts). Add a key here
 * (and there) when a new dashboard widget ships.
 */
export const DASHBOARD_WIDGETS = [
  { key: 'count_fleet', label: 'Fleet count' },
  { key: 'count_operators', label: 'Operators count' },
  { key: 'count_users', label: 'Users count' },
  { key: 'system_health', label: 'System health' },
  { key: 'company_status', label: 'Company status' },
  { key: 'upcoming_maintenance', label: 'Upcoming maintenance' },
  { key: 'recent_activity', label: 'Recent activity' },
  { key: 'fleet_graph', label: 'Fleet graph' },
  { key: 'operations_snapshot', label: 'Operations snapshot' },
  { key: 'compliance_position', label: 'Compliance position' },
  { key: 'expiring_soon', label: 'Expiring soon' },
  { key: 'fleet_utilisation', label: 'Fleet utilisation' },
] as const;

export const DASHBOARD_WIDGET_KEYS = DASHBOARD_WIDGETS.map((w) => w.key) as string[];
