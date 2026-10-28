import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProviderReadiness,
  ProviderObservation,
  ProviderStore,
} from "./native-provider-admission";

const scope = { teamId: 1, apiKeyId: 11 };
let now = Date.parse("2026-10-28T10:00:00Z");
let rows: Map<string, string>;
let redis: Map<string, string>;
let observation: ProviderObservation;
let writes: number;
let reads: ReturnType<typeof vi.fn>;
let store: ProviderStore;
function setup() {
  return createProviderReadiness({
    store,
    redis: {
      get: async (key) => redis.get(key) ?? null,
      create: async (key, value) => {
        if (redis.has(key)) return false;
        redis.set(key, value);
        return true;
      },
      compareSwap: async (key, old, value) => {
        if (redis.get(key) !== old) return false;
        redis.set(key, value);
        return true;
      },
    },
    now: () => now,
    observe: reads,
  });
}
beforeEach(() => {
  rows = new Map();
  redis = new Map();
  writes = 0;
  now = Date.parse("2026-10-28T10:00:00Z");
  observation = {
    accountId: "123456789012",
    region: "us-east-1",
    senderDomain: "example.invalid",
    senderDomainScoped: true,
    providerScopeFingerprint: "scope-owned",
    maxPerSecond: 10,
    max24Hours: 1000,
    sent24Hours: 10,
    observedAt: new Date(now).toISOString(),
    sendingEnabled: true,
    rawEnforcementStatus: "HEALTHY",
    productionAccessEnabled: true,
    identityVerified: true,
    serviceHeadroomPercent: 50,
    rateCeiling: 5,
  };
  reads = vi.fn(async () => ({ ...observation }));
  store = {
    get: async (key) => rows.get(key) ?? null,
    create: async (key, value) => {
      if (rows.has(key)) throw new Error("unique");
      writes++;
      rows.set(key, value);
    },
    put: async (key, value) => {
      writes++;
      rows.set(key, value);
    },
    locked: async (_key, action) => action(store),
  };
});
describe("Native provider readiness durable first initialization", () => {
  it("GET never initializes a missing ledger", async () => {
    expect(await setup().capabilities(scope)).toMatchObject({
      qualified: false,
      reason: "PROVIDER_NOT_QUALIFIED",
    });
    expect(writes).toBe(0);
    expect(redis.size).toBe(0);
  });
  it("explicit qualification initializes once and exposes actual raw quota", async () => {
    const gate = setup();
    expect(await gate.qualify(scope)).toMatchObject({
      qualified: true,
      senderDomainScoped: true,
      providerScopeFingerprint: "scope-owned",
      quota: {
        max24Hours: 1000,
        sent24Hours: 10,
        remaining24Hours: 990,
        enforcementStatus: "enforced",
      },
    });
    const epoch = [...rows.values()][0];
    expect(await gate.capabilities(scope)).toMatchObject({ qualified: true });
    expect([...rows.values()][0]).toBe(epoch);
  });
  it("neither GET nor explicit POST recreates Redis after durable epoch exists", async () => {
    const gate = setup();
    await gate.qualify(scope);
    const before = [...rows.entries()];
    redis.clear();
    expect(await gate.capabilities(scope)).toMatchObject({
      qualified: false,
      reason: "PROVIDER_LEDGER_LOST",
    });
    expect(await gate.qualify(scope)).toMatchObject({
      qualified: false,
      reason: "PROVIDER_LEDGER_LOST",
    });
    expect([...rows.entries()]).toEqual(before);
    expect(redis.size).toBe(0);
  });
  it("corrupt Redis cannot be silently replaced by qualification", async () => {
    const gate = setup();
    await gate.qualify(scope);
    for (const key of redis.keys()) redis.set(key, "{}");
    expect(await gate.qualify(scope)).toMatchObject({
      qualified: false,
      reason: "PROVIDER_LEDGER_LOST",
    });
    expect([...redis.values()]).toEqual(["{}"]);
  });
  it.each([
    "sendingEnabled",
    "productionAccessEnabled",
    "identityVerified",
    "senderDomainScoped",
  ] as const)(
    "missing/disabled %s fails closed before initialization",
    async (field) => {
      observation[field] = false;
      expect(await setup().qualify(scope)).toMatchObject({ qualified: false });
      expect(rows.size).toBe(0);
      expect(redis.size).toBe(0);
    },
  );
  it("missing headroom and stale provider evidence cannot qualify", async () => {
    observation.serviceHeadroomPercent = NaN;
    expect(await setup().qualify(scope)).toMatchObject({ qualified: false });
    observation.serviceHeadroomPercent = 50;
    now += 60001;
    expect(await setup().qualify(scope)).toMatchObject({ qualified: false });
    expect(rows.size).toBe(0);
  });
});

