// La configuración del agente se unificó en Ajustes. Se deja el redirect para
// no romper enlaces guardados ni los deep links viejos (?tab=filtros|acciones).

import { redirect } from "next/navigation";

export default function AgentRedirect({
  searchParams,
}: {
  searchParams: { tab?: string };
}) {
  const sec = searchParams.tab === "filtros" || searchParams.tab === "acciones"
    ? `&sec=${searchParams.tab}`
    : "";
  redirect(`/settings?tab=agente${sec}`);
}
