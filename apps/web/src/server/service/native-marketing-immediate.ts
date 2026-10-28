import {
  AccountSuspendedException,
  BadRequestException,
  MessageRejected,
  SendingPausedException,
  TooManyRequestsException,
} from "@aws-sdk/client-sesv2";
import { Email } from "@prisma/client";
import { randomUUID } from "crypto";
import { EmailContent } from "~/types";
import { getConfigurationSetName } from "~/utils/ses-utils";
import { PreparedMarketingEnvelope, sendRawEmail } from "../aws/ses";
import { db } from "../db";
import { getRedis } from "../redis";
import { UnsendApiError } from "../public-api/api-error";
import { sendEmail } from "./email-service";
import { LimitService } from "./limit-service";
import {
  existingMarketingOwner,
  fenceNativePermit,
  MarketingHandoffContext,
  MarketingHandoffUnknown,
  MarketingNoSend,
  MarketingRecord,
  NATIVE_PROTOCOL,
  NativePermit,
  NativePermitRecord,
  readMarketingControl,
  readNativePermit,
  setNativePermitEffect,
  singleMarketingMailbox,
  transitionMarketingControl,
} from "./marketing-handoff";

import {
  nativeProviderReadiness,
  requireAdmissionPermit,
} from "./native-provider-runtime";

export interface NativeReply {
  protocol: typeof NATIVE_PROTOCOL;
  intentId: string;
  budgetKey: string;
  permitId: string;
  outcome:
    | "accepted"
    | "held"
    | "unknown"
    | "suppressed"
    | "expired"
    | "rejected";
  sdkInvoked: boolean;
  permitConsumed?: boolean;
  replayed: boolean;
  emailId?: string;
  accepted?: {
    permitId: string;
    provider: "ses";
    messageId: string;
    acceptedAt: string;
  };
  reason?: string;
  retryAfterMs?: number;
}
export interface NativeResult {
  status: 200 | 400 | 403 | 404 | 429 | 503 | 422 | 409;
  body: NativeReply;
}
export interface ProviderPermit {
  kind: "permit";
  accountId: string;
  region: string;
  recipientCount: number;
  envelopeDigest: string;
  observationGeneration: number;
  permitId: string;
  ledgerEpoch?: string;
  observationHash?: string;
  senderScopeFingerprint?: string;
}
export interface NativeDependencies {
  database: typeof db;
  now: () => Date;
  send: typeof sendRawEmail;
  admission: {
    qualified: boolean;
    invalidate?: (permit: ProviderPermit, until: number) => Promise<void>;
    preflight?: (scope: {
      teamId: number;
      apiKeyId?: number;
    }) => Promise<{ qualified: boolean; reason?: string }>;
    validate?: (
      scope: { teamId: number; apiKeyId?: number },
      permit: ProviderPermit,
    ) => Promise<void>;
    settle?: (
      permit: ProviderPermit,
      effect: "unused" | "accepted" | "unknown",
    ) => Promise<void>;
    acquire: (input: {
      teamId: number;
      apiKeyId?: number;
      controlId: string;
      revision: number;
      region: string;
      recipientCount: number;
      envelopeDigest: string;
      businessExpiresAt: string | null;
    }) => Promise<ProviderPermit | { kind: "hold"; reason: string }>;
  };
  getAccountPause: (accountId: string, region: string) => Promise<number>;
  pauseAccount: (
    accountId: string,
    region: string,
    until: number,
  ) => Promise<void>;
  configurationSet: typeof getConfigurationSetName;
  checkTeamLimit: (teamId: number) => Promise<{ isLimitReached: boolean }>;
  capabilities: (scope: {
    teamId: number;
    apiKeyId?: number;
  }) => Promise<{ qualified: boolean; [key: string]: unknown }>;
  qualify?: (scope: {
    teamId: number;
    apiKeyId?: number;
  }) => Promise<{ qualified: boolean; [key: string]: unknown }>;
  senderScope: (scope: {
    teamId: number;
    apiKeyId?: number;
    domainId: number;
  }) => Promise<string | null>;
}
const pauseKey = (accountId: string, region: string) =>
  `usesend:mkt:v1:pause:${encodeURIComponent(accountId)}:${encodeURIComponent(region)}`;
