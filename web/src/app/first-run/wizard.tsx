"use client";

// INVARIANT: this file must not import runtime-config or createServiceClient

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { ProvisionStatus } from "@/app/api/provision/status/route";
import type { FirstRunStep } from "./stepper";
import { ProvisionStepper } from "./stepper";
import { ConnectSupabase } from "./connect-supabase";
import { Initialize } from "./initialize";
import { CreateUser } from "./create-user";

export function FirstRunWizard() {
  const router = useRouter();
  const [status, setStatus] = useState<ProvisionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setFetchError(null);
    try {
      const res = await fetch("/api/provision/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ProvisionStatus;
      setStatus(data);

      // Terminal redirects
      if (data.nextStep === "done") {
        router.replace("/inbox");
        return;
      }
      if (data.nextStep === "anthropic" || data.nextStep === "kommo") {
        // User exists but Anthropic/Kommo not yet configured — entrá directo al
        // dashboard; el onboarding sigue como panel lateral (drawer). ?setup=open
        // lo deja abierto en la primera carga.
        router.replace("/inbox?setup=open");
        return;
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Error al verificar estado");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const handleStepComplete = useCallback(() => {
    setLoading(true);
    // Re-fetch status to get next step
    void fetchStatus();
  }, [fetchStatus]);

  const handleCreateUserComplete = useCallback(() => {
    // Usuario creado y logueado → entrá al dashboard; el onboarding (Anthropic,
    // Kommo, etc.) continúa como panel lateral (drawer), abierto en la 1ra carga.
    router.replace("/inbox?setup=open");
  }, [router]);

  if (loading) {
    return (
      <div className="min-h-dvh bg-neutral-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-6 w-6 rounded-full border-2 border-neutral-200 border-t-brand animate-spin" />
          <p className="text-sm text-neutral-500">Verificando estado…</p>
        </div>
      </div>
    );
  }

  if (fetchError || !status) {
    return (
      <div className="min-h-dvh bg-neutral-50 flex items-center justify-center px-4">
        <div className="max-w-sm w-full rounded-2xl border border-red-200 bg-white p-6 shadow-modal space-y-4">
          <p className="text-sm font-medium text-red-700">
            No se pudo verificar el estado del sistema
          </p>
          <p className="text-xs text-neutral-500">{fetchError}</p>
          <Button
            type="button"
            onClick={() => {
              setLoading(true);
              void fetchStatus();
            }}
          >
            Reintentar
          </Button>
        </div>
      </div>
    );
  }

  const step = status.nextStep as FirstRunStep;

  return (
    <div className="min-h-dvh bg-neutral-50 px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-2xl space-y-6">
        {/* Header */}
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
            Configuración inicial
          </h1>
          <p className="text-sm text-neutral-500">
            Unos pocos pasos y tu agente queda listo. No hace falta saber de
            tecnología ni usar la terminal.
          </p>
        </header>

        {/* Step rail */}
        <ProvisionStepper currentStep={step} />

        {/* Step content */}
        <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-card">
          {step === "connect-supabase" && (
            <ConnectSupabase onContinue={handleStepComplete} />
          )}

          {step === "initialize" && (
            <Initialize
              initialStatus={status}
              onComplete={handleStepComplete}
            />
          )}

          {step === "create-user" && (
            <CreateUser onComplete={handleCreateUserComplete} />
          )}

          {/* anthropic / kommo / done should redirect — show fallback */}
          {(step === "anthropic" || step === "kommo" || step === "done") && (
            <div className="space-y-3">
              <p className="text-sm text-neutral-700">
                Redirigiendo al wizard de configuración…
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
