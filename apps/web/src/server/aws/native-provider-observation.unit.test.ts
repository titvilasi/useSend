import {
  GetAccountCommand,
  GetEmailIdentityCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import { STSClient } from "@aws-sdk/client-sts";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("~/env", () => ({
  env: {
    AWS_ACCESS_KEY: "owned-fake",
    AWS_SECRET_KEY: "owned-fake",
    AWS_SES_ENDPOINT: "http://127.0.0.1:9",
  },
}));
const { database } = vi.hoisted(() => ({
  database: {
    apiKey: { findUnique: vi.fn() },
    sesSetting: { findUnique: vi.fn() },
  },
}));
vi.mock("../db", () => ({ db: database }));
import {
  observeNativeProvider,
  readSesProviderProof,
} from "./native-provider-observation";
const attempts: number[] = [];
let enforcement: string | undefined;
beforeEach(() => {
  attempts.length = 0;
  enforcement = "HEALTHY";
  database.apiKey.findUnique.mockResolvedValue({
    id: 11,
    teamId: 1,
    tokenHash: "owned-hash",
    updatedAt: new Date(),
    domain: {
      id: 1,
      teamId: 1,
      name: "example.invalid",
      region: "us-east-1",
      updatedAt: new Date(),
    },
  });
  database.sesSetting.findUnique.mockResolvedValue({
    transactionalQuota: 50,
    sesEmailRateLimit: 5,
  });
  vi.spyOn(SESv2Client.prototype, "send").mockImplementation(async function (
    this: SESv2Client,
    command: unknown,
    options: { abortSignal: AbortSignal },
  ) {
    attempts.push(await this.config.maxAttempts());
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    if (command instanceof GetAccountCommand)
      return {
        EnforcementStatus: enforcement,
        SendingEnabled: true,
        ProductionAccessEnabled: true,
        SendQuota: {
          MaxSendRate: 10,
          Max24HourSend: 1000,
          SentLast24Hours: 50,
        },
      };
    if (command instanceof GetEmailIdentityCommand)
      return { VerifiedForSendingStatus: true };
    throw new Error("Unexpected provider command");
  } as typeof SESv2Client.prototype.send);
  vi.spyOn(STSClient.prototype, "send").mockImplementation(async function (
    this: STSClient,
  ) {
    attempts.push(await this.config.maxAttempts());
    return { Account: "123456789012" };
  } as typeof STSClient.prototype.send);
});
describe("Native-only real SDK command boundary using zero-network fakes", () => {
  it("reads actual account quota/current account/sender with one attempt each", async () => {
    expect(
      await readSesProviderProof("example.invalid", "us-east-1"),
    ).toMatchObject({
      accountId: "123456789012",
      max24Hours: 1000,
      sent24Hours: 50,
      rawEnforcementStatus: "HEALTHY",
      identityVerified: true,
    });
    expect(attempts).toEqual([1, 1, 1]);
  });
  it("does not fabricate missing AWS enforcement status", async () => {
    enforcement = undefined;
    expect(
      await readSesProviderProof("example.invalid", "us-east-1"),
    ).toMatchObject({ rawEnforcementStatus: null });
  });
});

describe("scoped fresh evidence cache", () => {
  it("rejects an unscoped or wrong-team key before any provider SDK call", async () => {
    database.apiKey.findUnique.mockResolvedValueOnce({
      id: 11,
      teamId: 1,
      domain: null,
    });
    await expect(
      observeNativeProvider({ teamId: 1, apiKeyId: 11 }),
    ).rejects.toThrow("DOMAIN_SCOPED_KEY_REQUIRED");
    database.apiKey.findUnique.mockResolvedValueOnce({
      id: 11,
      teamId: 2,
      domain: { teamId: 2 },
    });
    await expect(
      observeNativeProvider({ teamId: 1, apiKeyId: 11 }),
    ).rejects.toThrow("DOMAIN_SCOPED_KEY_REQUIRED");
    expect(attempts).toEqual([]);
  });
  it("caches actual observations for at most 60s while key rotation changes sender scope", async () => {
    vi.useFakeTimers();
    try {
      const first = await observeNativeProvider({ teamId: 1, apiKeyId: 11 });
      const second = await observeNativeProvider({ teamId: 1, apiKeyId: 11 });
      expect(first.providerScopeFingerprint).toBe(
        second.providerScopeFingerprint,
      );
      expect(attempts).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(60001);
      const refreshed = await observeNativeProvider({
        teamId: 1,
        apiKeyId: 11,
      });
      expect(Date.parse(refreshed.observedAt)).toBeGreaterThan(
        Date.parse(first.observedAt),
      );
      expect(attempts).toHaveLength(6);
      const current = await database.apiKey.findUnique();
      database.apiKey.findUnique.mockResolvedValue({
        ...current,
        tokenHash: "rotated-owned",
      });
      const rotated = await observeNativeProvider({ teamId: 1, apiKeyId: 11 });
      expect(rotated.providerScopeFingerprint).not.toBe(
        first.providerScopeFingerprint,
      );
      expect(attempts).toHaveLength(9);
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds even an SDK fake that ignores abort to one shared 3s deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(SESv2Client.prototype, "send").mockImplementation(
        (() =>
          new Promise(() => undefined)) as typeof SESv2Client.prototype.send,
      );
      vi.spyOn(STSClient.prototype, "send").mockImplementation(
        (() => new Promise(() => undefined)) as typeof STSClient.prototype.send,
      );
      const assertion = expect(
        readSesProviderProof("timeout.invalid", "us-east-1"),
      ).rejects.toThrow("PROVIDER_OBSERVATION_TIMEOUT");
      await vi.advanceTimersByTimeAsync(3000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
