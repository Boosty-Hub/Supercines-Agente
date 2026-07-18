"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import {
  Menu, X, Inbox, Users, Layers, Target, Sparkles, Stars,
  Repeat, Bell, Settings, LogOut, BarChart3, ChevronRight,
} from "@/components/ui";
import { BcvBanner } from "./bcv-banner";

type BcvData = { rate: number; source: string; fetchedAt: string };

const ENV_AGENT_LABEL = process.env.NEXT_PUBLIC_AGENT_LABEL || "Agente";

export type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
};

export type NavGroup = {
  label: string;
  items: NavItem[];
  /** Solo visible para admins (credenciales, kill switches, usuarios). */
  adminOnly?: boolean;
};

// Grupos de sección (NO cambia rutas).
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Operación",
    items: [
      { href: "/inbox", label: "Inbox", icon: Inbox },
      { href: "/leads", label: "Leads", icon: Users },
      // Alertas es un buzón de monitoreo de solo lectura, no configuración → vive en Operación.
      { href: "/alerts", label: "Alertas", icon: Bell },
    ],
  },
  {
    label: "Contenido y calidad",
    items: [
      { href: "/contenido", label: "Contenido", icon: Layers },
      { href: "/promos", label: "Promos y situaciones", icon: Sparkles },
      { href: "/verticales", label: "Verticales", icon: Target },
      { href: "/outcomes", label: "Outcomes", icon: Sparkles },
      { href: "/consumo", label: "Consumo", icon: BarChart3 },
      { href: "/dreams", label: "Dreams", icon: Stars },
    ],
  },
  {
    label: "Configuración",
    adminOnly: true,
    items: [
      // Agente, Kommo y Herramientas viven dentro de Ajustes (pestañas).
      { href: "/seguimiento", label: "Seguimiento", icon: Repeat },
      { href: "/usuarios", label: "Usuarios", icon: Users },
      { href: "/settings", label: "Ajustes", icon: Settings },
    ],
  },
];

