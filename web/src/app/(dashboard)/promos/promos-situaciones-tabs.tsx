"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import PromoCard from "./promo-card";
import PromoFormModal from "./promo-form-modal";
import { type Promo } from "./promo-utils";
import SituacionCard from "./situacion-card";
import SituacionFormModal from "./situacion-form-modal";
import { type Situacion } from "./situacion-utils";
import { SectionCard, EmptyState, Button } from "@/components/ui";
import { Sparkles, Alert, Plus } from "@/components/ui/icons";

type Tab = "promos" | "situaciones";

export default function PromosSituacionesTabs({
  initialTab,
  promos,
  situaciones,
}: {
  initialTab: Tab;
  promos: Promo[];
  situaciones: Situacion[];
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const router = useRouter();

  const [promoModal, setPromoModal] = useState<{ open: boolean; editing: Promo | null }>({ open: false, editing: null });
  const [sitModal, setSitModal] = useState<{ open: boolean; editing: Situacion | null }>({ open: false, editing: null });

  async function togglePromo(id: string, next: boolean) {
    await fetch(`/api/promotions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    router.refresh();
  }
  async function deletePromo(id: string) {
    await fetch(`/api/promotions/${id}`, { method: "DELETE" });
    router.refresh();
  }
  async function toggleSit(id: string, next: boolean) {
    await fetch(`/api/situations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    router.refresh();
  }
  async function deleteSit(id: string) {
    await fetch(`/api/situations/${id}`, { method: "DELETE" });
    router.refresh();
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "promos", label: "Promos y eventos" },
    { key: "situaciones", label: "Situaciones" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-1 rounded-lg bg-neutral-100 p-1">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={
              "px-3 py-1.5 text-sm font-medium rounded-md transition-colors " +
              (tab === key ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-600 hover:text-neutral-900")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab: Promos y eventos */}
      {tab === "promos" && (
        <div className="space-y-6">
          <SectionCard
            icon={<Sparkles size={18} />}
            title="Crear promo o evento"
            description="El agente menciona las promos activas en cada respuesta cuando son relevantes."
            action={
              <Button variant="primary" size="sm" leftIcon={<Plus size={14} />} onClick={() => setPromoModal({ open: true, editing: null })}>
                Nueva
              </Button>
            }
          >
            <p className="text-xs text-neutral-500">
              Las promos activas se inyectan automáticamente en el contexto del agente. Podés activar/desactivar
              cada una sin borrarla, y fijar fechas o días de la semana para que apliquen solo cuando corresponde.
            </p>
          </SectionCard>

          {promos.length === 0 ? (
            <EmptyState
              icon={<Sparkles size={24} />}
              title="Sin promos ni eventos"
              description="Creá la primera promo para que el agente empiece a mencionarla en sus respuestas."
              action={
                <Button variant="primary" size="sm" leftIcon={<Plus size={14} />} onClick={() => setPromoModal({ open: true, editing: null })}>
                  Crear primera promo
                </Button>
              }
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {promos.map((promo) => (
                <PromoCard
                  key={promo.id}
                  promo={promo}
                  onToggle={togglePromo}
                  onEdit={(p) => setPromoModal({ open: true, editing: p })}
                  onDelete={deletePromo}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab: Situaciones */}
      {tab === "situaciones" && (
        <div className="space-y-6">
          <SectionCard
            icon={<Alert size={18} />}
            title="Crear situación"
            description="Contexto que el agente SIEMPRE debe tener en cuenta al responder (un feriado, una emergencia, un corte)."
            action={
              <Button variant="primary" size="sm" leftIcon={<Plus size={14} />} onClick={() => setSitModal({ open: true, editing: null })}>
                Nueva
              </Button>
            }
          >
            <p className="text-xs text-neutral-500">
              A diferencia de las promos (que se mencionan solo si vienen al caso), las situaciones activas son
              contexto ambiental: el agente las considera en TODA respuesta mientras estén vigentes.
            </p>
          </SectionCard>

          {situaciones.length === 0 ? (
            <EmptyState
              icon={<Alert size={24} />}
              title="Sin situaciones"
              description="Creá una situación cuando algo del mundo real deba condicionar las respuestas del agente."
              action={
                <Button variant="primary" size="sm" leftIcon={<Plus size={14} />} onClick={() => setSitModal({ open: true, editing: null })}>
                  Crear primera situación
                </Button>
              }
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {situaciones.map((s) => (
                <SituacionCard
                  key={s.id}
                  situacion={s}
                  onToggle={toggleSit}
                  onEdit={(x) => setSitModal({ open: true, editing: x })}
                  onDelete={deleteSit}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <PromoFormModal
        key={"promo-" + (promoModal.editing?.id ?? "new")}
        open={promoModal.open}
        initial={promoModal.editing}
        onClose={() => setPromoModal({ open: false, editing: null })}
        onSaved={() => { setPromoModal({ open: false, editing: null }); router.refresh(); }}
      />
      <SituacionFormModal
        key={"sit-" + (sitModal.editing?.id ?? "new")}
        open={sitModal.open}
        initial={sitModal.editing}
        onClose={() => setSitModal({ open: false, editing: null })}
        onSaved={() => { setSitModal({ open: false, editing: null }); router.refresh(); }}
      />
    </div>
  );
}
