// Cloudflare Worker: intermediario seguro entre AulaGame y la API de Anthropic (Claude)
// para generar preguntas con IA, y activación segura de la demo Premium de 5 días.
// Solo disponible para profesores con plan Premium o demo activa (verificado en
// Firestore, en el servidor, nunca solo en el navegador).
//
// Endpoints:
//   POST /generate     Body JSON: { uid, game, subject, count, extra? }
//                       Respuesta OK:  { ok:true, data: <estructura específica del juego> }
//                       Respuesta error: { ok:false, error: "mensaje legible", code?: "..." }
//
//   POST /start-trial   Header: Authorization: Bearer <Firebase ID token>
//                        Activa 5 días de Premium de prueba para la cuenta del token (una
//                        sola vez por cuenta). Respuesta OK: { ok:true, trialFin: "<ISO>" }

const ALLOWED_ORIGINS = [
  "https://aulagames.teacherseba.com",
  "https://aulagame.cl",
  "https://www.aulagame.cl",
];
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";

const TRIAL_DIAS = 5;
const TRIAL_AI_LIMITE = 10;

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin) || LOCALHOST_RE.test(origin);
}

function corsHeaders(origin) {
  const allow = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/* ======================================================================
 * A. CUENTA DE SERVICIO DE FIREBASE — acceso de servidor a Firestore
 *    (lectura y escritura de profes/{uid}), nunca confía en lo que envía
 *    el navegador. Usa OAuth2 con JWT firmado por la cuenta de servicio.
 * ====================================================================== */

let cachedGoogleToken = null; // { token, expiresAt } — se reutiliza mientras el Worker esté "caliente"

function base64url(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importServiceAccountKey(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey("pkcs8", bytes.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

const CF_EDGE_ERROR_CODES = new Set([520, 521, 522, 523, 524, 525, 526, 527]);

/** Cloudflare Workers ocasionalmente devuelve un 520-527 sintético (generado por el
 * propio edge de Cloudflare, no por el origen real) para subrequests a Google que en
 * realidad habrían funcionado. Reintenta un par de veces antes de darse por vencido. */
async function fetchWithRetry(url, options, attempts = 3) {
  let lastRes;
  for (let i = 0; i < attempts; i++) {
    lastRes = await fetch(url, options);
    if (!CF_EDGE_ERROR_CODES.has(lastRes.status)) return lastRes;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
  }
  return lastRes;
}

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedGoogleToken && cachedGoogleToken.expiresAt > now + 60) return cachedGoogleToken.token;

  let sa;
  try {
    sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON no es un JSON válido.");
  }

  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const signInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const key = await importServiceAccountKey(sa.private_key);
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(signInput));
  const jwt = `${signInput}.${base64url(signature)}`;

  const tokenRes = await fetchWithRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!tokenRes.ok) throw new Error("No se pudo obtener el token de Google: " + (await tokenRes.text()));
  const tokenData = await tokenRes.json();
  cachedGoogleToken = { token: tokenData.access_token, expiresAt: now + (tokenData.expires_in || 3600) };
  return cachedGoogleToken.token;
}

/* ======================================================================
 * B. LECTURA/ESCRITURA DE profes/{uid} EN FIRESTORE (REST, vía cuenta de
 *    servicio — bypassa las reglas de seguridad igual que el Admin SDK).
 * ====================================================================== */

function parseFirestoreValue(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return parseInt(v.integerValue, 10);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(parseFirestoreValue);
  if ("mapValue" in v) return parseFirestoreFields(v.mapValue.fields || {});
  return null;
}

function parseFirestoreFields(fields) {
  const out = {};
  for (const k in fields) out[k] = parseFirestoreValue(fields[k]);
  return out;
}

function profeDocUrl(env, uid) {
  const projectId = env.FIREBASE_PROJECT_ID || "aulagame-4c019";
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/profes/${encodeURIComponent(uid)}`;
}

/** Lee profes/{uid} completo. Devuelve {} si el documento todavía no existe. */
async function getProfeDoc(env, uid) {
  const token = await getGoogleAccessToken(env);
  const res = await fetchWithRetry(profeDocUrl(env, uid), { headers: { Authorization: "Bearer " + token } });
  if (res.status === 404) return {};
  if (!res.ok) throw new Error("Firestore respondió " + res.status + ": " + (await res.text()));
  const doc = await res.json();
  return parseFirestoreFields(doc.fields || {});
}

/** Escribe solo los campos indicados en profes/{uid} (merge por updateMask); crea el
 * documento si todavía no existía. Nunca toca "juegos" ni otros campos no listados. */
async function patchProfeDoc(env, uid, fieldsTyped) {
  const token = await getGoogleAccessToken(env);
  const maskParams = Object.keys(fieldsTyped)
    .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join("&");
  const res = await fetchWithRetry(`${profeDocUrl(env, uid)}?${maskParams}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ fields: fieldsTyped }),
  });
  if (!res.ok) throw new Error("Firestore PATCH respondió " + res.status + ": " + (await res.text()));
  return res.json();
}

