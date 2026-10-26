// Módulo compartido: calcula el estado "Premium" combinado (plan pagado o demo
// gratuita de 5 días activa) a partir de los datos crudos de profes/{uid} en
// Firestore. Puro — sin dependencias de Firebase — para poder usarse igual
// desde index.html y desde los editores de cada juego (play/shared/ai-questions.js).

export const TRIAL_DIAS = 5;
export const TRIAL_AI_LIMITE = 10;

function aFecha(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === "function") return valor.toDate(); // Firestore Timestamp (SDK cliente)
  var fecha = new Date(valor);
  return isNaN(fecha.getTime()) ? null : fecha;
}

/**
 * data: el objeto que entrega snap.data() de profes/{uid} (o {} si no existe).
 * Devuelve:
 *   plan           — "gratis" | "premium"
 *   trialUsado     — true si esta cuenta ya activó su demo alguna vez
 *   trialActiva    — true si la demo está activa ahora mismo (trialFin futuro)
 *   diasRestantes  — días completos que quedan de demo (0 si no hay demo activa)
 *   esPremium      — true si plan === "premium" O trialActiva (lo que se usa en
 *                    todo el sitio para límites de juegos, botón de IA, insignias...)
 *   aiTrialUsos    — generaciones de IA ya usadas durante la demo actual
 *   puedeActivarDemo — true si puede activar la demo (no la ha usado y no es premium)
 */
export function calcularEstadoPremium(data) {
  data = data || {};
  var plan = data.plan === "premium" ? "premium" : "gratis";
  var trialFin = aFecha(data.trialFin);
  var ahora = new Date();
  var trialActiva = !!(trialFin && trialFin.getTime() > ahora.getTime());
  var diasRestantes = trialActiva ? Math.max(1, Math.ceil((trialFin.getTime() - ahora.getTime()) / 86400000)) : 0;
  var trialUsado = !!data.trialUsado;
  return {
    plan: plan,
    trialUsado: trialUsado,
    trialFin: trialFin,
    trialActiva: trialActiva,
    diasRestantes: diasRestantes,
    esPremium: plan === "premium" || trialActiva,
    aiTrialUsos: typeof data.aiTrialUsos === "number" ? data.aiTrialUsos : 0,
    puedeActivarDemo: plan !== "premium" && !trialActiva && !trialUsado,
  };
}
