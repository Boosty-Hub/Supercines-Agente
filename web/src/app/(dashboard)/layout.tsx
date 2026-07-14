import { Suspense } from "react";
import { cookies } from "next/headers";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValue } from "@/lib/runtime-config";
import { getBcvRateCached } from "@/lib/exchange";
import { getRole } from "@/lib/auth/roles";
import { getSetupState } from "@/lib/setup-state";
import { MobileNav, SidebarNav } from "./nav";
import { UpdatesBanner } from "./updates-banner";
import { EmbedTabsNav } from "./embed-tabs-nav";
import { NavProgress } from "./nav-progress";
import { SetupDrawer } from "./setup-drawer";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const [{ count: alertsCount }, { data: pubCfg }] = await Promise.all([
    supabase
      .from("alerts")
      .select("*", { count: "exact", head: true })
      .is("acknowledged_at", null),
    supabase
      .from("kommo_publish_config")
      .select("bcv_rate_enabled")
      .eq("is_active", true)
      .maybeSingle(),
  ]);

  const email = user?.email ?? "";
  const alerts = alertsCount ?? 0;
  const isAdmin = getRole(user) === "admin";
  // Resolve the branding label DB-first (editable from /agent) with env
  // fallback. Resolved server-side so it does NOT depend on the build-time
  // NEXT_PUBLIC_AGENT_LABEL inlining.
  const label = (await configValue("NEXT_PUBLIC_AGENT_LABEL")) || "Agente";

  // Tasa BCV: misma fuente + cache 6h que la tool del agente. Solo si la
  // capacidad está activa; si la fuente falla, simplemente no hay badge.
  const bcv = pubCfg?.bcv_rate_enabled === true ? await getBcvRateCached() : null;

  // Auto-update: ON salvo que el operador lo apague explícitamente ("0").
  const autoUpdate = (await configValue("AUTO_UPDATE_ENABLED")) !== "0";

  const isEmbed = cookies().get("embed_mode")?.value === "1";

  // Onboarding no bloqueante: el wizard vive como panel lateral (drawer) SOBRE
  // el dashboard. Se computa el estado desde runtime_config (DB) solo para
  // admins y fuera del embed. Si el onboarding ya está completo, el drawer no
  // muestra nada (ni launcher ni auto-apertura) salvo que ?setup=open lo fuerce.
  const setupState = isAdmin && !isEmbed ? await getSetupState() : null;
  const showSetupDrawer = setupState !== null;

  if (isEmbed) {
    return (
      <div className="flex flex-col h-dvh overflow-hidden bg-neutral-50">
        <Suspense fallback={null}>
          <NavProgress />
        </Suspense>
        <EmbedTabsNav label={label} alertsCount={alerts} isAdmin={isAdmin} />
        <main className="flex-1 min-w-0 overflow-y-auto">{children}</main>
      </div>
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-neutral-50">
      <Suspense fallback={null}>
        <NavProgress />
      </Suspense>
      <SidebarNav email={email} alertsCount={alerts} label={label} bcv={bcv ?? undefined} isAdmin={isAdmin} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav email={email} alertsCount={alerts} label={label} bcv={bcv ?? undefined} isAdmin={isAdmin} />
        <UpdatesBanner autoUpdate={autoUpdate} />
        <main className="flex-1 min-w-0 overflow-y-auto">{children}</main>
      </div>
      {showSetupDrawer && <SetupDrawer state={setupState} />}
    </div>
  );
}
