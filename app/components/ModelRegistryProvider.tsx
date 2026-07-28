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

const STORAGE_KEY = "ai-workbench:model-registry:v1";

type ModelRegistry = {
  models: ChatModel[];
  enabledModels: ChatModel[];
  selectedModelId: string | null;
  selectedModel: ChatModel | null;
  setSelectedModelId: (id: string | null) => void;
  addModel: (draft: Partial<ModelDraft>) => void;
  setModelEnabled: (id: string, enabled: boolean) => void;
  setDefaultModel: (id: string) => void;
  removeModel: (id: string) => void;
};

const ModelRegistryContext = createContext<ModelRegistry | null>(null);

export function ModelRegistryProvider({ children }: { children: ReactNode }) {
  const [models, setModels] = useState<ChatModel[]>(() => [...DEFAULT_MODELS]);
  const [selectedModelId, setSelectedModelIdState] = useState<string | null>(() =>
    resolveSelectedModelId(DEFAULT_MODELS, null),
  );
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let storedModels = DEFAULT_MODELS;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw !== null) storedModels = parseStoredModels(raw);
    } catch {
      // Keep the server-safe defaults if browser storage is unavailable.
    }

    queueMicrotask(() => {
      setModels(storedModels);
      setSelectedModelIdState(resolveSelectedModelId(storedModels, null));
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

  const registry = useMemo<ModelRegistry>(() => {
    const enabledModels = getEnabledModels(models);
    const selectedModel = enabledModels.find((model) => model.id === selectedModelId) ?? null;

    return {
      models,
      enabledModels,
      selectedModelId,
      selectedModel,
      setSelectedModelId: (id) => {
        setSelectedModelIdState(resolveSelectedModelId(models, id));
      },
      addModel: (draft) => {
        setModels((currentModels) => {
          const nextModels = addRegisteredModel(currentModels, draft);
          setSelectedModelIdState((currentId) =>
            resolveSelectedModelId(nextModels, currentId),
          );
          return nextModels;
        });
      },
      setModelEnabled: (id, enabled) => {
        setModels((currentModels) => {
          const nextModels = setRegisteredModelEnabled(currentModels, id, enabled);
          setSelectedModelIdState((currentId) =>
            resolveSelectedModelId(nextModels, currentId),
          );
          return nextModels;
        });
      },
      setDefaultModel: (id) => {
        setModels((currentModels) => {
          const nextModels = setRegisteredDefaultModel(currentModels, id);
          setSelectedModelIdState((currentId) =>
            resolveSelectedModelId(nextModels, currentId),
          );
          return nextModels;
        });
      },
      removeModel: (id) => {
        setModels((currentModels) => {
          const nextModels = removeRegisteredModel(currentModels, id);
          setSelectedModelIdState((currentId) =>
            resolveSelectedModelId(nextModels, currentId),
          );
          return nextModels;
        });
      },
    };
  }, [models, selectedModelId]);

  return <ModelRegistryContext.Provider value={registry}>{children}</ModelRegistryContext.Provider>;
}

export function useModelRegistry() {
  const registry = useContext(ModelRegistryContext);
  if (!registry) {
    throw new Error("useModelRegistry must be used within ModelRegistryProvider");
  }
  return registry;
}
