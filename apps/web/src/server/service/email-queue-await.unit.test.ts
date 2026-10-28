import { beforeEach, describe, expect, it, vi } from "vitest";

const { add, database } = vi.hoisted(() => ({
  add: vi.fn(),
  database: { sesSetting: { findMany: vi.fn() } },
}));
vi.mock("bullmq", () => ({
  Queue: class {
    add = add;
  },
  Worker: class {
    concurrency = 1;
  },
}));
vi.mock("../db", () => ({ db: database }));
vi.mock("../redis", () => ({ getRedis: () => ({}) }));
vi.mock("../aws/ses", () => ({ sendRawEmail: vi.fn() }));
vi.mock("~/utils/ses-utils", () => ({ getConfigurationSetName: vi.fn() }));
vi.mock("../logger/log", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("./limit-service", () => ({ LimitService: {} }));
import { EmailQueueService } from "./email-queue-service";

function pendingAdd() {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = () => {
      no(new Error("owned enqueue rejection"));
    };
  });
  // The missing-await baseline must not leak an unhandled rejection into Vitest.
  void promise.catch(() => undefined);
  add.mockReturnValue(promise);
  return { resolve, reject };
}
beforeEach(async () => {
  database.sesSetting.findMany.mockResolvedValue([
    { region: "us-east-1", sesEmailRateLimit: 2, transactionalQuota: 50 },
  ]);
  await EmailQueueService.init();
});
describe("single queue enqueue acknowledgement", () => {
  it("does not resolve while Redis add is still pending", async () => {
    const deferred = pendingAdd();
    let settled = false;
    const queued = EmailQueueService.queueEmail(
      "owned-email",
      1,
      "us-east-1",
      true,
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    deferred.resolve();
    await queued;
    expect(settled).toBe(true);
    expect(add).toHaveBeenCalledWith(
      "owned-email",
      expect.objectContaining({ emailId: "owned-email", teamId: 1 }),
      expect.objectContaining({ jobId: "owned-email" }),
    );
  });
  it("propagates a rejected Redis add to the existing service caller", async () => {
    const deferred = pendingAdd();
    const queued = EmailQueueService.queueEmail(
      "owned-email",
      1,
      "us-east-1",
      true,
    );
    const rejection = expect(queued).rejects.toThrow("owned enqueue rejection");
    deferred.reject();
    await rejection;
    expect(add).toHaveBeenCalledTimes(1);
  });
});
