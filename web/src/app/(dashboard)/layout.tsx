import { Suspense } from "react";
import { cookies } from "next/headers";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValue } from "@/lib/runtime-config";
import { getBcvRateCached } from "@/lib/exchange";
import { getScope } from "@/lib/auth/roles";
import { getSetupState } from "@/lib/setup-state";
import { MobileNav, SidebarNav } from "./nav";
import { BoostySupportWidget } from "./boosty-widget";
import { EmbedTabsNav } from "./embed-tabs-nav";
import { NavProgress } from "./nav-progress";
import { SetupDrawer } from "./setup-drawer";
import { TorreDeControl } from "./torre-de-control";
import SystemBanner from "./system-banner";
import { SystemHaltedBanner } from "./system-halted-banner";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const [{ count: alertsCount }, { data: pubCfg }, { data: haltCfg }] = await Promise.all([
    supabase
      .from("alerts")
      .select("*", { count: "exact", head: true })
      .is("acknowledged_at", null),
    supabase
      .from("kommo_publish_config")
      .select("bcv_rate_enabled, agent_enabled, publishing_enabled")
      .eq("is_active", true)
      .maybeSingle(),
    // Apagado total: query APARTE del select de arriba — si la migración que
    // agrega `system_halted` todavía no se aplicó en este proyecto, este
    // select falla solo (fail-open: banner oculto) sin tirar abajo el resto
    // del layout (branding, BCV, alertas).
    supabase.from("kommo_publish_config").select("system_halted").eq("is_active", true).maybeSingle(),
  ]);

  const systemHalted = haltCfg?.system_halted === true;
  // Estado inline de la torre de control — mismo criterio que /inbox y Ajustes:
  // generate-response solo bloquea con agent_enabled === false explícito.
  const systemStatus = {
    agentEnabled: pubCfg?.agent_enabled !== false,
    publishingEnabled: pubCfg?.publishing_enabled === true,
  };
  const email = user?.email ?? "";
  const alerts = alertsCount ?? 0;
  const scope = getScope(user);
  // Resolve the branding label DB-first (editable from /agent) with env
  // fallback. Resolved server-side so it does NOT depend on the build-time
  // NEXT_PUBLIC_AGENT_LABEL inlining.
  const label = (await configValue("NEXT_PUBLIC_AGENT_LABEL")) || "Agente";

  // Tasa BCV: misma fuente + cache 6h que la tool del agente. Solo si la
  // capacidad está activa; si la fuente falla, simplemente no hay badge.
  const bcv = pubCfg?.bcv_rate_enabled === true ? await getBcvRateCached() : null;


  const isEmbed = (await cookies()).get("embed_mode")?.value === "1";

  // Onboarding no bloqueante: el wizard vive como panel lateral (drawer) SOBRE
  // el dashboard. Se computa el estado desde runtime_config (DB) solo para
  // admins y fuera del embed. Si el onboarding ya está completo, el drawer no
  // muestra nada (ni launcher ni auto-apertura) salvo que ?setup=open lo fuerce.
  const setupState = scope === "configuracion" && !isEmbed ? await getSetupState() : null;
  const showSetupDrawer = setupState !== null;

  if (isEmbed) {
    return (
      <div className="flex flex-col h-dvh overflow-hidden bg-neutral-50">
        {/* La franja va ARRIBA DE TODO y fuera del <main> scrolleable: un apagón
            del agente no puede quedar fuera de vista por haber scrolleado. */}
        <SystemBanner puedeActuar={scope === "configuracion"} />
        {systemHalted && <SystemHaltedBanner />}
        <Suspense fallback={null}>
          <NavProgress />
        </Suspense>
        <EmbedTabsNav label={label} alertsCount={alerts} scope={scope} />
        <div className="flex min-h-0 flex-1">
          <main className="flex-1 min-w-0 overflow-y-auto">{children}</main>
          <TorreDeControl conteoInicial={alerts} systemStatusInicial={systemStatus} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-dvh overflow-hidden bg-neutral-50">
      <SystemBanner puedeActuar={scope === "configuracion"} />
      {systemHalted && <SystemHaltedBanner />}
      <div className="flex min-h-0 flex-1">
        <Suspense fallback={null}>
          <NavProgress />
        </Suspense>
        <SidebarNav email={email} alertsCount={alerts} label={label} bcv={bcv ?? undefined} scope={scope} />
        <div className="flex min-w-0 flex-1 flex-col">
          <MobileNav email={email} alertsCount={alerts} label={label} bcv={bcv ?? undefined} scope={scope} />
          <main className="flex-1 min-w-0 overflow-y-auto">{children}</main>
        </div>
        <TorreDeControl conteoInicial={alerts} systemStatusInicial={systemStatus} />
        {showSetupDrawer && <SetupDrawer state={setupState} />}
      </div>
      <BoostySupportWidget email={email} />
    </div>
  );
}
