"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_MODELS,
  addModel as addRegisteredModel,
  getConnectedModels,
  normalizeModels,
  parseStoredModels,
  removeModel as removeRegisteredModel,
  resolveSelectedModelId,
  setDefaultModel as setRegisteredDefaultModel,
  setModelEnabled as setRegisteredModelEnabled,
  type ChatModel,
  type ModelDraft,
} from "../lib/model-registry.mjs";
import {
  maskCredential,
  parseStoredCredentials,
  updateCredential,
} from "../lib/model-credential-store.mjs";
import { AGENT_IDS } from "../lib/agent-catalog.mjs";

const MODEL_STORAGE_KEY = "ai-workbench:model-registry:v2";
const LEGACY_MODEL_STORAGE_KEY = "ai-workbench:model-registry:v1";
const CREDENTIAL_STORAGE_KEY = "ai-workbench:model-credentials:v1";
const CREDENTIAL_REVISION_STORAGE_KEY = "ai-workbench:model-credential-revisions:v1";
const IMAGE_CONFIG_STORAGE_KEY = "ai-workbench:image-model-config:v1";
const IMAGE_CREDENTIAL_STORAGE_KEY = "ai-workbench:image-model-credential:v1";
const IMAGE_CREDENTIAL_REVISION_STORAGE_KEY =
  "ai-workbench:image-model-credential-revision:v1";
const CHAT_SELECTION_STORAGE_KEY = "ai-workbench:chat-model-selection:v1";
const AGENT_SELECTIONS_STORAGE_KEY = "ai-workbench:agent-model-selections:v1";
const SELECTABLE_AGENT_IDS = new Set(
  AGENT_IDS.filter((agentId) => agentId !== "content-matrix"),
);

type AgentModelSelections = Record<string, string>;
type TextModelConfigDraft = Partial<Pick<
  ChatModel,
  | "provider"
  | "displayName"
  | "baseUrl"
  | "modelId"
  | "enabled"
  | "isDefault"
  | "connectionStatus"
  | "testedFingerprint"
>>;
type ImageConfig = {
  baseUrl: string;
  modelId: string;
  enabled: boolean;
  connectionStatus: "untested" | "testing" | "connected" | "failed" | "changed";
  testedFingerprint: string;
};

const DEFAULT_IMAGE_CONFIG: ImageConfig = {
  baseUrl: "",
  modelId: "",
  enabled: false,
  connectionStatus: "untested",
  testedFingerprint: "",
};
const IMAGE_CONNECTION_STATUSES = new Set<ImageConfig["connectionStatus"]>([
  "untested",
  "testing",
  "connected",
  "failed",
  "changed",
]);

type ModelRegistry = {
  models: ChatModel[];
  enabledModels: ChatModel[];
  connectedModels: ChatModel[];
  chatSelectedModelId: string | null;
  chatSelectedModel: ChatModel | null;
  setChatSelectedModelId: (id: string | null) => void;
  getAgentSelectedModelId: (agentId: string) => string | null;
  setAgentSelectedModelId: (agentId: string, id: string | null) => void;
  addModel: (draft: Partial<ModelDraft>) => void;
  setModelEnabled: (id: string, enabled: boolean) => void;
  setDefaultModel: (id: string) => void;
  removeModel: (id: string) => void;
  getCredential: (id: string) => string | null;
  getMaskedCredential: (id: string) => string;
  getCredentialRevision: (id: string) => string;
  saveCredential: (
    id: string,
    draftValue: string,
    clearRequested: boolean,
    nextRevision?: string | null,
  ) => string;
  saveModelConfig: (id: string, draft: TextModelConfigDraft) => void;
  invalidateModelConnection: (id: string) => void;
  imageConfig: ImageConfig;
  imageCredential: string | null;
  imageCredentialRevision: string;
  saveImageConfig: (draft: Partial<ImageConfig>) => void;
  saveImageCredential: (
    draftValue: string,
    clearRequested: boolean,
    nextRevision?: string | null,
  ) => string;
  invalidateImageConnection: () => void;
};

