// Cloudflare Worker: intermediario seguro entre AulaGame y la API de Anthropic (Claude)
// para generar preguntas con IA. Solo disponible para profesores con plan Premium
// (verificado en Firestore, en el servidor, nunca solo en el navegador).
//
// Endpoint: POST /generate
// Body JSON: { uid, game, subject, count, extra? }
// Respuesta OK:  { ok:true, data: <estructura específica del juego, ver GAME_CONFIG> }
// Respuesta error: { ok:false, error: "mensaje legible", code?: "NOT_PREMIUM" }

const ALLOWED_ORIGINS = [
  "https://aulagames.teacherseba.com",
];
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin) || LOCALHOST_RE.test(origin);
}

function corsHeaders(origin) {
  const allow = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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
 * A. VERIFICACIÓN DE PLAN PREMIUM EN FIRESTORE (server-side, vía cuenta
 *    de servicio de Firebase — nunca confía en lo que envía el navegador)
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
    scope: "https://www.googleapis.com/auth/datastore.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const signInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const key = await importServiceAccountKey(sa.private_key);
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(signInput));
  const jwt = `${signInput}.${base64url(signature)}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!tokenRes.ok) throw new Error("No se pudo obtener el token de Google: " + (await tokenRes.text()));
  const tokenData = await tokenRes.json();
  cachedGoogleToken = { token: tokenData.access_token, expiresAt: now + (tokenData.expires_in || 3600) };
  return cachedGoogleToken.token;
}

/** Lee profes/{uid} en Firestore usando la cuenta de servicio y confirma plan === "premium". */
async function checkIsPremium(env, uid) {
  const token = await getGoogleAccessToken(env);
  const projectId = env.FIREBASE_PROJECT_ID || "aulagame-4c019";
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/profes/${encodeURIComponent(uid)}`,
    { headers: { Authorization: "Bearer " + token } }
  );
  if (res.status === 404) return false;
  if (!res.ok) throw new Error("Firestore respondió " + res.status + ": " + (await res.text()));
  const doc = await res.json();
  const planVal = doc.fields && doc.fields.plan && doc.fields.plan.stringValue;
  return planVal === "premium";
}

/* ======================================================================
 * B. CONFIGURACIÓN POR JUEGO — formato exacto que espera cada editor,
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
 * C. HANDLER PRINCIPAL
 * ====================================================================== */

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/generate") {
      return json({ ok: false, error: "Ruta no encontrada. Usa POST /generate." }, 404, origin);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json({ ok: false, error: "El servidor no tiene configurada la clave de la IA (ANTHROPIC_API_KEY)." }, 500, origin);
    }
    if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      return json({ ok: false, error: "El servidor no tiene configurada la cuenta de servicio de Firebase." }, 500, origin);
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

    let premium;
    try {
      premium = await checkIsPremium(env, uid);
    } catch (e) {
      console.error("Error verificando plan premium:", e);
      return json({ ok: false, error: "No se pudo verificar tu plan en este momento. Intenta de nuevo en unos segundos." }, 502, origin);
    }
    if (!premium) {
      return json(
        { ok: false, code: "NOT_PREMIUM", error: "Generar preguntas con IA es una función exclusiva para profesores con plan Premium." },
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

    return json({ ok: true, data: toolUse.input }, 200, origin);
  },
};
