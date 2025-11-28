import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, teamProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { Plan, WebhookCallStatus, WebhookStatus } from "@prisma/client";
import { WEBHOOK_EVENT_TYPES } from "~/server/service/webhook-events";
import {
  WebhookQueueService,
  WebhookService,
} from "~/server/service/webhook-service";

const EVENT_TYPES_ENUM = z.enum(
  WEBHOOK_EVENT_TYPES as unknown as [string, ...string[]],
);
const PLAN_WEBHOOK_LIMIT_FREE = 1;
const PLAN_WEBHOOK_LIMIT_PAID = 3;

function getWebhookLimit(team: { isActive: boolean; plan: Plan }) {
  const isPaid = team.isActive && team.plan !== "FREE";
  return isPaid ? PLAN_WEBHOOK_LIMIT_PAID : PLAN_WEBHOOK_LIMIT_FREE;
}

export const webhookRouter = createTRPCRouter({
  list: teamProcedure.query(async ({ ctx }) => {
    return db.webhook.findMany({
      where: { teamId: ctx.team.id, status: { not: WebhookStatus.DELETED } },
      orderBy: { createdAt: "desc" },
    });
  }),

  create: teamProcedure
    .input(
      z.object({
        url: z.string().url(),
        description: z.string().optional(),
        eventTypes: z.array(EVENT_TYPES_ENUM).min(1),
        secret: z.string().min(16).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const limit = getWebhookLimit(ctx.team);
      const count = await db.webhook.count({
        where: {
          teamId: ctx.team.id,
          status: { not: WebhookStatus.DELETED },
        },
      });

      if (count >= limit) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Webhook limit reached: ${count}/${limit}. Upgrade plan to add more.`,
        });
      }

      const secret = input.secret ?? WebhookService.generateSecret();

      return db.webhook.create({
        data: {
          teamId: ctx.team.id,
          url: input.url,
          description: input.description,
          secret,
          eventTypes: input.eventTypes,
          status: WebhookStatus.ACTIVE,
          createdByUserId: ctx.session.user.id,
        },
      });
    }),

  update: teamProcedure
    .input(
      z.object({
        id: z.string(),
        url: z.string().url().optional(),
        description: z.string().nullable().optional(),
        eventTypes: z.array(EVENT_TYPES_ENUM).min(1).optional(),
        rotateSecret: z.boolean().optional(),
        secret: z.string().min(16).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const webhook = await db.webhook.findFirst({
        where: { id: input.id, teamId: ctx.team.id },
      });

      if (!webhook || webhook.status === WebhookStatus.DELETED) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Webhook not found",
        });
      }

      const secret =
        input.rotateSecret === true
          ? WebhookService.generateSecret()
          : input.secret;

      return db.webhook.update({
        where: { id: webhook.id },
        data: {
          url: input.url ?? webhook.url,
          description:
            input.description === undefined
              ? webhook.description
              : (input.description ?? null),
          eventTypes: input.eventTypes ?? webhook.eventTypes,
          secret: secret ?? webhook.secret,
        },
      });
    }),

  setStatus: teamProcedure
    .input(
      z.object({
        id: z.string(),
        status: z
          .nativeEnum(WebhookStatus)
          .refine(
            (s) => s !== WebhookStatus.DELETED,
            "Deletion not supported here",
          ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const webhook = await db.webhook.findFirst({
        where: { id: input.id, teamId: ctx.team.id },
      });

      if (!webhook || webhook.status === WebhookStatus.DELETED) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Webhook not found",
        });
      }

      return db.webhook.update({
        where: { id: webhook.id },
        data: {
          status: input.status,
          consecutiveFailures:
            input.status === WebhookStatus.ACTIVE
              ? 0
              : webhook.consecutiveFailures,
        },
      });
    }),

  test: teamProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return WebhookService.testWebhook({
        webhookId: input.id,
        teamId: ctx.team.id,
      });
    }),

  listCalls: teamProcedure
    .input(
      z.object({
        webhookId: z.string().optional(),
        status: z.nativeEnum(WebhookCallStatus).optional(),
        limit: z.number().min(1).max(50).default(20),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const calls = await db.webhookCall.findMany({
        where: {
          teamId: ctx.team.id,
          webhookId: input.webhookId,
          status: input.status,
        },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        cursor: input.cursor ? { id: input.cursor } : undefined,
      });

      let nextCursor: string | null = null;
      if (calls.length > input.limit) {
        const next = calls.pop();
        nextCursor = next?.id ?? null;
      }

      return {
        items: calls,
        nextCursor,
      };
    }),

  getCall: teamProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const call = await db.webhookCall.findFirst({
        where: { id: input.id, teamId: ctx.team.id },
      });

      if (!call) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Webhook call not found",
        });
      }

      return call;
    }),

  retryCall: teamProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return WebhookService.retryCall({
        callId: input.id,
        teamId: ctx.team.id,
      });
    }),
});
