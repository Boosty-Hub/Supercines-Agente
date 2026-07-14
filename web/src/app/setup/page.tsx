import { redirect } from "next/navigation";

// El wizard de configuración ya NO es una página full-screen: vive como panel
// lateral (drawer) sobre el dashboard para que el onboarding no bloquee el
// acceso a la plataforma. /setup se conserva como deep-link — los links "corré
// /setup" dispersos por la app siguen funcionando y abren el drawer.
export const dynamic = "force-dynamic";

export default function SetupPage() {
  redirect("/inbox?setup=open");
}
