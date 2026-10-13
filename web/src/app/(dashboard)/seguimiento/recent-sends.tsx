import Link from "next/link";
import { SectionCard, EmptyState, Badge } from "@/components/ui";
import { Repeat } from "@/components/ui/icons";
import { timeAgo } from "@/lib/time-ago";
import { FollowUpRetryButton } from "./follow-up-retry-button";

export type RecentSend = {
  id: string;
  leadId: string;
  leadName: string;
  step: number;
  status: string;
  sentAt: string;
  templateName: string | null;
  error: string | null;
};

const STATUS_COLOR: Record<string, "green" | "red"> = {
  sent: "green",
  failed: "red",
};

const STATUS_LABEL: Record<string, string> = {
  sent: "Enviado",
  failed: "Falló",
};

// Errores del proveedor larguísimos (a veces un JSON entero) — se resumen a
// algo legible; el detalle completo va en el title del elemento.
function shortError(err: string): string {
  return err.length > 90 ? err.slice(0, 90) + "…" : err;
}

/**
 * Log de los últimos envíos de seguimiento (tabla `follow_ups`, append-only).
 * Cada fila abre la conversación del lead; los fallidos ofrecen reintentar
 * a mano sin esperar al próximo barrido de follow-up-scan.
 */
export function RecentSends({ rows }: { rows: RecentSend[] }) {
  return (
    <SectionCard
      icon={<Repeat size={18} />}
      title="Envíos recientes"
      description="Últimos seguimientos que el agente mandó o intentó mandar."
    >
      {rows.length === 0 ? (
        <EmptyState
          title="Todavía no se envió ningún seguimiento"
          description="Acá va a aparecer el log en cuanto follow-up-scan mande el primero."
        />
      ) : (
        <ul className="divide-y divide-neutral-100 -mx-5 -my-1">
          {rows.map((r) => (
            <li key={r.id} className="px-5 py-3">
              <Link
                href={`/inbox/${r.leadId}`}
                className="block rounded-lg transition-colors hover:bg-neutral-50"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-900">
                    {r.leadName}
                  </span>
                  <span className="shrink-0 text-[11px] text-neutral-400">{timeAgo(r.sentAt)}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Badge color="neutral">Paso {r.step}</Badge>
                  <Badge color={STATUS_COLOR[r.status] ?? "neutral"}>
                    {STATUS_LABEL[r.status] ?? r.status}
                  </Badge>
                  {r.templateName && (
                    <span className="truncate text-[11px] text-neutral-400">{r.templateName}</span>
                  )}
                </div>
                {r.status === "failed" && r.error && (
                  <p className="mt-1 truncate text-[11px] text-red-600" title={r.error}>
                    {shortError(r.error)}
                  </p>
                )}
              </Link>
              {/* Reintentar: FUERA del Link — ver nota en follow-up-retry-button.tsx */}
              {r.status === "failed" && <FollowUpRetryButton leadId={r.leadId} />}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
