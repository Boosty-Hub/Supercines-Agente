// Un `retrieveAgent` que lee cada agente UNA sola vez durante la vida del retriever.
//
// /agent necesita el agente vivo para dos cosas (desfase de scaffold/modelo y
// conflicto de prompt) y antes cada una hacía su propio GET a Anthropic. Se crea un
// retriever por render y se inyecta en ambas: comparten la lectura (incluso si
// corren en paralelo, porque se guarda la promesa). Es deliberadamente un objeto de
// vida corta y NO un cache global: los caminos que mutan el agente (sync, cambio de
// modelo) siempre leen la versión fresca para su control de concurrencia optimista.

import type { NamedResource } from "./anthropic-managed.ts";

export type AgentRetriever = (apiKey: string, agentId: string) => Promise<NamedResource>;

export function onceRetriever(retrieve: AgentRetriever): AgentRetriever {
  const lecturas = new Map<string, Promise<NamedResource>>();
  return (apiKey, agentId) => {
    const key = `${apiKey}\u0000${agentId}`;
    let p = lecturas.get(key);
    if (!p) {
      p = retrieve(apiKey, agentId);
      lecturas.set(key, p);
    }
    return p;
  };
}
