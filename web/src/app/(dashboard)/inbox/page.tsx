import { redirect } from "next/navigation";
import { EmptyState, MessageSquare } from "@/components/ui";

export const dynamic = "force-dynamic";

// Sin conversación abierta (la lista/tablero la dibuja el layout). Los enlaces
// viejos `/inbox?lead=<id>` (alertas, Dreams, favoritos del navegador) se
// resuelven en next.config.mjs; este redirect es la red de seguridad si el id no
// tiene forma de UUID. Conserva los filtros.
export default function InboxPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const { lead, ...rest } = searchParams;
  if (typeof lead === "string" && lead) {
    const qs = new URLSearchParams(
      Object.entries(rest).filter((e): e is [string, string] => typeof e[1] === "string")
    ).toString();
    redirect(`/inbox/${encodeURIComponent(lead)}${qs ? `?${qs}` : ""}`);
  }
  return (
    <div className="flex h-full items-center justify-center p-8">
      <EmptyState
        icon={<MessageSquare size={20} />}
        title="Seleccioná un lead"
        description="Elegí una conversación de la lista para verla acá."
      />
    </div>
  );
}