describe("durable epoch ordering and provider-only reservation limits", () => {
  it("commits the INITIALIZING tombstone before any Redis first-create", async () => {
    let inTransaction = false;
    store.locked = async (_key, action) => {
      inTransaction = true;
      try {
        return await action(store);
      } finally {
        inTransaction = false;
      }
    };
    const gate = createProviderReadiness({
      store,
      now: () => now,
      observe: reads,
      redis: {
        get: async (key) => redis.get(key) ?? null,
        create: async (key, value) => {
          expect(inTransaction).toBe(false);
          redis.set(key, value);
          return true;
        },
        compareSwap: async () => true,
      },
    });
    expect(await gate.qualify(scope)).toMatchObject({ qualified: true });
  });
  it("leaves first-init tombstone closed after an uncertain Redis acknowledgement", async () => {
    const gate = createProviderReadiness({
      store,
      now: () => now,
      observe: reads,
      redis: {
        get: async (key) => redis.get(key) ?? null,
        create: async () => {
          throw new Error("lost Redis ACK");
        },
        compareSwap: async () => false,
      },
    });
    expect(await gate.qualify(scope)).toMatchObject({ qualified: false });
    expect(rows.size).toBe(1);
    expect(JSON.parse([...rows.values()][0]!).state).toBe("INITIALIZING");
    expect(await gate.qualify(scope)).toMatchObject({
      qualified: false,
      reason: "PROVIDER_LEDGER_LOST",
    });
  });
  it("missing AWS enforcement metadata cannot qualify", async () => {
    observation.rawEnforcementStatus = null;
    expect(await setup().qualify(scope)).toMatchObject({ qualified: false });
    expect(rows.size).toBe(0);
  });
});

const prepared = (controlId = "logical-one") => ({
  controlId,
  revision: 1,
  region: "us-east-1",
  recipientCount: 1,
  envelopeDigest: "prepared-mime-one",
  businessExpiresAt: null,
});
describe("account+region provider-only quota and rate reservations", () => {
  it("shares physical provider rate across teams without copying Native daily budget", async () => {
    const gate = setup();
    await gate.qualify(scope);
    expect(await gate.acquire(scope, prepared())).toMatchObject({
      kind: "permit",
      recipientCount: 1,
    });
    expect(
      await gate.acquire({ teamId: 2, apiKeyId: 22 }, prepared("other-team")),
    ).toMatchObject({ kind: "hold", reason: "PROVIDER_RATE_LIMITED" });
    now += 400;
    expect(
      await gate.acquire({ teamId: 2, apiKeyId: 22 }, prepared("other-team")),
    ).toMatchObject({ kind: "permit" });
  });
  it("reserves actual prepared cost against AWS rolling quota after service headroom", async () => {
    observation.sent24Hours = 499;
    const gate = setup();
    await gate.qualify(scope);
    expect(await gate.acquire(scope, prepared())).toMatchObject({
      kind: "permit",
    });
    now += 400;
    expect(await gate.acquire(scope, prepared("two"))).toMatchObject({
      kind: "hold",
      reason: "PROVIDER_QUOTA_RESERVED",
    });
  });
  it("pending and unknown commitments survive a fresh lower AWS observation", async () => {
    observation.sent24Hours = 499;
    const gate = setup();
    await gate.qualify(scope);
    const permit = await gate.acquire(scope, prepared());
    expect(permit.kind).toBe("permit");
    if (permit.kind !== "permit") throw new Error("expected permit");
    await gate.settle(permit, "unknown");
    now += 1000;
    observation.observedAt = new Date(now).toISOString();
    expect(await gate.capabilities(scope)).toMatchObject({ qualified: true });
    expect(await gate.acquire(scope, prepared("two"))).toMatchObject({
      kind: "hold",
      reason: "PROVIDER_QUOTA_RESERVED",
    });
    now += 25 * 3600000;
    observation.observedAt = new Date(now).toISOString();
    expect(await gate.acquire(scope, prepared("three"))).toMatchObject({
      kind: "hold",
      reason: "PROVIDER_QUOTA_RESERVED",
    });
  });
  it("only a proved unused reservation releases quota; unknown cannot downgrade", async () => {
    observation.sent24Hours = 499;
    const gate = setup();
    await gate.qualify(scope);
    const permit = await gate.acquire(scope, prepared());
    if (permit.kind !== "permit") throw new Error("expected permit");
    await gate.settle(permit, "unused");
    now += 400;
    const second = await gate.acquire(scope, prepared("two"));
    expect(second.kind).toBe("permit");
    if (second.kind !== "permit") throw new Error("expected permit");
    await gate.settle(second, "unknown");
    await gate.settle(second, "unused");
    now += 400;
    expect(await gate.acquire(scope, prepared("three"))).toMatchObject({
      kind: "hold",
      reason: "PROVIDER_QUOTA_RESERVED",
    });
  });
  it("rejects mismatched actual envelope cost and cannot reserve after Redis loss", async () => {
    const gate = setup();
    await gate.qualify(scope);
    expect(
      await gate.acquire(scope, { ...prepared(), recipientCount: 2 }),
    ).toMatchObject({ kind: "hold" });
    redis.clear();
    expect(await gate.acquire(scope, prepared())).toMatchObject({
      kind: "hold",
      reason: "PROVIDER_LEDGER_LOST",
    });
  });
});

