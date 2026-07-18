"use client";

import { useState } from "react";
import { Switch } from "@/components/ui";
import { Button, inputCls, textareaCls } from "@/components/ui";
import { KommoFieldSelect } from "@/components/kommo/field-select";

const DEFAULT_RULES =
  'Respuesta CORTA (máximo 200 caracteres), sin saludos largos ni presentaciones: directo al grano. NO des precios, montos ni promociones con números en público — para eso invitá al DM ("te pasamos el detalle por DM 💛"). Tono cercano, máximo 1 emoji. Si el comentario es solo elogio o emojis, agradecé breve.';

export type CommentsConfig = {
  comment_reply_enabled: boolean;
  comment_salesbot_id: number | null;
  comment_field_id: number | null;
  comment_reply_rules: string | null;
  comment_instructions: string | null;
  comment_source_ids: number[];
};

export function CommentsPanel({ initial }: { initial: CommentsConfig }) {
  const [replyEnabled, setReplyEnabled] = useState(initial.comment_reply_enabled);
  const [salsbotId, setSalsbotId] = useState<string>(
    initial.comment_salesbot_id != null ? String(initial.comment_salesbot_id) : ""
  );
  const [rules, setRules] = useState<string>(initial.comment_reply_rules ?? DEFAULT_RULES);
  const [instructions, setInstructions] = useState<string>(
    initial.comment_instructions ??
      'El mensaje vino de un comentario público en una publicación de Instagram. Tu respuesta sale por DM: reconocé el origen con naturalidad (ej: "vi tu comentario 😊"), andá directo al grano.'
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function post(body: Record<string, unknown>, okMsg: string) {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch("/api/agent/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setOk(okMsg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
    return true;
  }

  async function toggleReply(v: boolean) {
    const prev = replyEnabled;
    setReplyEnabled(v);
    const success = await post(
      { comment_reply_enabled: v },
      v ? "Respuesta pública activada" : "Respuesta pública desactivada"
    );
    if (!success) setReplyEnabled(prev);
  }

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const fieldId = fd.get("comment_field_id");

    await post(
      {
        comment_salesbot_id: salsbotId.trim() ? Number(salsbotId.trim()) : null,
        comment_field_id: fieldId ? Number(fieldId) : null,
        comment_reply_rules: rules,
        comment_instructions: instructions,
      },
      "Configuración guardada"
    );
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm space-y-4">
      {/* Header + switch maestro en la misma fila */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
            Comentarios de Instagram
          </h2>
          <p className="text-xs text-neutral-500">
            El agente detecta los comentarios y SIEMPRE responde por DM privado (configurable
            abajo). El switch activa ADEMÁS una respuesta pública corta en el comentario,
            redactada por la IA con sus propias reglas.
          </p>
        </div>
        <div className="shrink-0 pt-0.5">
          <Switch checked={replyEnabled} disabled={busy} onChange={toggleReply} />
        </div>
      </div>

      {/* Configuración — solo visible cuando el switch está encendido */}
      {replyEnabled && (
        <div className="space-y-4 border-t border-neutral-100 pt-4 transition-all">
          <p className="text-xs font-semibold uppercase tracking-wide text-violet-700">
            💬 En el comentario (público — lo ve toda tu audiencia)
          </p>
          <form onSubmit={handleSave} className="space-y-4">
            {/* Salesbot de comentarios */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-700">
                Salesbot de comentarios (ID numérico)
              </label>
              <input
                type="number"
                value={salsbotId}
                onChange={(e) => setSalsbotId(e.target.value)}
                placeholder="Ej: 12345"
                className={inputCls + " font-mono"}
              />
              <p className="text-xs text-neutral-400">
                En Kommo: Configuración → Salesbots → abrí el bot → el ID está en la URL{" "}
                <span className="font-mono">/salesbots/edit/{"{id}"}</span>.
              </p>
            </div>

            {/* Campo de respuesta pública */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-700">Campo de respuesta pública</label>
              <KommoFieldSelect name="comment_field_id" defaultValue={initial.comment_field_id} />
              <p className="text-xs text-neutral-400">
                Campo de lead donde se escribe la respuesta pública antes de disparar el salesbot de
                comentarios. Debe ser distinto al campo de respuesta principal.
              </p>
            </div>

            {/* Reglas de la respuesta pública */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-700">
                Reglas de la respuesta pública
              </label>
              <textarea
                value={rules}
                onChange={(e) => setRules(e.target.value)}
                rows={4}
                maxLength={1000}
                className={textareaCls}
              />
              <p className="text-xs text-neutral-400">
                La IA redacta cada respuesta pública siguiendo estas reglas. Ejemplos: prohibir
                precios, largo máximo, tono. Tope duro del sistema: 280 caracteres.{" "}
                <span className="text-neutral-500">({rules.length}/1000)</span>
              </p>
            </div>

            <Button type="submit" variant="primary" size="sm" busy={busy}>
              {busy ? "Guardando…" : "Guardar configuración"}
            </Button>
          </form>

          {/* Info de fuentes de comentarios detectadas */}
          {initial.comment_source_ids.length > 0 && (
            <div className="rounded-lg border border-neutral-100 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
              Fuente de comentarios detectada:{" "}
              {initial.comment_source_ids.map((id) => (
                <span key={id} className="font-mono font-medium text-neutral-700 mr-1">
                  #{id}
                </span>
              ))}
              <span className="ml-1">(configurado en DB — para cambiar, contactá al equipo técnico)</span>
            </div>
          )}
        </div>
      )}

      {/* DM privado: aplica SIEMPRE que un mensaje venga de un comentario,
          esté o no activa la respuesta pública. */}
      <div className="space-y-1.5 border-t border-neutral-100 pt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          ✉️ En el DM (privado — la respuesta completa de siempre)
        </p>
        <label className="text-xs font-medium text-neutral-700">
          Cómo tratar los DMs que nacieron de un comentario
        </label>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={3}
          className={textareaCls}
        />
        <p className="text-xs text-neutral-400">
          Acá el agente puede dar precios y detalles (es privado). Estas instrucciones le dicen
          cómo reconocer el origen y el tono.
        </p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          busy={busy}
          onClick={() => post({ comment_instructions: instructions }, "Instrucciones del DM guardadas")}
        >
          Guardar instrucciones del DM
        </Button>
      </div>

      {ok && <p className="text-xs text-emerald-600">&#10003; {ok}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
