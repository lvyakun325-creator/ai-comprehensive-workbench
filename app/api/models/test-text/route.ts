import {
  modelErrorResponse,
  noStoreJson,
  readBoundedModelRequest,
  testTextConnection,
  type GlobalModelRuntimeOptions,
  type GlobalTextConfig,
} from "../../../lib/global-model-runtime";

export function createTestTextRoute(
  options: GlobalModelRuntimeOptions = {},
) {
  return async function handleTestText(request: Request): Promise<Response> {
    try {
      const input = await readBoundedModelRequest(request);
      await testTextConnection(input.config as GlobalTextConfig, {
        ...options,
        signal: request.signal,
      });
      return noStoreJson({ ok: true });
    } catch (error) {
      return modelErrorResponse(error);
    }
  };
}

export const POST = createTestTextRoute();