/** Calcula el estado "premium" combinado (plan pagado o demo de 5 días activa) a
 * partir del documento profes/{uid}. */
function estadoPremiumDesdeDoc(data) {
  const plan = data.plan === "premium" ? "premium" : "gratis";
  const trialFinMs = data.trialFin ? new Date(data.trialFin).getTime() : null;
  const trialActiva = !!(trialFinMs && trialFinMs > Date.now());
  const aiTrialUsos = typeof data.aiTrialUsos === "number" ? data.aiTrialUsos : 0;
  return {
    plan,
    trialUsado: !!data.trialUsado,
    trialActiva,
    trialFinMs,
    premium: plan === "premium" || trialActiva,
    aiTrialUsos,
  };
}

/* ======================================================================
 * C. VERIFICACIÓN DE TOKEN DE FIREBASE AUTH (para /start-trial) — nunca
 *    confía en el uid que mande el navegador: lo obtiene del propio token
 *    firmado por Google, verificado con las claves públicas de Firebase.
 * ====================================================================== */

import { importX509, jwtVerify, decodeProtectedHeader } from "jose";

const FIREBASE_CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let cachedFirebaseCerts = null; // { certs, expiresAt }

async function getFirebaseCerts() {
  const now = Date.now();
  if (cachedFirebaseCerts && cachedFirebaseCerts.expiresAt > now) return cachedFirebaseCerts.certs;
  const res = await fetchWithRetry(FIREBASE_CERTS_URL, {});
  if (!res.ok) throw new Error("No se pudieron obtener las claves públicas de Firebase.");
  const certs = await res.json();
  const cacheControl = res.headers.get("cache-control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAgeMs = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) * 1000 : 3600000;
  cachedFirebaseCerts = { certs, expiresAt: now + Math.min(maxAgeMs, 6 * 3600000) };
  return certs;
}

/** Verifica un Firebase Auth ID token (firma, emisor, audiencia y expiración) y
 * devuelve el uid real del profesor dueño de la sesión. Lanza si no es válido. */
async function verifyFirebaseIdToken(idToken, projectId) {
  const certs = await getFirebaseCerts();
  const { kid } = decodeProtectedHeader(idToken);
  const cert = kid && certs[kid];
  if (!cert) throw new Error("Token con clave desconocida o expirada.");
  const publicKey = await importX509(cert, "RS256");
  const { payload } = await jwtVerify(idToken, publicKey, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });
  if (!payload.sub || typeof payload.sub !== "string") throw new Error("Token sin identificador de usuario.");
  return payload.sub;
}

/* ======================================================================
 * D. CONFIGURACIÓN POR JUEGO — formato exacto que espera cada editor,
 *    instrucciones de generación y el "tool schema" que fuerza a Claude
 *    a devolver JSON estructurado válido (tool_choice forzado).
 * ====================================================================== */

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const BASE_SYSTEM =
  "Eres un asistente para profesores que crea material educativo para juegos de clase en AulaGame. " +
  "Genera contenido apropiado para estudiantes (sin violencia, sexo, discriminación ni lenguaje ofensivo), " +
  "claro, correcto y variado. Responde siempre en español salvo que el tema pida explícitamente contenido " +
  "en otro idioma (ej. vocabulario o gramática de inglés). Usa EXCLUSIVAMENTE la herramienta indicada para " +
  "responder — no escribas texto fuera de la llamada a la herramienta.";