function NavItemLink({
  item,
  pathname,
  alertsCount,
  onNavigate,
  collapsed = false,
}: {
  item: NavItem;
  pathname: string;
  alertsCount: number;
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const active = pathname === item.href || pathname.startsWith(item.href + "/");
  const Icon = item.icon;
  const showAlertBadge = item.href === "/alerts" && alertsCount > 0;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={`group relative flex items-center rounded-lg text-sm transition-colors ${
        collapsed ? "justify-center px-2 py-2.5" : "gap-2.5 px-3 py-2"
      } ${
        active
          ? "bg-brand-soft font-medium text-brand-strong"
          : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
      }`}
    >
      {/* Barra izquierda activa */}
      {active && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-brand" />
      )}
      <span className="relative">
        <Icon
          size={17}
          className={active ? "text-brand" : "text-neutral-400 group-hover:text-neutral-600"}
        />
        {/* Colapsado: el contador se reduce a un punto rojo sobre el ícono */}
        {collapsed && showAlertBadge && (
          <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white" />
        )}
      </span>
      {!collapsed && <span className="flex-1">{item.label}</span>}
      {!collapsed && showAlertBadge && (
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
            active ? "bg-white text-brand-strong" : "bg-red-500 text-white"
          }`}
        >
          {alertsCount}
        </span>
      )}
    </Link>
  );
}

function NavGroups({
  alertsCount,
  onNavigate,
  collapsed = false,
  isAdmin = true,
}: {
  alertsCount: number;
  onNavigate?: () => void;
  collapsed?: boolean;
  isAdmin?: boolean;
}) {
  const pathname = usePathname();
  const groups = NAV_GROUPS.filter((g) => isAdmin || !g.adminOnly);
  return (
    <nav className={"flex-1 overflow-y-auto py-2 " + (collapsed ? "px-2" : "px-3")}>
      {groups.map((group) => (
        <div key={group.label}>
          {collapsed ? (
            // Colapsado: en vez del título de grupo, un separador fino.
            <div className="mx-2 my-2 border-t border-neutral-200/70 first:border-t-0" />
          ) : (
            <p className="px-3 pb-1.5 pt-5 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
              {group.label}
            </p>
          )}
          <div className="space-y-0.5">
            {group.items.map((item) => (
              <NavItemLink
                key={item.href}
                item={item}
                pathname={pathname}
                alertsCount={alertsCount}
                onNavigate={onNavigate}
                collapsed={collapsed}
              />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

function NavFooter({
  email,
  onNavigate,
  collapsed = false,
}: {
  email: string;
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  // Inicial del email para el avatar
  const initial = (email || "U").charAt(0).toUpperCase();

  if (collapsed) {
    return (
      <div className="border-t border-neutral-200/80 p-2">
        <div className="flex flex-col items-center gap-2">
          <div
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-neutral-100 text-xs font-medium text-neutral-600"
            title={email}
          >
            {initial}
          </div>
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              onClick={onNavigate}
              aria-label="Cerrar sesión"
              title="Cerrar sesión"
              className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <LogOut size={16} />
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-neutral-200/80 p-3">
      <div className="flex items-center gap-2.5">
        {/* Avatar inicial */}
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-neutral-100 text-xs font-medium text-neutral-600">
          {initial}
        </div>
        {/* Email truncado */}
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-600" title={email}>
          {email}
        </span>
        {/* Botón logout solo-ícono */}
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            onClick={onNavigate}
            aria-label="Cerrar sesión"
            className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LogOut size={16} />
          </button>
        </form>
      </div>
    </div>
  );
}

export function SidebarNav({
  email,
  alertsCount,
  label,
  bcv,
  isAdmin = true,
}: {
  email: string;
  alertsCount: number;
  label?: string;
  bcv?: BcvData;
  isAdmin?: boolean;
}) {
  const agentLabel = label || ENV_AGENT_LABEL;
  const initial = agentLabel.charAt(0).toUpperCase();

  // Colapsado: persistido en localStorage. Arranca expandido y sincroniza al
  // montar para evitar mismatch de hidratación (SSR no tiene localStorage).
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(window.localStorage.getItem("sidebar-collapsed") === "1");
  }, []);
  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      window.localStorage.setItem("sidebar-collapsed", next ? "1" : "0");
      return next;
    });
  }

  return (
    <aside
      className={
        "hidden flex-col border-r border-neutral-200/80 bg-white transition-[width] duration-200 lg:flex " +
        (collapsed ? "w-16" : "w-60")
      }
    >
      {/* Header de marca + toggle de colapso */}
      <div
        className={
          "flex items-center border-b border-neutral-200/80 py-4 " +
          (collapsed ? "flex-col gap-2 px-2" : "gap-2.5 px-4")
        }
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-foreground text-sm font-semibold">
          {initial}
        </div>
        {!collapsed && (
          <p className="min-w-0 flex-1 truncate font-semibold tracking-tight text-neutral-900">
            {agentLabel}
          </p>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expandir menú" : "Colapsar menú"}
          title={collapsed ? "Expandir menú" : "Colapsar menú"}
          aria-pressed={collapsed}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight size={16} className={"transition-transform " + (collapsed ? "" : "rotate-180")} />
        </button>
      </div>

      <NavGroups alertsCount={alertsCount} collapsed={collapsed} isAdmin={isAdmin} />

      {/* Pill BCV compacto sobre el footer de usuario (oculto al colapsar) */}
      {bcv && !collapsed && (
        <div className="border-t border-neutral-200/80 px-3 py-2">
          <BcvBanner rate={bcv.rate} source={bcv.source} fetchedAt={bcv.fetchedAt} variant="sidebar" />
        </div>
      )}

      <NavFooter email={email} collapsed={collapsed} />
    </aside>
  );
}

export function MobileNav({
  email,
  alertsCount,
  label,
  bcv,
  isAdmin = true,
}: {
  email: string;
  alertsCount: number;
  label?: string;
  bcv?: BcvData;
  isAdmin?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const agentLabel = label || ENV_AGENT_LABEL;
  const initial = agentLabel.charAt(0).toUpperCase();

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-neutral-200 bg-white px-4 lg:hidden">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-brand-foreground text-xs font-semibold">
            {initial}
          </div>
          <p className="font-semibold tracking-tight text-neutral-900">{agentLabel}</p>
        </div>
        <div className="flex items-center gap-2">
          {bcv && (
            <BcvBanner rate={bcv.rate} source={bcv.source} fetchedAt={bcv.fetchedAt} variant="mini" />
          )}
          <button
            type="button"
            aria-label="Abrir menú"
            onClick={() => setOpen(true)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-700 transition-colors hover:bg-neutral-50"
          >
            <Menu size={18} />
          </button>
        </div>
      </header>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-0 flex h-full w-72 flex-col bg-white shadow-modal">
            {/* Header de marca (drawer) */}
            <div className="flex items-center justify-between border-b border-neutral-200/80 px-4 py-4">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-foreground text-sm font-semibold">
                  {initial}
                </div>
                <p className="min-w-0 truncate font-semibold tracking-tight text-neutral-900">
                  {agentLabel}
                </p>
              </div>
              <button
                type="button"
                aria-label="Cerrar menú"
                onClick={() => setOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100"
              >
                <X size={18} />
              </button>
            </div>
            <NavGroups
              alertsCount={alertsCount}
              onNavigate={() => setOpen(false)}
              isAdmin={isAdmin}
            />
            <NavFooter email={email} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
