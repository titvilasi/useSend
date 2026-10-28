import { Prisma } from "@prisma/client";
import {
  MessageRejected,
  TooManyRequestsException,
} from "@aws-sdk/client-sesv2";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { records, emails, events, queued, queueEmail, database, auth } =
  vi.hoisted(() => ({
    records: new Map<string, string>(),
    emails: new Map<string, Record<string, unknown>>(),
    events: new Map<string, Record<string, unknown>>(),
    queued: [] as unknown[][],
    queueEmail: vi.fn(),
    auth: { apiKeyId: 11 },
    database: {
      apiKey: { findUnique: vi.fn() },
      domain: { findUnique: vi.fn() },
      suppressionList: { findUnique: vi.fn() },
      contactBook: { findFirst: vi.fn() },
      contact: { findUnique: vi.fn(), create: vi.fn() },
      email: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      emailEvent: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
      $transaction: vi.fn(),
    },
  }));
vi.mock("~/server/db", () => ({ db: database }));
vi.mock("~/server/public-api/auth", () => ({
  getTeamFromToken: async () => ({
    id: 1,
    apiKeyId: auth.apiKeyId,
    apiKey: { domainId: null },
  }),
}));
vi.mock("~/utils/common", () => ({ isSelfHosted: () => true }));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("~/server/service/email-queue-service", () => ({
  EmailQueueService: { queueEmail },
}));
vi.mock("~/server/service/domain-service", () => ({
  validateDomainFromEmail: async () => ({ id: 1, region: "us-east-1" }),
  validateApiKeyDomainAccess: async () => ({ id: 1, region: "us-east-1" }),
}));
vi.mock("@usesend/email-editor/src/renderer", () => ({
  EmailRenderer: class {},
}));
vi.mock("~/server/service/suppression-service", () => ({
  SuppressionService: { checkMultipleEmails: async () => ({}) },
}));
vi.mock("~/server/service/campaign-service", () => ({
  createContactBookUnsubUrl: () => "http://localhost/unsubscribe/owned",
}));
vi.mock("~/server/redis", () => ({
  getRedis: () => ({
    get: async (key: string) => records.get(key) ?? null,
    set: async (key: string, value: string) => {
      if (records.has(key)) return null;
      records.set(key, value);
      return "OK";
    },
    setex: async (key: string, _seconds: number, value: string) => {
      records.set(key, value);
    },
    del: async (key: string) => records.delete(key),
  }),
}));

import { getApp } from "~/server/public-api/hono";
import * as routes from "./send-email";

