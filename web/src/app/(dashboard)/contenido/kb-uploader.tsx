"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function KBUploader() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!title.trim()) return setError("Título requerido");
    if (!file && !content.trim()) return setError("Sube un archivo o pega contenido");

    setBusy(true);
    const form = new FormData();
    form.set("title", title);
    if (file) form.set("file", file);
    if (content.trim()) form.set("content", content);

    const res = await fetch("/api/kb/ingest", { method: "POST", body: form });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "error");
      return;
    }
    setResult(`✓ ${json.chunks} chunks indexados (${json.chars.toLocaleString()} chars)`);
    setTitle("");
    setContent("");
    setFile(null);
    const f = document.getElementById("kb-file") as HTMLInputElement | null;
    if (f) f.value = "";
    router.refresh();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-5 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm"
    >
      <p className="text-xs text-neutral-500">
        Sube cursos, documentos, FAQs. Acepta PDF, DOCX, TXT, MD, SRT, VTT. Cada chunk se vectoriza con{" "}
        <span className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[11px] text-neutral-700">gte-small</span>{" "}
        (384 dims) vía Supabase AI.
      </p>

      <div className="space-y-2">
        <label className="text-sm font-medium text-neutral-700">Título</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder='Ej: "Curso IA Foundations — Módulo 4"'
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-neutral-700">Archivo</label>
        <label
          htmlFor="kb-file"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) setFile(f);
          }}
          className={
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors " +
            (dragging
              ? "border-neutral-900 bg-neutral-50"
              : "border-neutral-300 hover:border-neutral-400 hover:bg-neutral-50")
          }
        >
          <svg
            className="h-8 w-8 text-neutral-400"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
            />
          </svg>
          {file ? (
            <span className="text-sm font-medium text-neutral-900">{file.name}</span>
          ) : (
            <>
              <span className="text-sm font-medium text-neutral-700">
                Arrastra un archivo o haz clic para seleccionar
              </span>
              <span className="text-xs text-neutral-400">PDF, DOCX, TXT, MD, SRT, VTT</span>
            </>
          )}
          <input
            id="kb-file"
            type="file"
            accept=".pdf,.docx,.txt,.md,.srt,.vtt"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="sr-only"
          />
        </label>
        <p className="text-xs text-neutral-400">Máx 5 MB. Transcripciones largas: usar TXT o SRT.</p>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-neutral-700">… o pegá contenido (markdown)</label>
        <textarea
          rows={6}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Pega markdown aquí"
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {result && <p className="text-sm text-emerald-700">{result}</p>}

      <button
        type="submit"
        disabled={busy}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
      >
        {busy ? "Procesando…" : "Indexar"}
      </button>
    </form>
  );
}
