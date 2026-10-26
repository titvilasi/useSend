import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { database, queued, emails } = vi.hoisted(() => ({
  database: {
    contactBook: { findFirst: vi.fn() },
    contact: { findUnique: vi.fn(), create: vi.fn() },
    email: { create: vi.fn(), update: vi.fn() },
    emailEvent: { create: vi.fn() },
  },
  queued: [] as string[],
  emails: [] as Array<Record<string, unknown>>,
}));

// Database, queue, renderer, and provider-facing dependencies stay local.
vi.mock("~/server/db", () => ({ db: database }));
vi.mock("./email-queue-service", () => ({
  EmailQueueService: {
    queueEmail: async (id: string) => { queued.push(id); },
  },
}));
vi.mock("./domain-service", () => ({
  validateDomainFromEmail: async () => ({ id: 1, region: "us-east-1" }),
  validateApiKeyDomainAccess: vi.fn(),
}));
vi.mock("@usesend/email-editor/src/renderer", () => ({ EmailRenderer: class {} }));
vi.mock("../logger/log", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("./suppression-service", () => ({
  SuppressionService: { checkMultipleEmails: async () => ({}) },
}));
vi.mock("./campaign-service", () => ({
  createContactBookUnsubUrl: () => "http://localhost/unsubscribe/owned-test",
}));

import { sendEmail } from "./email-service";

const contact = {
  id: "contact_owned",
  contactBookId: "book_owned",
  email: "owned@example.invalid",
  properties: { retained: "yes" },
  subscribed: true,
};
const request = {
  teamId: 1,
  contactBookId: "book_owned",
  to: "owned@example.invalid",
  from: "sender@example.invalid",
  subject: "Owned local verification",
  text: "Synthetic local content",
};

function conflict(meta: Record<string, unknown> = {
  modelName: "Contact", target: ["contactBookId", "email"],
}, code = "P2002") {
  return new Prisma.PrismaClientKnownRequestError("owned local contact conflict", {
    code, clientVersion: "6.6.0", meta,
  });
}

beforeEach(() => {
  queued.length = 0;
  emails.length = 0;
  database.contactBook.findFirst.mockResolvedValue({ id: "book_owned", teamId: 1 });
  database.contact.findUnique.mockResolvedValue(null);
  database.contact.create.mockResolvedValue(contact);
  database.email.create.mockImplementation(async ({ data }) => {
    const saved = { ...data, id: `email_owned_${emails.length + 1}` };
    emails.push(saved);
    return saved;
  });
  database.emailEvent.create.mockResolvedValue({});
});

describe("transactional email contact creation contention", () => {
  it("queues both emails when concurrent first sends collide on the same contact", async () => {
    let initialReads = 0;
    let stored: typeof contact | null = null;
    let releaseReads!: () => void;
    const bothReadMissing = new Promise<void>((resolve) => { releaseReads = resolve; });
    database.contact.findUnique.mockImplementation(async ({ where }) => {
      expect(where).toEqual({ contactBookId_email: {
        contactBookId: "book_owned", email: "owned@example.invalid",
      } });
      if (initialReads < 2) {
        initialReads += 1;
        if (initialReads === 2) releaseReads();
        await bothReadMissing;
        return null;
      }
      return stored;
    });
    database.contact.create.mockImplementation(async ({ data }) => {
      if (stored) throw conflict();
      stored = { ...contact, ...data };
      return stored;
    });

    const results = await Promise.allSettled([
      sendEmail(request), sendEmail({ ...request, subject: "Owned local welcome" }),
    ]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(queued).toEqual(["email_owned_1", "email_owned_2"]);
    expect(emails.map((email) => email.contactId)).toEqual(["contact_owned", "contact_owned"]);
    expect(stored).toEqual({ ...contact, properties: {} });
    expect(database.contact.create).toHaveBeenCalledTimes(2);
  });

  it("preserves an already existing unsubscribed contact without creating or queueing", async () => {
    const unsubscribed = { ...contact, subscribed: false };
    database.contact.findUnique.mockResolvedValue(unsubscribed);

    const result = await sendEmail(request);

    expect(result.latestStatus).toBe("SUPPRESSED");
    expect(queued).toEqual([]);
    expect(unsubscribed).toEqual({ ...contact, subscribed: false });
    expect(database.contact.create).not.toHaveBeenCalled();
  });

  it("preserves unsubscribe and properties when the conflicting contact is reread", async () => {
    const unsubscribed = { ...contact, subscribed: false };
    database.contact.findUnique.mockResolvedValueOnce(null).mockResolvedValue(unsubscribed);
    database.contact.create.mockRejectedValue(conflict());

    const result = await sendEmail(request);

    expect(result.latestStatus).toBe("SUPPRESSED");
    expect(result.contactId).toBeUndefined();
    expect(queued).toEqual([]);
    expect(unsubscribed).toEqual({ ...contact, subscribed: false });
    expect(database.contact.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["other database code", conflict(undefined, "P1001")],
    ["other model", conflict({ modelName: "Email", target: ["contactBookId", "email"] })],
    ["other unique key", conflict({ modelName: "Contact", target: ["id"] })],
    ["extra key field", conflict({ modelName: "Contact", target: ["contactBookId", "email", "teamId"] })],
    ["missing target", conflict({ modelName: "Contact" })],
    ["untyped lookalike", { code: "P2002", meta: { modelName: "Contact", target: ["contactBookId", "email"] } }],
  ])("propagates %s without queueing or retrying email", async (_name, error) => {
    database.contact.create.mockRejectedValue(error);

    await expect(sendEmail(request)).rejects.toBe(error);

    expect(emails).toEqual([]);
    expect(queued).toEqual([]);
    expect(database.contact.findUnique).toHaveBeenCalledTimes(1);
    expect(database.contact.create).toHaveBeenCalledTimes(1);
  });

  it("propagates the original conflict if the exact contact cannot be reread", async () => {
    const error = conflict();
    database.contact.create.mockRejectedValue(error);

    await expect(sendEmail(request)).rejects.toBe(error);

    expect(emails).toEqual([]);
    expect(queued).toEqual([]);
    expect(database.contact.create).toHaveBeenCalledTimes(1);
  });
});
