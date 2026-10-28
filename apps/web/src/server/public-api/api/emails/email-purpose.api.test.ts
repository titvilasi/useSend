import { beforeEach, describe, expect, it, vi } from "vitest";

const { records, sendEmail, sendBulkEmails } = vi.hoisted(() => ({
  records: new Map<string, string>(),
  sendEmail: vi.fn(),
  sendBulkEmails: vi.fn(),
}));
vi.mock("~/server/public-api/auth", () => ({
  getTeamFromToken: async () => ({
    id: 1,
    apiKeyId: 11,
    apiKey: { domainId: null },
  }),
}));
vi.mock("~/utils/common", () => ({ isSelfHosted: () => true }));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("~/server/service/email-service", () => ({
  sendEmail,
  sendBulkEmails,
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
import registerSingle from "./send-email";
import registerBatch from "./batch-email";

const payload = {
  to: "owned@example.invalid",
  from: "sender@example.invalid",
  subject: "Owned",
  text: "Synthetic",
};
function app() {
  const result = getApp();
  registerSingle(result);
  registerBatch(result);
  return result;
}
function post(path: string, body: unknown, key?: string) {
  return app().request("http://localhost/api/v1/emails" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  records.clear();
  sendEmail.mockResolvedValue({ id: "email_owned" });
  sendBulkEmails.mockResolvedValue([{ id: "email_owned" }]);
});
describe("public single-send purpose contract", () => {
  it.each(["service", "marketing"] as const)(
    "passes explicit %s purpose without replacing the existing request",
    async (purpose) => {
      const response = await post("", { ...payload, purpose });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ emailId: "email_owned" });
      expect(sendEmail).toHaveBeenCalledWith({
        ...payload,
        purpose,
        html: undefined,
        teamId: 1,
        apiKeyId: 11,
      });
    },
  );
  it("does not inject purpose for an omitted-purpose request", async () => {
    expect((await post("", payload)).status).toBe(200);
    expect(sendEmail.mock.calls[0]?.[0]).not.toHaveProperty("purpose");
  });
  it("returns an old omitted-purpose idempotency record without another send", async () => {
    records.set(
      "idem:1:old-service",
      JSON.stringify({
        bodyHash:
          "f2b35f7a5fb240b69d9e783e1da74e16490badb08c8ea4a2c4d7d80f3cc718c5",
        emailIds: ["email_previously_accepted"],
      }),
    );
    const response = await post("", payload, "old-service");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      emailId: "email_previously_accepted",
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("rejects marketing scheduling before the service side-effect boundary", async () => {
    const response = await post("", {
      ...payload,
      purpose: "marketing",
      scheduledAt: "2030-01-01T00:00:00Z",
    });
    expect(response.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("rejects marketing batch input before the batch service boundary", async () => {
    const response = await post("/batch", [
      payload,
      { ...payload, purpose: "marketing" },
    ]);
    expect(response.status).toBe(400);
    expect(sendBulkEmails).not.toHaveBeenCalled();
  });
  it("keeps default scheduled batch requests supported", async () => {
    const body = [{ ...payload, scheduledAt: "2030-01-01T00:00:00Z" }];
    const response = await post("/batch", body);
    expect(response.status).toBe(200);
    expect(sendBulkEmails.mock.calls[0]?.[0]).toEqual([
      { ...body[0], html: undefined, teamId: 1, apiKeyId: 11 },
    ]);
  });
  it.each(["", "no-at-address", []])(
    "rejects malformed TO %j at the API boundary",
    async (to) => {
      const response = await post("", { ...payload, to });
      expect(response.status).toBe(400);
      expect(sendEmail).not.toHaveBeenCalled();
    },
  );
  it("keeps a legitimate legacy display-name address supported", async () => {
    const body = {
      ...payload,
      to: '"Someone @ Fit Square" <owned@example.invalid>',
    };
    expect((await post("", body)).status).toBe(200);
    expect(sendEmail.mock.calls[0]?.[0].to).toBe(body.to);
  });
});