const GAME_CONFIG = {
  rosco: {
    minCount: 26, maxCount: 26, defaultCount: 26,
    build(subject) {
      return {
        userPrompt:
          `Tema: "${subject}". Genera las 26 pistas de un rosco tipo "Pasapalabra": una pista por cada letra ` +
          `del abecedario en este orden exacto: ${LETTERS.join(",")}. Cada pista debe describir, sin nombrarla, ` +
          `una palabra relacionada con el tema que EMPIECE con esa letra (si de verdad no existe ninguna palabra ` +
          `razonable que empiece con esa letra para el tema dado, usa una palabra que CONTENGA esa letra y acláralo ` +
          `en la pista, ej. "Contiene la K:"). Pistas breves (máx. 20 palabras), claras y sin ambigüedad.`,
        tool: {
          name: "devolver_rosco",
          description: "Devuelve las 26 pistas del rosco en orden alfabético A-Z.",
          input_schema: {
            type: "object",
            properties: { clues: { type: "array", minItems: 26, maxItems: 26, items: { type: "string" } } },
            required: ["clues"],
          },
        },
      };
    },
  },

  millonario: {
    minCount: 3, maxCount: 30, defaultCount: 10,
    build(subject, n) {
      return {
        userPrompt:
          `Tema: "${subject}". Genera ${n} preguntas de opción múltiple estilo "¿Quién quiere ser millonario?", ` +
          `cada una con 4 alternativas (solo una correcta) y dificultad variada.`,
        tool: {
          name: "devolver_preguntas",
          description: "Devuelve las preguntas de opción múltiple generadas.",
          input_schema: {
            type: "object",
            properties: {
              questions: {
                type: "array", minItems: n, maxItems: n,
                items: {
                  type: "object",
                  properties: {
                    prompt: { type: "string" },
                    options: { type: "array", minItems: 4, maxItems: 4, items: { type: "string" } },
                    correct: { type: "integer", minimum: 0, maximum: 3, description: "Índice (0-3) de la alternativa correcta dentro de options." },
                  },
                  required: ["prompt", "options", "correct"],
                },
              },
            },
            required: ["questions"],
          },
        },
      };
    },
  },

  battlecastle3d: {
    minCount: 5, maxCount: 60, defaultCount: 15,
    build(subject, n) {
      return {
        userPrompt:
          `Tema: "${subject}". Genera ${n} preguntas de opción múltiple con exactamente 3 alternativas cada una ` +
          `(1 correcta + 2 incorrectas), para un juego de batalla de castillos por turnos. Preguntas cortas y directas.`,
        tool: {
          name: "devolver_preguntas",
          description: "Devuelve las preguntas generadas.",
          input_schema: {
            type: "object",
            properties: {
              questions: {
                type: "array", minItems: n, maxItems: n,
                items: {
                  type: "object",
                  properties: {
                    question: { type: "string" },
                    options: {
                      type: "array", minItems: 3, maxItems: 3, items: { type: "string" },
                      description: "3 alternativas. options[0] DEBE ser siempre la respuesta correcta; options[1] y options[2] son distractores plausibles.",
                    },
                  },
                  required: ["question", "options"],
                },
              },
            },
            required: ["questions"],
          },
        },
      };
    },
  },

  jeopardy: {
    minCount: 1, maxCount: 1, defaultCount: 1, // estructura fija: 25 + 5 bonus
    build(subject, n, extra) {
      const cats = Array.isArray(extra && extra.categories) && extra.categories.length
        ? extra.categories.slice(0, 5)
        : null;
      const catLine = cats
        ? `Usa estas 5 categorías, una por cada clave de color (en este orden: azul, rojo, verde, amarillo, morado): ${cats.join(" | ")}.`
        : `Inventa 5 subcategorías variadas y relevantes del tema dado, y asígnalas en este orden a las claves de color: azul, rojo, verde, amarillo, morado.`;
      return {
        userPrompt:
          `Tema general: "${subject}". Genera un tablero tipo Jeopardy con 5 categorías x 5 preguntas cada una ` +
          `(25 preguntas en total), con puntajes 50/40/30/20/10 por categoría (a mayor puntaje, mayor dificultad). ` +
          `${catLine} Además genera 5 preguntas "bonus" adicionales (más difíciles, sin categoría) sobre el mismo tema general.`,
        tool: {
          name: "devolver_jeopardy",
          description: "Devuelve el tablero completo de Jeopardy.",
          input_schema: {
            type: "object",
            properties: {
              questions: {
                type: "array", minItems: 25, maxItems: 25,
                items: {
                  type: "object",
                  properties: {
                    cat: { type: "string", enum: ["azul", "rojo", "verde", "amarillo", "morado"] },
                    pts: { type: "integer", enum: [50, 40, 30, 20, 10] },
                    q: { type: "string" },
                    a: { type: "string" },
                  },
                  required: ["cat", "pts", "q", "a"],
                },
              },
              bonusQuestions: {
                type: "array", minItems: 5, maxItems: 5,
                items: {
                  type: "object",
                  properties: { q: { type: "string" }, a: { type: "string" } },
                  required: ["q", "a"],
                },
              },
            },
            required: ["questions", "bonusQuestions"],
          },
        },
      };
    },
  },

  betyouranswer: {
    minCount: 3, maxCount: 30, defaultCount: 10,
    build(subject, n) {
      return {
        userPrompt:
          `Tema: "${subject}". Genera ${n} preguntas de trivia de respuesta abierta (el profesor juzga oralmente ` +
          `si la respuesta del alumno es correcta), cada una con su respuesta correcta y una breve explicación/dato curioso.`,
        tool: {
          name: "devolver_preguntas",
          description: "Devuelve las preguntas de trivia generadas.",
          input_schema: {
            type: "object",
            properties: {
              questions: {
                type: "array", minItems: n, maxItems: n,
                items: {
                  type: "object",
                  properties: {
                    question: { type: "string" },
                    answer: { type: "string" },
                    explanation: { type: "string" },
                  },
                  required: ["question", "answer", "explanation"],
                },
              },
            },
            required: ["questions"],
          },
        },
      };
    },
  },

  impostor: {
    minCount: 1, maxCount: 10, defaultCount: 3,
    build(subject, n) {
      return {
        userPrompt:
          `Tema: "${subject}". Genera ${n} rondas para un juego tipo "Impostor/Codenames": cada ronda tiene un ` +
          `título corto y exactamente 8 palabras (sustantivos concretos, en el mismo idioma que el tema) que ` +
          `pertenecen claramente a esa temática, para que los jugadores las adivinen por pistas.`,
        tool: {
          name: "devolver_rondas",
          description: "Devuelve las rondas generadas.",
          input_schema: {
            type: "object",
            properties: {
              rounds: {
                type: "array", minItems: n, maxItems: n,
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    words: {
                      type: "object",
                      properties: {
                        green: { type: "string" }, red: { type: "string" }, blue: { type: "string" }, lime: { type: "string" },
                        white: { type: "string" }, pink: { type: "string" }, cyan: { type: "string" }, orange: { type: "string" },
                      },
                      required: ["green", "red", "blue", "lime", "white", "pink", "cyan", "orange"],
                    },
                  },
                  required: ["title", "words"],
                },
              },
            },
            required: ["rounds"],
          },
        },
      };
    },
  },

  quizlive: {
    minCount: 3, maxCount: 30, defaultCount: 10,
    build(subject, n) {
      return {
        userPrompt: `Tema: "${subject}". Genera ${n} preguntas de opción múltiple con 4 alternativas cada una (solo una correcta).`,
        tool: {
          name: "devolver_preguntas",
          description: "Devuelve las preguntas generadas.",
          input_schema: {
            type: "object",
            properties: {
              questions: {
                type: "array", minItems: n, maxItems: n,
                items: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    options: { type: "array", minItems: 4, maxItems: 4, items: { type: "string" } },
                    correct: { type: "integer", minimum: 0, maximum: 3 },
                  },
                  required: ["text", "options", "correct"],
                },
              },
            },
            required: ["questions"],
          },
        },
      };
    },
  },

  robotfight: {
    minCount: 3, maxCount: 40, defaultCount: 10,
    build(subject, n) {
      return {
        userPrompt:
          `Tema: "${subject}". Genera ${n} tarjetas de práctica: cada una tiene un "enunciado" corto (una palabra, ` +
          `número o frase corta a mostrar), la "respuesta correcta" y 2 respuestas incorrectas plausibles (distractores).`,
        tool: {
          name: "devolver_preguntas",
          description: "Devuelve las tarjetas generadas.",
          input_schema: {
            type: "object",
            properties: {
              questions: {
                type: "array", minItems: n, maxItems: n,
                items: {
                  type: "object",
                  properties: {
                    number: { type: "string", description: "El enunciado/prompt corto a mostrar (a pesar del nombre del campo, puede ser texto)." },
                    correct: { type: "string" },
                    wrong: { type: "array", minItems: 2, maxItems: 2, items: { type: "string" } },
                  },
                  required: ["number", "correct", "wrong"],
                },
              },
            },
            required: ["questions"],
          },
        },
      };
    },
  },

  raceboard: {
    minCount: 3, maxCount: 40, defaultCount: 12,
    build(subject, n) {
      return {
        userPrompt: `Tema: "${subject}". Genera ${n} preguntas o consignas de respuesta abierta que el profesor leerá en voz alta a los alumnos.`,
        tool: {
          name: "devolver_preguntas",
          description: "Devuelve la lista de preguntas.",
          input_schema: {
            type: "object",
            properties: { questions: { type: "array", minItems: n, maxItems: n, items: { type: "string" } } },
            required: ["questions"],
          },
        },
      };
    },
  },

  evilgame: {
    minCount: 3, maxCount: 30, defaultCount: 23,
    build(subject, n) {
      return {
        userPrompt: `Tema: "${subject}". Genera ${n} consignas/preguntas cortas de respuesta abierta para casillas de un tablero tipo "juego de la oca".`,
        tool: {
          name: "devolver_preguntas",
          description: "Devuelve la lista de consignas.",
          input_schema: {
            type: "object",
            properties: { questions: { type: "array", minItems: n, maxItems: n, items: { type: "string" } } },
            required: ["questions"],
          },
        },
      };
    },
  },

  monopoly: {
    minCount: 3, maxCount: 40, defaultCount: 16,
    build(subject, n) {
      return {
        userPrompt: `Tema: "${subject}". Genera ${n} consignas cortas de respuesta abierta (ej. "di una oración usando...", "nombra...") para tarjetas de un juego tipo Monopoly.`,
        tool: {
          name: "devolver_preguntas",
          description: "Devuelve la lista de consignas.",
          input_schema: {
            type: "object",
            properties: { questions: { type: "array", minItems: n, maxItems: n, items: { type: "string" } } },
            required: ["questions"],
          },
        },
      };
    },
  },

  memorice: {
    minCount: 2, maxCount: 15, defaultCount: 8,
    build(subject, n) {
      return {
        userPrompt:
          `Tema: "${subject}". Genera ${n} palabras de vocabulario simples (1-2 palabras cada una) relacionadas con ` +
          `el tema, para que el profesor busque/tome fotos y arme un juego de memoria (memorice). Deben ser fáciles ` +
          `de representar con una imagen.`,
        tool: {
          name: "devolver_palabras",
          description: "Devuelve la lista de palabras de vocabulario.",
          input_schema: {
            type: "object",
            properties: { labels: { type: "array", minItems: n, maxItems: n, items: { type: "string" } } },
            required: ["labels"],
          },
        },
      };
    },
  },
};

