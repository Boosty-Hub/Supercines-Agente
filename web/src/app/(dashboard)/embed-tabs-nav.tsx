"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_GROUPS } from "./nav";

const ENV_AGENT_LABEL = process.env.NEXT_PUBLIC_AGENT_LABEL || "Agente";

export function EmbedTabsNav({
  label,
  alertsCount,
  isAdmin = true,
}: {
  label?: string;
  alertsCount: number;
  isAdmin?: boolean;
}) {
  const pathname = usePathname();
  const agentLabel = label || ENV_AGENT_LABEL;
  const groups = NAV_GROUPS.filter((g) => isAdmin || !g.adminOnly);

  return (
    <div className="shrink-0 border-b border-neutral-200 bg-white">
      {/* Barra de marca compacta */}
      <div className="flex items-center gap-2 border-b border-neutral-100 px-4 py-2">
        <div className="grid h-6 w-6 shrink-0 place-items-center rounded bg-brand text-brand-foreground text-xs font-semibold">
          {agentLabel.charAt(0).toUpperCase()}
        </div>
        <span className="text-sm font-semibold tracking-tight text-neutral-900">
          {agentLabel}
        </span>
      </div>

      {/* Tabs — los mismos módulos del sidebar, ahora horizontales */}
      <div className="flex overflow-x-auto scrollbar-none px-2">
        {groups.map((group, gi) => (
          <div key={group.label} className="flex shrink-0 items-center">
            {gi > 0 && (
              <div className="mx-2 h-4 w-px shrink-0 bg-neutral-200" />
            )}
            {group.items.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(item.href + "/");
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`relative flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm transition-colors ${
                    active
                      ? "font-medium text-brand-strong"
                      : "text-neutral-500 hover:text-neutral-800"
                  }`}
                >
                  <Icon
                    size={15}
                    className={active ? "text-brand" : "text-neutral-400"}
                  />
                  {item.label}
                  {item.href === "/alerts" && alertsCount > 0 && (
                    <span className="ml-0.5 inline-flex items-center rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
                      {alertsCount}
                    </span>
                  )}
                  {active && (
                    <span className="absolute bottom-0 inset-x-2 h-0.5 rounded-full bg-brand" />
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
