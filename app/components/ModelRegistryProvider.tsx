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
  getEnabledModels,
  parseStoredModels,
  removeModel as removeRegisteredModel,
  resolveSelectedModelId,
  setDefaultModel as setRegisteredDefaultModel,
  setModelEnabled as setRegisteredModelEnabled,
  type ChatModel,
  type ModelDraft,
} from "../lib/model-registry.mjs";
import { AGENT_IDS } from "../lib/agent-catalog.mjs";

const STORAGE_KEY = "ai-workbench:model-registry:v1";
const CHAT_SELECTION_STORAGE_KEY = "ai-workbench:chat-model-selection:v1";
const AGENT_SELECTIONS_STORAGE_KEY = "ai-workbench:agent-model-selections:v1";
const SELECTABLE_AGENT_IDS = new Set(
  AGENT_IDS.filter((agentId) => agentId !== "content-matrix"),
);

type AgentModelSelections = Record<string, string>;

type ModelRegistry = {
  models: ChatModel[];
  enabledModels: ChatModel[];
  chatSelectedModelId: string | null;
  chatSelectedModel: ChatModel | null;
  setChatSelectedModelId: (id: string | null) => void;
  getAgentSelectedModelId: (agentId: string) => string | null;
  setAgentSelectedModelId: (agentId: string, id: string | null) => void;
  addModel: (draft: Partial<ModelDraft>) => void;
  setModelEnabled: (id: string, enabled: boolean) => void;
  setDefaultModel: (id: string) => void;
  removeModel: (id: string) => void;
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

export function ModelRegistryProvider({ children }: { children: ReactNode }) {
  const [models, setModels] = useState<ChatModel[]>(() => [...DEFAULT_MODELS]);
  const [chatSelectedModelId, setChatSelectedModelIdState] = useState<
    string | null
  >(() =>
    resolveSelectedModelId(DEFAULT_MODELS, null),
  );
  const [agentSelectedModelIds, setAgentSelectedModelIds] =
    useState<AgentModelSelections>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let storedModels = DEFAULT_MODELS;
    let storedChatSelection: string | null = null;
    let storedAgentSelections: AgentModelSelections = {};
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw !== null) storedModels = parseStoredModels(raw);
      storedChatSelection = window.localStorage.getItem(
        CHAT_SELECTION_STORAGE_KEY,
      );
      storedAgentSelections = parseStoredAgentSelections(
        window.localStorage.getItem(AGENT_SELECTIONS_STORAGE_KEY),
        storedModels,
      );
    } catch {
      // Keep the server-safe defaults if browser storage is unavailable.
    }

    queueMicrotask(() => {
      setModels([...storedModels]);
      setChatSelectedModelIdState(
        resolveSelectedModelId(storedModels, storedChatSelection),
      );
      setAgentSelectedModelIds(storedAgentSelections);
      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    if (!hydrated) return;

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(models));
    } catch {
      // The interactive registry remains usable when browser storage is unavailable.
    }
  }, [hydrated, models]);

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
    const enabledModels = getEnabledModels(models);
    const chatSelectedModel =
      enabledModels.find((model) => model.id === chatSelectedModelId) ?? null;
    const getAgentSelectedModelId = (agentId: string) => {
      if (!SELECTABLE_AGENT_IDS.has(agentId)) return null;
      return resolveSelectedModelId(
        models,
        agentSelectedModelIds[agentId] ?? null,
      );
    };
    const reconcileSelections = (nextModels: ChatModel[]) => {
      setChatSelectedModelIdState((currentId) =>
        resolveSelectedModelId(nextModels, currentId),
      );
      setAgentSelectedModelIds((currentSelections) =>
        reconcileAgentSelections(nextModels, currentSelections),
      );
    };

    return {
      models,
      enabledModels,
      chatSelectedModelId,
      chatSelectedModel,
      setChatSelectedModelId: (id) => {
        setChatSelectedModelIdState(resolveSelectedModelId(models, id));
      },
      getAgentSelectedModelId,
      setAgentSelectedModelId: (agentId, id) => {
        if (!SELECTABLE_AGENT_IDS.has(agentId)) return;
        setAgentSelectedModelIds((currentSelections) => {
          const resolvedModelId = resolveSelectedModelId(models, id);
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
    };
  }, [agentSelectedModelIds, chatSelectedModelId, models]);

  return <ModelRegistryContext.Provider value={registry}>{children}</ModelRegistryContext.Provider>;
}

export function useModelRegistry() {
  const registry = useContext(ModelRegistryContext);
  if (!registry) {
    throw new Error("useModelRegistry must be used within ModelRegistryProvider");
  }
  return registry;
}
