import { Email, Prisma } from "@prisma/client";
import { createHash } from "crypto";
import addressparser from "nodemailer/lib/addressparser";
import { db } from "../db";
import { UnsendApiError } from "../public-api/api-error";
import { EmailContent } from "~/types";

export const NATIVE_PROTOCOL = "native-immediate-v1" as const;
export type MarketingState =
  | "READY"
  | "WAITING"
  | "SUBMITTING"
  | "ACCEPTED"
  | "UNKNOWN_HOLD"
  | "EXPIRED"
  | "SUPPRESSED"
  | "REJECTED"
  | "ENQUEUE_PENDING"
  | "QUEUED"
  | "HANDOFF_UNKNOWN";
export interface MarketingControl {
  kind: "MARKETING_DISPATCH";
  version: 1;
  protocol?: typeof NATIVE_PROTOCOL;
  emailId: string;
  teamId: number;
  requestHash: string;
  region: string;
  expiresAt: string | null;
  state: MarketingState;
  revision: number;
  attemptNumber: number;
  attemptToken: string | null;
  accountId: string | null;
  recipientCount: number | null;
  envelopeDigest: string | null;
  reason: string | null;
  observedSesId: string | null;
  nextEligibleAt: string | null;
  nativeBudgetKey?: string;
  acceptedPermitId?: string;
  acceptedAt?: string;
  blockedObservationGeneration?: number;
  unsubscribeUrl?: string;
}
export interface MarketingRecord {
  id: string;
  data: MarketingControl;
}
export type MarketingStore = Pick<
  Prisma.TransactionClient,
  "email" | "emailEvent"