const ModelRegistryContext = createContext<ModelRegistry | null>(null);

function reconcileAgentSelections(
  models: readonly ChatModel[],
  selections: AgentModelSelections,
) {
  const reconciled: AgentModelSelections = {};

  for (const [agentId, modelId] of Object.entries(selections)) {
    if (!SELECTABLE_AGENT_IDS.has(agentId) || typeof modelId !== "string") {
      continue;
    }
    const resolvedModelId = resolveSelectedModelId(models, modelId);
    if (resolvedModelId) reconciled[agentId] = resolvedModelId;
  }

  return reconciled;
}

function parseStoredAgentSelections(
  raw: string | null,
  models: readonly ChatModel[],
) {
  if (raw === null) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return reconcileAgentSelections(models, parsed as AgentModelSelections);
  } catch {
    return {};
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseStoredImageConfig(raw: string | null): ImageConfig {
  if (raw === null) return DEFAULT_IMAGE_CONFIG;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return DEFAULT_IMAGE_CONFIG;
    }
    const value = parsed as Partial<ImageConfig>;
    return {
      baseUrl: text(value.baseUrl),
      modelId: text(value.modelId),
      enabled: value.enabled === true,
      connectionStatus: IMAGE_CONNECTION_STATUSES.has(value.connectionStatus as ImageConfig["connectionStatus"])
        ? value.connectionStatus as ImageConfig["connectionStatus"]
        : "untested",
      testedFingerprint: text(value.testedFingerprint),
    };
  } catch {
    return DEFAULT_IMAGE_CONFIG;
  }
}

function parseStoredImageCredential(raw: string | null): string | null {
  if (raw === null) return null;
  return parseStoredCredentials(JSON.stringify({ image: raw })).image ?? null;
}

function validCredentialRevision(value: unknown): string {
  if (typeof value !== "string") return "";
  const revision = value.trim();
  return revision
    && revision.length <= 200
    && !/[\u0000-\u001F\u007F]/.test(revision)
    ? revision
    : "";
}

function parseStoredCredentialRevisions(raw: string | null): Record<string, string> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const revisions: Record<string, string> = {};
    for (const [rawId, rawRevision] of Object.entries(parsed)) {
      const id = text(rawId);
      const revision = validCredentialRevision(rawRevision);
      if (!id || !revision) return {};
      revisions[id] = revision;
    }
    return revisions;
  } catch {
    return {};
  }
}

