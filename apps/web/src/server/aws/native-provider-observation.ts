import {
  SESv2Client,
  GetAccountCommand,
  GetEmailIdentityCommand,
} from "@aws-sdk/client-sesv2";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { createHash } from "crypto";
import { env } from "~/env";
import { db } from "../db";
import {
  ProviderObservation,
  ProviderScope,
} from "../service/native-provider-admission";

export async function readSesProviderProof(domain: string, region: string) {
  const controller = new AbortController();
  const credentials = {
    accessKeyId: env.AWS_ACCESS_KEY,
    secretAccessKey: env.AWS_SECRET_KEY,
  };
  const ses = new SESv2Client({
    region,
    credentials,
    endpoint: env.AWS_SES_ENDPOINT,
    maxAttempts: 1,
  });
  const sts = new STSClient({ region, credentials, maxAttempts: 1 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("PROVIDER_OBSERVATION_TIMEOUT"));
      }, 3000);
    });
    const [account, identity, caller] = await Promise.race([
      Promise.all([
        ses.send(new GetAccountCommand({}), { abortSignal: controller.signal }),
        ses.send(new GetEmailIdentityCommand({ EmailIdentity: domain }), {
          abortSignal: controller.signal,
        }),
        sts.send(new GetCallerIdentityCommand({}), {
          abortSignal: controller.signal,
        }),
      ]),
      timeout,
    ]);
    return {
      accountId: caller.Account ?? "",
      maxPerSecond: account.SendQuota?.MaxSendRate ?? NaN,
      max24Hours: account.SendQuota?.Max24HourSend ?? NaN,
      sent24Hours: account.SendQuota?.SentLast24Hours ?? NaN,
      sendingEnabled: account.SendingEnabled === true,
      productionAccessEnabled: account.ProductionAccessEnabled === true,
      rawEnforcementStatus: account.EnforcementStatus ?? null,
      identityVerified: identity.VerifiedForSendingStatus === true,
      observedAt: new Date().toISOString(),
    };
  } finally {
    controller.abort();
    if (timer) clearTimeout(timer);
    ses.destroy();
    sts.destroy();
  }
}
const cache = new Map<
  string,
  { expiresAt: number; value: ProviderObservation }
>();
const accountObservations = new Map<string, ProviderObservation>();
function sharedQuota(value: ProviderObservation) {
  const id = value.accountId + "\0" + value.region;
  const latest = accountObservations.get(id);
  if (!latest || Date.parse(value.observedAt) > Date.parse(latest.observedAt)) {
    accountObservations.set(id, value);
    return value;
  }
  // Sender identity/key evidence stays scoped; quota observations are physical account+region state.
  return {
    ...value,
    observedAt: latest.observedAt,
    maxPerSecond: latest.maxPerSecond,
    max24Hours: latest.max24Hours,
    sent24Hours: latest.sent24Hours,
    sendingEnabled: latest.sendingEnabled,
    productionAccessEnabled: latest.productionAccessEnabled,
    rawEnforcementStatus: latest.rawEnforcementStatus,
  };
}
export async function observeNativeProvider(
  scope: ProviderScope,
): Promise<ProviderObservation> {
  if (!scope.apiKeyId) throw new Error("DOMAIN_SCOPED_KEY_REQUIRED");
  const key = await db.apiKey.findUnique({
    where: { id: scope.apiKeyId },
    include: { domain: true },
  });
  if (
    !key ||
    key.teamId !== scope.teamId ||
    !key.domain ||
    key.domain.teamId !== scope.teamId
  )
    throw new Error("DOMAIN_SCOPED_KEY_REQUIRED");
  const policy = await db.sesSetting.findUnique({
    where: { region: key.domain.region },
  });
  if (!policy) throw new Error("PROVIDER_POLICY_REQUIRED");
  const binding = createHash("sha256")
    .update(
      JSON.stringify({
        teamId: scope.teamId,
        apiKeyId: key.id,
        tokenHash: key.tokenHash,
        domainId: key.domain.id,
        domain: key.domain.name,
        domainUpdatedAt: key.domain.updatedAt,
        region: key.domain.region,
        credential: env.AWS_ACCESS_KEY,
        endpoint: env.AWS_SES_ENDPOINT,
        headroom: policy.transactionalQuota,
        rateCeiling: policy.sesEmailRateLimit,
      }),
    )
    .digest("hex");
  const cached = cache.get(binding);
  if (cached && cached.expiresAt > Date.now()) return sharedQuota(cached.value);
  const proof = await readSesProviderProof(key.domain.name, key.domain.region);
  const value: ProviderObservation = {
    ...proof,
    region: key.domain.region,
    senderDomain: key.domain.name,
    senderDomainScoped: true,
    providerScopeFingerprint: createHash("sha256")
      .update(binding + "\0" + proof.accountId)
      .digest("hex"),
    serviceHeadroomPercent: policy.transactionalQuota,
    rateCeiling: policy.sesEmailRateLimit,
  };
  cache.set(binding, { expiresAt: Date.now() + 60000, value });
  return sharedQuota(value);
}