const live: NativeDependencies = {
  database: db,
  now: () => new Date(),
  send: sendRawEmail,
  senderScope: async (scope) => {
    const result = await nativeProviderReadiness.capabilities(scope);
    return result.qualified ? result.providerScopeFingerprint : null;
  },
  admission: {
    qualified: true,
    invalidate: (permit, until) =>
      nativeProviderReadiness.invalidate(
        requireAdmissionPermit({ ...permit }),
        until,
      ),
    preflight: (scope) => nativeProviderReadiness.capabilities(scope),
    acquire: (input) =>
      nativeProviderReadiness.acquire(
        { teamId: input.teamId, apiKeyId: input.apiKeyId },
        input,
      ),
    validate: (scope, permit) =>
      nativeProviderReadiness.validate(
        scope,
        requireAdmissionPermit({ ...permit }),
      ),
    settle: (permit, effect) =>
      nativeProviderReadiness.settle(
        requireAdmissionPermit({ ...permit }),
        effect,
      ),
  },
  getAccountPause: async (account, region) => {
    const raw = await getRedis().get(pauseKey(account, region));
    const value = raw === null ? 0 : Number(raw);
    if (!Number.isFinite(value)) throw new Error("INVALID_PROVIDER_PAUSE");
    return value;
  },
  pauseAccount: async (account, region, until) => {
    await getRedis().eval(
      "local old=tonumber(redis.call('GET',KEYS[1]) or '0');if tonumber(ARGV[1])>old then redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[2]);end;return 1",
      1,
      pauseKey(account, region),
      String(until),
      String(Math.max(1, until - Date.now())),
    );
  },
  configurationSet: getConfigurationSetName,
  checkTeamLimit: (id) => LimitService.checkEmailLimit(id),
  capabilities: (scope) => nativeProviderReadiness.capabilities(scope),
  qualify: (scope) => nativeProviderReadiness.qualify(scope),
};
export async function nativeMarketingCapabilities(
  overrides: Partial<NativeDependencies> = {},
  scope: { teamId: number; apiKeyId?: number } = { teamId: 0 },
) {
  return {
    ...(await (overrides.capabilities ?? live.capabilities)(scope)),
    protocol: NATIVE_PROTOCOL,
  };
}
const consumed = (entry: NativePermitRecord | null | undefined) =>
  entry === null
    ? false
    : entry?.data.effect === "consumed"
      ? true
      : entry?.data.effect === "unused"
        ? false
        : undefined;
