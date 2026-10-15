"use client";

// INVARIANT: this file must not import runtime-config or createServiceClient

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { inputCls, labelCls } from "@/components/ui/styles";

function validate(email: string, password: string, confirm: string) {
  const errors: Record<string, string> = {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = "Ingresá un email válido.";
  }
  if (password.length < 8) {
    errors.password = "La contraseña debe tener al menos 8 caracteres.";
  }
  if (password !== confirm) {
    errors.confirm = "Las contraseñas no coinciden.";
  }
  return errors;
}

export function CreateUser({
  accessToken: tokenFromInitialize,
  onComplete,
}: {
  /** Token sbp_ del paso Inicializar ("" si se recargó la página: se pide acá). */
  accessToken: string;
  onComplete: () => void;
}) {
  const router = useRouter();
  const [token, setToken] = useState(tokenFromInitialize);
  // Si el registro público no se pudo cerrar solo: el aviso con el paso manual, antes de seguir.
  const [signupWarning, setSignupWarning] = useState<{ error: string; manualStep: string } | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);

    const errs = validate(email, password, confirm);
    if (!token.trim()) errs.accessToken = "Pegá tu token de Supabase (sbp_…).";
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setRunning(true);
    try {
      // 1. Create the user (server-side; first-run lock enforced there).
      const res = await fetch("/api/provision/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, confirm, accessToken: token.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        fieldErrors?: Record<string, string>;
        signupDisabled?: boolean;
        signupError?: string;
        manualStep?: string;
      };

      if (res.status === 400 && data.fieldErrors) {
        setFieldErrors(data.fieldErrors);
        return;
      }
      // 409 = a user already exists (e.g. you're resuming after a partial run).
      // That's fine — we just sign in below with the credentials entered.
      // Any other non-OK is a real error.
      if (!res.ok && res.status !== 409) {
        setServerError(data.error ?? `No se pudo crear el usuario (HTTP ${res.status})`);
        return;
      }

      // 2. Sign in with the SAME cookie-based SSR client the rest of the app
      // uses, so the middleware recognizes the session and we can continue the
      // onboarding into /setup (Anthropic + Kommo). We never bounce to /login.
      const supabase = createSupabaseBrowserClient();
      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (authError) {
        setServerError(
          res.status === 409
            ? "Ya existe un usuario con otra contraseña. Ingresá la contraseña correcta para continuar."
            : `Usuario creado, pero no pudimos iniciar sesión: ${authError.message}. Reintentá.`
        );
        return;
      }

      // 3. Session is in cookies now. Si el registro público quedó ABIERTO, se avisa y se espera
      // a que la persona lo confirme: no se sigue en silencio.
      if (res.ok && data.signupDisabled === false) {
        setSignupWarning({
          error: data.signupError ?? "No se pudo cerrar el registro público.",
          manualStep: data.manualStep ?? "",
        });
        return;
      }
      router.refresh();
      onComplete();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setRunning(false);
    }
  }

  if (signupWarning) {
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-neutral-900">Usuario creado — falta un paso</h2>
          <p className="mt-1 text-sm text-neutral-500">
            No pudimos cerrar el registro público de tu proyecto de Supabase. Mientras siga abierto,
            cualquiera puede crearse una cuenta (sin acceso al panel, pero una cuenta que nadie dio de alta).
          </p>
        </div>
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-medium">Cerralo a mano:</p>
          <p>{signupWarning.manualStep}</p>
          <p className="font-mono text-xs text-amber-800">{signupWarning.error}</p>
        </div>
        <Button
          type="button"
          onClick={() => {
            router.refresh();
            onComplete();
          }}
        >
          Ya lo cerré, continuar
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-neutral-900">
          Creá tu usuario
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Con este email y contraseña vas a entrar al panel. Es el único acceso
          — guardalo bien.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="space-y-2">
          <label className={labelCls} htmlFor="fr-email">
            Email
          </label>
          <input
            id="fr-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@tuempresa.com"
            className={inputCls}
            disabled={running}
            autoComplete="email"
          />
          {fieldErrors.email && (
            <p className="text-xs text-red-600">{fieldErrors.email}</p>
          )}
        </div>

        <div className="space-y-2">
          <label className={labelCls} htmlFor="fr-password">
            Contraseña
          </label>
          <input
            id="fr-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Mínimo 8 caracteres"
            className={inputCls}
            disabled={running}
            autoComplete="new-password"
          />
          {fieldErrors.password && (
            <p className="text-xs text-red-600">{fieldErrors.password}</p>
          )}
        </div>

        <div className="space-y-2">
          <label className={labelCls} htmlFor="fr-confirm">
            Confirmar contraseña
          </label>
          <input
            id="fr-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Repetí la contraseña"
            className={inputCls}
            disabled={running}
            autoComplete="new-password"
          />
          {fieldErrors.confirm && (
            <p className="text-xs text-red-600">{fieldErrors.confirm}</p>
          )}
        </div>

        {(!tokenFromInitialize || fieldErrors.accessToken) && (
          <div className="space-y-2">
            <label className={labelCls} htmlFor="fr-token">
              Token de Supabase
            </label>
            <input
              id="fr-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="sbp_..."
              className={inputCls + " font-mono"}
              disabled={running}
              autoComplete="off"
            />
            <p className="text-xs text-neutral-500">
              El mismo del paso anterior: con él cerramos el registro público de tu proyecto.
            </p>
            {fieldErrors.accessToken && (
              <p className="text-xs text-red-600">{fieldErrors.accessToken}</p>
            )}
          </div>
        )}

        {serverError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {serverError}
          </div>
        )}

        <Button type="submit" busy={running}>
          {running ? "Creando…" : "Crear usuario y continuar"}
        </Button>
      </form>
    </div>
  );
}
