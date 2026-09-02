import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { clsx } from "clsx";
import { useAuth } from "../context/AuthContext";
import { PORTAL_DASHBOARD_URL } from "../lib/supabase";

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
}

const items: NavItem[] = [
  { to: "/", label: "Analytics", end: true },
  { to: "/search", label: "Search" },
  { to: "/suggestions", label: "Contact" },
  { to: "/import", label: "Import" },
  { to: "/petitions", label: "Petitions" },
  { to: "/tracking", label: "Tracking" },
  { to: "/universes", label: "Universes" },
  { to: "/usage", label: "Usage" },
  { to: "/logs", label: "Logs" },
];

function initials(name?: string | null, email?: string | null) {
  const n = (name ?? "").trim();
  if (n) {
    const parts = n.split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] ?? "";
    const b = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
    return (a + b).toUpperCase() || "?";
  }
  const e = (email ?? "").trim();
  return (e[0] ?? "?").toUpperCase();
}

function roleLabel(role?: string | null) {
  if (!role) return "";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function Layout() {
  const { profile, signOut } = useAuth();
  const { pathname } = useLocation();
  const [openMenu, setOpenMenu] = useState(false);
  const accountRef = useRef<HTMLDivElement | null>(null);

  const isItemActive = (item: NavItem) =>
    item.end
      ? pathname === item.to
      : pathname === item.to || pathname.startsWith(item.to + "/");

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (
        accountRef.current &&
        !accountRef.current.contains(e.target as Node)
      ) {
        setOpenMenu(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  useEffect(() => {
    setOpenMenu(false);
  }, [pathname]);

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
                    "rounded-md px-3 py-2 text-sm font-medium",
                    isItemActive(i)
                      ? "bg-brand-50 text-brand-700"
                      : "text-slate-600 hover:bg-slate-100",
                  )}
                >
                  {i.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div
            ref={accountRef}
            className="relative ml-1 shrink-0 border-l border-slate-200 pl-3 sm:ml-2 sm:pl-4"
          >
            <button
              type="button"
              onClick={() => setOpenMenu((open) => !open)}
              className={clsx(
                "inline-flex items-center gap-2 rounded-full py-1 pl-1 pr-1.5 text-left hover:bg-slate-100 sm:pr-2.5",
                openMenu && "bg-slate-100",
              )}
              aria-expanded={openMenu}
              aria-haspopup="menu"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
                {initials(profile?.full_name, profile?.email)}
              </span>
              <span className="hidden min-w-0 max-w-[10rem] lg:block">
                <span className="block truncate text-sm font-medium leading-tight text-slate-800">
                  {profile?.full_name || profile?.email}
                </span>
                <span className="block truncate text-[11px] leading-tight text-slate-400">
                  {roleLabel(profile?.role)}
                </span>
              </span>
              <svg
                className={clsx(
                  "hidden h-3.5 w-3.5 shrink-0 text-slate-400 transition lg:block",
                  openMenu && "rotate-180",
                )}
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden
              >
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
            {openMenu && (
              <div
                role="menu"
                className="absolute right-0 top-full z-50 mt-1.5 w-56 rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
              >
                <div className="border-b border-slate-100 px-3 py-2 lg:hidden">
                  <p className="truncate text-sm font-medium text-slate-800">
                    {profile?.full_name || profile?.email}
                  </p>
                  <p className="truncate text-xs text-slate-400">
                    {roleLabel(profile?.role)}
                  </p>
                </div>
                <a
                  href={PORTAL_DASHBOARD_URL}
                  role="menuitem"
                  className="flex w-full items-center px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Forms Dashboard
                </a>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void signOut()}
                  className="flex w-full items-center px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
        <nav className="flex items-center gap-0.5 overflow-x-auto border-t border-slate-100 px-1.5 py-1 scrollbar-none md:hidden">
          {items.map((i) => (
            <NavLink
              key={i.to}
              to={i.to}
              end={i.end}
              className={clsx(
                "shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium sm:px-3 sm:text-sm",
                isItemActive(i)
                  ? "bg-brand-50 text-brand-700"
                  : "text-slate-600",
              )}
            >
              {i.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto min-w-0 max-w-7xl overflow-x-clip px-3 py-4 sm:px-4 sm:py-6 lg:py-8">
        <Outlet />
      </main>
    </div>
  );
}