function createCredentialRevision() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `rev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ModelRegistryProvider({ children }: { children: ReactNode }) {
  const [models, setModels] = useState<ChatModel[]>(() => [...DEFAULT_MODELS]);
  const [chatSelectedModelId, setChatSelectedModelIdState] = useState<
    string | null
  >(() =>
    resolveSelectedModelId(DEFAULT_MODELS, null),
  );
  const [agentSelectedModelIds, setAgentSelectedModelIds] =
    useState<AgentModelSelections>({});
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [credentialRevisions, setCredentialRevisions] =
    useState<Record<string, string>>({});
  const [imageConfig, setImageConfig] = useState<ImageConfig>(DEFAULT_IMAGE_CONFIG);
  const [imageCredential, setImageCredential] = useState<string | null>(null);
  const [imageCredentialRevision, setImageCredentialRevision] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let storedModels = DEFAULT_MODELS;
    let storedChatSelection: string | null = null;
    let storedAgentSelections: AgentModelSelections = {};
    let storedCredentials: Record<string, string> = {};
    let storedCredentialRevisions: Record<string, string> = {};
    let storedImageConfig = DEFAULT_IMAGE_CONFIG;
    let storedImageCredential: string | null = null;
    let storedImageCredentialRevision = "";
    try {
      const raw = window.localStorage.getItem(MODEL_STORAGE_KEY)
        ?? window.localStorage.getItem(LEGACY_MODEL_STORAGE_KEY);
      if (raw !== null) storedModels = parseStoredModels(raw);
      storedChatSelection = window.localStorage.getItem(
        CHAT_SELECTION_STORAGE_KEY,
      );
      storedAgentSelections = parseStoredAgentSelections(
        window.localStorage.getItem(AGENT_SELECTIONS_STORAGE_KEY),
        getConnectedModels(storedModels),
      );
      storedCredentials = parseStoredCredentials(
        window.localStorage.getItem(CREDENTIAL_STORAGE_KEY),
      );
      storedCredentialRevisions = parseStoredCredentialRevisions(
        window.localStorage.getItem(CREDENTIAL_REVISION_STORAGE_KEY),
      );
      for (const id of Object.keys(storedCredentials)) {
        if (!storedCredentialRevisions[id]) {
          storedCredentialRevisions[id] = createCredentialRevision();
        }
      }
      storedImageConfig = parseStoredImageConfig(
        window.localStorage.getItem(IMAGE_CONFIG_STORAGE_KEY),
      );
      storedImageCredential = parseStoredImageCredential(
        window.localStorage.getItem(IMAGE_CREDENTIAL_STORAGE_KEY),
      );
      storedImageCredentialRevision = validCredentialRevision(
        window.localStorage.getItem(IMAGE_CREDENTIAL_REVISION_STORAGE_KEY),
      );
      if (storedImageCredential && !storedImageCredentialRevision) {
        storedImageCredentialRevision = createCredentialRevision();
      }
    } catch {
      // Keep the server-safe defaults if browser storage is unavailable.
    }

    queueMicrotask(() => {
      setModels([...storedModels]);
      setChatSelectedModelIdState(
        resolveSelectedModelId(getConnectedModels(storedModels), storedChatSelection),
      );
      setAgentSelectedModelIds(storedAgentSelections);
      setCredentials(storedCredentials);
      setCredentialRevisions(storedCredentialRevisions);
      setImageConfig(storedImageConfig);
      setImageCredential(storedImageCredential);
      setImageCredentialRevision(storedImageCredentialRevision);
      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    if (!hydrated) return;

    try {
      window.localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(models));
    } catch {
      // The interactive registry remains usable when browser storage is unavailable.
    }
  }, [hydrated, models]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(credentials));
      window.localStorage.setItem(
        CREDENTIAL_REVISION_STORAGE_KEY,
        JSON.stringify(credentialRevisions),
      );
    } catch {
      // Credentials remain isolated in memory when browser storage is unavailable.
    }
  }, [credentialRevisions, credentials, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(IMAGE_CONFIG_STORAGE_KEY, JSON.stringify(imageConfig));
      if (imageCredential) {
        window.localStorage.setItem(IMAGE_CREDENTIAL_STORAGE_KEY, imageCredential);
      } else {
        window.localStorage.removeItem(IMAGE_CREDENTIAL_STORAGE_KEY);
      }
      if (imageCredentialRevision) {
        window.localStorage.setItem(
          IMAGE_CREDENTIAL_REVISION_STORAGE_KEY,
          imageCredentialRevision,
        );
      } else {
        window.localStorage.removeItem(IMAGE_CREDENTIAL_REVISION_STORAGE_KEY);
      }
    } catch {
      // Image settings remain isolated in memory when browser storage is unavailable.
    }
  }, [hydrated, imageConfig, imageCredential, imageCredentialRevision]);

  useEffect(() => {
    if (!hydrated) return;

    try {
      if (chatSelectedModelId) {
        window.localStorage.setItem(
          CHAT_SELECTION_STORAGE_KEY,
          chatSelectedModelId,
        );
      } else {
        window.localStorage.removeItem(CHAT_SELECTION_STORAGE_KEY);
      }
      window.localStorage.setItem(
        AGENT_SELECTIONS_STORAGE_KEY,
        JSON.stringify(agentSelectedModelIds),
      );
    } catch {
      // Selections remain isolated in memory when browser storage is unavailable.
    }
  }, [agentSelectedModelIds, chatSelectedModelId, hydrated]);

  const registry = useMemo<ModelRegistry>(() => {
    const connectedModels = getConnectedModels(models);
    const enabledModels = connectedModels;
    const chatSelectedModel =
      connectedModels.find((model) => model.id === chatSelectedModelId) ?? null;
    const getAgentSelectedModelId = (agentId: string) => {
      if (!SELECTABLE_AGENT_IDS.has(agentId)) return null;
      return resolveSelectedModelId(
        connectedModels,
        agentSelectedModelIds[agentId] ?? null,
      );
    };
    const reconcileSelections = (nextModels: ChatModel[]) => {
      setChatSelectedModelIdState((currentId) =>
        resolveSelectedModelId(getConnectedModels(nextModels), currentId),
      );
      setAgentSelectedModelIds((currentSelections) =>
        reconcileAgentSelections(getConnectedModels(nextModels), currentSelections),
      );
    };

    return {
      models,
      enabledModels,
      connectedModels,
      chatSelectedModelId,
      chatSelectedModel,
      setChatSelectedModelId: (id) => {
        setChatSelectedModelIdState(resolveSelectedModelId(connectedModels, id));
      },
      getAgentSelectedModelId,
      setAgentSelectedModelId: (agentId, id) => {
        if (!SELECTABLE_AGENT_IDS.has(agentId)) return;
        setAgentSelectedModelIds((currentSelections) => {
          const resolvedModelId = resolveSelectedModelId(connectedModels, id);
          if (!resolvedModelId) {
            const remainingSelections = { ...currentSelections };
            delete remainingSelections[agentId];
            return remainingSelections;
          }
          return {
            ...currentSelections,
            [agentId]: resolvedModelId,
          };
        });
      },
      addModel: (draft) => {
        setModels((currentModels) => {
          const nextModels = addRegisteredModel(currentModels, draft);
          reconcileSelections(nextModels);
          return nextModels;
        });
      },
      setModelEnabled: (id, enabled) => {
        setModels((currentModels) => {
          const nextModels = setRegisteredModelEnabled(currentModels, id, enabled);
          reconcileSelections(nextModels);
          return nextModels;
        });
      },
      setDefaultModel: (id) => {
        setModels((currentModels) => {
          const nextModels = setRegisteredDefaultModel(currentModels, id);
          reconcileSelections(nextModels);
          return nextModels;
        });
      },
      removeModel: (id) => {
        setModels((currentModels) => {
          const nextModels = removeRegisteredModel(currentModels, id);
          reconcileSelections(nextModels);
          return nextModels;
        });
      },
      getCredential: (id) => credentials[id] ?? null,
      getMaskedCredential: (id) => maskCredential(credentials[id]),
      getCredentialRevision: (id) => credentialRevisions[id] ?? "",
      saveCredential: (id, draftValue, clearRequested, requestedRevision) => {
        const targetId = text(id);
        const hasReplacement = text(draftValue) !== "";
        const currentRevision = credentialRevisions[targetId] ?? "";
        if (!targetId || (!clearRequested && !hasReplacement)) {
          return currentRevision;
        }
        const revision = requestedRevision === null
          ? ""
          : validCredentialRevision(requestedRevision) || createCredentialRevision();
        setCredentials((currentCredentials) =>
          updateCredential(currentCredentials, targetId, draftValue, clearRequested),
        );
        setCredentialRevisions((current) => {
          if (revision) return { ...current, [targetId]: revision };
          const next = { ...current };
          delete next[targetId];
          return next;
        });
        return revision;
      },
      saveModelConfig: (id, draft) => {
        const targetId = text(id);
        if (!targetId) return;
        setModels((currentModels) => {
          const current = currentModels.find((model) => model.id === targetId);
          if (!current) return currentModels;

          const provider = draft.provider === undefined ? current.provider : text(draft.provider);
          const displayName = draft.displayName === undefined
            ? current.displayName
            : text(draft.displayName);
          const baseUrl = draft.baseUrl === undefined ? current.baseUrl : text(draft.baseUrl);
          const modelId = draft.modelId === undefined ? current.modelId : text(draft.modelId);
          if (!provider || !displayName || !modelId) return currentModels;

          const connectionChanged = baseUrl !== current.baseUrl || modelId !== current.modelId;
          const connectionStatus = connectionChanged && current.connectionStatus === "connected"
            ? "changed"
            : draft.connectionStatus === undefined
              ? current.connectionStatus
              : IMAGE_CONNECTION_STATUSES.has(draft.connectionStatus)
                ? draft.connectionStatus
                : "untested";
          const testedFingerprint = connectionChanged
            ? ""
            : draft.testedFingerprint === undefined
              ? current.testedFingerprint
              : text(draft.testedFingerprint);
          const enabled = draft.enabled === undefined
            ? current.enabled
            : draft.enabled === true && connectionStatus === "connected";
          const isDefault = enabled && (
            draft.isDefault === undefined ? current.isDefault : draft.isDefault === true
          );
          const nextModels = normalizeModels(currentModels.map((model) =>
            model.id === targetId
              ? {
                  ...model,
                  provider,
                  displayName,
                  baseUrl,
                  modelId,
                  enabled,
                  isDefault,
                  connectionStatus,
                  testedFingerprint,
                }
              : model,
          ));
          if (
            nextModels.length !== currentModels.length
            || !nextModels.some((model) => model.id === targetId)
          ) {
            return currentModels;
          }
          reconcileSelections(nextModels);
          return nextModels;
        });
      },
      invalidateModelConnection: (id) => {
        const targetId = text(id);
        if (!targetId) return;
        setModels((currentModels) => {
          const nextModels = normalizeModels(currentModels.map((model) =>
            model.id === targetId
              ? {
                  ...model,
                  connectionStatus: "changed",
                  testedFingerprint: "",
                }
              : model,
          ));
          reconcileSelections(nextModels);
          return nextModels;
        });
      },
      imageConfig,
      imageCredential,
      imageCredentialRevision,
      saveImageConfig: (draft) => {
        setImageConfig((current) => {
          const baseUrl = draft.baseUrl === undefined ? current.baseUrl : text(draft.baseUrl);
          const modelId = draft.modelId === undefined ? current.modelId : text(draft.modelId);
          const connectionChanged = baseUrl !== current.baseUrl || modelId !== current.modelId;
          const connectionStatus = connectionChanged && current.connectionStatus !== "untested"
            ? "changed"
            : draft.connectionStatus === undefined
              ? current.connectionStatus
              : IMAGE_CONNECTION_STATUSES.has(draft.connectionStatus)
                ? draft.connectionStatus
                : "untested";
          return {
            ...current,
            baseUrl,
            modelId,
            enabled: draft.enabled === undefined
              ? current.enabled
              : draft.enabled === true && connectionStatus === "connected",
            connectionStatus,
            testedFingerprint: connectionChanged
              ? ""
              : draft.testedFingerprint === undefined
                ? current.testedFingerprint
                : text(draft.testedFingerprint),
          };
        });
      },
      saveImageCredential: (draftValue, clearRequested, requestedRevision) => {
        const hasReplacement = text(draftValue) !== "";
        if (!clearRequested && !hasReplacement) {
          return imageCredentialRevision;
        }
        const revision = requestedRevision === null
          ? ""
          : validCredentialRevision(requestedRevision) || createCredentialRevision();
        setImageCredential((current) =>
          updateCredential({ image: current ?? "" }, "image", draftValue, clearRequested).image
            ?? null,
        );
        setImageCredentialRevision(revision);
        return revision;
      },
      invalidateImageConnection: () => {
        setImageConfig((current) =>
          ({
            ...current,
            connectionStatus: "changed",
            testedFingerprint: "",
          }),
        );
      },
    };
  }, [
    agentSelectedModelIds,
    chatSelectedModelId,
    credentialRevisions,
    credentials,
    imageConfig,
    imageCredential,
    imageCredentialRevision,
    models,
  ]);

  return <ModelRegistryContext.Provider value={registry}>{children}</ModelRegistryContext.Provider>;
}

export function useModelRegistry() {
  const registry = useContext(ModelRegistryContext);
  if (!registry) {
    throw new Error("useModelRegistry must be used within ModelRegistryProvider");
  }
  return registry;
}
