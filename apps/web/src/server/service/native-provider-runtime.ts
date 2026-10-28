import { observeNativeProvider } from "../aws/native-provider-observation";
import {
  createProviderReadiness,
  AdmissionPermit,
} from "./native-provider-admission";
import {
  nativeProviderRedis,
  nativeProviderStore,
} from "./native-provider-store";

export const nativeProviderReadiness = createProviderReadiness({
  store: nativeProviderStore,
  redis: nativeProviderRedis,
  observe: observeNativeProvider,
  now: () => Date.now(),
});
export function requireAdmissionPermit(value: {
  [key: string]: unknown;
}): AdmissionPermit {
  if (
    value.kind !== "permit" ||
    typeof value.ledgerEpoch !== "string" ||
    typeof value.observationHash !== "string" ||
    typeof value.senderScopeFingerprint !== "string"
  )
    throw new Error("PROVIDER_PERMIT_MISMATCH");
  return value as unknown as AdmissionPermit;
}
