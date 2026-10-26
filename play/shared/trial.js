// Módulo compartido: activación de la demo Premium gratuita de 5 días, vía el
// mismo Cloudflare Worker que genera preguntas con IA. La activación real (y la
// verificación de que la cuenta no la haya usado antes) ocurre en el servidor
// — este módulo solo llama al endpoint con el ID token de Firebase Auth del
// profesor ya logueado.

// Misma base que AI_WORKER_URL en ai-questions.js (ver cloudflare-worker/README.md).
export const TRIAL_WORKER_BASE = "https://aulagame-ai-questions.aulagame-snlmjjs.workers.dev";

/**
 * idToken: el ID token de Firebase Auth del profesor (user.getIdToken()).
 * Devuelve { ok:true, trialFin:"<ISO>" } si se activó, o lanza un Error con
 * `.message` legible y `.code` (ej. "TRIAL_USED", "ALREADY_PREMIUM") si no.
 */
export async function activarDemoPremium(idToken) {
  const res = await fetch(TRIAL_WORKER_BASE + "/start-trial", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + idToken },
  });
  const payload = await res.json().catch(function () { return null; });
  if (!res.ok || !payload || !payload.ok) {
    const err = new Error((payload && payload.error) || "No se pudo activar la demo. Intenta de nuevo.");
    err.code = payload && payload.code;
    throw err;
  }
  return payload;
}