function response(
  context: MarketingHandoffContext,
  permit: NativePermit,
  outcome: NativeReply["outcome"],
  status: NativeResult["status"],
  sdkInvoked: boolean,
  entry: NativePermitRecord | null | undefined,
  extra: Partial<NativeReply> = {},
): NativeResult {
  return {
    status,
    body: {
      protocol: NATIVE_PROTOCOL,
      intentId: context.idempotencyKey,
      budgetKey: permit.budgetKey,
      permitId: permit.id,
      outcome,
      sdkInvoked,
      ...(consumed(entry) !== undefined
        ? { permitConsumed: consumed(entry) }
        : {}),
      replayed: false,
      ...extra,
    },
  };
}
async function terminal(
  record: MarketingRecord,
  entry: NativePermitRecord | null,
  state: "EXPIRED" | "SUPPRESSED" | "REJECTED",
  reason: string,
  effect: "unused" | "consumed",
  deps: NativeDependencies,
) {
  await deps.database.$transaction(async (tx) => {
    const next = await transitionMarketingControl(
      record,
      { state, reason },
      tx,
    );
    if (!next) throw new MarketingHandoffUnknown(record.data.emailId);
    if (entry && !(await setNativePermitEffect(entry, effect, tx)))
      throw new MarketingHandoffUnknown(record.data.emailId);
    const status =
      state === "EXPIRED"
        ? "CANCELLED"
        : state === "SUPPRESSED"
          ? "SUPPRESSED"
          : "FAILED";
    const changed = await tx.email.updateMany({
      where: {
        id: record.data.emailId,
        teamId: record.data.teamId,
        sesEmailId: null,
        latestStatus: { in: ["QUEUED", "SCHEDULED"] },
      },
      data: { latestStatus: status },
    });
    if (changed.count)
      await tx.emailEvent.create({
        data: {
          id: `${record.id}/${next.data.revision}`,
          emailId: record.data.emailId,
          teamId: record.data.teamId,
          status,
          data: { kind: "NATIVE_TERMINAL", reason },
        },
      });
  });
}
export async function submitNativeMarketing(
  content: EmailContent,
  context: MarketingHandoffContext & { teamId: number; apiKeyId?: number },
  permit: NativePermit,
  overrides: Partial<NativeDependencies> = {},
): Promise<NativeResult> {
  const deps = { ...live, ...overrides };
  let entry: NativePermitRecord | null | undefined;
  try {
    const email = await sendEmail(
      { ...content, teamId: context.teamId, apiKeyId: context.apiKeyId },
      {
        ...context,
        beforePrepare: async () => {
          if (
            content.expiresAt !== null &&
            content.expiresAt !== undefined &&
            Date.parse(content.expiresAt) <= deps.now().getTime()
          )
            throw new MarketingNoSend("DELIVERY_DEADLINE_ELAPSED", "EXPIRED");
          if (Date.parse(permit.submitBefore) <= deps.now().getTime())
            throw new MarketingNoSend("NATIVE_SUBMIT_WINDOW_ELAPSED");
          if (!deps.admission.qualified)
            throw new MarketingNoSend("PROVIDER_ADMISSION_UNQUALIFIED");
          if (deps.admission.preflight) {
            const ready = await deps.admission.preflight(context);
            if (!ready.qualified)
              throw new MarketingNoSend(
                ready.reason ?? "PROVIDER_ADMISSION_UNQUALIFIED",
              );
          }
        },
      },
    );
    const record = await existingMarketingOwner(
      context.teamId,
      context,
      deps.database,
    );
    if (!record) throw new MarketingHandoffUnknown(email.id);
    return executePreparedNative(email, record, context, permit, deps);
  } catch (error) {
    try {
      entry = await readNativePermit(context.teamId, permit, deps.database);
    } catch {
      entry = undefined;
    }
    if (error instanceof MarketingNoSend) {
      return response(
        context,
        permit,
        error.terminal
          ? (error.terminal.toLowerCase() as
              | "expired"
              | "suppressed"
              | "rejected")
          : "held",
        error.terminal ? 422 : 429,
        false,
        entry,
        {
          reason: error.reason,
          retryAfterMs: error.terminal ? undefined : 30000,
        },
      );
    }
    if (error instanceof UnsendApiError && error.status < 500)
      return response(
        context,
        permit,
        "rejected",
        error.status as 400 | 403 | 404 | 409,
        false,
        entry,
        { reason: error.code },
      );
    return response(context, permit, "unknown", 503, false, entry, {
      reason: "MARKETING_HANDOFF_UNKNOWN",
      ...(error instanceof MarketingHandoffUnknown && error.emailId
        ? { emailId: error.emailId }
        : {}),
    });
  }
}
export async function executePreparedNative(
  email: Email,
  initial: MarketingRecord,
  context: MarketingHandoffContext,
  permit: NativePermit,
  overrides: Partial<NativeDependencies> = {},
): Promise<NativeResult> {
  const deps = { ...live, ...overrides };
  let record = initial;
  let entry: NativePermitRecord | null | undefined;
  let sdkInvoked = false;
  let fencedHere = false;
  let observedId: string | undefined;
  let providerPermit: ProviderPermit | undefined;
  let providerEffect: "unused" | "accepted" | "unknown" | undefined;
  const result = (
    outcome: NativeReply["outcome"],
    status: NativeResult["status"],
    extra: Partial<NativeReply> = {},
  ) =>
    response(context, permit, outcome, status, sdkInvoked, entry, {
      emailId: email.id,
      ...extra,
    });
  const accepted = (replayed: boolean): NativeResult =>
    result("accepted", 200, {
      replayed,
      accepted: {
        permitId: record.data.acceptedPermitId!,
        provider: "ses",
        messageId: record.data.observedSesId!,
        acceptedAt: record.data.acceptedAt!,
      },
    });
  const checkDeadlines = () => {
    if (
      record.data.expiresAt !== null &&
      Date.parse(record.data.expiresAt) <= deps.now().getTime()
    )
      throw new MarketingNoSend("DELIVERY_DEADLINE_ELAPSED", "EXPIRED");
    if (
      !Number.isFinite(Date.parse(permit.submitBefore)) ||
      Date.parse(permit.submitBefore) <= deps.now().getTime()
    )
      throw new MarketingNoSend("NATIVE_SUBMIT_WINDOW_ELAPSED");
  };
  try {
    entry = await readNativePermit(email.teamId, permit, deps.database);
    if (entry && entry.data.controlId !== record.id)
      return result("rejected", 409, {
        reason: "NATIVE_PERMIT_OWNER_MISMATCH",
        replayed: true,
      });
    if (record.data.protocol !== NATIVE_PROTOCOL)
      return result("unknown", 503, {
        reason: "OWNER_PROTOCOL_UNQUALIFIED",
        replayed: true,
      });
    if (record.data.state === "ACCEPTED") {
      if (
        !record.data.observedSesId ||
        !record.data.acceptedPermitId ||
        !record.data.acceptedAt ||
        email.sesEmailId !== record.data.observedSesId
      )
        return result("unknown", 503, {
          reason: "ACCEPTANCE_RECEIPT_UNQUALIFIED",
          replayed: true,
        });
      return accepted(true);
    }
    if (
      [
        "SUBMITTING",
        "UNKNOWN_HOLD",
        "ENQUEUE_PENDING",
        "HANDOFF_UNKNOWN",
        "QUEUED",
      ].includes(record.data.state)
    )
      return result("unknown", 503, {
        reason: "PROVIDER_OUTCOME_UNKNOWN",
        replayed: true,
      });
    if (["SUPPRESSED", "EXPIRED", "REJECTED"].includes(record.data.state))
      return result(
        record.data.state.toLowerCase() as
          | "suppressed"
          | "expired"
          | "rejected",
        422,
        {
          reason:
            record.data.state === "EXPIRED"
              ? "DELIVERY_DEADLINE_ELAPSED"
              : (record.data.reason ?? "EMAIL_SUPPRESSED"),
          replayed: true,
        },
      );
    if (entry)
      return result(
        entry.data.effect === "unknown" ? "unknown" : "held",
        entry.data.effect === "unknown" ? 503 : 429,
        {
          reason: "NATIVE_PERMIT_REQUIRES_FRESH_NONCE",
          replayed: true,
          retryAfterMs: 30000,
        },
      );
    if (email.sesEmailId)
      return result("unknown", 503, {
        reason: "PRIOR_SES_ID_REQUIRES_RECONCILIATION",
      });
    checkDeadlines();
    if (!deps.admission.qualified)
      throw new MarketingNoSend("PROVIDER_ADMISSION_UNQUALIFIED");
    if (
      record.data.nextEligibleAt &&
      Date.parse(record.data.nextEligibleAt) > deps.now().getTime()
    )
      throw new MarketingNoSend("PROVIDER_BACKOFF");
    const domain = email.domainId
      ? await deps.database.domain.findUnique({ where: { id: email.domainId } })
      : null;
    if (
      !domain ||
      domain.teamId !== email.teamId ||
      domain.region !== record.data.region
    )
      throw new MarketingNoSend("DOMAIN_BINDING_CHANGED");
    if (!singleMarketingMailbox(email))
      throw new MarketingNoSend(
        "MARKETING_SINGLE_RECIPIENT_REQUIRED",
        "REJECTED",
      );
    const configurationSetName = await deps.configurationSet(
      domain.clickTracking,
      domain.openTracking,
      domain.region,
    );
    if (!configurationSetName)
      throw new MarketingNoSend("PROVIDER_CONFIGURATION_UNAVAILABLE");
    if ((await deps.checkTeamLimit(email.teamId)).isLimitReached)
      throw new MarketingNoSend("TEAM_LIMIT_REACHED");
    observedId = await deps.send({
      to: email.to,
      from: email.from,
      subject: email.subject,
      text: email.text ?? undefined,
      html: email.html ?? undefined,
      cc: email.cc,
      bcc: email.bcc,
      replyTo: email.replyTo,
      region: domain.region,
      configurationSetName,
      attachments: email.attachments
        ? JSON.parse(email.attachments)
        : undefined,
      headers: email.headers ? JSON.parse(email.headers) : undefined,
      isBulk: true,
      emailId: email.id,
      sesTenantId: domain.sesTenantId,
      unsubUrl: record.data.unsubscribeUrl,
      marketing: {
        expiresAt: record.data.expiresAt,
        submitBefore: permit.submitBefore,
        now: deps.now,
        onSdkInvocation: () => {
          sdkInvoked = true;
        },
        beforeSubmit: async (envelope: PreparedMarketingEnvelope) => {
          if (
            envelope.recipientCount !== 1 ||
            envelope.to.length !== 1 ||
            envelope.cc.length ||
            envelope.bcc.length
          )
            throw new MarketingNoSend(
              "MARKETING_SINGLE_RECIPIENT_REQUIRED",
              "REJECTED",
            );
          checkDeadlines();
          const admission = await deps.admission.acquire({
            teamId: email.teamId,
            apiKeyId: context.apiKeyId,
            controlId: record.id,
            revision: record.data.revision,
            region: domain.region,
            recipientCount: 1,
            envelopeDigest: envelope.digest,
            businessExpiresAt: record.data.expiresAt,
          });
          if (admission.kind === "hold")
            throw new MarketingNoSend(admission.reason);
          providerPermit = admission;
          if (
            !admission.accountId ||
            !admission.permitId ||
            admission.region !== domain.region ||
            admission.recipientCount !== 1 ||
            admission.envelopeDigest !== envelope.digest ||
            !Number.isFinite(admission.observationGeneration) ||
            (record.data.accountId &&
              record.data.accountId !== admission.accountId)
          )
            throw new MarketingNoSend("PROVIDER_PERMIT_MISMATCH");
          if (
            record.data.blockedObservationGeneration !== undefined &&
            admission.observationGeneration <=
              record.data.blockedObservationGeneration
          )
            throw new MarketingNoSend("PROVIDER_REFRESH_REQUIRED");
          if (
            (await deps.getAccountPause(
              admission.accountId,
              admission.region,
            )) > deps.now().getTime()
          )
            throw new MarketingNoSend("PROVIDER_ACCOUNT_PAUSED");
          const fenced = await fenceNativePermit(
            record,
            permit,
            {
              attemptNumber: record.data.attemptNumber + 1,
              attemptToken: randomUUID(),
              accountId: admission.accountId,
              recipientCount: 1,
              envelopeDigest: envelope.digest,
              reason: null,
            },
            deps.database,
          );
          if (!fenced) throw new MarketingHandoffUnknown(email.id);
          record = fenced.record;
          entry = fenced.permit;
          fencedHere = true;
          if (permit.senderScope !== undefined) {
            const scope = await deps.senderScope({
              teamId: email.teamId,
              apiKeyId: context.apiKeyId,
              domainId: domain.id,
            });
            if (!scope || scope !== permit.senderScope)
              throw new MarketingNoSend("SENDER_SCOPE_CHANGED");
          }
          if (deps.admission.validate) {
            try {
              await deps.admission.validate(
                { teamId: email.teamId, apiKeyId: context.apiKeyId },
                admission,
              );
            } catch (error) {
              throw new MarketingNoSend(
                error instanceof Error
                  ? error.message
                  : "PROVIDER_VALIDATION_UNAVAILABLE",
              );
            }
          }
          const mailbox = envelope.to[0]!.toLowerCase().trim();
          const contact = email.contactId
            ? await deps.database.contact.findUnique({
                where: { id: email.contactId },
                include: { contactBook: true },
              })
            : null;
          if (
            !contact ||
            contact.contactBook.teamId !== email.teamId ||
            contact.email !== mailbox
          )
            throw new MarketingNoSend("CANONICAL_CONTACT_REQUIRED");
          const authority = await deps.database.contact.findUnique({
            where: {
              contactBookId_email: {
                contactBookId: contact.contactBookId,
                email: mailbox,
              },
            },
          });
          if (!authority || authority.id !== contact.id)
            throw new MarketingNoSend("CANONICAL_CONTACT_REQUIRED");
          const suppression = await deps.database.suppressionList.findUnique({
            where: { teamId_email: { teamId: email.teamId, email: mailbox } },
          });
          if (suppression || !authority.subscribed)
            throw new MarketingNoSend("EMAIL_SUPPRESSED", "SUPPRESSED");
          checkDeadlines();
        },
      },
    });
    if (!observedId?.trim() || !sdkInvoked)
      throw new Error("SDK_ACCEPTANCE_UNQUALIFIED");
    const acceptedAt = deps.now().toISOString();
    await deps.database.$transaction(async (tx) => {
      await tx.email.update({
        where: { id: email.id },
        data: { sesEmailId: observedId, attachments: null, headers: null },
      });
      const next = await transitionMarketingControl(
        record,
        {
          state: "ACCEPTED",
          observedSesId: observedId!,
          acceptedPermitId: permit.id,
          acceptedAt,
          reason: null,
        },
        tx,
      );
      if (
        !next ||
        !entry ||
        !(await setNativePermitEffect(entry, "consumed", tx))
      )
        throw new MarketingHandoffUnknown(email.id);
      record = next;
    });
    providerEffect = "accepted";
    entry = await readNativePermit(email.teamId, permit, deps.database);
    return accepted(false);
  } catch (error) {
    if (!sdkInvoked && !observedId) {
      try {
        entry = await readNativePermit(email.teamId, permit, deps.database);
      } catch {
        entry = undefined;
        return result("unknown", 503, {
          reason: "NATIVE_PERMIT_EFFECT_UNKNOWN",
        });
      }
      if (entry && entry.data.controlId !== record.id)
        return result("rejected", 409, {
          reason: "NATIVE_PERMIT_OWNER_MISMATCH",
          replayed: true,
        });
      if (
        entry?.data.effect === "consumed" ||
        (entry?.data.effect === "unknown" && !fencedHere)
      )
        return result("unknown", 503, {
          reason: "NATIVE_PERMIT_EFFECT_UNKNOWN",
          replayed: true,
        });
    }
    if (sdkInvoked || observedId) {
      if (
        !observedId &&
        (error instanceof TooManyRequestsException ||
          error instanceof SendingPausedException ||
          error instanceof AccountSuspendedException) &&
        providerPermit
      ) {
        const until = deps.now().getTime() + 30000;
        let accountInvalidated = true;
        try {
          await deps.admission.invalidate?.(providerPermit, until);
          await deps.pauseAccount(
            providerPermit.accountId,
            providerPermit.region,
            until,
          );
        } catch {
          accountInvalidated = false;
          /* The current owner stays UNKNOWN if durable account invalidation is uncertain. */
        }
        try {
          if (!accountInvalidated)
            throw new Error("PROVIDER_INVALIDATION_UNKNOWN");
          providerEffect = "unused";
          await deps.database.$transaction(async (tx) => {
            const waiting = await transitionMarketingControl(
              record,
              {
                state: "WAITING",
                reason: error.name,
                nextEligibleAt: new Date(until).toISOString(),
                blockedObservationGeneration:
                  providerPermit!.observationGeneration,
              },
              tx,
            );
            if (
              !waiting ||
              !entry ||
              !(await setNativePermitEffect(entry, "consumed", tx))
            )
              throw new MarketingHandoffUnknown(email.id);
            record = waiting;
          });
          entry = entry
            ? { ...entry, data: { ...entry.data, effect: "consumed" } }
            : entry;
          return result("held", 429, {
            reason: error.name,
            retryAfterMs: 30000,
            permitConsumed: true,
          });
        } catch {
          /* Unknown persistence below keeps the fence closed. */
        }
      }
      if (
        !observedId &&
        (error instanceof BadRequestException ||
          error instanceof MessageRejected)
      ) {
        providerEffect = "unused";
        try {
          await terminal(
            record,
            entry ?? null,
            "REJECTED",
            error.name,
            "consumed",
            deps,
          );
          return result("rejected", 422, {
            reason: error.name,
            permitConsumed: true,
          });
        } catch {
          /* Keep the submission unknown if recording failed. */
        }
      }
      try {
        const committed = await readMarketingControl(record.id, deps.database);
        if (
          committed?.data.state === "ACCEPTED" &&
          committed.data.observedSesId === observedId &&
          observedId
        ) {
          record = committed;
          entry = await readNativePermit(email.teamId, permit, deps.database);
          return accepted(false);
        }
        await deps.database.$transaction(async (tx) => {
          await transitionMarketingControl(
            record,
            {
              state: "UNKNOWN_HOLD",
              reason: "PROVIDER_OUTCOME_UNKNOWN",
              observedSesId: observedId ?? null,
            },
            tx,
          );
          if (entry) await setNativePermitEffect(entry, "consumed", tx);
        });
      } catch {
        /* Durable SUBMITTING and unknown permit remain closed forever. */
      }
      return result("unknown", 503, {
        reason: "PROVIDER_OUTCOME_UNKNOWN",
        permitConsumed: true,
      });
    }
    if (error instanceof MarketingHandoffUnknown)
      return result("unknown", 503, { reason: "MARKETING_HANDOFF_UNKNOWN" });
    const reason =
      error instanceof MarketingNoSend
        ? error.reason
        : "PROVIDER_PRE_SUBMIT_UNAVAILABLE";
    try {
      if (error instanceof MarketingNoSend && error.terminal) {
        await terminal(
          record,
          entry ?? null,
          error.terminal,
          reason,
          "unused",
          deps,
        );
        entry = entry
          ? { ...entry, data: { ...entry.data, effect: "unused" } }
          : entry;
        return result(
          error.terminal.toLowerCase() as "suppressed" | "expired" | "rejected",
          422,
          { reason },
        );
      }
      await deps.database.$transaction(async (tx) => {
        const waiting = await transitionMarketingControl(
          record,
          { state: "WAITING", reason },
          tx,
        );
        if (!waiting) throw new MarketingHandoffUnknown(email.id);
        if (entry && !(await setNativePermitEffect(entry, "unused", tx)))
          throw new MarketingHandoffUnknown(email.id);
        record = waiting;
      });
      entry = entry
        ? { ...entry, data: { ...entry.data, effect: "unused" } }
        : entry;
      return result("held", 429, { reason, retryAfterMs: 30000 });
    } catch {
      return result("unknown", 503, {
        reason: "PRE_SUBMIT_PERSISTENCE_UNKNOWN",
      });
    }
  } finally {
    if (providerPermit && deps.admission.settle) {
      try {
        await deps.admission.settle(
          providerPermit,
          providerEffect ?? (sdkInvoked || observedId ? "unknown" : "unused"),
        );
      } catch {
        /* Pending reservation and hash mismatch remain closed; no lease reclaim. */
      }
    }
  }
}

export async function qualifyNativeMarketing(
  scope: { teamId: number; apiKeyId?: number },
  overrides: Partial<NativeDependencies> = {},
) {
  return {
    ...(await (overrides.qualify ?? live.qualify!)(scope)),
    protocol: NATIVE_PROTOCOL,
  };
}
