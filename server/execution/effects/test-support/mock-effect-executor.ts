import type { ExternalEffectResult } from "@/lib/execution/effects";
import { ExecutionErrorCode } from "@/lib/execution/errors";
import type { ExecutionItem, NodeExecutionResult, NodeExecutor } from "@/lib/execution/types";
import { EffectIdentityError, validateBusinessKey } from "../effect-key";
import type { MockBehavior, MockExternalEffect } from "./mock-external-effect";

/**
 * A node executor that performs one FAKE external effect per input item —
 * shaped the way a real one (a WhatsApp send, in a later phase) will have
 * to be:
 *
 *   - only through context.effects, never by calling out directly;
 *   - refusing to run when it is absent: the synchronous path has no
 *     recovery, hence no way to settle an ambiguous outcome;
 *   - naming the entity each item affects (businessKey) and validating ALL
 *     of them before the first effect, so one bad item cannot fail the node
 *     after earlier items already reached the provider;
 *   - one item at a time, each awaited — never concurrently within a node;
 *   - reporting each result as itself. unknown is not failed, fenced is not
 *     failed, and none of them is success.
 *
 * TEST SUPPORT ONLY — never registered in lib/execution/executors/index.ts,
 * so no workflow a user builds can reach it.
 *
 * Config: { businessKeyField?: string (default "leadId"), text?: string }.
 */
export const MOCK_EFFECT_NODE_TYPE = "mockExternalEffect";
export const MOCK_EFFECT_OPERATION = "mock.send_message";

export interface MockEffectExecutorOptions {
  provider: MockExternalEffect;
  /** The fake behaviour for each call; defaults to success. */
  behaviorFor?: (businessKey: string, itemIndex: number) => MockBehavior;
}

function errorFor(result: Exclude<ExternalEffectResult, { status: "succeeded" }>) {
  switch (result.status) {
    case "failed":
      return {
        code: ExecutionErrorCode.EXTERNAL_EFFECT_FAILED,
        message: `The provider rejected the request (${result.code})`,
      };
    case "unknown":
      return {
        code: ExecutionErrorCode.EXTERNAL_EFFECT_UNKNOWN,
        message: `The external operation may or may not have happened and needs explicit resolution: ${result.reason}`,
      };
    case "fenced":
      return {
        code: ExecutionErrorCode.EXTERNAL_EFFECT_FENCED,
        message: "This attempt no longer owns the execution; nothing was sent",
      };
    case "payload_mismatch":
      return {
        code: ExecutionErrorCode.EXTERNAL_EFFECT_PAYLOAD_MISMATCH,
        message: "The same operation was requested with different content; nothing was sent",
      };
    case "not_attempted":
      return {
        code: ExecutionErrorCode.EXTERNAL_EFFECT_NOT_ATTEMPTED,
        message: `Nothing was sent: ${result.reason}`,
      };
  }
}

export function createMockEffectExecutor(options: MockEffectExecutorOptions): NodeExecutor {
  const behaviorFor = options.behaviorFor ?? ((): MockBehavior => "success");

  return {
    nodeType: MOCK_EFFECT_NODE_TYPE,
    async execute(context): Promise<NodeExecutionResult> {
      const start = performance.now();
      const fail = (code: string, message: string): NodeExecutionResult => ({
        status: "error",
        durationMs: Math.round(performance.now() - start),
        error: { code, message, nodeId: context.nodeId, nodeType: MOCK_EFFECT_NODE_TYPE, retryable: false },
      });

      const effects = context.effects;
      if (!effects) {
        return fail(
          ExecutionErrorCode.EXTERNAL_EFFECTS_UNAVAILABLE,
          "External effects run only on the queued (async) path, where an ambiguous outcome can be settled"
        );
      }

      const field =
        typeof context.config.businessKeyField === "string" ? context.config.businessKeyField : "leadId";
      const text = typeof context.config.text === "string" ? context.config.text : "";

      // Identity of EVERY item before the first effect.
      const businessKeys: string[] = [];
      for (const item of context.input.items) {
        try {
          businessKeys.push(validateBusinessKey(item.json[field]));
        } catch (err) {
          if (err instanceof EffectIdentityError) {
            return fail(ExecutionErrorCode.BUSINESS_KEY_REQUIRED, err.message);
          }
          throw err;
        }
      }

      const output: ExecutionItem[] = [];
      for (let i = 0; i < context.input.items.length; i++) {
        const item = context.input.items[i]!;
        const businessKey = businessKeys[i]!;

        let result: ExternalEffectResult;
        try {
          result = await effects.run(context.nodeId, {
            operation: MOCK_EFFECT_OPERATION,
            businessKey,
            payload: { text, recipient: businessKey },
            perform: options.provider.perform(behaviorFor(businessKey, i)),
          });
        } catch {
          // The durable record could not be settled (a database error around
          // the call). Whether anything left is not knowable from here; the
          // operation's own record is the source of truth.
          return fail(
            ExecutionErrorCode.EXTERNAL_EFFECT_UNKNOWN,
            "The state of the external operation could not be recorded; check the operation record"
          );
        }

        if (result.status !== "succeeded") {
          const { code, message } = errorFor(result);
          return fail(code, message);
        }

        output.push({
          json: {
            ...item.json,
            effect: {
              status: result.status,
              providerReference: result.providerReference,
              replayed: result.replayed,
            },
          },
        });
      }

      return {
        status: "success",
        output: { items: output },
        durationMs: Math.round(performance.now() - start),
      };
    },
  };
}
