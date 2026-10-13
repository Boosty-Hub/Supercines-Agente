// _shared/keep-alive.ts
// Para las funciones que el llamador ESPERA (necesita el resultado) pero que no
// pueden morir a mitad si el llamador corta: el panel (serverless, timeout del host)
// o pg_net. Sin esto, cuando el cliente se desconecta el runtime mata el handler y el
// trabajo queda a medias (p. ej. el reintento manual de un seguimiento muere después
// del salesbot y antes de registrar el envío → el próximo barrido lo vuelve a mandar).
//
// keepAlive(work) registra la promesa en EdgeRuntime.waitUntil —el worker sigue vivo
// hasta que termine, aunque nadie lea la respuesta— y devuelve la MISMA promesa para
// que el handler la espere y conteste con el resultado si el llamador sigue ahí.
// Sin EdgeRuntime (tests/local) es transparente.

type WaitUntil = (p: Promise<unknown>) => void;

export function keepAlive<T>(work: Promise<T>, runtime: { waitUntil?: WaitUntil } | undefined = edgeRuntime()): Promise<T> {
  // El catch es solo para la copia que sostiene al worker: el error lo maneja quien espera `work`.
  if (runtime?.waitUntil) runtime.waitUntil(work.catch(() => {}));
  return work;
}

function edgeRuntime(): { waitUntil?: WaitUntil } | undefined {
  return (globalThis as { EdgeRuntime?: { waitUntil?: WaitUntil } }).EdgeRuntime;
}
