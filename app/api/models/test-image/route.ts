import {
  modelErrorResponse,
  noStoreJson,
  readBoundedModelRequest,
  testImageConnection,
  type GlobalImageConfig,
  type GlobalModelRuntimeOptions,
} from "../../../lib/global-model-runtime";

export function createTestImageRoute(
  options: GlobalModelRuntimeOptions = {},
) {
  return async function handleTestImage(request: Request): Promise<Response> {
    try {
      const input = await readBoundedModelRequest(request);
      await testImageConnection(input.config as GlobalImageConfig, {
        ...options,
        signal: request.signal,
      });
      return noStoreJson({ ok: true });
    } catch (error) {
      return modelErrorResponse(error);
    }
  };
}

export const POST = createTestImageRoute();
