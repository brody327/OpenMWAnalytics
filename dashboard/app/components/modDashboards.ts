// mod_id -> its bespoke, domain-aware dashboard.
//
// The whole design in one table: MOST mods have no custom dashboard and fall back to the
// envelope-level summary the mod page renders for everyone (counts, sessions, first/last
// seen, an explorer link). A mod earns a rich view only when someone teaches the platform
// its event schema and writes the aggregation for it -- today that is exactly CCFF.
//
// Adding a mod's dashboard is one line here. That is the same "register on first sight,
// zero-DDL" spirit as the `mods` table itself: the platform is open, and depth is opt-in.
//
// The value type allows an async component (a Server Component that fetches its own data),
// so the mod page can pick a dashboard by id without knowing what data each one needs.

import { ConfrontationDashboard } from './ConfrontationDashboard';

type ModDashboard = () => React.ReactNode | Promise<React.ReactNode>;

export const MOD_DASHBOARDS: Record<string, ModDashboard> = {
  ccff: ConfrontationDashboard,
};
