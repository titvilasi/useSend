import { createHash, randomUUID } from "crypto";
export interface ProviderScope {
  teamId: number;
  apiKeyId?: number;
}
export interface ProviderObservation {
  accountId: string;
  region: string;
  senderDomain: string;
  senderDomainScoped: boolean;
  providerScopeFingerprint: string;
  maxPerSecond: number;
  max24Hours: number;
  sent24Hours: number;
  observedAt: string;
  sendingEnabled: boolean;
  rawEnforcementStatus: string | null;
  productionAccessEnabled: boolean;
  identityVerified: boolean;
  serviceHeadroomPercent: number;
  rateCeiling: number;
}
export interface ProviderAcquireInput {
  controlId: string;
  revision: number;
  region: string;
  recipientCount: number;
  envelopeDigest: string;
  businessExpiresAt: string | null;
}
export interface AdmissionPermit {
  kind: "permit";
  accountId: string;
  region: string;
  recipientCount: number;
  envelopeDigest: string;
  observationGeneration: number;
  permitId: string;
  ledgerEpoch: string;
  observationHash: string;
  senderScopeFingerprint: string;
}
export interface ProviderStore {
  get(key: string): Promise<string | null>;
  create(key: string, value: string): Promise<void>;
  put(key: string, value: string): Promise<void>;
  locked<T>(
    key: string,
    action: (store: ProviderStore) => Promise<T>,
  ): Promise<T>;
}
export interface ProviderReadinessDependencies {
  store: ProviderStore;
  redis: {
    get(key: string): Promise<string | null>;
    create(key: string, value: string): Promise<boolean>;
    compareSwap(key: string, old: string, value: string): Promise<boolean>;
  };
  now: () => number;
  observe(scope: ProviderScope): Promise<ProviderObservation>;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const observationHash = (o: ProviderObservation) =>
  hash(
    JSON.stringify({
      accountId: o.accountId,
      region: o.region,
      maxPerSecond: o.maxPerSecond,
      max24Hours: o.max24Hours,
      sent24Hours: o.sent24Hours,
      observedAt: o.observedAt,
      sendingEnabled: o.sendingEnabled,
      productionAccessEnabled: o.productionAccessEnabled,
      rawEnforcementStatus: o.rawEnforcementStatus,
      serviceHeadroomPercent: o.serviceHeadroomPercent,
      rateCeiling: o.rateCeiling,
    }),
  );
export const providerLedgerKey = (accountId: string, region: string) =>
  `usesend:native-provider:v1:${accountId}:${region}`;
interface Epoch {
  version: 1;
  epoch: string;
  state: "INITIALIZING" | "ACTIVE";
  ledgerHash: string;
}
interface Ledger {
  version: 1;
  epoch: string;
  observation: ProviderObservation;
  generation: number;
  nextAt: number;
  lastSubmitNextAt?: number;
  blockedObservationAt?: number;
  pausedUntil?: number;
  reservations: Record<string, Reservation>;
}
interface Reservation {
  controlId: string;
  revision: number;
  cost: number;
  envelopeDigest: string;
  state: "pending" | "accepted" | "unknown" | "unused";
  createdAt: number;
  acceptedAt?: number;
}
const held = (reason: string) => ({ qualified: false as const, reason });
function validObservation(o: ProviderObservation, now: number) {
  return (
    /^\d{12}$/.test(o.accountId) &&
    !!o.region &&
    !!o.senderDomain &&
    !!o.providerScopeFingerprint &&
    o.senderDomainScoped === true &&
    o.identityVerified === true &&
    o.sendingEnabled === true &&
    o.productionAccessEnabled === true &&
    o.rawEnforcementStatus === "HEALTHY" &&
    Number.isFinite(o.maxPerSecond) &&
    o.maxPerSecond > 0 &&
    Number.isFinite(o.max24Hours) &&
    o.max24Hours > 0 &&
    Number.isFinite(o.sent24Hours) &&
    o.sent24Hours >= 0 &&
    Number.isFinite(o.rateCeiling) &&
    o.rateCeiling > 0 &&
    Number.isInteger(o.serviceHeadroomPercent) &&
    o.serviceHeadroomPercent >= 0 &&
    o.serviceHeadroomPercent < 100 &&
    Number.isFinite(Date.parse(o.observedAt)) &&
    Date.parse(o.observedAt) <= now &&
    now - Date.parse(o.observedAt) <= 60000
  );
}
export function createProviderReadiness(deps: ProviderReadinessDependencies) {
  async function readiness(scope: ProviderScope, initialize: boolean) {
    try {
      const observation = await deps.observe(scope);
      if (!validObservation(observation, deps.now()))
        return held("PROVIDER_OBSERVATION_UNQUALIFIED");
      const key = providerLedgerKey(observation.accountId, observation.region);
      if (initialize) {
        const initialization = await deps.store.locked(key, async (store) => {
          if ((await store.get(key)) !== null) return null;
          const epoch: Epoch = {
            version: 1,
            epoch: randomUUID(),
            state: "INITIALIZING",
            ledgerHash: "",
          };
          await store.create(key, JSON.stringify(epoch));
          return epoch;
        });
        // First transaction commits a durable tombstone before touching Redis.
        if (initialization) {
          const raw = JSON.stringify({
            version: 1,
            epoch: initialization.epoch,
            observation,
            generation: 1,
            nextAt: 0,
            reservations: {},
          } satisfies Ledger);
          try {
            if (!(await deps.redis.create(key, raw)))
              return held("PROVIDER_LEDGER_LOST");
          } catch {
            return held("PROVIDER_LEDGER_LOST");
          }
          return await deps.store.locked(key, async (store) => {
            if (
              (await store.get(key)) !== JSON.stringify(initialization) ||
              (await deps.redis.get(key)) !== raw
            )
              return held("PROVIDER_LEDGER_LOST");
            await store.put(
              key,
              JSON.stringify({
                ...initialization,
                state: "ACTIVE",
                ledgerHash: hash(raw),
              }),
            );
            return metadata(observation);
          });
        }
      }
      return await deps.store.locked(key, async (store) => {
        const stored = await store.get(key);
        if (stored === null) return held("PROVIDER_NOT_QUALIFIED");
        const epoch = JSON.parse(stored) as Epoch;
        const raw = await deps.redis.get(key);
        if (
          epoch.version !== 1 ||
          epoch.state !== "ACTIVE" ||
          !raw ||
          hash(raw) !== epoch.ledgerHash
        )
          return held("PROVIDER_LEDGER_LOST");
        const ledger = JSON.parse(raw) as Ledger;
        if (
          ledger.version !== 1 ||
          ledger.epoch !== epoch.epoch ||
          !Number.isFinite(ledger.generation) ||
          !ledger.reservations ||
          !Number.isFinite(ledger.nextAt)
        )
          return held("PROVIDER_LEDGER_LOST");
        if (
          ledger.blockedObservationAt !== undefined &&
          Date.parse(observation.observedAt) <= ledger.blockedObservationAt
        )
          return held("PROVIDER_REFRESH_REQUIRED");
        if ((ledger.pausedUntil ?? 0) > deps.now())
          return held("PROVIDER_ACCOUNT_PAUSED");
        const oldTime = Date.parse(ledger.observation.observedAt);
        const newTime = Date.parse(observation.observedAt);
        if (newTime < oldTime) return held("PROVIDER_OBSERVATION_STALE");
        // Cached/identical observations never reset pending or uncertain commitments.
        if (
          newTime > oldTime ||
          observationHash(ledger.observation) !== observationHash(observation)
        ) {
          const next = JSON.stringify({
            ...ledger,
            observation,
            generation: ledger.generation + 1,
          });
          if (!(await deps.redis.compareSwap(key, raw, next)))
            return held("PROVIDER_LEDGER_LOST");
          await store.put(
            key,
            JSON.stringify({ ...epoch, ledgerHash: hash(next) }),
          );
        }
        return metadata(observation);
      });
    } catch {
      return held("PROVIDER_READINESS_UNAVAILABLE");
    }
  }
  async function mutate<T>(key: string, action: (ledger: Ledger) => T) {
    return deps.store.locked(key, async (store) => {
      const stored = await store.get(key);
      const raw = await deps.redis.get(key);
      if (!stored || !raw) throw new Error("PROVIDER_LEDGER_LOST");
      const epoch = JSON.parse(stored) as Epoch;
      if (
        epoch.version !== 1 ||
        epoch.state !== "ACTIVE" ||
        hash(raw) !== epoch.ledgerHash
      )
        throw new Error("PROVIDER_LEDGER_LOST");
      const ledger = JSON.parse(raw) as Ledger;
      if (
        ledger.epoch !== epoch.epoch ||
        ledger.version !== 1 ||
        !ledger.reservations
      )
        throw new Error("PROVIDER_LEDGER_LOST");
      const result = action(ledger);
      const next = JSON.stringify(ledger);
      if (next !== raw) {
        if (!(await deps.redis.compareSwap(key, raw, next)))
          throw new Error("PROVIDER_LEDGER_LOST");
        await store.put(
          key,
          JSON.stringify({ ...epoch, ledgerHash: hash(next) }),
        );
      }
      return result;
    });
  }
  async function acquire(
    scope: ProviderScope,
    input: ProviderAcquireInput,
  ): Promise<AdmissionPermit | { kind: "hold"; reason: string }> {
    try {
      const ready = await readiness(scope, false);
      if (!ready.qualified) return { kind: "hold", reason: ready.reason };
      const o = await deps.observe(scope);
      if (
        !validObservation(o, deps.now()) ||
        o.region !== input.region ||
        input.recipientCount !== 1 ||
        !input.envelopeDigest ||
        (input.businessExpiresAt !== null &&
          (!Number.isFinite(Date.parse(input.businessExpiresAt)) ||
            Date.parse(input.businessExpiresAt) <= deps.now()))
      )
        return { kind: "hold", reason: "PROVIDER_PERMIT_INPUT_INVALID" };
      return await mutate(
        providerLedgerKey(o.accountId, o.region),
        (ledger) => {
          const now = deps.now();
          if (
            ledger.blockedObservationAt !== undefined &&
            Date.parse(o.observedAt) <= ledger.blockedObservationAt
          )
            return {
              kind: "hold" as const,
              reason: "PROVIDER_REFRESH_REQUIRED",
            };
          if ((ledger.pausedUntil ?? 0) > now)
            return { kind: "hold" as const, reason: "PROVIDER_ACCOUNT_PAUSED" };

          if (observationHash(ledger.observation) !== observationHash(o))
            return {
              kind: "hold" as const,
              reason: "PROVIDER_OBSERVATION_CHANGED",
            };
          const reservations = Object.values(ledger.reservations);
          if (
            reservations.some(
              (r) =>
                r.controlId === input.controlId &&
                r.revision === input.revision &&
                r.state !== "unused",
            )
          )
            return {
              kind: "hold" as const,
              reason: "PROVIDER_RESERVATION_EXISTS",
            };
          const committed = reservations.reduce(
            (total, r) =>
              total +
              (r.state === "unused" ||
              (r.state === "accepted" &&
                r.acceptedAt !== undefined &&
                r.acceptedAt + 86400000 <= now)
                ? 0
                : r.cost),
            0,
          );
          const marketingCapacity = Math.floor(
            (o.max24Hours * (100 - o.serviceHeadroomPercent)) / 100,
          );
          if (
            o.sent24Hours + committed + input.recipientCount >
            marketingCapacity
          )
            return { kind: "hold" as const, reason: "PROVIDER_QUOTA_RESERVED" };
          if (now < ledger.nextAt)
            return { kind: "hold" as const, reason: "PROVIDER_RATE_LIMITED" };
          const rate =
            (Math.min(o.maxPerSecond, o.rateCeiling) *
              (100 - o.serviceHeadroomPercent)) /
            100;
          if (!(rate > 0))
            return {
              kind: "hold" as const,
              reason: "PROVIDER_RATE_UNQUALIFIED",
            };
          const id = randomUUID();
          ledger.nextAt = now + Math.ceil((1000 * input.recipientCount) / rate);
          ledger.reservations[id] = {
            controlId: input.controlId,
            revision: input.revision,
            cost: input.recipientCount,
            envelopeDigest: input.envelopeDigest,
            state: "pending",
            createdAt: now,
          };
          return {
            kind: "permit" as const,
            accountId: o.accountId,
            region: o.region,
            recipientCount: input.recipientCount,
            envelopeDigest: input.envelopeDigest,
            observationGeneration: ledger.generation,
            permitId: id,
            ledgerEpoch: ledger.epoch,
            observationHash: observationHash(o),
            senderScopeFingerprint: o.providerScopeFingerprint,
          };
        },
      );
    } catch (error) {
      return {
        kind: "hold",
        reason:
          error instanceof Error && error.message === "PROVIDER_LEDGER_LOST"
            ? error.message
            : "PROVIDER_ADMISSION_UNAVAILABLE",
      };
    }
  }
  async function settle(
    permit: AdmissionPermit,
    effect: "unused" | "accepted" | "unknown",
  ) {
    await mutate(
      providerLedgerKey(permit.accountId, permit.region),
      (ledger) => {
        const reservation = ledger.reservations[permit.permitId];
        if (
          ledger.epoch !== permit.ledgerEpoch ||
          !reservation ||
          reservation.cost !== permit.recipientCount ||
          reservation.envelopeDigest !== permit.envelopeDigest
        )
          throw new Error("PROVIDER_PERMIT_MISMATCH");
        if (reservation.state !== "pending") return;
        reservation.state = effect;
        if (effect === "accepted") reservation.acceptedAt = deps.now();
      },
    );
  }
  async function validate(scope: ProviderScope, permit: AdmissionPermit) {
    const ready = await readiness(scope, false);
    if (!ready.qualified) throw new Error(ready.reason);
    const o = await deps.observe(scope);
    if (
      !validObservation(o, deps.now()) ||
      o.providerScopeFingerprint !== permit.senderScopeFingerprint ||
      observationHash(o) !== permit.observationHash
    )
      throw new Error("PROVIDER_OBSERVATION_CHANGED");
    await mutate(
      providerLedgerKey(permit.accountId, permit.region),
      (ledger) => {
        if (
          ledger.blockedObservationAt !== undefined &&
          Date.parse(o.observedAt) <= ledger.blockedObservationAt
        )
          throw new Error("PROVIDER_REFRESH_REQUIRED");
        if ((ledger.pausedUntil ?? 0) > deps.now())
          throw new Error("PROVIDER_ACCOUNT_PAUSED");
        const reservation = ledger.reservations[permit.permitId];
        if (
          ledger.epoch !== permit.ledgerEpoch ||
          ledger.generation !== permit.observationGeneration ||
          !reservation ||
          reservation.state !== "pending" ||
          reservation.cost !== permit.recipientCount ||
          reservation.envelopeDigest !== permit.envelopeDigest
        )
          throw new Error("PROVIDER_PERMIT_MISMATCH");
        if (deps.now() < (ledger.lastSubmitNextAt ?? 0))
          throw new Error("PROVIDER_RATE_LIMITED");
        const rate =
          (Math.min(o.maxPerSecond, o.rateCeiling) *
            (100 - o.serviceHeadroomPercent)) /
          100;
        ledger.lastSubmitNextAt =
          deps.now() + Math.ceil((1000 * reservation.cost) / rate);
      },
    );
  }
  return {
    capabilities: (scope: ProviderScope) => readiness(scope, false),
    qualify: (scope: ProviderScope) => readiness(scope, true),
    acquire,
    settle,
    validate,
    invalidate: async (permit: AdmissionPermit, until: number) =>
      mutate(providerLedgerKey(permit.accountId, permit.region), (ledger) => {
        if (
          ledger.epoch !== permit.ledgerEpoch ||
          !ledger.reservations[permit.permitId]
        )
          throw new Error("PROVIDER_PERMIT_MISMATCH");
        ledger.blockedObservationAt = Math.max(
          ledger.blockedObservationAt ?? 0,
          deps.now(),
        );
        ledger.pausedUntil = Math.max(ledger.pausedUntil ?? 0, until);
        ledger.generation++;
      }),
  };
}
function metadata(o: ProviderObservation) {
  return {
    qualified: true as const,
    providerScopeFingerprint: o.providerScopeFingerprint,
    senderDomainScoped: true,
    senderDomain: o.senderDomain,
    quota: {
      maxPerSecond: o.maxPerSecond,
      max24Hours: o.max24Hours,
      sent24Hours: o.sent24Hours,
      remaining24Hours: Math.max(0, o.max24Hours - o.sent24Hours),
      observedAt: o.observedAt,
      sendingEnabled: true,
      enforcementStatus: "enforced",
    },
  };
}
