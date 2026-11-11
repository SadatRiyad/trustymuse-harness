import { BudgetTracker } from "../budget";
import { HarnessConfig } from "../config";
import { AdapterRequest, AdapterResult, ModelAdapter, apiGuard, stubBlockedResult } from "./api";

// Gemini adapter, V1 stub. A free tier may exist, but it must be verified at
// runtime against the current provider page and the live account. It is not
// hardcoded as guaranteed in V1. A live call would need GEMINI_API_KEY and a
// budget check, and is not made in V1.

export class GeminiAdapter implements ModelAdapter {
  id = "gemini-api";
  provider = "Google";

  async call(request: AdapterRequest, config: HarnessConfig, budget: BudgetTracker): Promise<AdapterResult> {
    const guard = apiGuard(this.provider, request.model, config, budget, "GEMINI_API_KEY");
    if (guard) {
      return guard;
    }
    return stubBlockedResult(this.provider, request.model);
  }
}
