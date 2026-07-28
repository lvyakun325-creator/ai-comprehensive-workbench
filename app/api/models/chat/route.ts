import {
  generateChatReply,
  modelErrorResponse,
  noStoreJson,
  readBoundedModelRequest,
  type ChatTurn,
  type GlobalModelRuntimeOptions,
  type GlobalTextConfig,
} from "../../../lib/global-model-runtime";

export function createChatRoute(options: GlobalModelRuntimeOptions = {}) {
  return async function handleChat(request: Request): Promise<Response> {
    try {
      const input = await readBoundedModelRequest(request);
      const reply = await generateChatReply(
        input.config as GlobalTextConfig,
        input.turns as ChatTurn[],
        {
          ...options,
          signal: request.signal,
        },
      );
      return noStoreJson({ ok: true, reply });
    } catch (error) {
      return modelErrorResponse(error);
    }
  };
}

export const POST = createChatRoute();
