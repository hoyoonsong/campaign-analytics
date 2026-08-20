import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { PORTAL_URL } from '../lib/supabase';

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
}

const items: NavItem[] = [
  { to: '/', label: 'Analytics', end: true },
  { to: '/search', label: 'Search' },
  { to: '/suggestions', label: 'Contact' },
  { to: '/import', label: 'Import' },
  { to: '/petitions', label: 'Petitions' },
  { to: '/tracking', label: 'Tracking' },
  { to: '/universes', label: 'Universes' },
  { to: '/usage', label: 'Usage' },
  { to: '/logs', label: 'Logs' },
];

export function Layout() {
  const { profile, signOut } = useAuth();
  const { pathname } = useLocation();

  const isItemActive = (item: NavItem) =>
    item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(item.to + '/');

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-3 py-2.5 sm:px-4 sm:py-3">
          <div className="flex min-w-0 items-center gap-6 md:gap-8">
            <NavLink to="/" className="flex shrink-0 items-center gap-3">
              <img
                src="/achilles-logo-v2.png"
                alt="Todd Achilles for US Senate"
                className="h-8 w-auto bg-transparent sm:h-11"
              />
            </NavLink>
            <nav className="hidden items-center gap-1 md:flex">
              {items.map((i) => (
                <NavLink
                  key={i.to}
                  to={i.to}
                  end={i.end}
                  className={clsx(
                    'rounded-md px-3 py-2 text-sm font-medium',
                    isItemActive(i)
                      ? 'bg-brand-50 text-brand-700'
                      : 'text-slate-600 hover:bg-slate-100',
                  )}
                >
                  {i.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <a
              href={PORTAL_URL}
              className="hidden text-xs font-medium text-brand-600 hover:underline sm:inline"
            >
              Campaign portal
            </a>
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium text-slate-700">
                {profile?.full_name || profile?.email}
              </p>
              <p className="text-xs capitalize text-slate-400">{profile?.role}</p>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              className="btn-secondary px-2.5 py-1.5 text-xs sm:px-4 sm:py-2 sm:text-sm"
            >
              Sign out
            </button>
          </div>
        </div>
        <nav className="flex items-center gap-0.5 overflow-x-auto border-t border-slate-100 px-1.5 py-1 scrollbar-none md:hidden">
          {items.map((i) => (
            <NavLink
              key={i.to}
              to={i.to}
              end={i.end}
              className={clsx(
                'shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium sm:px-3 sm:text-sm',
                isItemActive(i) ? 'bg-brand-50 text-brand-700' : 'text-slate-600',
              )}
            >
              {i.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-3 py-4 sm:px-4 sm:py-6 lg:py-8">
        <Outlet />
      </main>
    </div>
  );
}