/* ======================================================================
 * E. HANDLER PRINCIPAL
 * ====================================================================== */

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const projectId = env.FIREBASE_PROJECT_ID || "aulagame-4c019";

    if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      return json({ ok: false, error: "El servidor no tiene configurada la cuenta de servicio de Firebase." }, 500, origin);
    }

    /* ---------------- POST /start-trial ---------------- */
    if (request.method === "POST" && url.pathname === "/start-trial") {
      const authHeader = request.headers.get("Authorization") || "";
      const match = authHeader.match(/^Bearer (.+)$/);
      if (!match) {
        return json({ ok: false, error: "Falta iniciar sesión para activar la demo." }, 401, origin);
      }

      let uid;
      try {
        uid = await verifyFirebaseIdToken(match[1], projectId);
      } catch (e) {
        console.error("Token de Firebase inválido:", e);
        return json({ ok: false, error: "Tu sesión no es válida. Vuelve a iniciar sesión e intenta de nuevo." }, 401, origin);
      }

      let actual;
      try {
        actual = await getProfeDoc(env, uid);
      } catch (e) {
        console.error("Error leyendo profes/{uid} para start-trial:", e);
        return json({ ok: false, error: "No se pudo verificar tu cuenta. Intenta de nuevo en unos segundos." }, 502, origin);
      }

      if (actual.plan === "premium") {
        return json({ ok: false, code: "ALREADY_PREMIUM", error: "Tu cuenta ya tiene el plan Premium — no necesitas la demo." }, 409, origin);
      }
      if (actual.trialUsado) {
        return json({ ok: false, code: "TRIAL_USED", error: "Esta cuenta ya usó su demo gratuita de 5 días anteriormente." }, 409, origin);
      }

      const ahoraMs = Date.now();
      const trialFinMs = ahoraMs + TRIAL_DIAS * 24 * 60 * 60 * 1000;
      try {
        await patchProfeDoc(env, uid, {
          trialUsado: { booleanValue: true },
          trialInicio: { timestampValue: new Date(ahoraMs).toISOString() },
          trialFin: { timestampValue: new Date(trialFinMs).toISOString() },
          aiTrialUsos: { integerValue: "0" },
        });
      } catch (e) {
        console.error("Error activando demo Premium:", e);
        return json({ ok: false, error: "No se pudo activar la demo. Intenta de nuevo." }, 502, origin);
      }

      return json({ ok: true, trialFin: new Date(trialFinMs).toISOString() }, 200, origin);
    }

    /* ---------------- POST /generate ---------------- */
    if (request.method !== "POST" || url.pathname !== "/generate") {
      return json({ ok: false, error: "Ruta no encontrada. Usa POST /generate o POST /start-trial." }, 404, origin);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json({ ok: false, error: "El servidor no tiene configurada la clave de la IA (ANTHROPIC_API_KEY)." }, 500, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ ok: false, error: "Cuerpo de la solicitud inválido (se esperaba JSON)." }, 400, origin);
    }

    const { uid, game, subject, count, extra } = body || {};

    if (!uid || typeof uid !== "string") return json({ ok: false, error: "Falta el uid del profesor." }, 400, origin);
    if (!game || !GAME_CONFIG[game]) return json({ ok: false, error: "Juego no soportado: " + game }, 400, origin);
    if (!subject || typeof subject !== "string" || !subject.trim()) {
      return json({ ok: false, error: "Falta indicar el tema o materia." }, 400, origin);
    }

    let perfil;
    try {
      perfil = estadoPremiumDesdeDoc(await getProfeDoc(env, uid));
    } catch (e) {
      console.error("Error verificando plan premium:", e);
      return json({ ok: false, error: "No se pudo verificar tu plan en este momento. Intenta de nuevo en unos segundos." }, 502, origin);
    }
    if (!perfil.premium) {
      return json(
        { ok: false, code: "NOT_PREMIUM", error: "Generar preguntas con IA es una función exclusiva para profesores con plan Premium." },
        403,
        origin
      );
    }

    // Durante la demo (plan todavía "gratis" pero con trial activo) se limita la IA a
    // un total de TRIAL_AI_LIMITE generaciones, para proteger el crédito de la API.
    const enDemo = perfil.plan !== "premium" && perfil.trialActiva;
    if (enDemo && perfil.aiTrialUsos >= TRIAL_AI_LIMITE) {
      return json(
        {
          ok: false,
          code: "TRIAL_AI_LIMIT",
          error: `Ya usaste tus ${TRIAL_AI_LIMITE} generaciones con IA incluidas en la demo gratuita. Pásate a Premium para seguir generando sin límite.`,
        },
        403,
        origin
      );
    }

    const cfg = GAME_CONFIG[game];
    const n = clamp(parseInt(count, 10), cfg.minCount, cfg.maxCount);
    const { userPrompt, tool } = cfg.build(subject.trim().slice(0, 300), n, extra);

    let anthropicRes;
    try {
      anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 8000,
          system: BASE_SYSTEM,
          messages: [{ role: "user", content: userPrompt }],
          tools: [tool],
          tool_choice: { type: "tool", name: tool.name },
        }),
      });
    } catch (e) {
      console.error("Error de red llamando a Anthropic:", e);
      return json({ ok: false, error: "No se pudo contactar al servicio de IA. Intenta de nuevo." }, 502, origin);
    }

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic respondió con error:", anthropicRes.status, errText);
      const friendly = anthropicRes.status === 429
        ? "El servicio de IA está saturado en este momento. Intenta de nuevo en un minuto."
        : "Ocurrió un error generando las preguntas con IA. Intenta de nuevo.";
      return json({ ok: false, error: friendly }, 502, origin);
    }

    const data = await anthropicRes.json();
    const toolUse = (data.content || []).find((b) => b.type === "tool_use");
    if (!toolUse || !toolUse.input) {
      console.error("Respuesta de Anthropic sin tool_use:", JSON.stringify(data).slice(0, 500));
      return json({ ok: false, error: "La IA no devolvió un resultado con el formato esperado. Intenta de nuevo." }, 502, origin);
    }

    if (enDemo) {
      try {
        await patchProfeDoc(env, uid, { aiTrialUsos: { integerValue: String(perfil.aiTrialUsos + 1) } });
      } catch (e) {
        // No bloquea la respuesta al profesor por un fallo al contabilizar el uso;
        // solo se registra para no perder la generación ya pagada a la API.
        console.error("No se pudo incrementar aiTrialUsos:", e);
      }
    }

    return json({ ok: true, data: toolUse.input }, 200, origin);
  },
};
