"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Descarga (export) todos los dreams como un único JSON y permite re-subir
// (import) ese mismo JSON. El import es idempotente: paths ya presentes en
// el Memory Store se omiten.
export default function ExportImportButtons() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function pickFile() {
    setMsg(null);
    setError(null);
    fileInputRef.current?.click();
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // permite re-seleccionar el mismo archivo
    if (!file) return;
    setUploading(true);
    setMsg(null);
    setError(null);
    try {
      const text = await file.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        setError("Archivo no es JSON válido");
        return;
      }
      const res = await fetch("/api/dreams/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Error ${res.status}`);
        return;
      }
      const errs = Array.isArray(data.errors) ? data.errors.length : 0;
      setMsg(
        `✓ ${data.inserted} insertados, ${data.skipped} omitidos${
          errs ? `, ${errs} con error` : ""
        }`
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href="/api/dreams/export"
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
        >
          Descargar todos
        </a>
        <button
          type="button"
          disabled={uploading}
          onClick={pickFile}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-50"
        >
          {uploading ? "Subiendo…" : "Subir JSON"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={onFileChange}
          className="hidden"
        />
      </div>
      {msg && <span className="text-xs font-medium text-emerald-700">{msg}</span>}
      {error && <span className="text-xs font-medium text-red-600">{error}</span>}
    </div>
  );
}
