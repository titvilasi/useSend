/* global Proxy */
/* eslint-disable turbo/no-undeclared-env-vars -- Explicit isolated fixture inputs, never a cached Turbo task. */
import { PrismaClient } from "@prisma/client";
import { TooManyRequestsException } from "@aws-sdk/client-sesv2";
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import addressparser from "nodemailer/lib/addressparser";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const { fixtureDomain, forbidden } = vi.hoisted(() => ({
  fixtureDomain: {} as Record<string, unknown>,
  forbidden: [] as string[],
}));
vi.mock("../aws/ses", () => ({
  sendRawEmail: async () => {
    forbidden.push("SDK fallback");
    throw new Error("External SDK forbidden");
  },
}));
vi.mock("~/utils/ses-utils", () => ({
  getConfigurationSetName: async () => {
    forbidden.push("config fallback");
    throw new Error("External configuration forbidden");
  },
}));
vi.mock("./limit-service", () => ({
  LimitService: {
    checkEmailLimit: async () => {
      forbidden.push("billing fallback");
      throw new Error("Billing fallback forbidden");
    },
  },
}));
vi.mock("./domain-service", () => ({
  validateDomainFromEmail: async () => fixtureDomain,
  validateApiKeyDomainAccess: async () => fixtureDomain,
}));
vi.mock("./email-queue-service", () => ({
  EmailQueueService: {
    queueEmail: async () => {
      forbidden.push("Native Bull enqueue");
      throw new Error("Native must not enqueue");
    },
  },
}));
vi.mock("./campaign-service", () => ({
  createContactBookUnsubUrl: () => "http://127.0.0.1/unsubscribe/owned",
}));
vi.mock("@usesend/email-editor/src/renderer", () => ({
  EmailRenderer: class {},
}));
import { connection, getRedis } from "../redis";
import { db as globalDb } from "../db";
import {
  createMarketingOwner,
  existingMarketingOwner,
  MarketingHandoffContext,
  NATIVE_PROTOCOL,
  NativePermit,
  readMarketingControl,
  readNativePermit,
} from "./marketing-handoff";
import {
  executePreparedNative,
  NativeDependencies,
  submitNativeMarketing,
} from "./native-marketing-immediate";
const enabled = process.env.RUN_MARKETING_LOCAL_FENCE_TESTS === "true";
describe.skipIf(!enabled)(
  "owned real PG/Redis Native immediate protocol",
  () => {
    let plan: {
      fixtureId: string;
      database: string;
      ownerMarker: string;
      localUrls: { postgres: string; redis: string };
      redisPrefix: string;
    };
    let first: PrismaClient;
    let second: PrismaClient;
    let teamId: number;
    let domainId: number;
    let bookId: string;
    let contactId: string;
    const physical = new Map<string, number>();
    const outcomes: Record<string, unknown> = {};
    const output = () => process.env.MARKETING_FIXTURE_OUTCOME!;
    beforeAll(async () => {
      plan = JSON.parse(
        readFileSync(process.env.MARKETING_FIXTURE_PLAN!, "utf8"),
      );
      if (
        process.env.DATABASE_URL !== plan.localUrls.postgres ||
        process.env.REDIS_URL !== plan.localUrls.redis
      )
        throw new Error("Wrong fixture URL");
      const url = new URL(plan.localUrls.postgres);
      if (
        url.hostname !== "127.0.0.1" ||
        url.port !== "55542" ||
        url.pathname !== `/${plan.database}` ||
        !plan.database.startsWith("usesend_marketing_test_")
      )
        throw new Error("Refusing unowned DB");
      first = new PrismaClient({
        datasources: { db: { url: plan.localUrls.postgres } },
      });
      second = new PrismaClient({
        datasources: { db: { url: plan.localUrls.postgres } },
      });
      const marker = await first.$queryRaw<
        Array<{ name: string; marker: string }>
      >`SELECT datname AS name,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()`;
      if (
        marker[0]?.marker !== plan.ownerMarker ||
        marker[0].name !== plan.database
      )
        throw new Error("Fixture marker mismatch");
      const team = await first.team.create({
        data: { name: `native-${plan.fixtureId}` },
      });
      teamId = team.id;
      const domain = await first.domain.create({
        data: {
          name: `${plan.fixtureId}.example.invalid`,
          teamId,
          publicKey: "synthetic",
          region: "us-east-1",
          status: "SUCCESS",
        },
      });
      domainId = domain.id;
      Object.assign(fixtureDomain, domain);
      const book = await first.contactBook.create({
        data: { teamId, name: `native-${plan.fixtureId}`, properties: {} },
      });
      bookId = book.id;
      const contact = await first.contact.create({
        data: {
          contactBookId: bookId,
          email: "owned@example.invalid",
          properties: {},
          subscribed: true,
        },
      });
      contactId = contact.id;
      writeFileSync(
        output() + ".seed.json",
        JSON.stringify(
          {
            fixtureId: plan.fixtureId,
            teamId,
            domainId,
            bookId,
            contactId,
            ownerMarker: plan.ownerMarker,
          },
          null,
          2,
        ),
      );
    }, 15000);
    const context = (name: string): MarketingHandoffContext => ({
      protocol: NATIVE_PROTOCOL,
      idempotencyKey: `${plan.fixtureId}/${name}`,
      requestHash: createHash("sha256")
        .update(`client-business/${name}`)
        .digest("hex"),
      budgetKey: `native-budget-${plan.fixtureId}`,
    });
    const permit = (name: string): NativePermit => ({
      id: `${plan.fixtureId}/${name}`,
      budgetKey: `native-budget-${plan.fixtureId}`,
      submitBefore: new Date(Date.now() + 120000).toISOString(),
    });
    async function owner(
      name: string,
      client = first,
      expiresAt: string | null = null,
    ) {
      return createMarketingOwner(
        {
          teamId,
          domainId,
          contactId,
          from: "sender@example.invalid",
          to: ["owned@example.invalid"],
          cc: [],
          bcc: [],
          replyTo: [],
          subject: `Synthetic ${name}`,
          text: "Synthetic",
          latestStatus: "QUEUED",
        },
        "us-east-1",
        expiresAt,
        context(name),
        client,
      );
    }
    function deps(
      client = first,
      result: (id: string) => Promise<string | undefined> = async (id) =>
        `ses-${id}`,
    ): Partial<NativeDependencies> {
      return {
        database: client,
        now: () => new Date(),
        admission: {
          qualified: true,
          acquire: async (input) => ({
            kind: "permit",
            accountId: `fixture-${plan.fixtureId}`,
            region: input.region,
            recipientCount: input.recipientCount,
            envelopeDigest: input.envelopeDigest,
            observationGeneration: 1,
            permitId: `provider-${input.controlId}`,
          }),
        },
        configurationSet: async () => "owned-config",
        checkTeamLimit: async () => ({ isLimitReached: false }),
        senderScope: async () => "actual-fixture-scope",
        send: async (input) => {
          if (!input.emailId || !input.marketing)
            throw new Error("Missing Native boundary");
          const parse = (values?: string[]) =>
            (values ?? []).flatMap((value) =>
              addressparser(value, { flatten: true }).map((v) => v.address),
            );
          const env = {
            to: parse(input.to),
            cc: parse(input.cc),
            bcc: parse(input.bcc),
          };
          await input.marketing.beforeSubmit({
            ...env,
            recipientCount: env.to.length + env.cc.length + env.bcc.length,
            digest: createHash("sha256")
              .update(JSON.stringify(env))
              .digest("hex"),
          });
          if (
            input.marketing.expiresAt !== null &&
            Date.parse(input.marketing.expiresAt) <=
              input.marketing.now().getTime()
          )
            throw new Error("Fixture deadline unexpectedly passed");
          if (
            Date.parse(input.marketing.submitBefore) <=
            input.marketing.now().getTime()
          )
            throw new Error("Fixture technical window unexpectedly passed");
          input.marketing.onSdkInvocation();
          physical.set(input.emailId, (physical.get(input.emailId) ?? 0) + 1);
          return result(input.emailId);
        },
      };
    }
    it("uses one durable logical owner despite a two-client creation race and Redis result loss", async () => {
      const raced = await Promise.all([
        owner("owner-race", first),
        owner("owner-race", second),
      ]);
      expect(raced.filter((v) => v.created)).toHaveLength(1);
      expect(new Set(raced.map((v) => v.email.id)).size).toBe(1);
      expect(
        await first.email.count({
          where: { teamId, subject: "Synthetic owner-race" },
        }),
      ).toBe(1);
      const key = plan.redisPrefix + "old-result";
      await getRedis().set(key, "old");
      await getRedis().del(key);
      expect(
        (await existingMarketingOwner(teamId, context("owner-race"), second))
          ?.data.emailId,
      ).toBe(raced[0]!.email.id);
      await expect(
        existingMarketingOwner(
          teamId,
          { ...context("owner-race"), requestHash: "different" },
          second,
        ),
      ).rejects.toMatchObject({ code: "NOT_UNIQUE" });
      outcomes.ownerRace = raced[0]!.email.id;
    });
    it("allows one physical invocation under a real CAS/permit race and caches both replay forms", async () => {
      const owned = await owner("send-race"),
        unit = permit("unit-race");
      const results = await Promise.all([
        executePreparedNative(
          owned.email,
          owned.record,
          context("send-race"),
          unit,
          deps(first),
        ),
        executePreparedNative(
          owned.email,
          owned.record,
          context("send-race"),
          unit,
          deps(second),
        ),
      ]);
      expect(physical.get(owned.email.id)).toBe(1);
      expect(results.some((v) => v.status === 200)).toBe(true);
      const row = (await readMarketingControl(owned.record.id, second))!,
        email = (await second.email.findUnique({
          where: { id: owned.email.id },
        }))!;
      const same = await executePreparedNative(
        email,
        row,
        context("send-race"),
        unit,
        deps(second),
      );
      expect(same.body).toMatchObject({
        sdkInvoked: false,
        permitConsumed: true,
        replayed: true,
      });
      const fresh = await executePreparedNative(
        email,
        row,
        context("send-race"),
        permit("fresh-unused"),
        deps(second),
      );
      expect(fresh.body).toMatchObject({
        sdkInvoked: false,
        permitConsumed: false,
        replayed: true,
      });
      const other = await owner("different-owner");
      const denied = await executePreparedNative(
        other.email,
        other.record,
        context("different-owner"),
        unit,
        deps(second),
      );
      expect(denied.body.permitConsumed).toBe(true);
      expect(physical.get(other.email.id) ?? 0).toBe(0);
      outcomes.casRace = {
        emailId: owned.email.id,
        results: results.map((v) => v.status),
      };
    });
    it("leaves a pre-SDK fence commit with lost ACK closed to another client", async () => {
      const owned = await owner("fence-ack"),
        unit = permit("fence-ack-unit");
      let lost = false;
      const proxy = new Proxy(first, {
        get(target, property, receiver) {
          if (property === "$transaction")
            return async (
              operation: Parameters<typeof first.$transaction>[0],
            ) => {
              const value = await first.$transaction(operation as never);
              if (!lost) {
                lost = true;
                throw new Error("Owned fence ACK lost");
              }
              return value;
            };
          return Reflect.get(target, property, receiver);
        },
      });
      const initial = await executePreparedNative(
        owned.email,
        owned.record,
        context("fence-ack"),
        unit,
        deps(proxy),
      );
      expect(initial.status).toBe(503);
      expect(initial.body.permitConsumed).not.toBe(false);
      const row = (await readMarketingControl(owned.record.id, second))!;
      expect(row.data.state).toBe("SUBMITTING");
      const retry = await executePreparedNative(
        owned.email,
        row,
        context("fence-ack"),
        permit("fence-new-unit"),
        deps(second),
      );
      expect(retry.status).toBe(503);
      expect(physical.get(owned.email.id) ?? 0).toBe(0);
      outcomes.fenceAck = owned.email.id;
    });
    it("keeps SDK transport UNKNOWN closed to a new client and new permit", async () => {
      const owned = await owner("unknown"),
        unit = permit("unknown-unit");
      const result = await executePreparedNative(
        owned.email,
        owned.record,
        context("unknown"),
        unit,
        deps(first, async () => {
          throw new Error("Owned transport unknown");
        }),
      );
      expect(result.status).toBe(503);
      const row = (await readMarketingControl(owned.record.id, second))!;
      const again = await executePreparedNative(
        owned.email,
        row,
        context("unknown"),
        permit("unknown-new-unit"),
        deps(second),
      );
      expect(again.status).toBe(503);
      expect(physical.get(owned.email.id)).toBe(1);
      expect(row.data.state).toBe("UNKNOWN_HOLD");
      outcomes.unknown = owned.email.id;
    });
    it("rereads acceptance after a completion-commit acknowledgement is lost", async () => {
      const owned = await owner("commit-ack"),
        unit = permit("commit-unit");
      let lost = false;
      const proxy = new Proxy(first, {
        get(target, property, receiver) {
          if (property === "$transaction")
            return async (
              operation: Parameters<typeof first.$transaction>[0],
            ) => {
              const value = await first.$transaction(operation as never);
              if (!lost && (physical.get(owned.email.id) ?? 0) > 0) {
                lost = true;
                throw new Error("Owned completion ACK lost");
              }
              return value;
            };
          return Reflect.get(target, property, receiver);
        },
      });
      const result = await executePreparedNative(
        owned.email,
        owned.record,
        context("commit-ack"),
        unit,
        deps(proxy),
      );
      expect(result.status).toBe(200);
      expect(physical.get(owned.email.id)).toBe(1);
      expect(
        (await readMarketingControl(owned.record.id, second))?.data.state,
      ).toBe("ACCEPTED");
      outcomes.commitAck = owned.email.id;
    });
    it("checks canonical unsubscribes without creating display/case aliases", async () => {
      await first.contact.update({
        where: { id: contactId },
        data: { subscribed: false },
      });
      for (const [i, to] of [
        "Owner <owned@example.invalid>",
        "OWNED@EXAMPLE.INVALID",
      ].entries()) {
        const name = `consent-${i}`,
          body = {
            purpose: "marketing" as const,
            expiresAt: null,
            to,
            from: "sender@example.invalid",
            contactBookId: bookId,
            subject: `Synthetic ${name}`,
            text: "Synthetic",
          };
        const result = await submitNativeMarketing(
          body,
          { ...context(name), teamId },
          permit(name),
          deps(first),
        );
        expect(result.status).toBe(422);
        expect(result.body).toMatchObject({
          outcome: "suppressed",
          sdkInvoked: false,
          permitConsumed: false,
        });
      }
      expect(
        await first.contact.count({ where: { contactBookId: bookId } }),
      ).toBe(1);
      await first.contact.update({
        where: { id: contactId },
        data: { subscribed: true },
      });
      outcomes.canonicalConsent = true;
    });
    it("keeps technical window expiry distinct from actual business expiry", async () => {
      const owned = await owner("technical"),
        unit = permit("technical-unit");
      let clock = new Date();
      unit.submitBefore = new Date(clock.getTime() + 100).toISOString();
      const options = deps(first);
      options.now = () => clock;
      options.admission = {
        qualified: true,
        acquire: async (input) => {
          clock = new Date(clock.getTime() + 200);
          return {
            kind: "permit",
            accountId: `fixture-${plan.fixtureId}`,
            region: input.region,
            recipientCount: 1,
            envelopeDigest: input.envelopeDigest,
            observationGeneration: 1,
            permitId: "provider-technical",
          };
        },
      };
      const held = await executePreparedNative(
        owned.email,
        owned.record,
        context("technical"),
        unit,
        options,
      );
      expect(held.status).toBe(429);
      expect(held.body).toMatchObject({
        sdkInvoked: false,
        permitConsumed: false,
        reason: "NATIVE_SUBMIT_WINDOW_ELAPSED",
      });
      expect(physical.get(owned.email.id) ?? 0).toBe(0);
      const expired = await owner(
        "business-expired",
        first,
        "2020-01-01T00:00:00Z",
      );
      const terminal = await executePreparedNative(
        expired.email,
        expired.record,
        context("business-expired"),
        permit("expired-unit"),
        deps(second),
      );
      expect(terminal.body).toMatchObject({
        outcome: "expired",
        reason: "DELIVERY_DEADLINE_ELAPSED",
        sdkInvoked: false,
      });
      outcomes.expiry = {
        technical: owned.email.id,
        business: expired.email.id,
      };
    });
    it("rechecks automatic sender scope at the final boundary", async () => {
      const owned = await owner("scope"),
        unit = { ...permit("scope-unit"), senderScope: "old-approved" };
      const result = await executePreparedNative(
        owned.email,
        owned.record,
        context("scope"),
        unit,
        deps(second),
      );
      expect(result.body).toMatchObject({
        outcome: "held",
        reason: "SENDER_SCOPE_CHANGED",
        sdkInvoked: false,
        permitConsumed: false,
      });
      expect(physical.get(owned.email.id) ?? 0).toBe(0);
      expect((await readNativePermit(teamId, unit, second))?.data.effect).toBe(
        "unused",
      );
      outcomes.scope = owned.email.id;
    });
    it("charges an SDK quota rejection once and shares the real Redis account pause", async () => {
      const owned = await owner("quota"),
        unit = permit("quota-unit");
      const result = await executePreparedNative(
        owned.email,
        owned.record,
        context("quota"),
        unit,
        deps(first, async () => {
          throw new TooManyRequestsException({
            $metadata: { httpStatusCode: 429 },
            message: "Owned typed quota rejection",
          });
        }),
      );
      expect(result.body).toMatchObject({
        outcome: "held",
        sdkInvoked: true,
        permitConsumed: true,
      });
      expect(physical.get(owned.email.id)).toBe(1);
      const other = await owner("paused-other");
      const held = await executePreparedNative(
        other.email,
        other.record,
        context("paused-other"),
        permit("paused-other-unit"),
        deps(second),
      );
      expect(held.body).toMatchObject({
        outcome: "held",
        sdkInvoked: false,
        permitConsumed: false,
      });
      const keys = await getRedis().keys(
        `usesend:mkt:v1:pause:*${plan.fixtureId}*`,
      );
      expect(keys).toHaveLength(1);
      expect(await getRedis().pttl(keys[0]!)).toBeGreaterThan(0);
      outcomes.quota = { emailId: owned.email.id, sharedPauseKeys: keys };
    });
    afterAll(async () => {
      try {
        if (first && teamId)
          writeFileSync(
            output(),
            JSON.stringify(
              {
                fixtureId: plan.fixtureId,
                outcomes,
                fakeRequests: Object.fromEntries(physical),
                forbiddenProviderCalls: forbidden,
                retainedControlsAndHistory: await first.emailEvent.findMany({
                  where: { teamId },
                  orderBy: { createdAt: "asc" },
                }),
                rowsKeptForExport: true,
              },
              null,
              2,
            ),
          );
        expect(forbidden).toEqual([]);
      } finally {
        if (first) await first.$disconnect();
        if (second) await second.$disconnect();
        await globalDb.$disconnect();
        if (connection && connection.status !== "end") await connection.quit();
      }
    });
  },
);
