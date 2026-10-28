import { beforeEach, describe, expect, it, vi } from "vitest";

const { database, queued, effects, suppression } = vi.hoisted(() => ({
  database: {
    contactBook: { findFirst: vi.fn() },
    contact: { findUnique: vi.fn(), create: vi.fn() },
    email: { create: vi.fn(), update: vi.fn() },
    emailEvent: { create: vi.fn() },
  },
  queued: [] as unknown[][],
  effects: [] as string[],
  suppression: vi.fn(),
}));
vi.mock("~/server/db", () => ({ db: database }));
vi.mock("./email-queue-service", () => ({
  EmailQueueService: {
    queueEmail: async (...args: unknown[]) => {
      queued.push(args);
    },
  },
}));
vi.mock("./domain-service", () => ({
  validateDomainFromEmail: async () => {
    effects.push("domain");
    return { id: 1, region: "us-east-1" };
  },
  validateApiKeyDomainAccess: vi.fn(),
}));
vi.mock("@usesend/email-editor/src/renderer", () => ({
  EmailRenderer: class {},
}));
vi.mock("../logger/log", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("./suppression-service", () => ({
  SuppressionService: { checkMultipleEmails: suppression },
}));
vi.mock("./campaign-service", () => ({
  createContactBookUnsubUrl: () => "http://localhost/unsubscribe/owned",
}));

import { sendBulkEmails, sendEmail } from "./email-service";

const request = {
  teamId: 1,
  contactBookId: "book_owned",
  to: "owned@example.invalid",
  from: "sender@example.invalid",
  subject: "Owned local test",
  text: "Synthetic",
};
beforeEach(() => {
  queued.length = 0;
  effects.length = 0;
  database.contactBook.findFirst.mockImplementation(async () => {
    effects.push("contactBook");
    return { id: "book_owned", teamId: 1 };
  });
  database.contact.findUnique.mockResolvedValue({
    id: "contact_owned",
    subscribed: true,
    email: request.to,
  });
  database.email.create.mockImplementation(async ({ data }) => {
    effects.push("email");
    return { ...data, id: "email_owned" };
  });
  database.emailEvent.create.mockResolvedValue({});
  suppression.mockResolvedValue({});
});

describe("single email purpose and early input guards", () => {
  it("routes explicit marketing to the marketing queue", async () => {
    await sendEmail({ ...request, purpose: "marketing" });
    expect(queued[0]?.slice(0, 4)).toEqual([
      "email_owned",
      1,
      "us-east-1",
      false,
    ]);
  });
  it.each([undefined, "service"] as const)(
    "keeps %s on the existing transactional queue",
    async (purpose) => {
      await sendEmail({ ...request, ...(purpose ? { purpose } : {}) });
      expect(queued[0]?.slice(0, 4)).toEqual([
        "email_owned",
        1,
        "us-east-1",
        true,
      ]);
    },
  );
  it("keeps existing default scheduled mail supported", async () => {
    const email = await sendEmail({
      ...request,
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(email.latestStatus).toBe("SCHEDULED");
    expect(queued[0]?.[3]).toBe(true);
    expect(queued[0]?.[5]).toBeGreaterThan(0);
  });
  it("rejects marketing scheduling before any contact or email work", async () => {
    await expect(
      sendEmail({
        ...request,
        purpose: "marketing",
        scheduledAt: "2030-01-01T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(effects).toEqual([]);
    expect(queued).toEqual([]);
  });
  it("rejects a marketing batch before its suppression or database work", async () => {
    suppression.mockImplementation(() => {
      throw new Error("suppression boundary reached");
    });
    await expect(
      sendBulkEmails([{ ...request, purpose: "marketing" }]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(suppression).not.toHaveBeenCalled();
    expect(effects).toEqual([]);
  });
  it.each(["no-at-address", "", "   ", []])(
    "rejects malformed TO %j before side effects",
    async (to) => {
      await expect(sendEmail({ ...request, to })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(effects).toEqual([]);
      expect(queued).toEqual([]);
    },
  );
  it.each([
    '"Someone @ Fit Square" <owned@example.invalid>',
    '"Name" <"a@b"@example.invalid>',
  ])("keeps legitimate legacy display-name address %s intact", async (to) => {
    const email = await sendEmail({ ...request, to });
    expect(email.to).toEqual([to]);
    expect(queued[0]?.[3]).toBe(true);
  });
  it("does not enqueue a suppressed marketing recipient", async () => {
    database.contact.findUnique.mockResolvedValue({
      id: "contact_owned",
      subscribed: false,
      email: request.to,
    });
    const email = await sendEmail({ ...request, purpose: "marketing" });
    expect(email.latestStatus).toBe("SUPPRESSED");
    expect(queued).toEqual([]);
  });
});
