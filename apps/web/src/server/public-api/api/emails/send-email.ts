import { createRoute, z } from "@hono/zod-openapi";
import { PublicAPIApp } from "~/server/public-api/hono";
import { sendEmail } from "~/server/service/email-service";
import { emailSchema } from "../../schemas/email-schema";
import { IdempotencyService } from "~/server/service/idempotency-service";
import { canonicalizePayload } from "~/server/utils/idempotency";
import { NATIVE_PROTOCOL } from "~/server/service/marketing-handoff";
import { nativeMarketingCapabilities, NativeDependencies, submitNativeMarketing } from "~/server/service/native-marketing-immediate";

const route = createRoute({
  method: "post",
  path: "/v1/emails",
  request: {
    headers: z
      .object({
        "Idempotency-Key": z
          .string()
          .min(1)
          .max(256)
          .optional()
          .openapi({
            description: `Pass the optional Idempotency-Key header to make the request safe to retry. The key can be up to 256 characters. The server stores the canonical request body and behaves as follows:

- Same key + same request body → returns the original emailId with 200 OK without re-sending.
- Same key + different request body → returns 409 Conflict with code: NOT_UNIQUE so you can detect the mismatch.
- Same key while another request is still being processed → returns 409 Conflict; retry after a short delay or once the first request completes.

Entries expire after 24 hours. Use a unique key per logical send (for example, an order or signup ID).`,
          }),
      })
      .partial(),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: emailSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ emailId: z.string().optional() }),
        },
      },
      description: "Retrieve the user",
    },
  },
});

function send(app: PublicAPIApp) {
  app.openapi(route, async (c) => {
    const team = c.var.team;
    const requestBody = c.req.valid("json");

    let html: string | undefined;
    const rawHtml = requestBody?.html?.toString();
    if (rawHtml && rawHtml !== "true" && rawHtml !== "false") {
      html = rawHtml;
    }

    const clientPayload = {
      ...requestBody,
      text: requestBody.text ?? undefined,
      html,
    };

    const idemKey = c.req.header("Idempotency-Key") ?? undefined;

    const result = await IdempotencyService.withIdempotency<
      typeof clientPayload,
      { emailId?: string }
    >({
      teamId: team.id,
      idemKey,
      payload: clientPayload,
      operation: async () => {
        const email = await sendEmail({
          ...clientPayload,
          teamId: team.id,
          apiKeyId: team.apiKeyId,
        });
        return { emailId: email?.id };
      },
      extractEmailIds: (result) => (result.emailId ? [result.emailId] : []),
      formatCachedResponse: (emailIds) => ({ emailId: emailIds[0] }),
      logContext: "email send",
    });

    return c.json(result);
  });
}

export default send;

export function registerNativeMarketing(app: PublicAPIApp, overrides: Partial<NativeDependencies> = {}) {
  const body = emailSchema.and(z.object({ purpose: z.literal("marketing"), expiresAt: z.string().datetime({ offset: true }).nullable(), contactBookId: z.string().min(1) }));
  const response = z.object({ protocol: z.literal(NATIVE_PROTOCOL), outcome: z.string(), sdkInvoked: z.boolean(), permitConsumed: z.boolean().optional(), replayed: z.boolean(), intentId: z.string(), budgetKey: z.string(), permitId: z.string() }).passthrough();
  app.openapi(createRoute({ method: "post", path: "/v1/native-marketing/immediate", request: { headers: z.object({ "idempotency-key": z.string().min(1).max(256), "x-native-permit-id": z.string().min(1).max(256), "x-native-submit-before": z.string().datetime({ offset: true }), "x-native-budget-key": z.string().min(1).max(256), "x-native-sender-scope": z.string().min(1).max(256).optional() }), body: { required: true, content: { "application/json": { schema: body } } } }, responses: { 200: { description: "Known SES acceptance only", content: { "application/json": { schema: response } } }, 429: { description: "Native retains the waiting message", content: { "application/json": { schema: response } } }, 503: { description: "Closed uncertain submission", content: { "application/json": { schema: response } } }, 422: { description: "Known terminal no-delivery result", content: { "application/json": { schema: response } } }, 409: { description: "Logical-owner or permit conflict", content: { "application/json": { schema: response } } } } }), async (c) => {
    const requested = c.req.valid("json"); const raw = requested.html?.toString(); const payload = { ...requested, text: requested.text ?? undefined, html: raw && raw !== "true" && raw !== "false" ? raw : undefined };
    const team = c.var.team;
    const result = await submitNativeMarketing(payload, { protocol: NATIVE_PROTOCOL, teamId: team.id, apiKeyId: team.apiKeyId, idempotencyKey: c.req.header("Idempotency-Key")!, requestHash: canonicalizePayload(payload).bodyHash, budgetKey: c.req.header("X-Native-Budget-Key")! }, { id: c.req.header("X-Native-Permit-Id")!, submitBefore: c.req.header("X-Native-Submit-Before")!, senderScope: c.req.header("X-Native-Sender-Scope"), budgetKey: c.req.header("X-Native-Budget-Key")! }, overrides);
    if (result.status === 429) c.header("Retry-After", String(Math.max(1, Math.ceil((result.body.retryAfterMs ?? 30000) / 1000))));
    return c.json(result.body, result.status);
  });
  app.openapi(createRoute({ method: "get", path: "/v1/native-marketing/capabilities", responses: { 200: { description: "Actual qualified admission metadata or explicit unqualified state", content: { "application/json": { schema: z.object({ protocol: z.literal(NATIVE_PROTOCOL), qualified: z.boolean() }).passthrough() } } } } }), async (c) => c.json(await nativeMarketingCapabilities(overrides), 200));
}
