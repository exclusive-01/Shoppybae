// Voice profiles: which Live model to use and how the session is configured.
// This file is the ONLY place that knows model IDs and the assistant persona.
// Shopping logic (product search, store rules, tools) is NOT here; it will be
// added later as a separate module that feeds `systemInstruction` and tools.

// Model IDs verified against Google's official models page (Gemini API docs,
// "Models", last updated 2026-10-22): gemini-3.8-live and
// gemini-3.8-live-extended-thinking are both listed as Stable.
export const PROFILES = {
  default: { model: "gemini-3.8-live" },
  "extended-thinking": { model: "gemini-3.8-live-extended-thinking" },
} as const;

export type ProfileName = keyof typeof PROFILES;
export const PROFILE_NAMES = Object.keys(PROFILES) as ProfileName[];

export function isProfileName(v: unknown): v is ProfileName {
  return typeof v === "string" && (PROFILE_NAMES as string[]).includes(v);
}

// Placeholder persona. No product data, no claims about features that do not exist yet.
export const SYSTEM_INSTRUCTION = [
  "You are the Shoppybae voice assistant.",
  "Speak naturally and keep answers short, since the user is listening, not reading.",
  "You do not currently have access to any product catalog, prices, or stock information.",
  "Never invent products, prices, availability, or store policies.",
  "If asked about specific products or orders, say that product search is not connected yet.",
].join(" ");

// Session settings shared by (a) the constraints locked into the ephemeral token
// and (b) the setup message the browser sends. Keeping them identical avoids
// setup/constraint mismatches. The system instruction stays server-side only.
export function sessionSettings() {
  return {
    responseModalities: ["AUDIO"],
    sessionResumption: {},
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

export function tokenConstraintsConfig() {
  return {
    ...sessionSettings(),
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
  };
}

export function clientSetup(profile: ProfileName) {
  return {
    model: `models/${PROFILES[profile].model}`,
    ...sessionSettings(),
  };
}
