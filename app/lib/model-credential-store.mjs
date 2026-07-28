const MAX_CREDENTIAL_LENGTH = 4_096;
const MAX_MODEL_ID_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validModelId(value) {
  const id = text(value);
  return id && id.length <= MAX_MODEL_ID_LENGTH && !CONTROL_CHARACTER_PATTERN.test(id)
    ? id
    : "";
}

function validCredential(value) {
  const credential = text(value);
  return credential
    && credential.length <= MAX_CREDENTIAL_LENGTH
    && !CONTROL_CHARACTER_PATTERN.test(credential)
    ? credential
    : "";
}

function normalizeCredentialMap(credentials) {
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    return {};
  }

  const normalized = {};
  for (const [rawId, rawCredential] of Object.entries(credentials)) {
    const id = validModelId(rawId);
    const credential = validCredential(rawCredential);
    if (id && credential) normalized[id] = credential;
  }
  return normalized;
}

export function parseStoredCredentials(raw) {
  if (typeof raw !== "string") return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const normalized = normalizeCredentialMap(parsed);
    return Object.keys(normalized).length === Object.keys(parsed).length ? normalized : {};
  } catch {
    return {};
  }
}

export function updateCredential(credentials, id, draftValue, clearRequested) {
  const next = { ...normalizeCredentialMap(credentials) };
  const modelId = validModelId(id);
  if (!modelId) return next;
  if (clearRequested) {
    delete next[modelId];
    return next;
  }
  const credential = validCredential(draftValue);
  if (credential) next[modelId] = credential;
  return next;
}

export function maskCredential(value) {
  const credential = validCredential(value);
  if (!credential) return "";
  if (credential.length <= 3) return "••••";
  const prefix = credential.slice(0, Math.min(3, credential.length));
  const suffix = credential.length > 7 ? credential.slice(-4) : "";
  return `${prefix}…${suffix}`;
}
