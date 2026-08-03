import { useSyncExternalStore } from "react";

export type CompetitorModelSessionConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type CompetitorModelSessionSnapshot = {
  config: CompetitorModelSessionConfig | null;
  revision: string;
};

const EMPTY_SNAPSHOT: CompetitorModelSessionSnapshot = {
  config: null,
  revision: "",
};

let snapshot = EMPTY_SNAPSHOT;
let revisionCounter = 0;
const listeners = new Set<() => void>();

export function getCompetitorModelSession(): CompetitorModelSessionSnapshot {
  return snapshot;
}

export function configureCompetitorModelSession(
  config: CompetitorModelSessionConfig,
  requestedRevision?: string,
): CompetitorModelSessionSnapshot {
  revisionCounter += 1;
  snapshot = {
    config: {
      baseUrl: config.baseUrl.trim(),
      apiKey: config.apiKey.trim(),
      model: config.model.trim(),
    },
    revision: requestedRevision?.trim() || `competitor-session-${revisionCounter}`,
  };
  emitChange();
  return snapshot;
}

export function clearCompetitorModelSession(): void {
  if (snapshot === EMPTY_SNAPSHOT) return;
  snapshot = EMPTY_SNAPSHOT;
  emitChange();
}

export function useCompetitorModelSession(): CompetitorModelSessionSnapshot {
  return useSyncExternalStore(
    subscribe,
    getCompetitorModelSession,
    getCompetitorModelSession,
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitChange(): void {
  for (const listener of listeners) listener();
}