>;
export interface NativePermit {
  id: string;
  budgetKey: string;
  submitBefore: string;
  senderScope?: string;
}
export interface MarketingHandoffContext {
  protocol: typeof NATIVE_PROTOCOL;
  idempotencyKey: string;
  requestHash: string;
  budgetKey: string;
  apiKeyId?: number;
  unsubscribeUrl?: string;
  beforePrepare?: (region: string) => Promise<void>;
}
export interface NativePermitRecord {
  id: string;
  data: {
    kind: "NATIVE_MARKETING_PERMIT";
    version: 1;
    controlId: string;
    emailId: string;
    teamId: number;
    permitId: string;
    budgetKey: string;
    submitBefore: string;
    effect: "unknown" | "consumed" | "unused";
    revision: number;
  };
}
export class MarketingHandoffUnknown extends Error {
  constructor(public readonly emailId?: string) {
    super("Marketing ownership or submission outcome is unknown.");
    this.name = "MarketingHandoffUnknown";
  }
}
export class MarketingNoSend extends Error {
  constructor(
    public readonly reason: string,
    public readonly terminal?: "EXPIRED" | "SUPPRESSED" | "REJECTED",
  ) {
    super(reason);
    this.name = "MarketingNoSend";
  }
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const marketingControlId = (teamId: number, key: string) =>
  `mkt-v1:${hash(`${teamId}\0${key}`)}`;
export const nativePermitId = (teamId: number, permit: NativePermit) =>
  `native-permit-v1:${hash(`${teamId}\0${permit.budgetKey}\0${permit.id}`)}`;
export function singleMarketingMailbox(
  content: Pick<EmailContent, "to" | "cc" | "bcc">,
): string | null {
  const parse = (values?: string | string[]) =>
    (values === undefined
      ? []
      : Array.isArray(values)
        ? values
        : [values]
    ).flatMap((value) => addressparser(value, { flatten: true }));
  const to = parse(content.to);
  return to.length === 1 &&
    to[0]?.address &&
    parse(content.cc).length === 0 &&
    parse(content.bcc).length === 0
    ? to[0].address
    : null;
}
export function validateMarketingHandoff(
  content: EmailContent,
  context?: MarketingHandoffContext,
): MarketingHandoffContext & { expiresAt: string | null } {
  if (
    context?.protocol !== NATIVE_PROTOCOL ||
    !context.idempotencyKey.trim() ||
    context.idempotencyKey.length > 256 ||
    !context.requestHash ||
    !context.budgetKey ||
    content.purpose !== "marketing" ||
    !content.contactBookId ||
    content.expiresAt === undefined ||
    (content.expiresAt !== null &&
      !Number.isFinite(Date.parse(content.expiresAt))) ||
    !singleMarketingMailbox(content)
  )
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message:
        "Native marketing requires a stable key, explicit expiry, contact book and one TO mailbox without CC/BCC.",
    });
  return { ...context, expiresAt: content.expiresAt };
}
const states: MarketingState[] = [
  "READY",
  "WAITING",
  "SUBMITTING",
  "ACCEPTED",
  "UNKNOWN_HOLD",
  "EXPIRED",
  "SUPPRESSED",
  "REJECTED",
  "ENQUEUE_PENDING",
  "QUEUED",
  "HANDOFF_UNKNOWN",
];
export async function readMarketingControl(
  id: string,
  database: MarketingStore = db,
): Promise<MarketingRecord | null> {
  const row = await database.emailEvent.findUnique({ where: { id } });
  const raw = row?.data;
  if (!row || !raw || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const data = raw as unknown as MarketingControl;
  if (
    data.kind !== "MARKETING_DISPATCH" ||
    data.version !== 1 ||
    data.emailId !== row.emailId ||
    data.teamId !== row.teamId ||
    !states.includes(data.state) ||
    !Number.isInteger(data.revision) ||
    data.revision < 1 ||
    typeof data.region !== "string" ||
    typeof data.requestHash !== "string" ||
    (data.expiresAt !== null &&
      (typeof data.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(data.expiresAt))))
  )
    return null;
  return { id, data };
}
export async function existingMarketingOwner(
  teamId: number,
  context: MarketingHandoffContext,
  database: MarketingStore = db,
): Promise<MarketingRecord | null> {
  const record = await readMarketingControl(
    marketingControlId(teamId, context.idempotencyKey),
    database,
  );
  if (
    record &&
    (record.data.teamId !== teamId ||
      record.data.requestHash !== context.requestHash ||
      (record.data.nativeBudgetKey &&
        record.data.nativeBudgetKey !== context.budgetKey))
  )
    throw new UnsendApiError({
      code: "NOT_UNIQUE",
      message:
        "Idempotency-Key already used with a different business payload or budget scope",
    });
  return record;
}
export async function resolveMarketingOwner(
  record: MarketingRecord,
  database: MarketingStore = db,
): Promise<Email> {
  if (
    [
      "ENQUEUE_PENDING",
      "HANDOFF_UNKNOWN",
      "SUBMITTING",
      "UNKNOWN_HOLD",
      "QUEUED",
    ].includes(record.data.state)
  )
    throw new MarketingHandoffUnknown(record.data.emailId);
  const email = await database.email.findUnique({
    where: { id: record.data.emailId, teamId: record.data.teamId },
  });
  if (!email) throw new MarketingHandoffUnknown(record.data.emailId);
  return email;
}
export async function createMarketingOwner(
  data: Prisma.EmailUncheckedCreateInput,
  region: string,
  expiresAt: string | null,
  context: MarketingHandoffContext,
  database: typeof db = db,
): Promise<{ email: Email; record: MarketingRecord; created: boolean }> {
  const id = marketingControlId(data.teamId, context.idempotencyKey);
  try {
    return await database.$transaction(async (tx) => {
      const email = await tx.email.create({ data });
      const control: MarketingControl = {
        kind: "MARKETING_DISPATCH",
        version: 1,
        protocol: NATIVE_PROTOCOL,
        emailId: email.id,
        teamId: email.teamId,
        requestHash: context.requestHash,
        region,
        expiresAt,
        state: email.latestStatus === "SUPPRESSED" ? "SUPPRESSED" : "READY",
        revision: 1,
        attemptNumber: 0,
        attemptToken: null,
        accountId: null,
        recipientCount: null,
        envelopeDigest: null,
        nextEligibleAt: null,
        reason: null,
        observedSesId: null,
        nativeBudgetKey: context.budgetKey,
      };
      if (context.unsubscribeUrl)
        control.unsubscribeUrl = context.unsubscribeUrl;
      await tx.emailEvent.create({
        data: {
          id,
          emailId: email.id,
          teamId: email.teamId,
          status: "QUEUED",
          data: control as unknown as Prisma.InputJsonValue,
        },
      });
      return { email, record: { id, data: control }, created: true };
    });
  } catch {
    let owner: MarketingRecord | null;
    try {
      owner = await existingMarketingOwner(data.teamId, context, database);
    } catch (error) {
      if (error instanceof UnsendApiError) throw error;
      throw new MarketingHandoffUnknown();
    }
    if (!owner) throw new MarketingHandoffUnknown();
    try {
      return {
        email: await resolveMarketingOwner(owner, database),
        record: owner,
        created: false,
      };
    } catch (error) {
      if (
        error instanceof MarketingHandoffUnknown ||
        error instanceof UnsendApiError
      )
        throw error;
      throw new MarketingHandoffUnknown(owner.data.emailId);
    }
  }
}
export async function transitionMarketingControl(
  record: MarketingRecord,
  patch: Partial<
    Omit<
      MarketingControl,
      | "kind"
      | "version"
      | "protocol"
      | "emailId"
      | "teamId"
      | "requestHash"
      | "region"
      | "expiresAt"
      | "revision"
      | "nativeBudgetKey"
    >
  >,
  database: MarketingStore = db,
): Promise<MarketingRecord | null> {
  const data = { ...record.data, ...patch, revision: record.data.revision + 1 };
  const result = await database.emailEvent.updateMany({
    where: {
      id: record.id,
      emailId: record.data.emailId,
      teamId: record.data.teamId,
      AND: [
        { data: { path: ["revision"], equals: record.data.revision } },
        { data: { path: ["state"], equals: record.data.state } },
      ],
    },
    data: { data: data as unknown as Prisma.InputJsonValue },
  });
  return result.count === 1 ? { id: record.id, data } : null;
}
export async function readNativePermit(
  teamId: number,
  permit: NativePermit,
  database: MarketingStore = db,
): Promise<NativePermitRecord | null> {
  const id = nativePermitId(teamId, permit),
    row = await database.emailEvent.findUnique({ where: { id } }),
    raw = row?.data;
  if (!row) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new MarketingHandoffUnknown(row.emailId);
  const data = raw as unknown as NativePermitRecord["data"];
  if (
    data.kind !== "NATIVE_MARKETING_PERMIT" ||
    data.version !== 1 ||
    data.emailId !== row.emailId ||
    data.teamId !== teamId ||
    data.permitId !== permit.id ||
    data.budgetKey !== permit.budgetKey ||
    !["unknown", "consumed", "unused"].includes(data.effect)
  )
    throw new MarketingHandoffUnknown(row.emailId);
  return { id, data };
}
export async function fenceNativePermit(
  record: MarketingRecord,
  permit: NativePermit,
  patch: Parameters<typeof transitionMarketingControl>[1],
  database: typeof db = db,
): Promise<{ record: MarketingRecord; permit: NativePermitRecord } | null> {
  return database.$transaction(async (tx) => {
    const fenced = await transitionMarketingControl(
      record,
      { ...patch, state: "SUBMITTING" },
      tx,
    );
    if (!fenced) return null;
    const entry: NativePermitRecord = {
      id: nativePermitId(record.data.teamId, permit),
      data: {
        kind: "NATIVE_MARKETING_PERMIT",
        version: 1,
        controlId: record.id,
        emailId: record.data.emailId,
        teamId: record.data.teamId,
        permitId: permit.id,
        budgetKey: permit.budgetKey,
        submitBefore: permit.submitBefore,
        effect: "unknown",
        revision: 1,
      },
    };
    await tx.emailEvent.create({
      data: {
        id: entry.id,
        emailId: entry.data.emailId,
        teamId: entry.data.teamId,
        status: "QUEUED",
        data: entry.data as unknown as Prisma.InputJsonValue,
      },
    });
    return { record: fenced, permit: entry };
  });
}
export async function setNativePermitEffect(
  entry: NativePermitRecord,
  effect: NativePermitRecord["data"]["effect"],
  database: MarketingStore = db,
): Promise<NativePermitRecord | null> {
  if (entry.data.effect === "consumed" && effect !== "consumed") return null;
  const data = { ...entry.data, effect, revision: entry.data.revision + 1 };
  const result = await database.emailEvent.updateMany({
    where: {
      id: entry.id,
      emailId: entry.data.emailId,
      AND: [{ data: { path: ["revision"], equals: entry.data.revision } }],
    },
    data: { data: data as unknown as Prisma.InputJsonValue },
  });
  return result.count === 1 ? { id: entry.id, data } : null;
}
