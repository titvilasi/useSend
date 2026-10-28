/* eslint-disable turbo/no-undeclared-env-vars -- Explicit isolated fixture inputs; never a Turbo task. */
import { PrismaClient } from "@prisma/client";
import {
  SESv2Client,
  GetAccountCommand,
  GetEmailIdentityCommand,
  SendEmailCommand,
} from "@aws-sdk/client-sesv2";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { readFileSync, writeFileSync } from "fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
vi.mock("~/utils/ses-utils", () => ({
  getConfigurationSetName: async () => {
    throw new Error("External config fallback forbidden");
  },
}));
vi.mock("./limit-service", () => ({
  LimitService: {
    checkEmailLimit: async () => {
      throw new Error("External billing fallback forbidden");
    },
  },
}));
vi.mock("./email-queue-service", () => ({
  EmailQueueService: {
    queueEmail: async () => {
      throw new Error("Native Bull enqueue forbidden");
    },
  },
}));
vi.mock("@usesend/email-editor/src/renderer", () => ({
  EmailRenderer: class {},
}));
import { db } from "../db";
import { connection, getRedis } from "../redis";
import { observeNativeProvider } from "../aws/native-provider-observation";
import { sendRawEmail } from "../aws/ses";
import {
  createProviderReadiness,
  providerLedgerKey,
} from "./native-provider-admission";
import {
  createNativeProviderStore,
  nativeProviderRedis,
} from "./native-provider-store";
import {
  createMarketingOwner,
  existingMarketingOwner,
  NATIVE_PROTOCOL,
} from "./marketing-handoff";
import {
  executePreparedNative,
  NativeDependencies,
} from "./native-marketing-immediate";
import { requireAdmissionPermit } from "./native-provider-runtime";
const enabled = process.env.RUN_NATIVE_PROVIDER_LOCAL_TESTS === "true";
describe.skipIf(!enabled)("owned real PG/Redis provider admission", () => {
  let plan: {
    fixtureId: string;
    database: string;
    ownerMarker: string;
    localUrls: { postgres: string; redis: string };
  };
  let second: PrismaClient;
  let teamId: number;
  let serial = 0;
  let clock = Date.now();
  let accountId = "";
  let sent = 10;
  let sendingEnabled = true;
  let physical = 0;
  let resultMode: "accepted" | "missing" = "accepted";
  const commandCounts: Record<string, number> = {};
  const forbidden: string[] = [];
  const outcomes: Record<string, unknown> = {};
  const keys: string[] = [];
  const output = () => process.env.MARKETING_FIXTURE_OUTCOME!;
  beforeAll(async () => {
    plan = JSON.parse(
      readFileSync(process.env.MARKETING_FIXTURE_PLAN!, "utf8"),
    );
    const url = new URL(plan.localUrls.postgres);
    if (
      process.env.DATABASE_URL !== plan.localUrls.postgres ||
      process.env.REDIS_URL !== plan.localUrls.redis ||
      url.hostname !== "127.0.0.1" ||
      url.port !== "55542" ||
      url.pathname !== `/${plan.database}` ||
      !plan.database.startsWith("usesend_marketing_test_")
    )
      throw new Error("Refusing unowned store");
    const marker = await db.$queryRaw<
      Array<{ marker: string }>
    >`SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()`;
    if (marker[0]?.marker !== plan.ownerMarker)
      throw new Error("Fixture marker mismatch");
    second = new PrismaClient({
      datasources: { db: { url: plan.localUrls.postgres } },
    });
    const team = await db.team.create({
      data: { name: `provider-${plan.fixtureId}` },
    });
    teamId = team.id;
    await db.sesSetting.create({
      data: {
        region: "us-east-1",
        idPrefix: plan.fixtureId,
        topic: "owned",
        callbackUrl: "http://127.0.0.1:1",
        transactionalQuota: 50,
        sesEmailRateLimit: 5,
      },
    });
    writeFileSync(
      output() + ".seed.json",
      JSON.stringify({
        fixtureId: plan.fixtureId,
        teamId,
        ownerMarker: plan.ownerMarker,
      }),
    );
  }, 15000);
  beforeEach(() => {
    vi.spyOn(SESv2Client.prototype, "send").mockImplementation(async function (
      this: SESv2Client,
      command: unknown,
    ) {
      expect(await this.config.maxAttempts()).toBe(1);
      const name =
        command instanceof GetAccountCommand
          ? "GetAccount"
          : command instanceof GetEmailIdentityCommand
            ? "GetEmailIdentity"
            : command instanceof SendEmailCommand
              ? "SendEmail"
              : "FORBIDDEN";
      commandCounts[name] = (commandCounts[name] ?? 0) + 1;
      if (command instanceof GetAccountCommand)
        return {
          SendingEnabled: sendingEnabled,
          ProductionAccessEnabled: true,
          EnforcementStatus: "HEALTHY",
          SendQuota: {
            MaxSendRate: 10,
            Max24HourSend: 1000,
            SentLast24Hours: sent,
          },
        };
      if (command instanceof GetEmailIdentityCommand)
        return { VerifiedForSendingStatus: true };
      if (command instanceof SendEmailCommand) {
        physical++;
        return {
          MessageId:
            resultMode === "accepted" ? `ses-owned-${physical}` : undefined,
        };
      }
      forbidden.push(name);
      throw new Error("External SES command forbidden");
    } as typeof SESv2Client.prototype.send);
    vi.spyOn(STSClient.prototype, "send").mockImplementation(async function (
      this: STSClient,
      command: unknown,
    ) {
      expect(await this.config.maxAttempts()).toBe(1);
      if (!(command instanceof GetCallerIdentityCommand)) {
        forbidden.push("STS command");
        throw new Error("External STS command forbidden");
      }
      commandCounts.GetCallerIdentity =
        (commandCounts.GetCallerIdentity ?? 0) + 1;
      return { Account: accountId };
    } as typeof STSClient.prototype.send);
  });
  function gate(client = db) {
    return createProviderReadiness({
      store: createNativeProviderStore(client),
      redis: nativeProviderRedis,
      observe: observeNativeProvider,
      now: () => Date.now(),
    });
  }
  async function scoped(name: string, sameAccount = false) {
    if (!sameAccount) {
      serial++;
      accountId = String(800000000000 + serial);
      sent = 10;
      sendingEnabled = true;
      resultMode = "accepted";
    }
    const domain = await db.domain.create({
      data: {
        name: `${name}-${plan.fixtureId}.example.invalid`,
        teamId,
        region: "us-east-1",
        publicKey: "owned",
        status: "SUCCESS",
      },
    });
    const key = await db.apiKey.create({
      data: {
        clientId: `${name}-${plan.fixtureId}`,
        tokenHash: "synthetic",
        partialToken: "synthetic",
        name,
        teamId,
        domainId: domain.id,
      },
    });
    const scope = { teamId, apiKeyId: key.id };
    const ledgerKey = providerLedgerKey(accountId, "us-east-1");
    keys.push(ledgerKey);
    return { scope, domain, ledgerKey };
  }
  const prepared = (name: string) => ({
    controlId: `${plan.fixtureId}/${name}`,
    revision: 1,
    recipientCount: 1,
    envelopeDigest: `mime/${name}`,
    region: "us-east-1",
    businessExpiresAt: null,
  });
  it("GET is read-only before explicit first qualification", async () => {
    const s = await scoped("get-before");
    expect(await gate().capabilities(s.scope)).toMatchObject({
      qualified: false,
      reason: "PROVIDER_NOT_QUALIFIED",
    });
    expect(
      await db.appSetting.findUnique({ where: { key: s.ledgerKey } }),
    ).toBeNull();
    expect(await getRedis().get(s.ledgerKey)).toBeNull();
    outcomes.getBefore = true;
  });
  it("concurrent explicit qualification keeps exactly one durable account epoch", async () => {
    const s = await scoped("qualify-race");
    const results = await Promise.all([
      gate().qualify(s.scope),
      gate(second).qualify(s.scope),
    ]);
    expect(results.some((r) => r.qualified)).toBe(true);
    expect(await gate().capabilities(s.scope)).toMatchObject({
      qualified: true,
    });
    const epoch = await db.appSetting.findUniqueOrThrow({
      where: { key: s.ledgerKey },
    });
    expect(JSON.parse(epoch.value).state).toBe("ACTIVE");
    outcomes.qualifyRace = { results, epoch };
  });
  it("real PG lock+Redis CAS admits only one of eight concurrent final quota claims", async () => {
    const s = await scoped("quota-race");
    sent = 499;
    await gate().qualify(s.scope);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        gate(i % 2 ? second : db).acquire(s.scope, prepared(`race-${i}`)),
      ),
    );
    expect(results.filter((r) => r.kind === "permit")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "hold")).toHaveLength(7);
    outcomes.quotaRace = results;
  });
  it("fresh actual SDK observation does not refill an UNKNOWN reservation", async () => {
    const s = await scoped("unknown-retain");
    sent = 499;
    const g = gate();
    await g.qualify(s.scope);
    const claim = await g.acquire(s.scope, prepared("unknown"));
    if (claim.kind !== "permit") throw new Error("Expected permit");
    await g.settle(claim, "unknown");
    vi.useFakeTimers({ toFake: ["Date"] });
    clock = Date.now() + 60001;
    vi.setSystemTime(clock);
    expect(await g.capabilities(s.scope)).toMatchObject({ qualified: true });
    expect(await g.acquire(s.scope, prepared("after-refresh"))).toMatchObject({
      kind: "hold",
      reason: "PROVIDER_QUOTA_RESERVED",
    });
    outcomes.unknownRetained = JSON.parse((await getRedis().get(s.ledgerKey))!);
    vi.useRealTimers();
  });
  it("lost owned Redis key is never rebuilt by GET or POST", async () => {
    const s = await scoped("lost-key");
    const g = gate();
    await g.qualify(s.scope);
    const epoch = await db.appSetting.findUniqueOrThrow({
      where: { key: s.ledgerKey },
    });
    await getRedis().del(s.ledgerKey); // Sole owned-key loss injection in fresh disposable store.
    expect(await g.capabilities(s.scope)).toMatchObject({
      qualified: false,
      reason: "PROVIDER_LEDGER_LOST",
    });
    expect(await g.qualify(s.scope)).toMatchObject({
      qualified: false,
      reason: "PROVIDER_LEDGER_LOST",
    });
    expect(
      await db.appSetting.findUnique({ where: { key: s.ledgerKey } }),
    ).toEqual(epoch);
    expect(await getRedis().get(s.ledgerKey)).toBeNull();
    outcomes.lostKey = epoch;
  });
  it("rollback to an old owned Redis snapshot is detected against durable hash", async () => {
    const s = await scoped("rollback-key");
    const g = gate();
    await g.qualify(s.scope);
    const previous = (await getRedis().get(s.ledgerKey))!;
    const claim = await g.acquire(s.scope, prepared("rollback"));
    if (claim.kind !== "permit") throw new Error("Expected permit");
    await g.settle(claim, "unknown");
    await getRedis().set(s.ledgerKey, previous); // Exact owned-key stale snapshot injection, no global reset.
    expect(await g.capabilities(s.scope)).toMatchObject({
      qualified: false,
      reason: "PROVIDER_LEDGER_LOST",
    });
    expect(await g.qualify(s.scope)).toMatchObject({
      qualified: false,
      reason: "PROVIDER_LEDGER_LOST",
    });
    outcomes.staleSnapshot = true;
  });
  it("sender domains share account rate without a second owner/day budget", async () => {
    const first = await scoped("scope-first");
    const secondSender = await scoped("scope-second", true);
    const g = gate();
    await g.qualify(first.scope);
    expect((await g.acquire(first.scope, prepared("sender-one"))).kind).toBe(
      "permit",
    );
    expect(
      await g.acquire(secondSender.scope, prepared("sender-two")),
    ).toMatchObject({ kind: "hold", reason: "PROVIDER_RATE_LIMITED" });
    outcomes.sharedSenderRate = true;
  });
  it("followup: actual PG adapter/bootstrap and eight concurrent provider quota claims", async () => {
    const state = await scoped("followup-adapter");
    sent = 499;
    const proof = await observeNativeProvider(state.scope);
    expect(proof).toMatchObject({
      accountId,
      rawEnforcementStatus: "HEALTHY",
      max24Hours: 1000,
      sent24Hours: 499,
    });
    // Surface the driver/lock error directly instead of swallowing it in readiness's public HOLD.
    expect(
      await createNativeProviderStore(db).locked(state.ledgerKey, (store) =>
        store.get(state.ledgerKey),
      ),
    ).toBeNull();
    const g = gate();
    expect(await g.capabilities(state.scope)).toMatchObject({
      qualified: false,
      reason: "PROVIDER_NOT_QUALIFIED",
    });
    expect(await g.qualify(state.scope)).toMatchObject({ qualified: true });
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        gate(n % 2 ? second : db).acquire(
          state.scope,
          prepared(`followup-race-${n}`),
        ),
      ),
    );
    expect(claims.filter((value) => value.kind === "permit")).toHaveLength(1);
    expect(claims.filter((value) => value.kind === "hold")).toHaveLength(7);
    outcomes.followupAdapterAndQuota = { proof, claims };
  });
  it("followup: durable rejection generation blocks cached evidence/all owners/final permits after pause", async () => {
    const state = await scoped("followup-generation");
    const g = gate();
    expect(await g.qualify(state.scope)).toMatchObject({ qualified: true });
    const first = await g.acquire(state.scope, prepared("followup-first"));
    if (first.kind !== "permit") throw new Error("Expected permit");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 400);
      const prior = await g.acquire(state.scope, prepared("followup-prior"));
      if (prior.kind !== "permit") throw new Error("Expected prior permit");
      const beforeCalls = commandCounts.GetAccount;
      await g.invalidate(first, Date.now() + 30000);
      await g.settle(first, "unused");
      vi.setSystemTime(Date.now() + 30001);
      expect(await gate(second).capabilities(state.scope)).toMatchObject({
        qualified: false,
        reason: "PROVIDER_REFRESH_REQUIRED",
      });
      expect(
        await gate(second).acquire(
          state.scope,
          prepared("followup-other-owner"),
        ),
      ).toMatchObject({ kind: "hold", reason: "PROVIDER_REFRESH_REQUIRED" });
      await expect(g.validate(state.scope, prior)).rejects.toThrow(
        "PROVIDER_REFRESH_REQUIRED",
      );
      expect(commandCounts.GetAccount).toBe(beforeCalls);
      vi.setSystemTime(Date.now() + 30000);
      expect(await g.capabilities(state.scope)).toMatchObject({
        qualified: true,
      });
      expect(commandCounts.GetAccount).toBeGreaterThan(beforeCalls!);
      await expect(g.validate(state.scope, prior)).rejects.toThrow(
        "PROVIDER_OBSERVATION_CHANGED",
      );
      outcomes.followupGeneration = JSON.parse(
        (await getRedis().get(state.ledgerKey))!,
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("followup: UNKNOWN plus owned Redis rollback/loss never permits GET/POST rebuild", async () => {
    const state = await scoped("followup-loss");
    const g = gate();
    await g.qualify(state.scope);
    const old = (await getRedis().get(state.ledgerKey))!;
    const claim = await g.acquire(
      state.scope,
      prepared("followup-lost-unknown"),
    );
    if (claim.kind !== "permit") throw new Error("Expected permit");
    await g.settle(claim, "unknown");
    const unknown = (await getRedis().get(state.ledgerKey))!;
    const epoch = await db.appSetting.findUniqueOrThrow({
      where: { key: state.ledgerKey },
    });
    await getRedis().set(state.ledgerKey, old);
    expect(await g.capabilities(state.scope)).toMatchObject({
      qualified: false,
      reason: "PROVIDER_LEDGER_LOST",
    });
    expect(await g.qualify(state.scope)).toMatchObject({
      qualified: false,
      reason: "PROVIDER_LEDGER_LOST",
    });
    await getRedis().del(state.ledgerKey);
    expect(await g.qualify(state.scope)).toMatchObject({
      qualified: false,
      reason: "PROVIDER_LEDGER_LOST",
    });
    expect(await getRedis().get(state.ledgerKey)).toBeNull();
    expect(
      await db.appSetting.findUnique({ where: { key: state.ledgerKey } }),
    ).toEqual(epoch);
    outcomes.followupLoss = {
      epoch,
      unknownBeforeLoss: JSON.parse(unknown),
      remainedClosed: true,
    };
  });
  async function nativeCase(
    name: string,
    missing: boolean,
    unsubscribe = false,
  ) {
    const s = await scoped(name);
    const g = gate();
    await g.qualify(s.scope);
    resultMode = missing ? "missing" : "accepted";
    const book = await db.contactBook.create({
      data: { teamId, name, properties: {} },
    });
    const contact = await db.contact.create({
      data: {
        contactBookId: book.id,
        email: "owned@example.invalid",
        properties: {},
        subscribed: true,
      },
    });
    const context = {
      protocol: NATIVE_PROTOCOL,
      teamId,
      apiKeyId: s.scope.apiKeyId,
      idempotencyKey: `${plan.fixtureId}/${name}`,
      requestHash: `business-${name}`,
      budgetKey: `budget-${plan.fixtureId}`,
    };
    const created = await createMarketingOwner(
      {
        teamId,
        domainId: s.domain.id,
        contactId: contact.id,
        from: `sender@${s.domain.name}`,
        to: ["owned@example.invalid"],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: name,
        text: "Synthetic fixture",
        latestStatus: "QUEUED",
      },
      "us-east-1",
      null,
      context,
      db,
    );
    const deps: Partial<NativeDependencies> = {
      database: db,
      now: () => new Date(),
      send: sendRawEmail,
      configurationSet: async () => "owned-fake-config",
      checkTeamLimit: async () => ({ isLimitReached: false }),
      getAccountPause: async () => 0,
      pauseAccount: async () => undefined,
      admission: {
        qualified: true,
        acquire: (input) => g.acquire(s.scope, input),
        validate: async (scope, value) => {
          await g.validate(scope, requireAdmissionPermit({ ...value }));
          if (unsubscribe)
            await db.contact.update({
              where: { id: contact.id },
              data: { subscribed: false },
            });
        },
        settle: (value, effect) =>
          g.settle(requireAdmissionPermit({ ...value }), effect),
      },
    };
    const permit = {
      id: `${name}/one`,
      budgetKey: context.budgetKey,
      submitBefore: new Date(Date.now() + 120000).toISOString(),
    };
    const before = physical;
    const response = await executePreparedNative(
      created.email,
      created.record,
      context,
      permit,
      deps,
    );
    expect(response.status).toBe(unsubscribe ? 422 : missing ? 503 : 200);
    expect(response.body).toMatchObject({
      sdkInvoked: !unsubscribe,
      permitConsumed: !unsubscribe,
    });
    expect(physical).toBe(before + (unsubscribe ? 0 : 1));
    const owner = await existingMarketingOwner(teamId, context, db);
    if (!owner) throw new Error("Expected owner");
    const email = await db.email.findUniqueOrThrow({
      where: { id: created.email.id },
    });
    const replay = await executePreparedNative(
      email,
      owner,
      context,
      { ...permit, id: `${name}/fresh` },
      deps,
    );
    expect(replay.status).toBe(unsubscribe ? 422 : missing ? 503 : 200);
    expect(physical).toBe(before + (unsubscribe ? 0 : 1));
    const ledger = JSON.parse((await getRedis().get(s.ledgerKey))!);
    expect(Object.values(ledger.reservations)).toEqual([
      expect.objectContaining({
        state: unsubscribe ? "unused" : missing ? "unknown" : "accepted",
      }),
    ]);
    outcomes[name] = { response, replay, ledger, emailId: email.id };
  }
  it("actual MIME+SDK-fake acceptance settles provider reservation and replays without submit", async () =>
    nativeCase("native-accepted", false));
  it("actual missing SDK id preserves durable UNKNOWN and provider reservation forever", async () =>
    nativeCase("native-unknown", true));
  it("followup: real contact unsubscribe during provider validation prevents SDK", async () =>
    nativeCase("native-consent-wait", false, true));
  afterAll(async () => {
    vi.useRealTimers();
    try {
      if (plan && teamId)
        writeFileSync(
          output(),
          JSON.stringify(
            {
              fixtureId: plan.fixtureId,
              teamId,
              outcomes,
              commandCounts,
              physicalSdkSubmissions: physical,
              forbiddenExternalCalls: forbidden,
              retainedEpochs: await db.appSetting.findMany({
                where: { key: { in: keys } },
              }),
              retainedControls: await db.emailEvent.findMany({
                where: { teamId },
              }),
              rowsKeptForExport: true,
            },
            null,
            2,
          ),
        );
      expect(forbidden).toEqual([]);
    } finally {
      if (second) await second.$disconnect();
      await db.$disconnect();
      if (connection && connection.status !== "end") await connection.quit();
    }
  });
});