let physical = 0;
let requestPermit = "permit-one";
let sdkFailure: Error | null = null;
let expectedSenderScope: string | undefined;
let providerGeneration = 1;
let clockOffset = 0;
let missingSdkId = false;
const nativeDeps = {
  now: () => new Date(Date.now() + clockOffset),
  admission: {
    qualified: true,
    acquire: async (input: {
      region: string;
      recipientCount: number;
      envelopeDigest: string;
    }) => ({
      kind: "permit" as const,
      accountId: "owned-account",
      region: input.region,
      recipientCount: input.recipientCount,
      envelopeDigest: input.envelopeDigest,
      observationGeneration: providerGeneration,
      permitId: "provider-permit",
    }),
  },
  getAccountPause: async () => 0,
  pauseAccount: async () => undefined,
  senderScope: async () => "actual-sender-scope",
  configurationSet: async () => "owned-fake-config",
  checkTeamLimit: async () => ({ isLimitReached: false }),
  send: async (input: {
    emailId: string;
    marketing: {
      beforeSubmit: (envelope: unknown) => Promise<void>;
      onSdkInvocation: () => void;
    };
  }) => {
    await input.marketing.beforeSubmit({
      to: ["owned@example.invalid"],
      cc: [],
      bcc: [],
      recipientCount: 1,
      digest: "owned-envelope",
    });
    input.marketing.onSdkInvocation();
    physical += 1;
    if (sdkFailure) throw sdkFailure;
    return missingSdkId ? undefined : "ses-" + input.emailId;
  },
};
const payload = {
  purpose: "marketing",
  expiresAt: null,
  to: "owned@example.invalid",
  from: "sender@example.invalid",
  contactBookId: "book_owned",
  subject: "Owned",
  text: "Synthetic",
};
async function post(
  body: unknown = payload,
  key: string | undefined = "owned-send-key",
  overrides: unknown = nativeDeps,
) {
  const app = getApp();
  const register = (
    routes as unknown as {
      registerNativeMarketing?: (
        app: ReturnType<typeof getApp>,
        overrides?: unknown,
      ) => void;
    }
  ).registerNativeMarketing;
  if (overrides === null) register?.(app);
  else register?.(app, overrides);
  return app.request("http://localhost/api/v1/native-marketing/immediate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
      "X-Native-Permit-Id": requestPermit,
      "X-Native-Submit-Before": "2030-01-01T00:00:00Z",
      "X-Native-Budget-Key": "usesend:owned-budget",
      ...(expectedSenderScope
        ? { "X-Native-Sender-Scope": expectedSenderScope }
        : {}),
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  records.clear();
  physical = 0;
  requestPermit = "permit-one";
  sdkFailure = null;
  expectedSenderScope = undefined;
  providerGeneration = 1;
  clockOffset = 0;
  missingSdkId = false;
  emails.clear();
  events.clear();
  queued.length = 0;
  auth.apiKeyId = 11;
  database.apiKey.findUnique.mockResolvedValue({
    id: 11,
    domainId: null,
    domain: null,
  });
  database.contactBook.findFirst.mockResolvedValue({
    id: "book_owned",
    teamId: 1,
  });
  database.domain.findUnique.mockResolvedValue({
    id: 1,
    teamId: 1,
    region: "us-east-1",
    clickTracking: false,
    openTracking: false,
  });
  database.suppressionList.findUnique.mockResolvedValue(null);
  database.email.updateMany.mockImplementation(async ({ where, data }) => {
    const row = emails.get(where.id);
    if (!row) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  database.contact.findUnique.mockResolvedValue({
    id: "contact_owned",
    email: payload.to,
    subscribed: true,
    contactBookId: "book_owned",
    contactBook: { teamId: 1 },
  });
  database.contact.create.mockImplementation(async ({ data }) => ({
    ...data,
    id: "contact_alias",
    subscribed: true,
  }));
  database.email.create.mockImplementation(async ({ data }) => {
    const email = {
      id: `email_owned_${emails.size + 1}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    };
    emails.set(email.id, email);
    return email;
  });
  database.email.findUnique.mockImplementation(
    async ({ where }) => emails.get(where.id) ?? null,
  );
  database.email.update.mockImplementation(async ({ where, data }) => {
    const email = emails.get(where.id)!;
    Object.assign(email, data);
    return email;
  });
  database.emailEvent.findUnique.mockImplementation(
    async ({ where }) => events.get(where.id) ?? null,
  );
  database.emailEvent.create.mockImplementation(async ({ data }) => {
    const id = data.id ?? `event_${events.size + 1}`;
    if (events.has(id))
      throw new Prisma.PrismaClientKnownRequestError("Owned control conflict", {
        code: "P2002",
        clientVersion: "6.6.0",
        meta: { modelName: "EmailEvent", target: ["id"] },
      });
    const event = { ...data, id };
    events.set(id, event);
    return event;
  });
  database.emailEvent.updateMany.mockImplementation(async ({ where, data }) => {
    const row = events.get(where.id);
    if (!row) return { count: 0 };
    const expected = where.AND ?? [];
    if (
      expected.some(
        ({ data: condition }: { data: { path: string[]; equals: unknown } }) =>
          (row.data as Record<string, unknown>)[condition.path[0]!] !==
          condition.equals,
      )
    )
      return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  database.$transaction.mockImplementation(async (operation) =>
    operation(database),
  );
  queueEmail.mockImplementation(async (...args: unknown[]) => {
    queued.push(args);
  });
});

describe("Native immediate versioned acceptance contract", () => {
  it("closes a successful SDK response missing its message ID", async () => {
    missingSdkId = true;
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      outcome: "unknown",
      sdkInvoked: true,
      permitConsumed: true,
    });
    requestPermit = "permit-two";
    expect((await post()).status).toBe(503);
    expect(physical).toBe(1);
  });
  it("keeps persistence failure after SDK acceptance unknown without losing evidence", async () => {
    database.email.update.mockRejectedValue(
      new Error("Owned persistence unavailable"),
    );
    const response = await post({
      ...payload,
      headers: { "X-Owned": "evidence" },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      outcome: "unknown",
      sdkInvoked: true,
      permitConsumed: true,
    });
    expect([...emails.values()][0]?.headers).toBe('{"X-Owned":"evidence"}');
    expect([...events.values()].some((row) => row.status === "FAILED")).toBe(
      false,
    );
  });
  it("charges a typed permanent SDK rejection while keeping it terminal", async () => {
    sdkFailure = new MessageRejected({
      $metadata: { httpStatusCode: 400 },
      message: "Owned typed rejection",
    });
    const response = await post();
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      outcome: "rejected",
      sdkInvoked: true,
      permitConsumed: true,
    });
    expect(physical).toBe(1);
  });

  it("does not refund a permit consumed by a concurrent owner after a stale preflight read", async () => {
    await post();
    let hidden = true;
    database.emailEvent.findUnique.mockImplementation(async ({ where }) => {
      if (where.id.startsWith("native-permit-v1:") && hidden) {
        hidden = false;
        return null;
      }
      return events.get(where.id) ?? null;
    });
    const response = await post(payload, "concurrent-other-intent");
    const body = await response.json();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(body.permitConsumed).toBe(true);
    expect(physical).toBe(1);
  });
  it("never forgets an older consumed permit after a known-rejection retry", async () => {
    sdkFailure = new TooManyRequestsException({
      $metadata: { httpStatusCode: 429 },
      message: "Owned quota rejection",
    });
    const first = await post();
    expect(first.status).toBe(429);
    expect(await first.json()).toMatchObject({
      outcome: "held",
      sdkInvoked: true,
      permitConsumed: true,
    });
    sdkFailure = null;
    requestPermit = "permit-two";
    providerGeneration = 2;
    clockOffset = 31000;
    const accepted = await post();
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      accepted: { permitId: "permit-two" },
    });
    requestPermit = "permit-one";
    const old = await post();
    expect(old.status).toBe(200);
    expect(await old.json()).toMatchObject({
      sdkInvoked: false,
      permitConsumed: true,
      replayed: true,
      accepted: { permitId: "permit-two" },
    });
    expect(physical).toBe(2);
  });
  it("cannot spend one technical permit on a different logical email", async () => {
    await post();
    const second = await post(payload, "different-intent");
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      outcome: "rejected",
      sdkInvoked: false,
      permitConsumed: true,
      reason: "NATIVE_PERMIT_OWNER_MISMATCH",
    });
    expect(physical).toBe(1);
  });
  it("keeps the actual production-default admission held without a second queue", async () => {
    const response = await post(payload, "owned-default-held", null);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      protocol: "native-immediate-v1",
      outcome: "held",
      sdkInvoked: false,
      permitConsumed: false,
      replayed: false,
    });
    expect(emails.size).toBe(0);
    expect(queued).toEqual([]);
    expect(physical).toBe(0);
  });
  it("reports capabilities unqualified instead of inventing actual quota", async () => {
    const app = getApp();
    const register = (
      routes as unknown as {
        registerNativeMarketing: (app: ReturnType<typeof getApp>) => void;
      }
    ).registerNativeMarketing;
    register(app);
    const response = await app.request(
      "http://localhost/api/v1/native-marketing/capabilities",
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      protocol: "native-immediate-v1",
      qualified: false,
    });
    expect(body).not.toHaveProperty("quota");
    expect(body).not.toHaveProperty("providerScopeFingerprint");
  });
  it("holds a stale automatic sender scope immediately before SDK", async () => {
    expectedSenderScope = "old-approved-scope";
    const response = await post();
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      outcome: "held",
      reason: "SENDER_SCOPE_CHANGED",
      sdkInvoked: false,
      permitConsumed: false,
    });
    expect(physical).toBe(0);
  });
  it("returns200 only after known SES acceptance with an explicit receipt", async () => {
    const response = await post();
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(
      200,
    );
    const body = await response.json();
    expect(body).toMatchObject({
      protocol: "native-immediate-v1",
      intentId: "owned-send-key",
      budgetKey: "usesend:owned-budget",
      permitId: "permit-one",
      outcome: "accepted",
      sdkInvoked: true,
      permitConsumed: true,
      replayed: false,
      accepted: { permitId: "permit-one", provider: "ses" },
    });
    expect(body.emailId).toBeTruthy();
    expect(body.accepted.messageId).toBe("ses-" + body.emailId);
    expect(physical).toBe(1);
    expect(queued).toEqual([]);
  });
  it("keeps same-permit accepted replay consumed without another SDK invocation", async () => {
    await post();
    const replay = await post();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      outcome: "accepted",
      sdkInvoked: false,
      permitConsumed: true,
      replayed: true,
    });
    expect(physical).toBe(1);
  });
  it("does not consume a different fresh permit for cached prior acceptance", async () => {
    await post();
    requestPermit = "permit-two";
    const replay = await post();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      sdkInvoked: false,
      permitConsumed: false,
      replayed: true,
      accepted: { permitId: "permit-one" },
    });
    expect(physical).toBe(1);
    expect(emails.size).toBe(1);
  });
  it.each(["Owner <owned@example.invalid>", "OWNED@EXAMPLE.INVALID"])(
    "honors existing canonical unsubscribe for %s",
    async (to) => {
      database.contact.findUnique.mockImplementation(async ({ where }) =>
        where.contactBookId_email?.email === "owned@example.invalid"
          ? {
              id: "contact_owned",
              email: "owned@example.invalid",
              subscribed: false,
              contactBookId: "book_owned",
              contactBook: { teamId: 1 },
            }
          : null,
      );
      const response = await post({ ...payload, to });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        protocol: "native-immediate-v1",
        outcome: "suppressed",
        sdkInvoked: false,
        permitConsumed: false,
      });
      expect(database.contact.create).not.toHaveBeenCalled();
      expect(physical).toBe(0);
      expect(queued).toEqual([]);
    },
  );
  it("holds absent canonical consent authority without creating a fresh alias", async () => {
    database.contact.findUnique.mockResolvedValue(null);
    const response = await post();
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      outcome: "held",
      reason: "CANONICAL_CONTACT_REQUIRED",
      sdkInvoked: false,
      permitConsumed: false,
    });
    expect(database.contact.create).not.toHaveBeenCalled();
    expect(physical).toBe(0);
  });
  it("retains owner idempotency after Redis result expiry and server key metadata changes", async () => {
    const first = await (await post()).json();
    records.clear();
    auth.apiKeyId = 12;
    requestPermit = "permit-two";
    const next = await (await post()).json();
    expect(next.emailId).toBe(first.emailId);
    expect(emails.size).toBe(1);
    expect(physical).toBe(1);
  });
  it("keeps SDK ambiguity closed even when a fresh permit arrives", async () => {
    sdkFailure = new Error("SDK transport unknown");
    const first = await post();
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({
      outcome: "unknown",
      sdkInvoked: true,
      permitConsumed: true,
    });
    requestPermit = "permit-two";
    const again = await post();
    expect(again.status).toBe(503);
    expect(physical).toBe(1);
    expect(queued).toEqual([]);
  });
  it("uses typed503 when the ownership recovery read also fails", async () => {
    database.$transaction.mockImplementation(async (op) => {
      await op(database);
      throw new Error("commit ACK lost");
    });
    database.emailEvent.findUnique.mockImplementation(async ({ where }) => {
      if (events.has(where.id)) throw new Error("recovery unavailable");
      return null;
    });
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      protocol: "native-immediate-v1",
      outcome: "unknown",
    });
    expect(physical).toBe(0);
  });
});

describe("Native readiness API scope and explicit bootstrap", () => {
  it("bodyless explicit POST qualification uses authenticated key scope", async () => {
    const app = getApp();
    const qualify = vi.fn(async () => ({ qualified: true }));
    routes.registerNativeMarketing(app, {
      ...nativeDeps,
      qualify,
    } as unknown as Parameters<typeof routes.registerNativeMarketing>[1]);
    const response = await app.request(
      "http://localhost/api/v1/native-marketing/qualify",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(qualify).toHaveBeenCalledExactlyOnceWith({
      teamId: 1,
      apiKeyId: 11,
    });
  });
  it("periodic GET passes authenticated scope and never calls qualification", async () => {
    const app = getApp();
    const capabilities = vi.fn(async () => ({
      qualified: false,
      reason: "PROVIDER_LEDGER_LOST",
    }));
    const qualify = vi.fn();
    routes.registerNativeMarketing(app, {
      ...nativeDeps,
      capabilities,
      qualify,
    } as unknown as Parameters<typeof routes.registerNativeMarketing>[1]);
    const response = await app.request(
      "http://localhost/api/v1/native-marketing/capabilities",
    );
    expect(response.status).toBe(200);
    expect(capabilities).toHaveBeenCalledExactlyOnceWith({
      teamId: 1,
      apiKeyId: 11,
    });
    expect(qualify).not.toHaveBeenCalled();
  });
});

describe("Native provider reservation integration", () => {
  it("releases only its own provider reservation on final known no-SDK hold", async () => {
    const settle = vi.fn(async () => undefined);
    const validate = vi.fn(async () => {
      throw new Error("PROVIDER_LEDGER_LOST");
    });
    const response = await post(payload, "final-loss", {
      ...nativeDeps,
      admission: { ...nativeDeps.admission, settle, validate },
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      sdkInvoked: false,
      permitConsumed: false,
      reason: "PROVIDER_LEDGER_LOST",
    });
    expect(physical).toBe(0);
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ permitId: "provider-permit" }),
      "unused",
    );
  });
  it("preserves UNKNOWN reservation after ambiguous SDK result and never auto-retries", async () => {
    const settle = vi.fn(async () => undefined);
    missingSdkId = true;
    const overrides = {
      ...nativeDeps,
      admission: { ...nativeDeps.admission, settle },
    };
    expect((await post(payload, "sdk-ambiguous", overrides)).status).toBe(503);
    expect(settle).toHaveBeenCalledWith(expect.anything(), "unknown");
    requestPermit = "fresh-request";
    expect((await post(payload, "sdk-ambiguous", overrides)).status).toBe(503);
    expect(physical).toBe(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });
  it("known SES quota rejection releases provider quota while Native physical permit remains spent", async () => {
    const settle = vi.fn(async () => undefined);
    sdkFailure = new TooManyRequestsException({
      message: "Owned quota fake",
      $metadata: {},
    });
    const response = await post(payload, "known-quota", {
      ...nativeDeps,
      admission: { ...nativeDeps.admission, settle },
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      sdkInvoked: true,
      permitConsumed: true,
    });
    expect(settle).toHaveBeenCalledWith(expect.anything(), "unused");
  });
  it("settles known accepted reservation without changing the durable acceptance receipt", async () => {
    const settle = vi.fn(async () => undefined);
    const response = await post(payload, "accepted-ledger", {
      ...nativeDeps,
      admission: { ...nativeDeps.admission, settle },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: "accepted",
      sdkInvoked: true,
      permitConsumed: true,
    });
    expect(settle).toHaveBeenCalledWith(expect.anything(), "accepted");
  });
});

describe("final consent after provider wait", () => {
  it("an unsubscribe committed during final provider validation prevents SDK submission", async () => {
    const settle = vi.fn(async () => undefined);
    const validate = vi.fn(async () => {
      database.contact.findUnique.mockResolvedValue({
        id: "contact_owned",
        email: payload.to,
        subscribed: false,
        contactBookId: "book_owned",
        contactBook: { teamId: 1 },
      });
    });
    const response = await post(payload, "unsubscribe-provider-wait", {
      ...nativeDeps,
      admission: { ...nativeDeps.admission, validate, settle },
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      outcome: "suppressed",
      sdkInvoked: false,
      permitConsumed: false,
    });
    expect(physical).toBe(0);
    expect(settle).toHaveBeenCalledWith(expect.anything(), "unused");
  });
});

it("keeps current submission UNKNOWN when durable shared rejection invalidation fails", async () => {
  const invalidate = vi.fn(async () => {
    throw new Error("lost DB acknowledgement");
  });
  const settle = vi.fn(async () => undefined);
  sdkFailure = new TooManyRequestsException({
    message: "Owned quota fake",
    $metadata: {},
  });
  const response = await post(payload, "invalidation-unknown", {
    ...nativeDeps,
    admission: { ...nativeDeps.admission, invalidate, settle },
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    outcome: "unknown",
    sdkInvoked: true,
    permitConsumed: true,
  });
  expect(invalidate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ accountId: "owned-account" }),
    expect.any(Number),
  );
  expect(settle).toHaveBeenCalledWith(expect.anything(), "unknown");
});