describe("final SDK provider boundary", () => {
  it("a second sender domain shares quota without invalidating an unchanged global observation", async () => {
    reads.mockImplementation(async (requested: { apiKeyId?: number }) => ({
      ...observation,
      senderDomain:
        requested.apiKeyId === 22 ? "second.invalid" : observation.senderDomain,
      providerScopeFingerprint:
        requested.apiKeyId === 22
          ? "scope-second"
          : observation.providerScopeFingerprint,
    }));
    const gate = setup();
    await gate.qualify(scope);
    const permit = await gate.acquire(scope, prepared());
    if (permit.kind !== "permit") throw new Error("expected permit");
    await gate.capabilities({ teamId: 2, apiKeyId: 22 });
    await expect(gate.validate(scope, permit)).resolves.toBeUndefined();
  });
  it("scope/key rotation after preparation fails before SDK and lost state cannot validate", async () => {
    const gate = setup();
    await gate.qualify(scope);
    const permit = await gate.acquire(scope, prepared());
    if (permit.kind !== "permit") throw new Error("expected permit");
    observation.providerScopeFingerprint = "rotated";
    await expect(gate.validate(scope, permit)).rejects.toThrow(
      "PROVIDER_OBSERVATION_CHANGED",
    );
    redis.clear();
    await expect(gate.validate(scope, permit)).rejects.toThrow(
      "PROVIDER_LEDGER_LOST",
    );
  });
  it("delayed prepared send cannot bunch with another final SDK permit", async () => {
    const gate = setup();
    await gate.qualify(scope);
    const first = await gate.acquire(scope, prepared());
    if (first.kind !== "permit") throw new Error("expected permit");
    now += 400;
    const second = await gate.acquire(scope, prepared("two"));
    if (second.kind !== "permit") throw new Error("expected permit");
    await gate.validate(scope, first);
    await expect(gate.validate(scope, second)).rejects.toThrow(
      "PROVIDER_RATE_LIMITED",
    );
  });
});

describe("durable account rejection generation", () => {
  it("typed provider rejection blocks all owners and old final permits beyond the 30s pause", async () => {
    const g = setup();
    await g.qualify(scope);
    const first = await g.acquire(scope, prepared());
    if (first.kind !== "permit") throw new Error("Expected permit");
    now += 400;
    const old = await g.acquire(scope, prepared("already-prepared"));
    if (old.kind !== "permit") throw new Error("Expected permit");
    await g.invalidate(first, now + 30000);
    await g.settle(first, "unused");
    now += 30001;
    expect(await g.capabilities(scope)).toMatchObject({
      qualified: false,
      reason: "PROVIDER_REFRESH_REQUIRED",
    });
    expect(await g.acquire(scope, prepared("different-owner"))).toMatchObject({
      kind: "hold",
      reason: "PROVIDER_REFRESH_REQUIRED",
    });
    await expect(g.validate(scope, old)).rejects.toThrow();
    observation.observedAt = new Date(now).toISOString();
    expect(await g.capabilities(scope)).toMatchObject({ qualified: true });
    await expect(g.validate(scope, old)).rejects.toThrow(
      "PROVIDER_OBSERVATION_CHANGED",
    );
    expect(await g.acquire(scope, prepared("fresh-owner"))).toMatchObject({
      kind: "permit",
    });
  });
});
