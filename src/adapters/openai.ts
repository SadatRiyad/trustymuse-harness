import { BudgetTracker } from "../budget";
import { HarnessConfig } from "../config";
import { AdapterRequest, AdapterResult, ModelAdapter, apiGuard, stubBlockedResult } from "./api";

// OpenAI adapter, V1 stub. No free API quota is claimed for OpenAI.
// A live call would need OPENAI_API_KEY and a budget cap above 0, and is not
// made in V1. The guard blocks it first, and the stub blocks it second.

export class OpenAiAdapter implements ModelAdapter {
  id = "openai-api";
  provider = "OpenAI";

  async call(request: AdapterRequest, config: HarnessConfig, budget: BudgetTracker): Promise<AdapterResult> {
    const guard = apiGuard(this.provider, request.model, config, budget, "OPENAI_API_KEY");
    if (guard) {
      return guard;
    }
    return stubBlockedResult(this.provider, request.model);
  }
}
