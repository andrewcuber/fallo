"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useField } from "@/components/providers";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  MapPin,
  CloudSun,
  Layers,
  RefreshCw,
  SlidersHorizontal,
  CalendarDays,
  GitCompare,
  Database,
  Menu,
  X,
  Plus,
} from "lucide-react";

const baseNav = [
  { label: "Overview", href: "/", icon: LayoutDashboard },
  { label: "My Fields", href: "/fields", icon: MapPin },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const { activeField } = useField();

  const fieldNav = activeField
    ? [
        {
          label: "Climate",
          href: `/field/${activeField.id}/climate`,
          icon: CloudSun,
        },
        { label: "Soil", href: `/field/${activeField.id}/soil`, icon: Layers },
        {
          label: "Crop Rotation Lab",
          href: `/field/${activeField.id}/rotations`,
          icon: RefreshCw,
        },
        {
          label: "What-If Simulator",
          href: `/field/${activeField.id}/simulator`,
          icon: SlidersHorizontal,
        },
        {
          label: "Field Calendar",
          href: `/field/${activeField.id}/calendar`,
          icon: CalendarDays,
        },
        {
          label: "Climate Analogues",
          href: `/field/${activeField.id}/analogues`,
          icon: GitCompare,
        },
      ]
    : [];

  const allNav = [...baseNav];

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  function NavLink({
    href,
    icon: Icon,
    label,
  }: {
    href: string;
    icon: React.ElementType;
    label: string;
  }) {
    const active = isActive(href);
    return (
      <Link
        href={href}
        onClick={() => setMobileOpen(false)}
        className={cn(
          "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
          active
            ? "bg-electric/20 text-electric"
            : "text-offwhite/60 hover:bg-offwhite/10 hover:text-offwhite"
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {label}
      </Link>
    );
  }

  return (
    <div className="flex min-h-screen">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex w-64 flex-col bg-space text-offwhite fixed inset-y-0 left-0 z-40 starfield">
        <div className="flex items-center gap-2 px-5 py-5">
          <Link
            href="/"
            aria-label="fallo home"
            className="inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-electric rounded-sm"
          >
            <Image
              src="/fallo-logo.svg"
              alt="fallo"
              width={114}
              height={45}
              priority
              className="h-8 w-auto object-contain"
            />
          </Link>
        </div>

        <div className="px-3 pb-2">
          <Link
            href="/fields/new"
            className="flex items-center gap-2 rounded-md bg-electric/15 px-3 py-2 text-sm font-medium text-electric hover:bg-electric/25 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Add Field
          </Link>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-2 overflow-y-auto">
          {allNav.map((item) => (
            <NavLink key={item.href} {...item} />
          ))}

          {fieldNav.length > 0 && (
            <>
              <div className="pt-4 pb-1 px-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-offwhite/30">
                  Active Field
                </p>
                <p className="text-xs text-offwhite/60 truncate mt-0.5">
                  {activeField?.name}
                </p>
              </div>
              {fieldNav.map((item) => (
                <NavLink key={item.href} {...item} />
              ))}
            </>
          )}
        </nav>

        {/* Subtle bottom accent line */}
        <div className="h-px bg-gradient-to-r from-transparent via-electric/30 to-transparent mx-4 mb-2" />
        <div className="px-5 pb-4 space-y-1.5">
          <Link
            href="/data-sources"
            className="flex items-center gap-2 text-[11px] text-offwhite/40 hover:text-offwhite/70 transition-colors"
          >
            <Database className="h-3 w-3" />
            Data Sources
          </Link>
          <p className="text-[10px] text-offwhite/30">
            Decision-support for crop rotation
          </p>
        </div>
      </aside>

      {/* Mobile Header */}
      <div className="lg:hidden fixed top-0 inset-x-0 z-40 bg-space text-offwhite border-b border-offwhite/10">
        <div className="flex items-center justify-between px-4 py-3">
          <Link
            href="/"
            aria-label="fallo home"
            className="inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-electric rounded-sm"
          >
            <Image
              src="/fallo-logo.svg"
              alt="fallo"
              width={114}
              height={45}
              priority
              className="h-7 w-auto object-contain"
            />
          </Link>
          <button
            onClick={() => setMobileOpen(true)}
            className="inline-flex items-center justify-center rounded-md p-2 text-offwhite hover:bg-slate-blue transition-colors"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Mobile Overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative z-10 w-72 max-w-[85vw] bg-space text-offwhite h-full shadow-xl flex flex-col starfield">
            <div className="flex items-center justify-between px-5 py-4 border-b border-offwhite/10">
              <Link
                href="/"
                onClick={() => setMobileOpen(false)}
                aria-label="fallo home"
                className="inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-electric rounded-sm"
              >
                <Image
                  src="/fallo-logo.svg"
                  alt="fallo"
                  width={114}
                  height={45}
                  className="h-7 w-auto object-contain"
                />
              </Link>
              <button
                onClick={() => setMobileOpen(false)}
                className="rounded-md p-2 text-offwhite hover:bg-slate-blue transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="px-3 py-3">
              <Link
                href="/fields/new"
                onClick={() => setMobileOpen(false)}
                className="flex items-center gap-2 rounded-md bg-electric/15 px-3 py-2 text-sm font-medium text-electric hover:bg-electric/25 transition-colors"
              >
                <Plus className="h-4 w-4" />
                Add Field
              </Link>
            </div>

            <nav className="flex-1 space-y-1 px-3 py-2 overflow-y-auto">
              {allNav.map((item) => (
                <NavLink key={item.href} {...item} />
              ))}

              {fieldNav.length > 0 && (
                <>
                  <div className="pt-4 pb-1 px-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-offwhite/30">
                      Active Field
                    </p>
                    <p className="text-xs text-offwhite/60 truncate mt-0.5">
                      {activeField?.name}
                    </p>
                  </div>
                  {fieldNav.map((item) => (
                    <NavLink key={item.href} {...item} />
                  ))}
                </>
              )}
            </nav>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 lg:ml-64 pt-14 lg:pt-0 min-h-screen bg-background">
        <div className="mx-auto max-w-6xl px-4 py-6 lg:py-10">{children}</div>
      </main>
    </div>
  );
}
