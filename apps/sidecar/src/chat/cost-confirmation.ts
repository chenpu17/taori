import type { Model } from '@taori/shared';
import type {
  CostsRepo,
  MemoriesRepo,
} from '../db/repos/index.js';
import type { ChatMessageForUpstream } from './run-actions.js';
import { throwIfBudgetBlockedOrNeedsConfirmation } from '../cost/budget-guard.js';

export interface RecoveryCostConfirmationInput {
  confirmed: boolean;
  conversationId: string;
  model: Model;
  messages: ChatMessageForUpstream[];
  costsRepo: CostsRepo;
  memoriesRepo: MemoriesRepo;
}

export function requireRecoveryCostConfirmationIfNeeded(
  input: RecoveryCostConfirmationInput,
): void {
  throwIfBudgetBlockedOrNeedsConfirmation({
    confirmed: input.confirmed,
    conversationId: input.conversationId,
    model: input.model,
    inputText: input.messages.map((message) => message.content).join('\n'),
    costsRepo: input.costsRepo,
    memoriesRepo: input.memoriesRepo,
  });
}
