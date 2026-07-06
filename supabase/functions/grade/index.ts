// Supabase Edge Function: grade
// Proxies grading requests to OpenRouter. API key stays server-side.
// Client sends: { kind: "text" | "audio", messages: [...], jsonMode?: boolean }

import { createClient } from "jsr:@supabase/supabase-js@2";

const DAILY_LIMIT = Number(Deno.env.get("DAILY_LIMIT") ?? "120");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // --- auth: verify the caller's JWT ---
  const authHeader = req.headers.get("Authorization") ?? "";
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user }, error: authErr } = await supa.auth.getUser();
  if (authErr || !user) return json({ error: "unauthorized" }, 401);

  // --- rate limit per user per day ---
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { count } = await admin
    .from("usage_log")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("created_at", since.toISOString());
  if ((count ?? 0) >= DAILY_LIMIT) {
    return json({ error: "daily limit reached, retry tomorrow" }, 429);
  }

  // --- payload ---
  let body: { kind?: string; messages?: unknown; jsonMode?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const { kind, messages, jsonMode = true } = body;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 6) {
    return json({ error: "invalid messages" }, 400);
  }
  const model =
    kind === "audio"
      ? Deno.env.get("MODEL_AUDIO") ?? "google/gemini-2.5-flash"
      : Deno.env.get("MODEL_TEXT") ?? "anthropic/claude-sonnet-4.5";

  // --- call OpenRouter ---
  const orRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("OPENROUTER_API_KEY")}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 2000,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!orRes.ok) {
    return json({ error: `openrouter ${orRes.status}: ${await orRes.text()}` }, 502);
  }
  const data = await orRes.json();

  // --- log usage ---
  await admin.from("usage_log").insert({ user_id: user.id, kind: kind ?? "text" });

  return json({ content: data.choices?.[0]?.message?.content ?? "" });
});
